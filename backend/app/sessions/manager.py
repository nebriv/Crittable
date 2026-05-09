"""Session orchestrator.

The :class:`SessionManager` is the only writer of session state. It owns a
per-session ``asyncio.Lock`` (no global lock); it persists via the
:class:`~.repository.SessionRepository`; and it's the bridge between the
transport layer (REST / WS), the LLM layer, and the audit log.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any, Literal

from ..auth.audit import AuditEvent, AuditLog
from ..auth.authn import HMACAuthenticator
from ..auth.authz import AuthorizationError
from ..config import Settings
from ..extensions.registry import FrozenRegistry
from ..logging_setup import get_logger
from .models import (
    Message,
    MessageKind,
    ParticipantKind,
    Role,
    ScenarioPlan,
    Session,
    SessionSettings,
    SessionState,
    SetupNote,
    Turn,
)
from .progress import compute_progress_pct
from .repository import SessionRepository
from .submission_pipeline import FACILITATOR_MENTION_TOKEN
from .turn_engine import (
    IllegalTransitionError,
    assert_plan_edit_field,
    assert_transition,
    can_submit,
    critical_inject_allowed,
    groups_from_flat,
    groups_quorum_met,
    record_critical_inject,
)

# Per-role per-turn cap on accepted ready toggles. Mirrors the
# per-turn submission cap. Beyond this, ``set_role_ready`` rejects
# with ``reason="flip_cap_exceeded"``. The audit log + WS broadcast
# surface is bounded so a buggy or malicious client can't flap
# ready→not-ready 100x/sec.
READY_FLIP_CAP_PER_TURN = 5
# Server-side debounce window. Toggles arriving within this many
# milliseconds of the role's most recent accepted toggle are dropped
# silently — no audit, no broadcast, no flip-cap increment. Smooths
# double-clicks without burning the cap.
READY_DEBOUNCE_MS = 250


@dataclass(frozen=True)
class SetReadyOutcome:
    """Result of ``SessionManager.set_role_ready``.

    ``accepted=True, reason=None`` is the happy path (toggle applied
    or idempotent re-mark). ``accepted=False`` with a ``reason``
    string is a directed rejection — the WS layer relays this to the
    actor as a ``set_ready_rejected`` frame so the optimistic UI can
    revert and announce. ``ready_to_advance`` is True when the toggle
    closed the quorum and the caller should fire ``run_play_turn``.
    ``client_seq`` echoes the actor's monotonically-increasing seq so
    the client can reconcile this ack against optimistic state.
    """

    accepted: bool
    reason: str | None
    ready_to_advance: bool
    client_seq: int

if TYPE_CHECKING:
    from ..llm.dispatch import ToolDispatcher
    from ..llm.guardrail import InputGuardrail
    from ..llm.protocol import ChatClient
    from ..ws.connection_manager import ConnectionManager


_logger = get_logger("session.manager")

ParticipantKindLiteral = ParticipantKind


def _is_oversized(value: Any) -> bool:
    """Drop fields that would bloat per-event log lines (long strings, big dicts)."""

    if isinstance(value, str):
        return len(value) > 200
    if isinstance(value, (list, dict)):
        return len(value) > 20
    return False


def _inherit_workstream_id(session: Session, *, role_id: str) -> str | None:
    """Phase B chat-declutter (docs/plans/chat-decluttering.md §4.4):
    resolve the workstream_id a player's reply should inherit.

    Two of the four documented rules are implemented in Phase B —
    the explicit-tag rule (#1) requires the composer ``#tag``
    autocomplete (Phase C), and the lead_role_id fallback (#3)
    requires lead-role lookup against open workstreams. The most
    impactful rule for the visible filter chrome is #2 ("most recent
    AI message addressing this player"), which is what this helper
    implements; #4 ("otherwise None") falls out as the default
    return.

    The walk is bounded by the session's existing message log size
    (already memory-resident) and short-circuits on the first match,
    so it's O(N) worst-case per submission with N capped at the
    session's history. We deliberately don't memoize: the cost is
    negligible against the sub-millisecond budget for ``submit_response``,
    and a stale memo would silently corrupt inheritance after a turn
    flips.

    The dispatch layer guarantees that AI messages produced by
    ``address_role`` and ``pose_choice`` carry exactly one role_id in
    their ``mentions`` list (the addressee), so a reverse-walk
    matching ``role_id in msg.mentions`` is the correct addressing
    predicate. Pre-Phase-A messages have empty ``mentions`` lists and
    fail the predicate, so they're safely ignored.
    """

    for msg in reversed(session.messages):
        if msg.kind != MessageKind.AI_TEXT:
            continue
        if role_id in msg.mentions:
            return msg.workstream_id
    return None


_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]+")


def sanitize_role_text(value: str | None) -> str | None:
    """Strip C0 / C1 / DEL controls + leading/trailing whitespace.

    Used by ``add_role`` (label and display_name) and by callers that
    need to reproduce the same de-dup key the manager will persist.
    Exposing this as a module-level helper means the bulk-create path
    in ``POST /api/sessions`` can de-dupe on the *post-sanitisation*
    label — otherwise two byte-variants of the same label slip past
    the de-dup set and collapse to identical persisted rows. Returns
    ``None`` for ``None`` input or strings that collapse to empty
    after stripping.
    """

    if value is None:
        return None
    cleaned = _CONTROL_CHARS_RE.sub("", value).strip()
    return cleaned or None


class SessionManager:
    def __init__(
        self,
        *,
        settings: Settings,
        repository: SessionRepository,
        connections: ConnectionManager,
        audit: AuditLog,
        llm: ChatClient,
        guardrail: InputGuardrail,
        tool_dispatcher: ToolDispatcher,
        extension_registry: FrozenRegistry,
        authn: HMACAuthenticator,
    ) -> None:
        self._settings = settings
        self._repo = repository
        self._connections = connections
        self._audit = audit
        self._llm = llm
        self._guardrail = guardrail
        self._dispatcher = tool_dispatcher
        self._registry = extension_registry
        self._authn = authn

        self._locks: dict[str, asyncio.Lock] = {}
        self._lock_meta = asyncio.Lock()
        self._closed = False
        # Background tasks (currently just AAR generation). Kept on the manager
        # so they aren't garbage-collected mid-flight; canceled on shutdown.
        self._bg_tasks: set[asyncio.Task[Any]] = set()
        # Shared markdown notepad service (issue #98). Holds the per-session
        # pycrdt Doc; mutations must be performed under the same per-session
        # lock as ``_locks[session_id]`` since pycrdt isn't safe for
        # concurrent mutation.
        from .notepad import NotepadService  # local import to avoid cycle
        self._notepad = NotepadService()

    # ------------------------------------------------------------------ utils
    async def _lock_for(self, session_id: str) -> asyncio.Lock:
        async with self._lock_meta:
            lock = self._locks.get(session_id)
            if lock is None:
                lock = asyncio.Lock()
                self._locks[session_id] = lock
            return lock

    def _enforce_submission_cap(
        self, session: Session, *, turn_id: str, role_id: str, turn_index: int
    ) -> None:
        """Wave 1 (issue #134) security review H2: per-role per-turn
        submission cap. Counts how many non-interjection PLAYER
        messages this role already has on the given turn and rejects
        the new one if the cap is met. Shared across
        ``submit_response``, ``proxy_submit_as``, and the per-role
        loop in ``proxy_submit_pending`` so the operator escape
        hatches can't bypass the flood backstop. Caller must hold
        the per-session lock.
        """

        role_msg_count = sum(
            1
            for m in session.messages
            if m.turn_id == turn_id
            and m.role_id == role_id
            and m.kind == MessageKind.PLAYER
            and not m.is_interjection
        )
        cap = self._settings.max_submissions_per_role_per_turn
        if role_msg_count >= cap:
            _logger.warning(
                "submission_rate_exceeded",
                session_id=session.id,
                role_id=role_id,
                turn_index=turn_index,
                count=role_msg_count,
                cap=cap,
            )
            raise IllegalTransitionError(
                f"too many submissions on this turn "
                f"({role_msg_count}/{cap}); wait for the AI to "
                "advance or ask the creator to force-advance."
            )

    def _emit(self, kind: str, session: Session, **payload: Any) -> None:
        evt = AuditEvent(
            kind=kind,
            session_id=session.id,
            turn_id=session.current_turn.id if session.current_turn else None,
            payload=payload,
        )
        self._audit.emit(evt)
        _logger.info(
            "session_event",
            audit_kind=kind,
            session_id=session.id,
            state=session.state.value,
            turn_index=(
                session.current_turn.index if session.current_turn else None
            ),
            **{
                k: v
                for k, v in payload.items()
                # ``event`` is reserved by structlog as the message key.
                # ``audit_kind`` / ``session_id`` / ``state`` /
                # ``turn_index`` are set explicitly above; ``open_turn``
                # passes ``turn_index=`` in payload, which used to
                # collide silently while structlog cached its bound
                # logger but raises ``TypeError: got multiple values
                # for keyword argument 'turn_index'`` on the per-call
                # logger path. Filter so the explicit values win.
                if k
                not in {
                    "event",
                    "audit_kind",
                    "session_id",
                    "state",
                    "turn_index",
                }
                and not _is_oversized(v)
            },
        )

    async def _broadcast_state(
        self, session: Session, *, record: bool = True
    ) -> None:
        """Broadcast a ``state_changed`` event for the current state.

        ``record`` controls whether the event lands in the connection
        manager's bounded replay buffer. Default ``True`` (state
        transitions are durable; reconnecting clients need them in the
        replay). Issue #111's progress-pulse re-broadcasts pass
        ``record=False`` — the snapshot regenerates ``progress_pct``
        at fetch time, so the pulse doesn't need to survive in the
        replay buffer (and using a slot per pulse would evict
        legitimate state_changed / message_complete events).
        """

        await self._connections.broadcast(
            session.id,
            {
                "type": "state_changed",
                "state": session.state.value,
                "active_role_ids": (
                    session.current_turn.active_role_ids if session.current_turn else []
                ),
                "turn_index": (
                    session.current_turn.index if session.current_turn else None
                ),
                # Issue #111: per-turn progress fraction so the TURN
                # STATE rail can render a determinate bar without
                # waiting for the next snapshot poll.
                "progress_pct": compute_progress_pct(session),
            },
            record=record,
        )

    # ----------------------------------------------------- session lifecycle
    async def create_session(
        self,
        *,
        scenario_prompt: str,
        creator_label: str,
        creator_display_name: str,
        settings: SessionSettings,
    ) -> tuple[Session, str]:
        if not scenario_prompt.strip():
            raise ValueError("scenario_prompt must be non-empty")
        creator_role = Role(
            label=creator_label,
            display_name=creator_display_name,
            kind="player",
            is_creator=True,
        )
        session = Session(
            scenario_prompt=scenario_prompt.strip(),
            settings=settings,
            roles=[creator_role],
            creator_role_id=creator_role.id,
        )
        await self._repo.create(session)
        async with await self._lock_for(session.id):
            assert_transition(session.state, SessionState.SETUP)
            session.state = SessionState.SETUP
            await self._repo.save(session)

        token = self._authn.mint(
            session_id=session.id,
            role_id=creator_role.id,
            kind="creator",
            version=creator_role.token_version,
        )
        self._emit(
            "session_created",
            session,
            scenario_prompt=session.scenario_prompt,
            difficulty=session.settings.difficulty,
            duration_minutes=session.settings.duration_minutes,
            features=session.settings.features.model_dump(),
        )
        return session, token

    async def add_role(
        self,
        *,
        session_id: str,
        label: str,
        display_name: str | None = None,
        kind: ParticipantKindLiteral = "player",
        acting_role_id: str,
        acting_token_version: int,
    ) -> tuple[Role, str]:
        # Strip C0/C1/DEL controls from the label and (optional)
        # display_name via ``sanitize_role_text``. Both the bulk
        # invitee-roles registration in ``POST /api/sessions`` and
        # the per-role POST endpoint flow creator-supplied strings
        # through here, and an attacker who can write to that field
        # could otherwise embed a ``\n`` to split a structlog audit
        # line OR wedge ANSI / Markdown directives into the
        # ``## Seated roster`` system block. ``IllegalTransitionError``
        # (matching ``set_role_display_name``) lets the per-role
        # route surface this as 409 instead of 500.
        label_clean = sanitize_role_text(label)
        if label_clean is None:
            raise IllegalTransitionError("label must not be blank")
        dn_clean = sanitize_role_text(display_name)
        async with await self._lock_for(session_id):
            session = await self._repo.get(session_id)
            # Re-verify creator authorization inside the lock. The route
            # already ran ``require_creator(token)`` against the bound token,
            # but a concurrent revocation can land between bind and lock,
            # leaving us with a stale-but-valid-looking token. Bumping
            # ``token_version`` is the only revocation signal, so we recheck
            # it against the current session state.
            acting_role = session.role_by_id(acting_role_id)
            if (
                acting_role is None
                or acting_role.token_version != acting_token_version
                or acting_role.id != session.creator_role_id
            ):
                raise AuthorizationError("creator authorization revoked")
            if session.state in (SessionState.ENDED,):
                raise IllegalTransitionError("cannot add roles to an ENDED session")
            if len(session.roles) >= self._settings.max_roles_per_session:
                raise IllegalTransitionError(
                    f"max roles reached: {self._settings.max_roles_per_session}"
                )
            role = Role(label=label_clean, display_name=dn_clean, kind=kind)
            session.roles.append(role)
            await self._repo.save(session)

        token = self._authn.mint(
            session_id=session_id,
            role_id=role.id,
            kind="player" if kind == "player" else "spectator",
            version=role.token_version,
        )
        self._emit(
            "role_added",
            session,
            role_id=role.id,
            label=role.label,
            participant_kind=role.kind,
        )
        await self._connections.broadcast(
            session.id,
            {
                "type": "participant_joined",
                "role_id": role.id,
                "label": role.label,
                "display_name": role.display_name,
                "kind": role.kind,
            },
        )
        return role, token

    async def get_session(self, session_id: str) -> Session:
        return await self._repo.get(session_id)

    # -------------------------------------------------- role management
    async def reissue_role_token(
        self,
        *,
        session_id: str,
        role_id: str,
        revoke_previous: bool,
        by_role_id: str | None = None,
    ) -> str:
        """Re-mint a role's join token.

        ``revoke_previous=False`` is a "show me the link again" — same token
        is regenerated (useful when the creator lost the original URL).
        ``revoke_previous=True`` is a "kick" — bumps ``role.token_version`` so
        any holder of the prior token gets a 4401 on next request.
        """

        async with await self._lock_for(session_id):
            session = await self._repo.get(session_id)
            role = session.role_by_id(role_id)
            if role is None:
                raise IllegalTransitionError(f"role not found: {role_id}")
            if role.is_creator and revoke_previous:
                raise IllegalTransitionError(
                    "cannot revoke the creator's token mid-session; end and "
                    "start a new session instead"
                )
            if revoke_previous:
                role.token_version += 1
                # Wave 1 (issue #134) security review H1: scrub the kicked
                # role from the active turn's ready/submitted lists. The
                # WS gets force-closed below, but a stale ``ready`` entry
                # would still trip the ready-quorum predicate after the
                # role's effective absence shrinks the active set. Same
                # treatment as ``remove_role``.
                if session.current_turn is not None:
                    session.current_turn.ready_role_ids = [
                        r
                        for r in session.current_turn.ready_role_ids
                        if r != role_id
                    ]
                    session.current_turn.submitted_role_ids = [
                        r
                        for r in session.current_turn.submitted_role_ids
                        if r != role_id
                    ]
                await self._repo.save(session)
            kind = "creator" if role.is_creator else (
                "player" if role.kind == "player" else "spectator"
            )
            token = self._authn.mint(
                session_id=session.id,
                role_id=role.id,
                kind=kind,  # type: ignore[arg-type]
                version=role.token_version,
            )
        self._emit(
            ("role_token_revoked" if revoke_previous else "role_token_reissued"),
            session,
            role_id=role_id,
            label=role.label,
            # Issue #127 follow-up (Product review): operator-action
            # audit lines must record WHO performed the action, not
            # just the target. Defaults to None for non-API callers.
            by=by_role_id,
        )
        if revoke_previous:
            # Bumping token_version only blocks *future* connect / API
            # attempts. The kicked player's existing WebSocket stays
            # open until we close it explicitly, so they could keep
            # posting through their already-open tab (issue #127).
            # Force-close every open socket for this role; the close
            # is fire-and-forget — the per-connection recv pump runs
            # its normal teardown when the close lands.
            await self._connections.disconnect_role(
                session_id, role_id, code=4401, reason="kicked"
            )
        return token

    async def set_role_display_name(
        self,
        *,
        session_id: str,
        role_id: str,
        display_name: str,
    ) -> Role:
        """Update one role's ``display_name``.

        Used by the player-join flow: the join intro asks the player
        for their name (e.g. "Bridget") and POSTs it here so other
        participants see ``Cybersecurity Engineer · Bridget`` in the
        transcript instead of the bare label. The endpoint is bound by
        the role's token — only the role themselves (or a creator
        impersonating via a creator token, but the route guards that)
        should hit this path.

        Emits a ``participant_renamed`` WS event so connected clients
        refresh their snapshot without polling. The previous behavior
        (display_name lived in localStorage only) had to be removed
        because no event signaled the rename to peer clients.
        """

        # Strip C0 (``\x00-\x1f``) + DEL (``\x7f``) + C1 (``\x80-\x9f``)
        # control characters before persisting. ``Field(max_length=64)``
        # lets a malicious player submit something like
        # ``"Bridget\nFAKE: state_changed"`` — the inner ``\n`` would
        # split a structlog audit line into two and confuse log
        # parsers / SIEM regexes. C1 controls are less common but still
        # valid Unicode and can interfere with downstream consumers
        # (some terminal emulators, log shippers, ANSI-aware viewers
        # interpret 0x80-0x9F as escape sequences). This is the first
        # player-callable mutation route, so the rule lands here. The
        # frontend's React render path is XSS-safe; this is defense-
        # in-depth at the storage boundary.
        import re

        sanitised = re.sub(r"[\x00-\x1f\x7f-\x9f]+", "", display_name)
        cleaned = sanitised.strip()
        if not cleaned:
            raise IllegalTransitionError("display_name must not be blank")
        async with await self._lock_for(session_id):
            session = await self._repo.get(session_id)
            role = session.role_by_id(role_id)
            if role is None:
                raise IllegalTransitionError(f"role not found: {role_id}")
            role.display_name = cleaned
            await self._repo.save(session)
        self._emit(
            "role_display_name_set",
            session,
            role_id=role_id,
            display_name=cleaned,
        )
        await self._connections.broadcast(
            session.id,
            {
                "type": "participant_renamed",
                "role_id": role_id,
                "display_name": cleaned,
            },
        )
        return role

    async def remove_role(
        self, *, session_id: str, role_id: str, by_role_id: str
    ) -> None:
        async with await self._lock_for(session_id):
            session = await self._repo.get(session_id)
            if session.creator_role_id != by_role_id:
                raise IllegalTransitionError("only the creator can remove roles")
            role = session.role_by_id(role_id)
            if role is None:
                raise IllegalTransitionError(f"role not found: {role_id}")
            if role.is_creator:
                raise IllegalTransitionError("cannot remove the creator's role")
            if session.current_turn and role_id in session.current_turn.active_role_ids:
                # Drop the active-role slot so the turn isn't stuck waiting
                # on a kicked player. Walk every group in
                # ``active_role_groups`` and remove the kicked id;
                # groups that empty out are dropped entirely (an empty
                # group would never close).
                trimmed_groups: list[list[str]] = []
                for group in session.current_turn.active_role_groups:
                    pruned = [rid for rid in group if rid != role_id]
                    if pruned:
                        trimmed_groups.append(pruned)
                session.current_turn.active_role_groups = trimmed_groups
            if session.current_turn:
                # Wave 1 (issue #134) security review H1: scrub the kicked
                # role from ``ready_role_ids`` and ``submitted_role_ids``
                # too. Otherwise (a) a stale ``ready`` entry can flip the
                # ready-quorum predicate after the active set shrinks,
                # auto-advancing a turn the team didn't ask for, and
                # (b) the snapshot leaks a role_id that no longer
                # appears in ``roles`` — a side-channel that didn't
                # exist before this PR.
                session.current_turn.ready_role_ids = [
                    r for r in session.current_turn.ready_role_ids if r != role_id
                ]
                session.current_turn.submitted_role_ids = [
                    r for r in session.current_turn.submitted_role_ids if r != role_id
                ]
            session.roles = [r for r in session.roles if r.id != role_id]
            await self._repo.save(session)
        self._emit("role_removed", session, role_id=role_id, by=by_role_id)
        await self._connections.broadcast(
            session.id,
            {"type": "participant_left", "role_id": role_id},
        )
        # Same reasoning as the revoke path in ``reissue_role_token``:
        # the removed player's already-open WS would otherwise let them
        # keep submitting messages until the next reconnect (issue #127).
        # ``_bind_token`` rejects the next REST poll because the role no
        # longer exists, but the live socket has no equivalent gate.
        await self._connections.disconnect_role(
            session_id, role_id, code=4401, reason="removed"
        )

    # ------------------------------------------------------- setup-phase API
    async def append_setup_message(
        self,
        *,
        session_id: str,
        speaker: str,
        content: str,
        topic: str | None = None,
        options: list[str] | None = None,
    ) -> None:
        if speaker not in ("ai", "creator"):
            raise ValueError("speaker must be 'ai' or 'creator'")
        async with await self._lock_for(session_id):
            session = await self._repo.get(session_id)
            if session.state != SessionState.SETUP:
                raise IllegalTransitionError("not in SETUP")
            assert speaker in ("ai", "creator")
            session.setup_notes.append(
                SetupNote(
                    speaker="ai" if speaker == "ai" else "creator",
                    content=content,
                    topic=topic,
                    options=options,
                )
            )
            await self._repo.save(session)
        self._emit(
            "setup_message",
            session,
            speaker=speaker,
            topic=topic,
            content_preview=content[:120],
        )

    async def finalize_setup(self, *, session_id: str, plan: ScenarioPlan) -> Session:
        async with await self._lock_for(session_id):
            session = await self._repo.get(session_id)
            assert_transition(session.state, SessionState.READY)
            session.plan = plan
            session.state = SessionState.READY
            await self._repo.save(session)
        self._emit("plan_finalized", session, title=plan.title)
        await self._broadcast_state(session)
        return session

    async def edit_plan_field(
        self, *, session_id: str, role_id: str, field: str, value: Any
    ) -> Session:
        async with await self._lock_for(session_id):
            session = await self._repo.get(session_id)
            if session.creator_role_id != role_id:
                raise IllegalTransitionError("plan edits are creator-only")
            assert_plan_edit_field(field)
            if session.plan is None:
                raise IllegalTransitionError("no plan to edit; finalize_setup first")
            setattr(session.plan, field, value)
            await self._repo.save(session)
            session.messages.append(
                Message(
                    kind=MessageKind.SYSTEM,
                    body=f"Creator edited plan field: {field}",
                )
            )
        self._emit("plan_edited", session, field=field)
        await self._connections.broadcast(
            session.id,
            {"type": "plan_edited", "field": field},
        )
        return session

    async def override_message_workstream(
        self,
        *,
        session_id: str,
        message_id: str,
        workstream_id: str | None,
        by_role_id: str,
        is_creator: bool,
    ) -> Message:
        """Manual workstream re-tag for a single message (chat-declutter polish).

        Authz contract:
          - ``is_creator=True`` → may move any message;
          - else the caller must be the message's ``role_id`` (the
            message-of-record's role can correct its own categorization).
          - everything else: ``IllegalTransitionError``.

        ``workstream_id=None`` moves the message back to the synthetic
        ``#main`` bucket. A non-None target must match one of the
        session's currently declared workstream ids; mismatches raise
        ``IllegalTransitionError`` (the route maps it to 400).

        Emits the ``workstream_override`` audit kind with ``before`` /
        ``after`` / ``actor`` so the AAR archeology run can replay every
        manual move. Fans out a ``message_workstream_changed`` WS event
        (replay-buffered, ``record=True``) so peer tabs update their
        filter view without a snapshot round-trip.
        """

        async with await self._lock_for(session_id):
            session = await self._repo.get(session_id)
            msg = next((m for m in session.messages if m.id == message_id), None)
            if msg is None:
                raise IllegalTransitionError(f"message not found: {message_id}")
            # Authz: creator OR message-owner only. Spectators / other roles
            # never get to re-tag someone else's message — covered by the
            # ws-event security review.
            if not is_creator and msg.role_id != by_role_id:
                raise IllegalTransitionError(
                    "only the message's author or the creator may override workstream"
                )
            target: str | None = workstream_id
            if target is not None:
                declared = (
                    {ws.id for ws in session.plan.workstreams}
                    if session.plan is not None
                    else set()
                )
                if target not in declared:
                    raise IllegalTransitionError(
                        f"workstream not declared on this session: {target}"
                    )
            before = msg.workstream_id
            if before == target:
                # Idempotent no-op — no audit / broadcast spam from a
                # double-click on the same menu item.
                return msg
            msg.workstream_id = target
            await self._repo.save(session)
        self._emit(
            "workstream_override",
            session,
            message_id=message_id,
            before=before,
            after=target,
            actor=by_role_id,
        )
        # Security review MEDIUM #1: ``record=False`` so override flips
        # don't pressure the 256-slot replay buffer. The new
        # ``workstream_id`` is part of the persisted message and lands
        # in any reconnecting tab's snapshot fetch — the WS event is a
        # live-tab nudge, not the source of truth. Without this guard
        # a creator (or message-author) flipping their own message in
        # a tight loop could evict legitimate ``state_changed`` /
        # ``message_complete`` entries from the buffer and break
        # reconnect rehydration. Mirrors the policy on
        # ``notepad_update`` / typing indicators / awareness frames.
        await self._connections.broadcast(
            session.id,
            {
                "type": "message_workstream_changed",
                "message_id": message_id,
                "workstream_id": target,
                "actor_role_id": by_role_id,
            },
            record=False,
        )
        return msg

    async def set_ai_paused(
        self, *, session_id: str, paused: bool, by_role_id: str
    ) -> Session:
        """Flip ``Session.ai_paused`` and fan the new state out to clients.

        Wave 3 (issue #69). Idempotent: re-issuing pause when already
        paused (or resume when already resumed) is a no-op — the
        broadcast is suppressed and no audit line is emitted, so a
        rapid double-click on the toggle doesn't double-log or send
        confusing repeated banners. ``by_role_id`` is the creator
        token's bound role; the route enforces creator-only — this
        method trusts the caller and records the actor for audit.

        Pause does NOT halt normal play turns. The flag is only
        consumed by the WS routing branch in ``ws/routes.py`` to skip
        ``run_interject`` for ``@facilitator`` mentions; player turn
        submissions still advance ``run_play_turn`` as usual. See the
        section in ``docs/PLAN.md`` and the routing branch comment.
        """

        async with await self._lock_for(session_id):
            session = await self._repo.get(session_id)
            if session.ai_paused == paused:
                return session
            session.ai_paused = paused
            await self._repo.save(session)
        self._emit(
            "ai_paused_by_creator" if paused else "ai_resumed_by_creator",
            session,
            by=by_role_id,
        )
        await self._connections.broadcast(
            session.id,
            {"type": "ai_pause_state_changed", "paused": paused},
        )
        return session

    # ------------------------------------------------------------ turn flow
    async def start_session(self, *, session_id: str) -> Session:
        async with await self._lock_for(session_id):
            session = await self._repo.get(session_id)
            if session.plan is None:
                raise IllegalTransitionError("cannot start without a finalized plan")
            if len([r for r in session.roles if r.kind == "player"]) < 2:
                raise IllegalTransitionError("at least 2 player roles required")
            assert_transition(session.state, SessionState.BRIEFING)
            session.state = SessionState.BRIEFING
            await self._repo.save(session)
        self._emit("session_started", session)
        await self._broadcast_state(session)
        return session

    async def open_turn(
        self, *, session_id: str, active_role_ids: Iterable[str]
    ) -> Turn:
        """Open the next awaiting turn with each role in its own group.

        Convenience wrapper for the common "every role must respond"
        case (force-advance recovery, briefing turn opener, legacy
        scenario fixtures). For the multi-role any-of case, callers
        should use :meth:`open_turn_with_groups` directly.
        """

        return await self.open_turn_with_groups(
            session_id=session_id,
            active_role_groups=groups_from_flat(list(active_role_ids)),
        )

    async def open_turn_with_groups(
        self,
        *,
        session_id: str,
        active_role_groups: Iterable[Iterable[str]],
    ) -> Turn:
        """Open the next awaiting turn with the AI's exact yield shape.

        Each entry of ``active_role_groups`` is a list of role_ids and
        represents one ASK; the gate (``groups_quorum_met``) advances
        the turn only when EVERY group has at least one ready vote.
        Empty groups are dropped here (an empty group could never
        close the gate); a fully-empty input raises since there's
        nothing to wait on.
        """

        normalized: list[list[str]] = []
        seen_in_groups: set[str] = set()
        for group in active_role_groups:
            deduped: list[str] = []
            for rid in group:
                if rid in seen_in_groups:
                    continue
                seen_in_groups.add(rid)
                deduped.append(rid)
            if deduped:
                normalized.append(deduped)
        if not normalized:
            raise IllegalTransitionError(
                "open_turn_with_groups requires at least one non-empty group"
            )
        async with await self._lock_for(session_id):
            session = await self._repo.get(session_id)
            target = SessionState.AWAITING_PLAYERS
            if session.state == SessionState.AI_PROCESSING:
                assert_transition(session.state, target)
            elif session.state == SessionState.BRIEFING:
                assert_transition(session.state, target)
            elif session.state == SessionState.AWAITING_PLAYERS:
                assert_transition(session.state, target)
            else:
                raise IllegalTransitionError(
                    f"cannot open turn from state {session.state}"
                )
            session.state = target
            turn = Turn(
                index=len(session.turns),
                active_role_groups=normalized,
                status="awaiting",
            )
            session.turns.append(turn)
            await self._repo.save(session)
        await self._broadcast_state(session)
        await self._connections.broadcast(
            session.id,
            {
                "type": "turn_changed",
                "turn_index": turn.index,
                "active_role_ids": turn.active_role_ids,
                # Issue #168: send the canonical groups shape too so
                # the frontend can render "either Paul or Lawrence"
                # for multi-role any-of groups instead of flattening
                # to "Paul, Lawrence" (which misleads the player into
                # thinking BOTH must answer).
                "active_role_groups": turn.active_role_groups,
                # Issue #111: ride the new-turn fan-out so a freshly-
                # opened turn (e.g. after force-advance reopens an
                # active set) carries the reset progress fraction.
                "progress_pct": compute_progress_pct(session),
            },
        )
        self._emit(
            "turn_opened", session, turn_index=turn.index, active=turn.active_role_ids
        )
        return turn

    def _enforce_dedupe_window(
        self, session: Session, *, role_id: str, content: str
    ) -> None:
        """Raise ``IllegalTransitionError`` if ``role_id`` posted the same
        body within ``duplicate_submission_window_seconds``.

        Backstop for the duplicate-submission path (issue #63). The
        15-second-apart duplicate visible in the screenshot is dissolved
        by the ``ai_thinking`` / ``ai_status`` indicators, but this
        guard prevents a stray double-Enter from producing two visible
        bubbles. Shared by ``submit_response`` and ``proxy_submit_as``
        (issue #78 — pre-fix the proxy path skipped this scan, which
        magnified into a real risk once the proxy became the documented
        out-of-turn interjection path).

        Scans backwards for the most recent ``PLAYER`` message from this
        same role within the dedupe window. We can't just check
        ``messages[-1]`` because an interject path can splice an AI
        reply between the two participant submits — and a SYSTEM banner
        can land in the same gap. The window itself bounds the scan, so
        the cost is at worst O(messages_in_last_30s).
        """

        window_seconds = self._settings.duplicate_submission_window_seconds
        if window_seconds <= 0:
            return
        stripped_new = content.strip()
        now = datetime.now(UTC)
        for prior in reversed(session.messages):
            if (now - prior.ts).total_seconds() >= window_seconds:
                return
            if prior.kind != MessageKind.PLAYER or prior.role_id != role_id:
                continue
            if prior.body.strip() == stripped_new:
                self._emit(
                    "dedupe_dropped_submission",
                    session,
                    role_id=role_id,
                    content_preview=content[:120],
                    elapsed_seconds=int((now - prior.ts).total_seconds()),
                )
                raise IllegalTransitionError(
                    "You just sent the same message — wait a moment "
                    "or change something to send again."
                )
            # Found the most recent same-role player message and it
            # didn't match — stop scanning.
            return

    async def submit_response(
        self,
        *,
        session_id: str,
        role_id: str,
        content: str,
        expected_token_version: int | None = None,
        mentions: list[str] | None = None,
    ) -> bool:
        """Record a player's submission. ALWAYS returns ``False`` —
        submissions never advance the turn. Use ``set_role_ready`` to
        flip the ready quorum.

        Allowed in ``AWAITING_PLAYERS`` (normal flow) AND in
        ``AI_PROCESSING`` (interjection during the AI's processing
        step). In ``AI_PROCESSING`` every submission is forced to
        ``is_interjection=True`` regardless of whether the role is on
        the active set — the AI is mid-stream, the quorum is closed,
        the message lands as a sidebar comment for the current turn
        (visible to the AI when it next plans). The composer staying
        enabled across the state flip is the whole point of the
        decoupled-ready model: drafts mid-typing don't get locked when
        the room's quorum closes.

        If the role is on ``active_role_ids`` AND the session is
        ``AWAITING_PLAYERS``, the post counts as a normal turn
        submission (a role can submit multiple messages on a turn).
        Otherwise it is recorded as an out-of-turn interjection
        (``is_interjection=True``) — appended to the transcript so the
        AI sees it on the next turn (and so the WS layer can fire
        ``run_interject`` for ``@facilitator`` mentions), but with no
        effect on ``submitted_role_ids`` / ``ready_role_ids`` /
        session state.

        ``mentions`` (Wave 2): cleaned list of mention targets — real
        ``role_id`` values + the literal ``"facilitator"``. The
        submission pipeline drops unknowns before this layer; we
        trust the input here and just persist on ``Message.mentions``.
        """

        async with await self._lock_for(session_id):
            session = await self._repo.get(session_id)
            if session.state not in (
                SessionState.AWAITING_PLAYERS,
                SessionState.AI_PROCESSING,
            ):
                raise IllegalTransitionError("session is not accepting player input")
            # Defense-in-depth for issue #127: even if the kicked /
            # removed player's WebSocket close raced with an in-flight
            # ``submit_response`` (the close is fire-and-forget; the
            # submit was already on the wire), the role lookup here
            # rejects it before it lands in the transcript. The
            # ``expected_token_version`` covers the kick (revoke) path
            # — the role is still in ``session.roles`` post-revoke, so
            # the existence check alone would miss it; the version
            # match closes the gap. Callers that don't carry a token
            # version (scenario runner, test helpers) pass None and
            # only get the existence check.
            existing = session.role_by_id(role_id)
            if existing is None:
                raise IllegalTransitionError(
                    f"role no longer exists in session: {role_id}"
                )
            if (
                expected_token_version is not None
                and existing.token_version != expected_token_version
            ):
                raise IllegalTransitionError(
                    "token has been revoked; rejoin with the new join link"
                )
            turn = session.current_turn
            if turn is None:
                raise IllegalTransitionError("no current turn")
            during_ai_processing = session.state == SessionState.AI_PROCESSING
            # During AI_PROCESSING the quorum is already closed; every
            # submission is a sidebar comment regardless of active-set
            # membership. The decoupled-ready model relies on this so
            # composers stay usable across the state flip without
            # accidentally re-opening the gate.
            if during_ai_processing:
                is_turn_submission = False
            else:
                is_turn_submission = can_submit(turn, role_id)
            # Per-role per-turn cap, checked BEFORE
            # ``session.messages.append`` so a rejected submission never
            # lands in the transcript. Interjections are exempt (they
            # don't count toward the ready quorum and are gated by the
            # active-set / state check upstream, not the cap).
            if is_turn_submission:
                self._enforce_submission_cap(
                    session,
                    turn_id=turn.id,
                    role_id=role_id,
                    turn_index=turn.index,
                )
            self._enforce_dedupe_window(session, role_id=role_id, content=content)
            cleaned_mentions = list(mentions) if mentions else []
            # Wave 3 (issue #69): snapshot the pause flag at submit
            # time iff the player tagged ``@facilitator``. Persisted
            # so the transcript's "AI silenced — won't reply"
            # indicator survives reloads even after the creator
            # later resumes. We deliberately don't snapshot it for
            # non-facilitator messages — the indicator is meaningless
            # there.
            ai_paused_at_submit = bool(
                session.ai_paused
                and FACILITATOR_MENTION_TOKEN in cleaned_mentions
            )
            # Phase B chat-declutter (docs/plans/chat-decluttering.md
            # §4.4): inherit the most recent AI-addressed-to-me
            # workstream so a player's reply lands under the same
            # track filter as the prompt that drove it. ``None`` if
            # no such message exists (or the addressing AI message
            # was cross-cutting).
            inherited_workstream_id = _inherit_workstream_id(
                session, role_id=role_id
            )
            session.messages.append(
                Message(
                    kind=MessageKind.PLAYER,
                    role_id=role_id,
                    body=content,
                    turn_id=turn.id,
                    is_interjection=not is_turn_submission,
                    during_ai_processing=during_ai_processing,
                    mentions=cleaned_mentions,
                    ai_paused_at_submit=ai_paused_at_submit,
                    workstream_id=inherited_workstream_id,
                )
            )
            if is_turn_submission and role_id not in turn.submitted_role_ids:
                turn.submitted_role_ids.append(role_id)
            # Submissions never touch ``ready_role_ids`` — only
            # ``set_role_ready`` flips the ready quorum. Submissions
            # never advance the turn either. The composer stays
            # enabled during AI_PROCESSING so drafts don't get locked
            # when the quorum closes; those messages land as
            # ``during_ai_processing=True`` interjections.
            active_snapshot = list(turn.active_role_ids)
            ready_snapshot = list(turn.ready_role_ids)
            submitted_snapshot = list(turn.submitted_role_ids)
            await self._repo.save(session)
        self._emit(
            "response_submitted" if is_turn_submission else "interjection_submitted",
            session,
            role_id=role_id,
            content_preview=content[:120],
            interjection=not is_turn_submission,
            during_ai_processing=during_ai_processing,
            active_role_ids=active_snapshot,
            ready_role_ids=ready_snapshot,
            submitted_role_ids=submitted_snapshot,
        )
        await self._connections.broadcast(
            session.id,
            {
                "type": "message_complete",
                "role_id": role_id,
                "kind": "player",
                "body": content,
                "is_interjection": not is_turn_submission,
                # Surfaces "this landed while the AI was thinking" so
                # the transcript can render a side-comment indicator
                # and the AAR pipeline can distinguish "responded on
                # turn" from "side-noted while AI was processing".
                "during_ai_processing": during_ai_processing,
                # Phase B chat-declutter (plan §4.4 / §4.8): the
                # message we just appended carries the inherited
                # workstream — surface it on the broadcast so the
                # frontend's TranscriptFilters track pills and the
                # 3 px stripe stay consistent with the snapshot.
                "workstream_id": inherited_workstream_id,
                # Wave 2: cleaned by the submission pipeline; clients
                # render the @-highlight from this list rather than
                # regex-scanning the body.
                "mentions": cleaned_mentions,
                # Wave 3 (issue #69): snapshot of ``Session.ai_paused``
                # at submit time, scoped to facilitator-tagged
                # messages. The transcript renders an "AI silenced —
                # won't reply" indicator under the bubble when this
                # is True. Snapshotted at submit so toggling pause
                # later doesn't re-paint historical messages.
                "ai_paused_at_submit": ai_paused_at_submit,
            },
        )
        return False

    async def set_role_ready(
        self,
        *,
        session_id: str,
        actor_role_id: str,
        subject_role_id: str,
        ready: bool,
        client_seq: int,
    ) -> SetReadyOutcome:
        """Toggle a role's ready state on the current play turn.

        Authorization: ``actor_role_id == subject_role_id`` is the
        normal player-self-toggle. ``actor != subject`` is only
        permitted when the actor's role has ``is_creator=True``
        (creator-impersonation, mirroring ``proxy_submit_as``). The
        audit log records both ids distinctly so a future review
        can spot creator-impersonation paths.

        Rejections are returned (not raised) so the WS handler can
        relay the reason to the actor as a ``set_ready_rejected``
        frame and the optimistic UI can revert cleanly.
        """
        async with await self._lock_for(session_id):
            session = await self._repo.get(session_id)
            if session.state != SessionState.AWAITING_PLAYERS:
                return SetReadyOutcome(
                    accepted=False,
                    reason="turn_already_advanced"
                    if session.state == SessionState.AI_PROCESSING
                    else "not_awaiting_players",
                    ready_to_advance=False,
                    client_seq=client_seq,
                )
            turn = session.current_turn
            if turn is None:
                return SetReadyOutcome(
                    accepted=False,
                    reason="no_current_turn",
                    ready_to_advance=False,
                    client_seq=client_seq,
                )
            actor_role = session.role_by_id(actor_role_id)
            subject_role = session.role_by_id(subject_role_id)
            if actor_role is None or subject_role is None:
                return SetReadyOutcome(
                    accepted=False,
                    reason="role_not_found",
                    ready_to_advance=False,
                    client_seq=client_seq,
                )
            if (
                actor_role_id != subject_role_id
                and not actor_role.is_creator
            ):
                return SetReadyOutcome(
                    accepted=False,
                    reason="not_authorized",
                    ready_to_advance=False,
                    client_seq=client_seq,
                )
            if subject_role_id not in turn.active_role_ids:
                return SetReadyOutcome(
                    accepted=False,
                    reason="not_active_role",
                    ready_to_advance=False,
                    client_seq=client_seq,
                )
            # Idempotent re-mark: state already matches request.
            # Accept without touching the flip cap, debounce ledger,
            # audit log, or broadcast — the client just needs a clean
            # ack against its client_seq.
            already_ready = subject_role_id in turn.ready_role_ids
            if ready == already_ready:
                return SetReadyOutcome(
                    accepted=True,
                    reason=None,
                    ready_to_advance=groups_quorum_met(turn),
                    client_seq=client_seq,
                )
            # Flip cap (5 per role per turn).
            flip_count = turn.ready_flip_count_by_role.get(subject_role_id, 0)
            if flip_count >= READY_FLIP_CAP_PER_TURN:
                return SetReadyOutcome(
                    accepted=False,
                    reason="flip_cap_exceeded",
                    ready_to_advance=False,
                    client_seq=client_seq,
                )
            # Debounce: drop silently if the most recent accepted
            # toggle for this role landed within READY_DEBOUNCE_MS.
            now = datetime.now(UTC)
            last_ts = turn.last_ready_change_ts_by_role.get(subject_role_id)
            if (
                last_ts is not None
                and now - last_ts < timedelta(milliseconds=READY_DEBOUNCE_MS)
            ):
                return SetReadyOutcome(
                    accepted=True,
                    reason=None,
                    ready_to_advance=groups_quorum_met(turn),
                    client_seq=client_seq,
                )
            # Apply the toggle.
            walked_back = False
            if ready:
                turn.ready_role_ids.append(subject_role_id)
            else:
                turn.ready_role_ids.remove(subject_role_id)
                walked_back = True
            turn.ready_flip_count_by_role[subject_role_id] = flip_count + 1
            turn.last_ready_change_ts_by_role[subject_role_id] = now
            ready_to_advance = groups_quorum_met(turn)
            if ready_to_advance:
                turn.status = "processing"
                session.state = SessionState.AI_PROCESSING
            active_snapshot = list(turn.active_role_ids)
            ready_snapshot = list(turn.ready_role_ids)
            await self._repo.save(session)
        self._emit(
            "ready_changed",
            session,
            actor_role_id=actor_role_id,
            subject_role_id=subject_role_id,
            ready=ready,
            client_seq=client_seq,
            ready_role_ids=ready_snapshot,
            active_role_ids=active_snapshot,
            ready_to_advance=ready_to_advance,
        )
        if walked_back:
            # Dedicated audit kind so the creator's /activity panel
            # can surface "X walked back ready N times" — a griefing
            # detection signal the generic ``ready_changed`` line
            # buries in the high-volume toggle stream.
            self._emit(
                "ready_walk_back",
                session,
                actor_role_id=actor_role_id,
                subject_role_id=subject_role_id,
                ready_role_ids=ready_snapshot,
                active_role_ids=active_snapshot,
            )
        await self._connections.broadcast(
            session.id,
            {
                "type": "ready_changed",
                "subject_role_id": subject_role_id,
                "actor_role_id": actor_role_id,
                "ready": ready,
                "ready_role_ids": ready_snapshot,
                "client_seq": client_seq,
            },
        )
        if ready_to_advance:
            await self._broadcast_state(session)
        return SetReadyOutcome(
            accepted=True,
            reason=None,
            ready_to_advance=ready_to_advance,
            client_seq=client_seq,
        )

    async def force_advance(self, *, session_id: str, by_role_id: str) -> None:
        # Refuse force-advance while a play-tier LLM call is mid-stream.
        # Without this guard, every operator click spawned a fresh
        # ``run_play_turn`` that raced the still-streaming original —
        # the screenshot timeline in issue #63 (three "Force-advanced"
        # SYSTEM banners followed by the AI's actual reply seconds
        # later) is exactly that race. Non-play tiers (guardrail,
        # setup, AAR) are NOT blocked: an operator must always be able
        # to recover from a hung non-play call.
        #
        # The check runs *inside* the per-session lock so it's
        # synchronized with state transitions. A play-tier call can only
        # be started by code that holds the lock at some point (the WS
        # / REST handlers acquire it via ``submit_response`` or earlier
        # ``force_advance`` invocations before kicking ``run_play_turn``);
        # checking outside the lock would let one of those start a
        # second call between our check and the state mutation,
        # producing the very race we're guarding against.
        async with await self._lock_for(session_id):
            session = await self._repo.get(session_id)
            # Creator-only gate (issue #215). Mirrors the equivalent
            # check in ``end_session`` so the wire contract matches the
            # UI contract: PR #214 removed the player-facing button, so
            # any non-creator caller is either a buggy client or a
            # probe and we surface it in the audit log.
            if session.creator_role_id != by_role_id:
                _logger.warning(
                    "force_advance_unauthorized",
                    session_id=session_id,
                    by_role_id=by_role_id,
                    creator_role_id=session.creator_role_id,
                )
                raise AuthorizationError(
                    "only the creator can force-advance the session"
                )
            in_flight = self._llm.in_flight_for(session_id)
            if any(c.tier == "play" for c in in_flight):
                _logger.info(
                    "force_advance_rejected_in_flight",
                    session_id=session_id,
                    by_role_id=by_role_id,
                    in_flight_tiers=[c.tier for c in in_flight],
                )
                raise IllegalTransitionError(
                    "AI is still processing — wait a few seconds before forcing advance"
                )
            turn = session.current_turn
            if turn is None:
                raise IllegalTransitionError("nothing to force-advance")

            # Recovery path: the AI errored without yielding (state still
            # AI_PROCESSING). Skip the dead turn and open a new awaiting
            # turn for all player roles so humans can drive the next beat.
            if turn.status == "errored":
                turn.status = "complete"
                turn.ended_at = datetime.now(UTC)
                player_role_ids = [r.id for r in session.roles if r.kind == "player"]
                new_turn = Turn(
                    index=len(session.turns),
                    active_role_groups=groups_from_flat(player_role_ids),
                    status="awaiting",
                )
                session.turns.append(new_turn)
                session.state = SessionState.AWAITING_PLAYERS
                session.messages.append(
                    Message(
                        kind=MessageKind.SYSTEM,
                        body=(
                            f"Force-advanced by {by_role_id}; AI failed to "
                            "yield, players continue"
                        ),
                        turn_id=new_turn.id,
                    )
                )
                await self._repo.save(session)
                await self.connections().broadcast(
                    session.id,
                    {
                        "type": "turn_changed",
                        "turn_index": new_turn.index,
                        "active_role_ids": new_turn.active_role_ids,
                        # Issue #168: send the groups shape too.
                        "active_role_groups": new_turn.active_role_groups,
                        # Issue #111: fresh turn → reset progress
                        # fraction (computed from active/submitted on
                        # the new turn).
                        "progress_pct": compute_progress_pct(session),
                    },
                )
                self._emit("force_advance", session, by=by_role_id, recovered_from="errored")
                await self._broadcast_state(session)
                return

            if session.state != SessionState.AWAITING_PLAYERS:
                raise IllegalTransitionError("nothing to force-advance")
            turn.status = "processing"
            session.state = SessionState.AI_PROCESSING
            session.messages.append(
                Message(
                    kind=MessageKind.SYSTEM,
                    body=f"Force-advanced by {by_role_id}; missing voices skipped",
                    turn_id=turn.id,
                )
            )
            await self._repo.save(session)
        self._emit("force_advance", session, by=by_role_id)
        await self._broadcast_state(session)

    async def proxy_submit_as(
        self,
        *,
        session_id: str,
        by_role_id: str,
        as_role_id: str,
        content: str,
        mentions: list[str] | None = None,
    ) -> None:
        """Solo-test impersonation: submit ``content`` on behalf of
        ``as_role_id`` (creator-only at the route layer).

        Distinct from ``submit_response`` because the WS / route layer
        only allows a participant to submit for their *own* role; this
        helper is the explicit creator escape hatch for one-tester multi-
        seat exercises.

        Submissions never advance the turn — use ``set_role_ready`` for
        that. To proxy-mark a role ready (creator filling in for an
        absent player), call ``set_role_ready`` with
        ``actor_role_id=<creator>`` and
        ``subject_role_id=<as_role_id>``. Allowed during
        ``AWAITING_PLAYERS`` (counts as a turn submission if the proxied
        role is active) AND ``AI_PROCESSING`` (interjection on the
        current turn). Mirrors ``submit_response``.
        """

        async with await self._lock_for(session_id):
            session = await self._repo.get(session_id)
            if session.state not in (
                SessionState.AWAITING_PLAYERS,
                SessionState.AI_PROCESSING,
            ):
                raise IllegalTransitionError("session is not accepting player input")
            turn = session.current_turn
            if turn is None:
                raise IllegalTransitionError("no current turn")
            # Validate ``as_role_id`` resolves to an actual seated player
            # role on this session. Pre-fix the relaxed gate (issue #78
            # + Copilot review) let a creator post messages on behalf of
            # arbitrary role_ids — including ones that don't exist or
            # are tagged spectator — which would have left orphaned
            # transcript entries the UI can't render properly and let
            # the proxy path side-step the spectator-cannot-submit gate
            # the WS layer enforces for real participants.
            target_role = session.role_by_id(as_role_id)
            if target_role is None:
                raise IllegalTransitionError(
                    f"role {as_role_id!r} is not seated on this session"
                )
            if target_role.kind != "player":
                raise IllegalTransitionError(
                    f"role {as_role_id!r} is not a player role; cannot proxy-submit"
                )
            during_ai_processing = session.state == SessionState.AI_PROCESSING
            if during_ai_processing:
                is_turn_submission = False
            else:
                is_turn_submission = can_submit(turn, as_role_id)
            # Mirror the ``submit_response`` per-role cap so the solo-
            # test escape hatch can't bypass the flood backstop. The cap
            # applies uniformly across all submission paths.
            if is_turn_submission:
                self._enforce_submission_cap(
                    session,
                    turn_id=turn.id,
                    role_id=as_role_id,
                    turn_index=turn.index,
                )
            # Apply the same dedupe scan ``submit_response`` runs.
            # Pre-issue-#78 the proxy path skipped this guard; once
            # proxy_submit_as became the documented out-of-turn
            # interjection path, the asymmetry let a creator hammer the
            # endpoint with identical bodies without backstop.
            self._enforce_dedupe_window(
                session, role_id=as_role_id, content=content
            )
            cleaned_proxy_mentions = list(mentions) if mentions else []
            # Wave 3 (issue #69): mirror ``submit_response``. When the
            # creator proxy-submits a ``@facilitator``-tagged message
            # while paused, the transcript needs the same silenced
            # indicator so a creator running solo-test against a
            # paused session sees the consistent UI.
            proxy_ai_paused_at_submit = bool(
                session.ai_paused
                and FACILITATOR_MENTION_TOKEN in cleaned_proxy_mentions
            )
            # Phase B chat-declutter (plan §4.4): proxy path inherits
            # the workstream the same way the regular submit path does
            # — symmetry matters because creators using proxy_respond
            # for solo-test runs would otherwise see their proxy
            # messages permanently in #main.
            inherited_workstream_id = _inherit_workstream_id(
                session, role_id=as_role_id
            )
            session.messages.append(
                Message(
                    kind=MessageKind.PLAYER,
                    role_id=as_role_id,
                    body=content,
                    turn_id=turn.id,
                    is_interjection=not is_turn_submission,
                    during_ai_processing=during_ai_processing,
                    mentions=cleaned_proxy_mentions,
                    ai_paused_at_submit=proxy_ai_paused_at_submit,
                    workstream_id=inherited_workstream_id,
                )
            )
            if is_turn_submission and as_role_id not in turn.submitted_role_ids:
                turn.submitted_role_ids.append(as_role_id)
            # Submissions never touch ``ready_role_ids`` or advance —
            # only ``set_role_ready`` flips the quorum. To proxy-mark a
            # role ready (creator filling in for an absent player), the
            # caller fires ``set_role_ready`` with
            # ``actor_role_id=<creator>`` and
            # ``subject_role_id=<as_role_id>``.
            active_snapshot = list(turn.active_role_ids)
            ready_snapshot = list(turn.ready_role_ids)
            submitted_snapshot = list(turn.submitted_role_ids)
            await self._repo.save(session)
        await self.connections().broadcast(
            session_id,
            {
                "type": "message_complete",
                "role_id": as_role_id,
                "kind": "player",
                "body": content,
                "is_interjection": not is_turn_submission,
                "during_ai_processing": during_ai_processing,
                "workstream_id": inherited_workstream_id,
                "mentions": cleaned_proxy_mentions,
                "ai_paused_at_submit": proxy_ai_paused_at_submit,
            },
        )
        self._emit(
            "proxy_submit_as",
            session,
            by=by_role_id,
            as_role=as_role_id,
            content_preview=content[:120],
            interjection=not is_turn_submission,
            during_ai_processing=during_ai_processing,
            active_role_ids=active_snapshot,
            ready_role_ids=ready_snapshot,
            submitted_role_ids=submitted_snapshot,
        )
        return None

    async def proxy_submit_pending(
        self, *, session_id: str, by_role_id: str, content: str
    ) -> int:
        """Solo-test helper: submit ``content`` on behalf of every active role
        that hasn't responded yet, except the operator's own role. Returns
        the number of seats filled.

        Creator-only at the route layer. Designed for one-person dev
        testing where the operator can't realistically open multiple
        browser tabs to play every seat.
        """

        filled: list[str] = []
        async with await self._lock_for(session_id):
            session = await self._repo.get(session_id)
            if session.state != SessionState.AWAITING_PLAYERS:
                raise IllegalTransitionError("session is not awaiting player input")
            turn = session.current_turn
            if turn is None:
                raise IllegalTransitionError("no current turn")
            pending = [
                rid
                for rid in turn.active_role_ids
                if rid != by_role_id and rid not in turn.submitted_role_ids
            ]
            for rid in pending:
                # Wave 1 (issue #134) security review (Copilot follow-up):
                # mirror the per-role cap on the bulk-fill path too.
                # ``proxy_submit_pending`` only fires once for any
                # given role per call (the ``pending`` list filters on
                # ``not in turn.submitted_role_ids``), so under normal
                # use the cap is moot — but a script repeatedly hitting
                # this endpoint after a force-advance reset could
                # otherwise sneak past the backstop. The cap applies
                # uniformly across all three submission paths.
                self._enforce_submission_cap(
                    session,
                    turn_id=turn.id,
                    role_id=rid,
                    turn_index=turn.index,
                )
                turn.submitted_role_ids.append(rid)
                # proxy_submit_pending is the creator's "advance now,
                # fill in stub responses for everyone else" escape
                # hatch. Auto-mark each filled seat as ready so the
                # ready-quorum gate flips and the turn actually
                # advances — leaving them in ``submitted_role_ids``
                # only would block forever. Bypass the per-role flip
                # cap and debounce here: this is a single creator
                # action, not user-driven flapping.
                if rid not in turn.ready_role_ids:
                    turn.ready_role_ids.append(rid)
                # Phase B chat-declutter (plan §4.4): each filled
                # seat inherits the workstream of the most recent AI
                # message addressing that role. The fill is N
                # independent inheritances, not N copies of the same
                # value — different roles may have been addressed by
                # different workstream-tagged AI messages.
                inherited = _inherit_workstream_id(session, role_id=rid)
                session.messages.append(
                    Message(
                        kind=MessageKind.PLAYER,
                        role_id=rid,
                        body=content,
                        turn_id=turn.id,
                        workstream_id=inherited,
                    )
                )
                filled.append(rid)
            ready_to_advance = groups_quorum_met(turn)
            if ready_to_advance:
                turn.status = "processing"
                session.state = SessionState.AI_PROCESSING
            await self._repo.save(session)
        for rid in filled:
            # Re-resolve the inheritance against the persisted state
            # so the broadcast carries the same value the persisted
            # message did (no race between append and broadcast).
            broadcast_msg = next(
                (
                    m
                    for m in reversed(session.messages)
                    if m.kind == MessageKind.PLAYER
                    and m.role_id == rid
                    and m.body == content
                ),
                None,
            )
            inherited_for_rid = (
                broadcast_msg.workstream_id if broadcast_msg else None
            )
            await self.connections().broadcast(
                session_id,
                {
                    "type": "message_complete",
                    "role_id": rid,
                    "kind": "player",
                    "body": content,
                    "during_ai_processing": False,
                    # Phase B chat-declutter (plan §4.4): inherited
                    # from the persisted message above.
                    "workstream_id": inherited_for_rid,
                    "mentions": [],
                },
            )
        self._emit(
            "proxy_submit",
            session,
            by=by_role_id,
            filled=filled,
        )
        if ready_to_advance:
            await self._broadcast_state(session)
        return len(filled)

    async def abort_current_turn(
        self, *, session_id: str, by_role_id: str, reason: str = "operator aborted"
    ) -> None:
        """God-mode escape hatch: mark the current turn errored so it stops
        looking "live" in the UI. The operator can then force-advance (which
        recovers from errored turns) to keep the session moving.

        Does **not** kill any in-flight Anthropic stream — that would require
        owning the request future. The stream will finish or error on its
        own; meanwhile the session is no longer waiting on it.
        """

        async with await self._lock_for(session_id):
            session = await self._repo.get(session_id)
            turn = session.current_turn
            if turn is None:
                raise IllegalTransitionError("no current turn to abort")
            if turn.status in ("complete", "errored"):
                raise IllegalTransitionError(
                    f"current turn is already {turn.status}"
                )
            turn.status = "errored"
            turn.error_reason = reason
            session.messages.append(
                Message(
                    kind=MessageKind.SYSTEM,
                    body=f"Turn aborted by {by_role_id}: {reason}",
                    turn_id=turn.id,
                )
            )
            await self._repo.save(session)
        self._emit("turn_aborted", session, by=by_role_id, reason=reason)
        await self.connections().broadcast(
            session_id,
            {
                "type": "error",
                "scope": "turn",
                "message": "AI turn aborted by operator. Use force-advance to continue.",
                "turn_index": turn.index,
            },
        )
        await self._broadcast_state(session)

    # Notepad lock-pending countdown (issue #98). The plan promised
    # players a 10-second window after the creator clicks End to save
    # their last thought before the notepad becomes read-only. We can't
    # delay the session state transition itself (creator expects the
    # session to end *now*) so we run the lock as a small background
    # task: emit the lock_pending event immediately, sleep, lock, emit
    # locked. AAR generation begins while the window is open and reads
    # whichever snapshot the players have pushed by lock time.
    NOTEPAD_LOCK_PENDING_SECONDS: float = 10.0

    async def _lock_notepad_after_delay(
        self, session_id: str, *, delay: float
    ) -> None:
        try:
            if delay > 0:
                await asyncio.sleep(delay)
            async with await self._lock_for(session_id):
                session = await self._repo.get(session_id)
                if session.notepad.locked:
                    return
                self._notepad.lock(session)
                await self._repo.save(session)
            self._emit("notepad_locked", session)
            await self._connections.broadcast(
                session_id,
                {
                    "type": "notepad_locked",
                    "locked_at": session.notepad.locked_at.isoformat()
                    if session.notepad.locked_at
                    else None,
                },
                record=True,
            )
        except Exception as exc:
            _logger.exception(
                "notepad_lock_after_delay_failed",
                session_id=session_id,
                error=str(exc),
            )

    async def end_session(
        self,
        *,
        session_id: str,
        by_role_id: str,
        reason: str = "ended",
        notepad_lock_pending_seconds: float | None = None,
    ) -> Session:
        delay = (
            self.NOTEPAD_LOCK_PENDING_SECONDS
            if notepad_lock_pending_seconds is None
            else max(0.0, notepad_lock_pending_seconds)
        )
        async with await self._lock_for(session_id):
            session = await self._repo.get(session_id)
            # Creator-only gate (issue #81). The AI-tool end path bypasses
            # this method (see turn_driver.py around the
            # ``end_session_reason`` branch), so this guard only constrains
            # creator/participant-initiated ends. Both REST
            # (POST /sessions/{id}/end) and WS (request_end_session) call
            # sites already catch IllegalTransitionError and surface it.
            if session.creator_role_id != by_role_id:
                # Log before raising — a misbehaving client repeatedly
                # hitting /end is a security-relevant signal and the
                # exception path alone leaves no operator-visible trail.
                _logger.warning(
                    "end_session_rejected",
                    session_id=session_id,
                    by_role_id=by_role_id,
                    creator_role_id=session.creator_role_id,
                )
                raise IllegalTransitionError(
                    "only the creator can end the session"
                )
            if session.state == SessionState.ENDED:
                return session  # idempotent
            assert_transition(session.state, SessionState.ENDED)
            session.state = SessionState.ENDED
            from datetime import datetime

            session.ended_at = datetime.now(UTC)
            session.messages.append(
                Message(
                    kind=MessageKind.SYSTEM,
                    body=f"Session ended by {by_role_id}: {reason}",
                )
            )
            session.aar_status = "pending"
            await self._repo.save(session)
        self._emit("session_ended", session, by=by_role_id, reason=reason)
        await self._broadcast_state(session)
        # Issue #98: announce the lock-pending countdown immediately
        # so clients can show the "session ending — N seconds" banner.
        # The notepad stays writable for ``delay`` seconds so players
        # can save a last thought, then a background task locks it.
        # When ``delay`` is 0 (test path) the lock fires synchronously
        # before AAR generation starts.
        await self._connections.broadcast(
            session_id,
            {
                "type": "notepad_lock_pending",
                "locks_in_seconds": int(delay),
            },
            record=False,
        )
        if delay <= 0:
            await self._lock_notepad_after_delay(session_id, delay=0)
        else:
            task = asyncio.create_task(
                self._lock_notepad_after_delay(session_id, delay=delay)
            )
            self._bg_tasks.add(task)
            task.add_done_callback(self._bg_tasks.discard)
        await self.trigger_aar_generation(session_id)
        return session

    async def trigger_aar_generation(self, session_id: str) -> None:
        """Kick AAR generation. Called by ``end_session`` and by the turn
        driver when the AI ends the session via the ``end_session`` tool.

        AAR runs in the background in production. With ``AAR_INLINE_ON_END``
        we run it inline because Starlette TestClient doesn't reliably
        progress cross-request tasks.
        """

        if self._settings.aar_inline_on_end:
            await self._generate_aar_bg(session_id)
        else:
            self._spawn_bg(self._generate_aar_bg(session_id))

    def _spawn_bg(self, coro: Any) -> None:
        task = asyncio.create_task(coro)
        self._bg_tasks.add(task)
        task.add_done_callback(self._bg_tasks.discard)

    async def _generate_aar_bg(self, session_id: str) -> None:
        from ..llm.export import AARGenerator

        async with await self._lock_for(session_id):
            try:
                session = await self._repo.get(session_id)
            except Exception as exc:
                _logger.warning(
                    "aar_generation_aborted_repo_get_failed",
                    session_id=session_id,
                    stage="initial_load",
                    error=str(exc),
                )
                return
            if session.aar_status not in ("pending", "failed"):
                return
            session.aar_status = "generating"
            await self._repo.save(session)
            target = session
        await self._connections.broadcast(
            session_id, {"type": "aar_status_changed", "status": "generating"}
        )
        # Labeled AI-status breadcrumb so the operator's UI shows
        # "AI — Drafting the after-action report" during the 30 s+
        # generation. Without this the UI only had ``aar_status_changed``
        # WS events, which connected clients see but reload-the-tab
        # users miss until their snapshot polls. Issue #63 audit gap #7.
        await self._broadcast_ai_status(session_id, phase="aar")
        _logger.info("aar_generation_start", session_id=session_id)

        try:
            generator = AARGenerator(llm=self._llm, audit=self._audit)
            markdown, report = await generator.generate(target)
        except Exception as exc:
            _logger.exception("aar_generation_failed", session_id=session_id, error=str(exc))
            async with await self._lock_for(session_id):
                try:
                    session = await self._repo.get(session_id)
                except Exception as repo_exc:
                    _logger.warning(
                        "aar_failure_persist_aborted_repo_get_failed",
                        session_id=session_id,
                        original_error=str(exc),
                        repo_error=str(repo_exc),
                    )
                    return
                session.aar_status = "failed"
                session.aar_error = str(exc)[:500]
                await self._repo.save(session)
            # Audit-log emission so the failure shows up in God Mode + the
            # JSONL audit dump alongside the WS-only ``aar_status_changed``
            # event. PM review flagged the gap.
            self._emit("aar_failed", session, error=str(exc)[:500])
            await self._connections.broadcast(
                session_id, {"type": "aar_status_changed", "status": "failed"}
            )
            await self._broadcast_ai_status(session_id, phase=None)
            return

        async with await self._lock_for(session_id):
            try:
                session = await self._repo.get(session_id)
            except Exception as exc:
                _logger.warning(
                    "aar_save_aborted_repo_get_failed",
                    session_id=session_id,
                    stage="ready_persist",
                    error=str(exc),
                )
                return
            session.aar_markdown = markdown
            session.aar_report = report
            session.aar_status = "ready"
            session.aar_error = None
            await self._repo.save(session)
        await self._connections.broadcast(
            session_id, {"type": "aar_status_changed", "status": "ready"}
        )
        await self._broadcast_ai_status(session_id, phase=None)
        _logger.info(
            "aar_generation_complete", session_id=session_id, length=len(markdown)
        )

    async def _broadcast_ai_status(
        self, session_id: str, *, phase: str | None
    ) -> None:
        """Manager-side helper for emitting the labeled ``ai_status``
        breadcrumb. Symmetric with ``TurnDriver._emit_ai_status`` —
        both broadcast to ``record=False`` so the events don't clog
        the replay buffer. Wrapped because a misbehaving WS handler
        must not abort the AAR pipeline.
        """

        try:
            await self._connections.broadcast(
                session_id,
                {
                    "type": "ai_status",
                    "phase": phase,
                    "attempt": None,
                    "budget": None,
                    "recovery": None,
                    "turn_index": None,
                    "for_role_id": None,
                },
                record=False,
            )
        except Exception as exc:
            _logger.warning(
                "ai_status_broadcast_failed",
                session_id=session_id,
                phase=phase,
                error=str(exc),
            )

    # ---------------------------------------------------- messaging helpers
    async def append_ai_message(
        self,
        *,
        session_id: str,
        body: str,
        turn_id: str,
        kind: MessageKind = MessageKind.AI_TEXT,
        tool_name: str | None = None,
        tool_args: dict[str, Any] | None = None,
    ) -> Message:
        async with await self._lock_for(session_id):
            session = await self._repo.get(session_id)
            msg = Message(
                kind=kind,
                body=body,
                turn_id=turn_id,
                tool_name=tool_name,
                tool_args=tool_args,
            )
            session.messages.append(msg)
            await self._repo.save(session)
        return msg

    async def append_recorded_message(
        self,
        *,
        session_id: str,
        kind: MessageKind,
        body: str,
        tool_name: str | None,
        tool_args: dict[str, Any] | None,
        role_id: str | None,
        is_interjection: bool,
        visibility: list[str] | Literal["all"],
        workstream_id: str | None = None,
        mentions: list[str] | None = None,
    ) -> Message:
        """Boundary for the dev-tools deterministic replay path.

        This is the ONE place a scenario JSON's ``ai_messages`` lands
        in ``session.messages`` — it intentionally does NOT call
        ``run_play_turn`` / ``submit_response`` (those are for live
        engine flow), so we own the validation here:

          * ``kind`` is restricted to ``ai_text`` / ``ai_tool_call`` /
            ``ai_tool_result`` / ``system`` / ``critical_inject``.
            ``player`` is forbidden — replayed player content goes
            through ``submit_response`` so the input-side guardrail
            sees it.
          * ``body`` is capped at the same
            ``max_participant_submission_chars`` participant text
            uses; truncated bodies get an explicit marker.
          * Broadcasts go through ``connections.broadcast`` so
            connected dev tabs see ``message_complete`` events.
          * Audit emission happens here so the replay path is
            distinguishable in the audit log
            (``recorded_message_injected``).

        Returns the persisted ``Message``.
        """

        from .models import MessageKind as _MK

        forbidden = {_MK.PLAYER}
        if kind in forbidden:
            raise ValueError(
                f"append_recorded_message refuses kind={kind.value!r} — "
                "replayed player content must go through submit_response"
            )
        # Body cap aligned with the scenario schema's
        # ``RecordedMessage.body`` Field(max_length=64_000), NOT the
        # player-submission cap. AI/system bodies in real sessions
        # routinely run multi-KB (broadcast tool outputs, share_data
        # blobs); using ``max_participant_submission_chars`` here
        # would silently truncate them mid-replay and break
        # deterministic-fidelity guarantees. The 64KB ceiling still
        # protects against pathological scenario files (e.g. a
        # corrupted JSON with a megabyte body).
        _RECORDED_BODY_CAP = 64_000
        if len(body) > _RECORDED_BODY_CAP:
            body = body[:_RECORDED_BODY_CAP] + "\n[recorded body truncated by replay]"
        async with await self._lock_for(session_id):
            session = await self._repo.get(session_id)
            turn = session.current_turn
            turn_id = turn.id if turn is not None else None
            # Chat-declutter polish: persist the recorded
            # ``workstream_id`` + ``mentions`` directly on the Message so
            # the replay UI sees the colored stripes + ``@-highlight``
            # chrome the real session rendered. The dispatcher writes
            # these fields on live tool_use; the recorder captures
            # them; the replay path must apply them.
            ws_target: str | None = None
            if workstream_id is not None and session.plan is not None:
                declared = {ws.id for ws in session.plan.workstreams}
                if workstream_id in declared:
                    ws_target = workstream_id
                # Silently drop an undeclared workstream — defensive
                # against a scenario file that names a workstream the
                # default plan doesn't seed (skip-setup path) or that
                # changed between record and replay.
            msg = Message(
                kind=kind,
                body=body,
                tool_name=tool_name,
                tool_args=tool_args,
                role_id=role_id,
                is_interjection=is_interjection,
                visibility=visibility,
                turn_id=turn_id,
                workstream_id=ws_target,
                mentions=list(mentions or []),
            )
            session.messages.append(msg)
            await self._repo.save(session)
        # WS frame shape mirrors the engine path's ``message_complete``
        # contract — ``turn_id`` + ``tool_args`` included so a watching
        # tab's handler can't tell a replayed message apart from an
        # engine-emitted one (which is the whole point of fidelity).
        await self._connections.broadcast(
            session_id,
            {
                "type": "message_complete",
                "kind": kind.value,
                "body": body,
                "tool_name": tool_name,
                "tool_args": tool_args,
                "role_id": role_id,
                "is_interjection": is_interjection,
                "turn_id": turn_id,
                # Phase A chat-declutter (plan §4.8). Recorded scenarios
                # don't carry workstream metadata in Phase A — replays
                # surface ``None`` / ``[]`` so live clients see the
                # same shape as live sessions.
                "workstream_id": msg.workstream_id,
                "mentions": list(msg.mentions),
            },
        )
        self._emit(
            "recorded_message_injected",
            session,
            message_kind=kind.value,
            tool_name=tool_name,
            body_preview=body[:120],
            role_id=role_id,
        )
        return msg

    async def record_critical_inject(self, *, session_id: str) -> bool:
        async with await self._lock_for(session_id):
            session = await self._repo.get(session_id)
            if not critical_inject_allowed(
                session, max_per_5_turns=self._settings.max_critical_injects_per_5_turns
            ):
                return False
            record_critical_inject(session)
            await self._repo.save(session)
            return True

    async def add_cost(
        self,
        *,
        session_id: str,
        usage: dict[str, int],
        estimated_usd: float,
    ) -> None:
        async with await self._lock_for(session_id):
            session = await self._repo.get(session_id)
            session.cost.input_tokens += usage.get("input", 0)
            session.cost.output_tokens += usage.get("output", 0)
            session.cost.cache_read_tokens += usage.get("cache_read", 0)
            session.cost.cache_creation_tokens += usage.get("cache_creation", 0)
            session.cost.estimated_usd += estimated_usd
            creator_id = session.creator_role_id
            cost_snapshot = session.cost.model_dump()
        if creator_id:
            await self._connections.send_to_role(
                session_id,
                creator_id,
                {
                    "type": "cost_updated",
                    "cost": cost_snapshot,
                    "max_turns": self._settings.max_turns_per_session,
                },
            )

    # ------------------------------------------------- AI turn loop helpers
    def llm(self) -> ChatClient:
        return self._llm

    def settings(self) -> Settings:
        return self._settings

    def dispatcher(self) -> ToolDispatcher:
        return self._dispatcher

    def guardrail(self) -> InputGuardrail:
        return self._guardrail

    def registry(self) -> FrozenRegistry:
        return self._registry

    def audit(self) -> AuditLog:
        return self._audit

    def connections(self) -> ConnectionManager:
        return self._connections

    def notepad(self) -> Any:
        """Access the per-process :class:`NotepadService` (issue #98)."""
        return self._notepad

    async def with_lock(self, session_id: str) -> asyncio.Lock:
        return await self._lock_for(session_id)

    async def emit(self, kind: str, session: Session, **payload: Any) -> None:
        self._emit(kind, session, **payload)

    async def flush_background_tasks(self) -> None:
        """Test helper: wait for in-flight background tasks (notably the AAR
        generator) to finish. Production code should never call this."""

        if self._bg_tasks:
            await asyncio.gather(*self._bg_tasks, return_exceptions=True)

    # --------------------------------------------------------------- shutdown
    async def shutdown(self) -> None:
        self._closed = True
        for task in list(self._bg_tasks):
            task.cancel()
        if self._bg_tasks:
            await asyncio.gather(*self._bg_tasks, return_exceptions=True)
        self._bg_tasks.clear()


__all__ = ["ParticipantKindLiteral", "SessionManager"]
