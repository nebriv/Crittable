"""Session orchestrator.

The :class:`SessionManager` is the only writer of session state. It owns a
per-session ``asyncio.Lock`` (no global lock); it persists via the
:class:`~.repository.SessionRepository`; and it's the bridge between the
transport layer (REST / WS), the LLM layer, and the audit log.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterable
from datetime import UTC
from typing import TYPE_CHECKING, Any

from ..auth.audit import AuditEvent, AuditLog
from ..auth.authn import HMACAuthenticator
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
    SessionState,
    SetupNote,
    Turn,
)
from .repository import SessionRepository
from .turn_engine import (
    IllegalTransitionError,
    all_submitted,
    assert_plan_edit_field,
    assert_transition,
    can_submit,
    critical_inject_allowed,
    record_critical_inject,
)

if TYPE_CHECKING:
    from ..llm.client import LLMClient
    from ..llm.dispatch import ToolDispatcher
    from ..llm.guardrail import InputGuardrail
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


class SessionManager:
    def __init__(
        self,
        *,
        settings: Settings,
        repository: SessionRepository,
        connections: ConnectionManager,
        audit: AuditLog,
        llm: LLMClient,
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

    # ------------------------------------------------------------------ utils
    async def _lock_for(self, session_id: str) -> asyncio.Lock:
        async with self._lock_meta:
            lock = self._locks.get(session_id)
            if lock is None:
                lock = asyncio.Lock()
                self._locks[session_id] = lock
            return lock

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
                if k != "event" and not _is_oversized(v)
            },
        )

    async def _broadcast_state(self, session: Session) -> None:
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
            },
        )

    # ----------------------------------------------------- session lifecycle
    async def create_session(
        self,
        *,
        scenario_prompt: str,
        creator_label: str,
        creator_display_name: str,
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
        )
        self._emit("session_created", session, scenario_prompt=session.scenario_prompt)
        return session, token

    async def add_role(
        self,
        *,
        session_id: str,
        label: str,
        display_name: str | None = None,
        kind: ParticipantKindLiteral = "player",
    ) -> tuple[Role, str]:
        async with await self._lock_for(session_id):
            session = await self._repo.get(session_id)
            if session.state in (SessionState.ENDED,):
                raise IllegalTransitionError("cannot add roles to an ENDED session")
            if len(session.roles) >= self._settings.max_roles_per_session:
                raise IllegalTransitionError(
                    f"max roles reached: {self._settings.max_roles_per_session}"
                )
            role = Role(label=label, display_name=display_name, kind=kind)
            session.roles.append(role)
            await self._repo.save(session)

        token = self._authn.mint(
            session_id=session_id,
            role_id=role.id,
            kind="player" if kind == "player" else "spectator",
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
                active_role_ids=list(active_role_ids),
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
            },
        )
        self._emit(
            "turn_opened", session, turn_index=turn.index, active=turn.active_role_ids
        )
        return turn

    async def submit_response(
        self, *, session_id: str, role_id: str, content: str
    ) -> bool:
        """Record a player's submission. Returns True if the turn is now complete."""

        async with await self._lock_for(session_id):
            session = await self._repo.get(session_id)
            if session.state != SessionState.AWAITING_PLAYERS:
                raise IllegalTransitionError("session is not awaiting player input")
            turn = session.current_turn
            if turn is None:
                raise IllegalTransitionError("no current turn")
            if not can_submit(turn, role_id):
                raise IllegalTransitionError("role cannot submit on this turn")
            turn.submitted_role_ids.append(role_id)
            session.messages.append(
                Message(
                    kind=MessageKind.PLAYER,
                    role_id=role_id,
                    body=content,
                    turn_id=turn.id,
                )
            )
            ready_to_advance = all_submitted(turn)
            if ready_to_advance:
                turn.status = "processing"
                session.state = SessionState.AI_PROCESSING
            await self._repo.save(session)
        self._emit(
            "response_submitted",
            session,
            role_id=role_id,
            content_preview=content[:120],
            ready_to_advance=ready_to_advance,
        )
        await self._connections.broadcast(
            session.id,
            {
                "type": "message_complete",
                "role_id": role_id,
                "kind": "player",
                "body": content,
            },
        )
        if ready_to_advance:
            await self._broadcast_state(session)
        return ready_to_advance

    async def force_advance(self, *, session_id: str, by_role_id: str) -> None:
        async with await self._lock_for(session_id):
            session = await self._repo.get(session_id)
            turn = session.current_turn
            if turn is None or session.state != SessionState.AWAITING_PLAYERS:
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

    async def end_session(
        self, *, session_id: str, by_role_id: str, reason: str = "ended"
    ) -> Session:
        async with await self._lock_for(session_id):
            session = await self._repo.get(session_id)
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
            await self._repo.save(session)
        self._emit("session_ended", session, by=by_role_id, reason=reason)
        await self._broadcast_state(session)
        return session

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
    def llm(self) -> LLMClient:
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

    async def with_lock(self, session_id: str) -> asyncio.Lock:
        return await self._lock_for(session_id)

    async def append_setup_dialogue(
        self, *, session_id: str, speaker: str, content: str
    ) -> None:
        await self.append_setup_message(
            session_id=session_id, speaker=speaker, content=content
        )

    async def emit(self, kind: str, session: Session, **payload: Any) -> None:
        self._emit(kind, session, **payload)

    # --------------------------------------------------------------- shutdown
    async def shutdown(self) -> None:
        self._closed = True


__all__ = ["ParticipantKindLiteral", "SessionManager"]
