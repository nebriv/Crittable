"""Tool-call dispatcher for the play and setup tiers.

Receives Claude's `tool_use` blocks (already JSON-validated by Anthropic),
routes them to the right side-effect, and synthesises `tool_result` content
that the next API call replays back to the model.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from pydantic import ValidationError

from ..auth.audit import AuditEvent, AuditLog
from ..extensions.dispatch import ExtensionDispatcher, ExtensionDispatchError
from ..extensions.registry import FrozenRegistry
from ..logging_setup import get_logger
from ..sessions.models import (
    Message,
    MessageKind,
    ScenarioBeat,
    ScenarioInject,
    ScenarioPlan,
    Session,
    SessionState,
    SetupNote,
    Workstream,
)
from ..sessions.slots import Slot, slot_for

if TYPE_CHECKING:
    from ..ws.connection_manager import ConnectionManager

_logger = get_logger("llm.dispatch")


# Issue #151 fix A — the set of play-tier tool names that satisfy the
# Critical-inject chain pairing requirement. Mirrors ``Slot.DRIVE`` in
# ``sessions/slots.py`` (broadcast / address_role / share_data /
# pose_choice). Lifted here as a frozenset so the dispatch-time scan
# avoids importing the slot map (the slot map already imports nothing
# heavy, but keeping the dispatcher's public surface narrow makes the
# pairing rule self-contained and greppable).
_DRIVE_TOOL_NAMES: frozenset[str] = frozenset(
    {"broadcast", "address_role", "share_data", "pose_choice"}
)


class DispatchOutcome:
    """Aggregates side-effect descriptors so the SessionManager can react."""

    def __init__(self) -> None:
        self.tool_results: list[dict[str, Any]] = []
        self.appended_messages: list[Message] = []
        self.set_active_role_ids: list[str] | None = None
        self.end_session_reason: str | None = None
        self.proposed_plan: ScenarioPlan | None = None
        self.finalized_plan: ScenarioPlan | None = None
        # Phase A chat-declutter (docs/plans/chat-decluttering.md §4.2):
        # workstreams declared in this dispatch batch. The setup-outcome
        # apply layer attaches them to ``session.plan.workstreams`` and
        # emits the ``workstream_declared`` WS event. Empty list when
        # the AI didn't declare any (or the feature flag is off).
        self.declared_workstreams: list[Workstream] = []
        self.critical_inject_fired: bool = False
        # Issue #151 fix B grounding payload. Set whenever the model
        # *attempted* an ``inject_critical_event`` call this turn,
        # whether the call succeeded, was rate-limited, or was rejected
        # for a missing-pair (fix A) violation. The turn validator
        # passes this into ``drive_recovery_directive`` so a
        # missing-DRIVE recovery after an inject-bearing turn knows
        # exactly which event the model needs to ground its broadcast
        # on. ``None`` when the turn produced no inject attempt at all.
        # If multiple injects fire in one batch (rare), the most-recent
        # attempt wins — operators rarely fire concurrent injects and
        # the recovery only needs one anchor anyway.
        self.critical_inject_attempted_args: dict[str, Any] | None = None
        self.had_yielding_call: bool = False
        # Set to True when ``broadcast`` or ``address_role`` fired
        # successfully on this turn. The play-turn driver uses this on
        # the BRIEFING turn to detect "yielded without a brief" — the
        # AI gave the active roles nothing to act on — and run a
        # broadcast-recovery pass before letting the state advance.
        self.had_player_facing_message: bool = False
        # Slots that fired SUCCESSFULLY on this turn. Read by the
        # turn validator to check the dispatch outcome against the
        # state-aware ``TurnContract``. Populated incrementally as
        # each ``_handle`` branch succeeds; rate-limit / unknown-id
        # rejections never hit this set (they surface via
        # ``tool_results[*].is_error=True`` instead). See
        # ``app/sessions/slots.py`` for the tool→slot mapping.
        self.slots: set[Slot] = set()

    def add_result(self, *, tool_use_id: str, content: str, is_error: bool = False) -> None:
        self.tool_results.append(
            {
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": content,
                "is_error": is_error,
            }
        )


class ToolDispatcher:
    def __init__(
        self,
        *,
        connections: ConnectionManager,
        audit: AuditLog,
        extension_dispatcher: ExtensionDispatcher,
        registry: FrozenRegistry,
        max_critical_injects_per_5_turns: int = 1,
        workstreams_enabled: bool = False,
    ) -> None:
        self._connections = connections
        self._audit = audit
        self._extensions = extension_dispatcher
        self._registry = registry
        self._max_critical = max_critical_injects_per_5_turns
        # Phase A chat-declutter (docs/plans/chat-decluttering.md §6.8).
        # When False, ``declare_workstreams`` is rejected at dispatch
        # (defence in depth — the tool is also absent from the
        # ``setup_tools_for`` payload, so the model shouldn't be able
        # to emit the call in the first place) and ``address_role``'s
        # ``workstream_id`` is dropped to ``None`` instead of being
        # strict-validated.
        self._workstreams_enabled = workstreams_enabled

    async def dispatch(
        self,
        *,
        session: Session,
        tool_uses: list[dict[str, Any]],
        turn_id: str | None,
        critical_inject_allowed_cb: Any,
    ) -> DispatchOutcome:
        """Dispatch all tool_use blocks concurrently. Returns the aggregate outcome."""

        outcome = DispatchOutcome()
        tool_uses = self._dedupe_setup_questions(session, tool_uses, outcome=outcome)
        # Issue #151 fix A: detect ``inject_critical_event`` calls that
        # land without a same-batch DRIVE-slot pairing (broadcast /
        # address_role / share_data / pose_choice). The pairing rule is
        # also stated in Block 6 ("Critical-inject chain (mandatory)"),
        # but the model sometimes ignores it on real injects, leaving
        # players staring at a banner with no per-role direction. The
        # cumulative outcome's ``critical_inject_attempted_args`` is
        # populated unconditionally below so the turn validator can
        # ground a missing-DRIVE recovery on the inject context (fix
        # B) regardless of whether the inject succeeded or was rejected
        # here.
        inject_attempts = [
            tu.get("input") or {}
            for tu in tool_uses
            if tu.get("name") == "inject_critical_event"
        ]
        if inject_attempts:
            # Defensive dict guard — Anthropic's tool-use contract says
            # ``input`` is an object, but the codebase pattern elsewhere
            # (see ``use_extension_tool`` at the bottom of ``_handle``)
            # validates with isinstance before consuming. Mirror the
            # pattern so a non-dict shape can never poison the recovery
            # grounding payload (which is otherwise read field-by-field
            # at the validator's trust boundary).
            last = inject_attempts[-1]
            outcome.critical_inject_attempted_args = (
                dict(last) if isinstance(last, dict) else None
            )
        has_drive_pairing = any(
            tu.get("name") in _DRIVE_TOOL_NAMES for tu in tool_uses
        )
        inject_pairing_violation = bool(inject_attempts) and not has_drive_pairing
        coros = [
            self._dispatch_one(
                session=session,
                tool_use=tu,
                turn_id=turn_id,
                outcome=outcome,
                critical_inject_allowed_cb=critical_inject_allowed_cb,
                inject_pairing_violation=inject_pairing_violation,
            )
            for tu in tool_uses
        ]
        await asyncio.gather(*coros)
        return outcome

    def _dedupe_setup_questions(
        self,
        session: Session,
        tool_uses: list[dict[str, Any]],
        *,
        outcome: DispatchOutcome,
    ) -> list[dict[str, Any]]:
        """Drop duplicate ``ask_setup_question`` calls.

        The setup-tier model has been observed firing several
        ``ask_setup_question`` tool calls in a single turn (and re-asking
        already-asked topics across turns). Both produce confusing UX.

        Rules:
          1. Within one batch, keep only the first ``ask_setup_question``
             tool call. Later ones become tool errors so the model sees
             the rejection in its next turn.
          2. Across turns, reject any ``ask_setup_question`` whose
             ``topic`` matches the *most recent* AI setup note that the
             creator has not yet replied to (i.e. the question is still
             open). Same goes for an exact body match.
        """

        if not tool_uses:
            return tool_uses

        last_ai_unanswered_topic: str | None = None
        last_ai_unanswered_body: str | None = None
        for note in reversed(session.setup_notes):
            if note.speaker == "creator":
                break
            if note.speaker == "ai":
                last_ai_unanswered_topic = note.topic
                last_ai_unanswered_body = note.content

        kept: list[dict[str, Any]] = []
        seen_first_ask = False
        seen_topics: set[str] = set()
        seen_bodies: set[str] = set()
        for tu in tool_uses:
            if tu.get("name") != "ask_setup_question":
                kept.append(tu)
                continue
            args = tu.get("input") or {}
            topic = (args.get("topic") or "").strip().lower()
            body = (args.get("question") or "").strip().lower()
            duplicate_reason: str | None = None
            if seen_first_ask:
                duplicate_reason = "duplicate ask_setup_question in same turn"
            elif topic and topic in seen_topics:
                duplicate_reason = f"duplicate topic '{topic}' in same turn"
            elif body and body in seen_bodies:
                duplicate_reason = "duplicate question body in same turn"
            elif (
                last_ai_unanswered_topic
                and topic
                and topic == last_ai_unanswered_topic.strip().lower()
            ):
                duplicate_reason = (
                    "topic matches the previous unanswered question; "
                    "wait for the creator's reply before re-asking"
                )
            elif (
                last_ai_unanswered_body
                and body
                and body == last_ai_unanswered_body.strip().lower()
            ):
                duplicate_reason = (
                    "question body matches the previous unanswered question"
                )

            if duplicate_reason:
                outcome.add_result(
                    tool_use_id=tu.get("id", ""),
                    content=duplicate_reason,
                    is_error=True,
                )
                self._audit.emit(
                    AuditEvent(
                        kind="tool_use_rejected",
                        session_id=session.id,
                        turn_id=None,
                        payload={
                            "name": "ask_setup_question",
                            "reason": duplicate_reason,
                        },
                    )
                )
                continue
            seen_first_ask = True
            if topic:
                seen_topics.add(topic)
            if body:
                seen_bodies.add(body)
            kept.append(tu)
        return kept

    async def _dispatch_one(
        self,
        *,
        session: Session,
        tool_use: dict[str, Any],
        turn_id: str | None,
        outcome: DispatchOutcome,
        critical_inject_allowed_cb: Any,
        inject_pairing_violation: bool = False,
    ) -> None:
        name = tool_use.get("name", "")
        tool_id = tool_use.get("id", "")
        args = tool_use.get("input") or {}
        state = session.state

        self._audit.emit(
            AuditEvent(
                kind="tool_use",
                session_id=session.id,
                turn_id=turn_id,
                payload={"name": name, "args_keys": sorted(args.keys())},
            )
        )

        try:
            content = await self._handle(
                session=session,
                state=state,
                name=name,
                args=args,
                outcome=outcome,
                tool_id=tool_id,
                turn_id=turn_id,
                critical_inject_allowed_cb=critical_inject_allowed_cb,
                inject_pairing_violation=inject_pairing_violation,
            )
            outcome.add_result(tool_use_id=tool_id, content=content)
            # Successful dispatch — record the slot this tool occupies
            # so the turn validator can inspect ``outcome.slots``. We
            # only mark slots on the success path; rejections (rate
            # limit, unknown role_id) are visible via ``tool_results``
            # but do NOT count toward turn-completeness.
            slot = slot_for(name)
            if slot is not None:
                outcome.slots.add(slot)
            else:
                # Unknown tool name = operator extension; treat as
                # bookkeeping for slot purposes (it doesn't drive or
                # yield).
                outcome.slots.add(Slot.BOOKKEEPING)
        except _DispatchError as exc:
            outcome.add_result(
                tool_use_id=tool_id,
                content=str(exc),
                is_error=True,
            )
            payload: dict[str, Any] = {"name": name, "reason": str(exc)}
            # Phase A chat-declutter (docs/plans/chat-decluttering.md
            # §7.2). Validation paths can attach structured extras
            # (``reason_code``, ``attempted``, ``known``) so an operator
            # grepping the audit ring for workstream rejections doesn't
            # have to parse English prose. The human-readable
            # ``reason`` is preserved verbatim — endpoints like
            # ``/setup/reply`` surface it back to the creator as a
            # diagnostic, and clobbering it with a short code would
            # drop the recovery hint. ``audit_extras`` MUST NOT
            # contain the key ``reason``; if it does we reroute it to
            # ``reason_code`` defensively.
            extras = getattr(exc, "audit_extras", None)
            if isinstance(extras, dict):
                for key, value in extras.items():
                    if key == "reason":
                        payload.setdefault("reason_code", value)
                    else:
                        payload[key] = value
            self._audit.emit(
                AuditEvent(
                    kind="tool_use_rejected",
                    session_id=session.id,
                    turn_id=turn_id,
                    payload=payload,
                )
            )

    # ------------------------------------------------- per-tool handlers
    async def _handle(
        self,
        *,
        session: Session,
        state: SessionState,
        name: str,
        args: dict[str, Any],
        outcome: DispatchOutcome,
        tool_id: str,
        turn_id: str | None,
        critical_inject_allowed_cb: Any,
        inject_pairing_violation: bool = False,
    ) -> str:
        # ``declare_workstreams`` (Phase A chat-declutter,
        # docs/plans/chat-decluttering.md §3.3) is a setup-tier tool
        # like the other three. Listed here as well so the SETUP /
        # non-SETUP gates treat it consistently regardless of the
        # ``workstreams_enabled`` flag (which gates *exposure*, not
        # *handling* — defence in depth if a misconfigured extension
        # somehow surfaces the name).
        _SETUP_ONLY_TOOLS = {
            "ask_setup_question",
            "propose_scenario_plan",
            "finalize_setup",
            "declare_workstreams",
        }
        if state == SessionState.SETUP:
            if name not in _SETUP_ONLY_TOOLS:
                raise _DispatchError(f"tool '{name}' not allowed during SETUP")
        elif state == SessionState.ENDED:
            raise _DispatchError("session is ended; no tools may run")
        else:
            if name in _SETUP_ONLY_TOOLS:
                raise _DispatchError(f"tool '{name}' is setup-only")

        # ------------------ setup ------------------
        if name == "ask_setup_question":
            # Setup conversation is kept *separately* from session.messages
            # (docs/PLAN.md § Setup phase) — it lives in session.setup_notes
            # and is rendered to the creator via SetupChat. If we appended it
            # to session.messages it would (a) leak into the play-tier
            # message history sent to Sonnet (which rejects conversations
            # ending in role=assistant), and (b) leak setup-only AI prose
            # into the play transcript shown to non-creator roles.
            session.setup_notes.append(
                SetupNote(
                    speaker="ai",
                    content=str(args.get("question", "")),
                    topic=args.get("topic"),
                    options=args.get("options"),
                )
            )
            outcome.had_yielding_call = True  # setup turns yield by asking
            return "question recorded; awaiting creator answer"

        if name == "propose_scenario_plan":
            _reject_if_xml_emission(args, tool_name="propose_scenario_plan")
            try:
                plan = ScenarioPlan.model_validate(_normalize_plan(args))
            except Exception as exc:
                # ``ScenarioPlan`` field invariants (min_length=1 on
                # narrative_arc/key_objectives/injects) raise here when
                # the model submits an empty draft. The model sees the
                # rejection via ``is_error=True`` on the next turn and
                # self-corrects.
                raise _DispatchError(
                    f"plan rejected: {exc}. populate narrative_arc "
                    "(>=1 beat), key_objectives (>=1 item), and injects "
                    "(>=1 item) before calling propose_scenario_plan."
                ) from exc
            _validate_plan_completeness(plan)
            # Phase A chat-declutter (docs/plans/chat-decluttering.md
            # §4.2): carry forward any cross-turn workstream
            # declarations (e.g. AI declared on turn 1, proposes plan
            # on turn 2). Same-turn declarations are merged in
            # ``_apply_setup_outcome`` after this replacement lands —
            # carrying them here would also work but the apply layer is
            # the canonical seam.
            if session.plan is not None and session.plan.workstreams:
                plan.workstreams = list(session.plan.workstreams)
            outcome.proposed_plan = plan
            outcome.had_yielding_call = True
            return "plan proposed; creator will review or request edits"

        if name == "finalize_setup":
            _reject_if_xml_emission(args, tool_name="finalize_setup")
            try:
                plan = ScenarioPlan.model_validate(_normalize_plan(args))
            except Exception as exc:
                raise _DispatchError(
                    f"plan rejected: {exc}. finalize_setup requires "
                    "narrative_arc (>=1 beat), key_objectives (>=1 "
                    "item), and injects (>=1 item)."
                ) from exc
            _validate_plan_completeness(plan)
            # Phase A chat-declutter: preserve any workstreams already
            # declared via ``declare_workstreams`` earlier in the same
            # setup turn (or earlier turn) onto the finalized plan.
            # The model isn't asked to re-emit them in
            # ``finalize_setup`` — the dispatcher carries them forward
            # so the AAR-blind / play-tier paths see a consistent
            # ``session.plan.workstreams`` regardless of declare order.
            if session.plan is not None and session.plan.workstreams:
                plan.workstreams = list(session.plan.workstreams)
            outcome.finalized_plan = plan
            outcome.had_yielding_call = True
            return "plan finalized; session is now READY"

        if name == "declare_workstreams":
            return _handle_declare_workstreams(
                session=session,
                args=args,
                outcome=outcome,
                workstreams_enabled=self._workstreams_enabled,
            )

        # ------------------ play ------------------
        if name == "broadcast":
            outcome.appended_messages.append(
                Message(
                    kind=MessageKind.AI_TEXT,
                    body=str(args.get("message", "")),
                    turn_id=turn_id,
                    tool_name=name,
                    tool_args=args,
                )
            )
            outcome.had_player_facing_message = True
            return "broadcast queued"

        if name == "address_role":
            resolved, unresolved = _resolve_role_refs(session, [args.get("role_id")])
            if unresolved or not resolved:
                raise _DispatchError(
                    f"unknown role_id: {args.get('role_id')!r} — pass the "
                    "opaque role_id (column 1 of the roster), not the label."
                )
            target_id = resolved[0]
            target = session.role_by_id(target_id)
            label = target.label if target else target_id
            args["role_id"] = target_id  # canonicalise so tool_args stays clean
            # Phase A chat-declutter (docs/plans/chat-decluttering.md
            # §4.5): validate the optional ``workstream_id``. Three
            # outcomes — valid id sticks, empty/missing → None, invalid
            # id → ``tool_result is_error=True`` so the strict-retry
            # loop can recover. The "after 3 retries fall back to
            # None" failure mode (plan §7.3) is handled implicitly by
            # the strict-retry caller: when retries exhaust, the model
            # eventually drops the field and the call goes through with
            # ``workstream_id=None``.
            workstream_id = _validate_workstream_id(
                session=session,
                value=args.get("workstream_id"),
                workstreams_enabled=self._workstreams_enabled,
                tool_name="address_role",
                session_id=session.id,
            )
            args["workstream_id"] = workstream_id
            outcome.appended_messages.append(
                Message(
                    kind=MessageKind.AI_TEXT,
                    body=f"@{label}: {args.get('message', '')}",
                    turn_id=turn_id,
                    tool_name=name,
                    tool_args=args,
                    workstream_id=workstream_id,
                    # Phase A chat-declutter (plan §5.1): structural
                    # source for the @-highlight. The frontend reads
                    # ``mentions`` directly; the body's ``@<label>``
                    # token is decorative.
                    mentions=[target_id],
                )
            )
            outcome.had_player_facing_message = True
            return "address queued"

        if name == "inject_event":
            outcome.appended_messages.append(
                Message(
                    kind=MessageKind.SYSTEM,
                    body=str(args.get("description", "")),
                    turn_id=turn_id,
                    tool_name=name,
                    tool_args=args,
                )
            )
            return "event injected"

        if name == "pose_choice":
            # Multi-choice tactical decision prompt. Renders as the
            # facilitator's AI message with options A / B / C / … so
            # the role knows what they're choosing between. Free-form
            # text replies are still accepted; clickable quick-reply
            # buttons are tracked as a follow-up product feature
            # (issue #71).
            ref = args.get("role_id")
            resolved, unresolved = _resolve_role_refs(session, [ref])
            if unresolved or not resolved:
                raise _DispatchError(
                    f"unknown role_id: {ref!r} — pass an opaque role_id "
                    "from Block 10."
                )
            target_id = resolved[0]
            target = session.role_by_id(target_id)
            label = target.label if target else target_id
            args["role_id"] = target_id  # canonicalise
            question = str(args.get("question", "")).strip()
            options = list(args.get("options", []) or [])
            if not options or len(options) < 2 or len(options) > 5:
                raise _DispatchError(
                    "pose_choice requires 2–5 options; "
                    f"got {len(options)}."
                )
            # Phase B chat-declutter (plan §3.1): same shape as
            # ``address_role.workstream_id`` — invalid value triggers
            # ``is_error=True`` so the strict-retry loop can recover.
            workstream_id = _validate_workstream_id(
                session=session,
                value=args.get("workstream_id"),
                workstreams_enabled=self._workstreams_enabled,
                tool_name="pose_choice",
                session_id=session.id,
            )
            args["workstream_id"] = workstream_id
            letters = ["A", "B", "C", "D", "E"]
            option_lines = "\n".join(
                f"**{letters[i]}.** {opt}" for i, opt in enumerate(options)
            )
            body = f"**{label}** — {question}\n\n{option_lines}"
            outcome.appended_messages.append(
                Message(
                    kind=MessageKind.AI_TEXT,
                    body=body,
                    turn_id=turn_id,
                    tool_name=name,
                    tool_args=args,
                    workstream_id=workstream_id,
                    # Phase B chat-declutter (plan §5.1): pose_choice
                    # is single-addressee like ``address_role`` — stamp
                    # the target as a structural mention so the
                    # @-highlight and "(@you)" badge fire even though
                    # the body's first token is the role label rather
                    # than ``@<label>``.
                    mentions=[target_id],
                )
            )
            outcome.had_player_facing_message = True
            return "choice posed"

        if name == "share_data":
            # Player-facing data dump (logs / IOCs / telemetry / alert
            # lists). Renders as an AI message so it's clearly the
            # facilitator's voice, with the raw markdown body produced
            # by the model. Distinct from `broadcast` so the frontend
            # can render the data block with monospace / copy-button
            # affordances and so the timeline can show "data shared".
            label = str(args.get("label", "")).strip()
            data = str(args.get("data", ""))
            # Phase B chat-declutter (plan §3.1): data shares are
            # often genuinely cross-cutting (an IOC dump can be
            # relevant to two workstreams) — the field is optional and
            # the model is expected to omit it for cross-cutting
            # dumps. Same validation seam as the other three.
            workstream_id = _validate_workstream_id(
                session=session,
                value=args.get("workstream_id"),
                workstreams_enabled=self._workstreams_enabled,
                tool_name="share_data",
                session_id=session.id,
            )
            args["workstream_id"] = workstream_id
            if label:
                body = f"**{label}**\n\n{data}"
            else:
                body = data
            outcome.appended_messages.append(
                Message(
                    kind=MessageKind.AI_TEXT,
                    body=body,
                    turn_id=turn_id,
                    tool_name=name,
                    tool_args=args,
                    workstream_id=workstream_id,
                )
            )
            outcome.had_player_facing_message = True
            return "data shared"

        if name == "track_role_followup":
            ref = args.get("role_id")
            resolved, unresolved = _resolve_role_refs(session, [ref])
            if not resolved:
                raise _DispatchError(
                    f"unknown role_id: {ref!r} — pass an opaque role_id from "
                    "Block 10."
                )
            from datetime import UTC, datetime

            from ..sessions.models import RoleFollowup

            target_id = resolved[0]
            prompt_text = str(args.get("prompt", "")).strip()
            if not prompt_text:
                raise _DispatchError("prompt is required")
            fu = RoleFollowup(role_id=target_id, prompt=prompt_text)
            session.role_followups.append(fu)
            target = session.role_by_id(target_id)
            label = target.label if target else target_id
            outcome.appended_messages.append(
                Message(
                    kind=MessageKind.SYSTEM,
                    body=f"Follow-up tracked for {label}: {prompt_text}",
                    turn_id=turn_id,
                    tool_name=name,
                    tool_args={**args, "role_id": target_id, "followup_id": fu.id},
                )
            )
            _ = unresolved  # consumed via raise above; silence lint
            _ = datetime.now(UTC)  # imported for parity with other handlers
            return f"followup tracked id={fu.id}"

        if name == "resolve_role_followup":
            from datetime import UTC, datetime

            fid = str(args.get("followup_id", "")).strip()
            status = args.get("status")
            if status not in ("done", "dropped"):
                raise _DispatchError("status must be 'done' or 'dropped'")
            fu_target = next(
                (f for f in session.role_followups if f.id == fid), None
            )
            if fu_target is None:
                raise _DispatchError(f"unknown followup_id: {fid}")
            if fu_target.status != "open":
                return f"followup already {fu_target.status}"
            fu_target.status = status
            fu_target.resolved_at = datetime.now(UTC)
            return f"followup {status}"

        # Note: ``record_decision_rationale`` was removed as a tool in
        # the 2026-04-30 tool-palette redesign. The model was using it
        # as a "thinking-first" entry point and stopping before
        # producing player-facing output. The decision log is now
        # populated automatically from the model's natural text content
        # blocks alongside its tool_use blocks (see
        # ``turn_driver._harvest_rationale_from_text``). Less schema
        # ceremony, no failure mode where calling ``rationale`` alone
        # short-circuits the turn.

        if name == "mark_timeline_point":
            # The actual title/note are stored in ``tool_args`` so the
            # frontend Timeline can extract them. We *intentionally* do
            # NOT render this as an AI_TEXT chat bubble because Sonnet
            # was using ``mark_timeline_point`` as a substitute for
            # ``broadcast`` (firing one pin per turn and skipping
            # narration entirely). Surfacing only as a SYSTEM-kind message
            # forces the model to ALSO call ``broadcast`` /
            # ``address_role`` when it wants to narrate the beat.
            title = str(args.get("title", "")).strip()
            note = str(args.get("note", "")).strip()
            outcome.appended_messages.append(
                Message(
                    kind=MessageKind.SYSTEM,
                    body=f"Pinned: {title}" + (f" — {note}" if note else ""),
                    turn_id=turn_id,
                    tool_name=name,
                    tool_args=args,
                )
            )
            return "timeline point pinned"

        if name == "inject_critical_event":
            # Issue #151 fix A: enforce the Critical-inject chain
            # mandate at dispatch time. Block 6 of the play-tier system
            # prompt requires that ``inject_critical_event`` lands with
            # at least one DRIVE-slot tool (broadcast / address_role /
            # share_data / pose_choice) in the same response so players
            # see per-role direction alongside the banner. The model
            # ignores this on real injects with some regularity; the
            # pre-fix recovery path was the post-turn DRIVE recovery,
            # which fired *after* paying the cost of a mis-composed
            # turn. Catch the violation here instead so the strict-
            # retry pass replays a structured rejection (model self-
            # corrects on the cheaper layer). The rate-limit check
            # below would also reject the call, but the pairing error
            # ships the actionable hint — re-fire as a chain — that
            # the rate-limit message lacks. The cumulative outcome's
            # ``critical_inject_attempted_args`` was already populated
            # by ``dispatch()`` for fix B's recovery grounding, so the
            # validator still sees the inject context even when this
            # branch rejects.
            if inject_pairing_violation:
                raise _DispatchError(
                    "inject_critical_event was emitted without a same-"
                    "response DRIVE-slot tool (`broadcast`, "
                    "`address_role`, `share_data`, or `pose_choice`). "
                    "Critical injects MUST land as a chain — without "
                    "the paired DRIVE call, players see the banner "
                    "land and then nothing, the turn stalls. Re-fire "
                    "as: `inject_critical_event(...)`, then a "
                    "`broadcast` / `address_role` / `share_data` / "
                    "`pose_choice` naming which active role acts on the "
                    "inject and what they do, then `set_active_roles` "
                    "yielding to those roles."
                )
            allowed = await _maybe_call(critical_inject_allowed_cb)
            if not allowed:
                raise _DispatchError("critical-event rate limit hit")
            # Phase B chat-declutter (plan §3.1): most injects target
            # one workstream (press inject → Comms; new IOC →
            # Containment), so the field is meaningful here. Validation
            # runs BEFORE the WS broadcast so a bad value still raises
            # as a strict-retryable tool error rather than fanning out
            # a half-formed critical_event the frontend would have to
            # retract.
            workstream_id = _validate_workstream_id(
                session=session,
                value=args.get("workstream_id"),
                workstreams_enabled=self._workstreams_enabled,
                tool_name="inject_critical_event",
                session_id=session.id,
            )
            args["workstream_id"] = workstream_id
            body_text = (
                f"[{args.get('severity','HIGH')}] {args.get('headline','')} — "
                f"{args.get('body','')}"
            )
            outcome.appended_messages.append(
                Message(
                    kind=MessageKind.CRITICAL_INJECT,
                    body=body_text,
                    turn_id=turn_id,
                    tool_name=name,
                    tool_args=args,
                    workstream_id=workstream_id,
                )
            )
            outcome.critical_inject_fired = True
            await self._connections.broadcast(
                session.id,
                {
                    "type": "critical_event",
                    "severity": args.get("severity", "HIGH"),
                    "headline": args.get("headline", ""),
                    "body": args.get("body", ""),
                },
            )
            return "critical event surfaced"

        if name == "set_active_roles":
            raw_ids = list(args.get("role_ids") or [])
            role_ids, unresolved = _resolve_role_refs(session, raw_ids)
            if not role_ids:
                # Nothing usable. Tell the model to retry with seated ids.
                raise _DispatchError(
                    f"unknown role_ids: {unresolved} — only the roles in "
                    "Block 10 exist; pass their opaque role_id (column 1)."
                )
            outcome.set_active_role_ids = role_ids
            outcome.had_yielding_call = True
            if unresolved:
                # Soft-success: the turn yields to the resolved roles, but
                # we surface a warning so the model corrects on the next
                # turn instead of repeating the same hallucinated label.
                return (
                    f"yielded to {role_ids}; ignored unknown role_ids "
                    f"{unresolved} (not in Block 10 roster)"
                )
            return f"yielded to {role_ids}"

        if name == "request_artifact":
            resolved, unresolved = _resolve_role_refs(session, [args.get("role_id")])
            if unresolved or not resolved:
                raise _DispatchError(
                    f"unknown role_id: {args.get('role_id')!r} — pass the "
                    "opaque role_id (column 1 of the roster), not the label."
                )
            target_id = resolved[0]
            target = session.role_by_id(target_id)
            label = target.label if target else target_id
            args["role_id"] = target_id
            outcome.appended_messages.append(
                Message(
                    kind=MessageKind.AI_TEXT,
                    body=(
                        f"[Artifact request] {args.get('artifact_type','')} from "
                        f"{label}: {args.get('instructions','')}"
                    ),
                    turn_id=turn_id,
                    tool_name=name,
                    tool_args=args,
                )
            )
            return "artifact requested"

        if name == "lookup_resource":
            try:
                return self._extensions.lookup_resource(str(args.get("name", "")))
            except ExtensionDispatchError as exc:
                raise _DispatchError(str(exc)) from exc

        if name == "use_extension_tool":
            try:
                inner_args = args.get("args") or {}
                if not isinstance(inner_args, dict):
                    raise _DispatchError("use_extension_tool.args must be an object")
                return self._extensions.invoke(
                    name=str(args.get("name", "")),
                    args=inner_args,
                    session_ctx={
                        "industry": _safe_get_setup(session, "industry"),
                        "roster_size": session.roster_size,
                        "beat_index": (
                            session.current_turn.index if session.current_turn else 0
                        ),
                    },
                    session_id=session.id,
                    turn_id=turn_id,
                )
            except ExtensionDispatchError as exc:
                raise _DispatchError(str(exc)) from exc

        if name == "end_session":
            outcome.end_session_reason = str(args.get("reason", "ended"))
            outcome.had_yielding_call = True
            return "end_session acknowledged"

        # Direct invocation of an extension tool name — Claude *should* go via
        # ``use_extension_tool``, but if it inlines the extension we still
        # honour it.
        if name in self._registry.tools:
            try:
                return self._extensions.invoke(
                    name=name,
                    args=args,
                    session_ctx={
                        "industry": _safe_get_setup(session, "industry"),
                        "roster_size": session.roster_size,
                        "beat_index": (
                            session.current_turn.index if session.current_turn else 0
                        ),
                    },
                    session_id=session.id,
                    turn_id=turn_id,
                )
            except ExtensionDispatchError as exc:
                raise _DispatchError(str(exc)) from exc

        raise _DispatchError(f"unknown tool: {name}")


class _DispatchError(RuntimeError):
    """Tool-result-as-error signal for the dispatcher.

    Carries an optional ``audit_extras`` dict that the dispatch-emit
    layer merges into the ``tool_use_rejected`` audit payload. Use it
    when a validation path has structured data worth surfacing to
    operators (e.g. ``reason="unknown_workstream_id"``,
    ``attempted=...``, ``known=[...]``) per
    docs/plans/chat-decluttering.md §7.2.
    """

    def __init__(self, message: str, *, audit_extras: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.audit_extras: dict[str, Any] | None = audit_extras


def _resolve_role_refs(
    session: Session, refs: list[Any]
) -> tuple[list[str], list[str]]:
    """Resolve a free-form list of role references to canonical role_ids.

    The system prompt explicitly tells the model to pass opaque role_ids,
    but it will occasionally hand back labels ("SOC", "IR Lead") or
    display names anyway. Rather than reject the whole turn (which sent
    the operator into force-advance loops), accept any unambiguous
    label / display-name match as a fallback.

    Returns ``(resolved_ids, unresolved_refs)``.
    """

    by_id = {r.id: r.id for r in session.roles}
    by_label_lower = {r.label.lower(): r.id for r in session.roles}
    by_display_lower = {
        (r.display_name or "").lower(): r.id
        for r in session.roles
        if r.display_name
    }
    resolved: list[str] = []
    unresolved: list[str] = []
    for raw in refs:
        if not isinstance(raw, str):
            unresolved.append(repr(raw))
            continue
        ref = raw.strip()
        if ref in by_id:
            resolved.append(ref)
            continue
        lowered = ref.lower()
        if lowered in by_label_lower:
            resolved.append(by_label_lower[lowered])
            continue
        if lowered in by_display_lower:
            resolved.append(by_display_lower[lowered])
            continue
        unresolved.append(ref)
    # De-dupe while preserving order.
    seen: set[str] = set()
    deduped: list[str] = []
    for rid in resolved:
        if rid not in seen:
            seen.add(rid)
            deduped.append(rid)
    return deduped, unresolved


async def _maybe_call(cb: Any) -> Any:
    if cb is None:
        return True
    if asyncio.iscoroutinefunction(cb):
        return await cb()
    result = cb()
    if asyncio.iscoroutine(result):
        return await result
    return result


def _validate_workstream_id(
    *,
    session: Session,
    value: Any,
    workstreams_enabled: bool,
    tool_name: str,
    session_id: str,
) -> str | None:
    """Validate an optional ``workstream_id`` on a play-tier tool call.

    docs/plans/chat-decluttering.md §4.5 — three outcomes:

    * empty / missing / non-string → ``None`` (silently dropped)
    * valid id (matches a declared workstream and feature flag is on)
      → returned as-is so the call site stamps it on the message
    * invalid id (string, but not in the declared set) → raise
      ``_DispatchError`` so the strict-retry loop replays the
      structured ``is_error=True`` ``tool_result`` to the model.

    When the ``workstreams_enabled`` flag is off we never strict-check
    the value — the field is silently dropped to ``None`` so an
    upgraded model (or a stale prompt cache) emitting the field
    against a flag-off backend doesn't error the whole tool call.
    Drops are logged at DEBUG so the audit trail remains complete
    (per CLAUDE.md "Logging rules — silent fallback path").
    """

    if value is None or value == "":
        return None
    if not isinstance(value, str):
        # Schema-shape drift; treat as missing.
        _logger.debug(
            "workstream_id_dropped_non_string",
            session_id=session_id,
            tool_name=tool_name,
            value_type=type(value).__name__,
        )
        return None
    if not workstreams_enabled:
        _logger.debug(
            "workstream_id_dropped_flag_off",
            session_id=session_id,
            tool_name=tool_name,
            attempted=value,
        )
        return None
    declared_ids = {ws.id for ws in (session.plan.workstreams if session.plan else [])}
    if not declared_ids:
        # Feature flag is on but no workstreams declared this session
        # — drop silently rather than fail every call.
        _logger.debug(
            "workstream_id_dropped_no_declarations",
            session_id=session_id,
            tool_name=tool_name,
            attempted=value,
        )
        return None
    if value not in declared_ids:
        known = sorted(declared_ids)
        # Plan §7.2: surface structured fields on the audit payload so
        # operators can grep ``reason_code="unknown_workstream_id"``
        # rather than parse the English prose. The human-readable
        # ``reason`` is preserved by the dispatch-emit layer (it's
        # what ``/setup/reply`` surfaces back to the creator); the
        # structured code rides alongside as ``reason_code`` so neither
        # consumer is starved.
        #
        # Security review LOW: clip the unknown value before echoing
        # it back to the model and the audit log. The strict-retry
        # loop replays the prose to the model on its next call, so an
        # adversarial / hallucinated multi-KB ``workstream_id`` would
        # otherwise fan out across the audit ring AND inflate the
        # next prompt. 120 chars is a generous upper bound for a
        # legit slug-shaped id; longer values are bugs anyway.
        clipped = value if len(value) <= 120 else f"{value[:120]}…"
        raise _DispatchError(
            f"unknown workstream_id {clipped!r} on {tool_name}. Known: "
            f"{', '.join(known)}. Pass an id from your earlier "
            "declare_workstreams call, or omit the field for a "
            "cross-cutting beat.",
            audit_extras={
                "reason_code": "unknown_workstream_id",
                "attempted": clipped,
                "known": known,
            },
        )
    return value


_WORKSTREAM_ID_HINT = (
    "ids must match ^[a-z][a-z0-9_]*$ (lowercase, snake_case), "
    "max 32 chars; labels are 1–24 chars."
)


def _handle_declare_workstreams(
    *,
    session: Session,
    args: dict[str, Any],
    outcome: DispatchOutcome,
    workstreams_enabled: bool,
) -> str:
    """Validate and stage workstreams declared by the AI in setup.

    docs/plans/chat-decluttering.md §4.2. The model emits
    ``{"workstreams": [{"id": "...", "label": "...",
    "lead_role_id": "..."}]}``. We:

    * Reject the call cleanly if the feature flag is off (defence in
      depth — the tool also isn't exposed in that case).
    * Validate each entry through the ``Workstream`` Pydantic model
      (id regex, length caps, etc).
    * Drop entries with unknown ``lead_role_id`` to ``None`` rather
      than rejecting the whole call (per "identity drift" pattern in
      CLAUDE.md model-output trust boundary — unknown ids are bugs in
      the model's output, not in the user's intent).
    * Stage the resulting list on ``outcome.declared_workstreams``;
      the setup-outcome layer attaches them to ``session.plan`` and
      fans out the ``workstream_declared`` WS event.
    """

    if not workstreams_enabled:
        raise _DispatchError(
            "declare_workstreams is gated by the WORKSTREAMS_ENABLED "
            "flag and is not currently enabled. Skip the call."
        )
    raw = args.get("workstreams")
    if not isinstance(raw, list):
        raise _DispatchError(
            "declare_workstreams requires a 'workstreams' array; "
            f"got {type(raw).__name__}."
        )
    valid_role_ids = {r.id for r in session.roles}
    seen_ids: set[str] = set()
    declared: list[Workstream] = []
    dropped_lead: list[tuple[str, str]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            raise _DispatchError(
                f"declare_workstreams entry must be an object; "
                f"got {type(entry).__name__}."
            )
        normalized = dict(entry)
        lead = normalized.get("lead_role_id")
        if isinstance(lead, str) and lead and lead not in valid_role_ids:
            # Drop the bad lead — log the offence rather than reject
            # the whole declaration. Mirror the dropped-count audit
            # pattern from ``_extract_report`` in ``llm/export.py``.
            dropped_lead.append((str(normalized.get("id", "")), lead))
            normalized["lead_role_id"] = None
        elif lead == "":
            normalized["lead_role_id"] = None
        try:
            ws = Workstream.model_validate(normalized)
        except ValidationError as exc:
            # Narrow exception type: Pydantic surfaces all schema
            # violations as ValidationError; anything else (TypeError,
            # AttributeError) signals a bug worth letting bubble.
            _logger.warning(
                "workstream_validation_failed",
                session_id=session.id,
                entry_id=normalized.get("id"),
                error=str(exc),
            )
            raise _DispatchError(
                f"workstream entry rejected: {exc}. {_WORKSTREAM_ID_HINT}"
            ) from exc
        if ws.id in seen_ids:
            raise _DispatchError(
                f"duplicate workstream id '{ws.id}' in this call; "
                "ids must be unique within the session."
            )
        seen_ids.add(ws.id)
        declared.append(ws)
    if dropped_lead:
        _logger.warning(
            "workstream_lead_role_dropped",
            session_id=session.id,
            dropped_count=len(dropped_lead),
            dropped=dropped_lead,
            valid_role_ids=sorted(valid_role_ids),
        )
    outcome.declared_workstreams = declared
    if dropped_lead:
        # Surface the drop to the model in the tool_result so it can
        # self-correct on a subsequent call (e.g. by passing a real
        # role_id or omitting the field). Mirrors the
        # ``set_active_roles`` soft-success pattern.
        bad = [f"{wid}->{lead}" for wid, lead in dropped_lead]
        return (
            f"declared {len(declared)} workstream(s); ignored unknown "
            f"lead_role_id(s) {bad} (not in roster)"
        )
    return f"declared {len(declared)} workstream(s)"


def _validate_plan_completeness(plan: ScenarioPlan) -> None:
    """Defence-in-depth check that the plan structurally drives an
    exercise. Pydantic ``min_length=1`` on the model fields is the
    primary gate; this catches the case where someone bypassed the
    model (e.g. constructed a ``ScenarioPlan`` with ``model_construct``
    or an extension passed a malformed dict that slipped past the
    Anthropic tool input_schema). Always called for both
    ``propose_scenario_plan`` and ``finalize_setup``.
    """

    missing: list[str] = []
    if not plan.narrative_arc:
        missing.append("narrative_arc")
    if not plan.key_objectives:
        missing.append("key_objectives")
    if not plan.injects:
        missing.append("injects")
    if missing:
        raise _DispatchError(
            "plan is structurally incomplete — missing/empty: "
            + ", ".join(missing)
            + ". every plan must define a narrative_arc (>=1 beat), "
            "key_objectives (>=1 item), and injects (>=1 item) so "
            "the play tier has structure to facilitate against."
        )


# Markers we treat as evidence that the model has fallen back to the
# legacy XML function-call format inside a JSON tool input. JSON is the
# only supported wire shape — when we see XML markup we reject hard
# and return a tailored error so the model self-corrects on the next
# turn instead of looping with an opaque pydantic message.
# Lower-cased so a single ``str.lower()`` pass on the value catches
# any casing the model emits.
_XML_EMISSION_MARKERS: tuple[str, ...] = (
    "<parameter ",
    "<parameter\t",
    "<parameter\n",
    "</parameter>",
    "<![cdata[",
    "<item>",
    "</item>",
    "<invoke>",
    "</invoke>",
)


def _has_xml_marker(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    lowered = value.lower()
    return any(marker in lowered for marker in _XML_EMISSION_MARKERS)


def _walk_for_xml_markers(value: Any, *, path: str = "") -> list[str]:
    """Walk ``value`` recursively and return JSON-pointer-ish paths
    of every string leaf that carries an XML emission marker.

    Path syntax: top-level keys are bare (``key_objectives``); list
    indices use bracket notation (``injects[0].summary``); nested
    dict keys join with a dot (``narrative_arc[1].label``). Empty path
    means the value itself is a marker-bearing string.

    Examples:
        ``_walk_for_xml_markers({"injects": [{"summary": "<item>x</item>"}]})``
        -> ``["injects[0].summary"]``
    """

    hits: list[str] = []
    if isinstance(value, str):
        if _has_xml_marker(value):
            hits.append(path or "<root>")
        return hits
    if isinstance(value, dict):
        for k, v in value.items():
            child_path = f"{path}.{k}" if path else str(k)
            hits.extend(_walk_for_xml_markers(v, path=child_path))
        return hits
    if isinstance(value, list):
        for i, v in enumerate(value):
            child_path = f"{path}[{i}]"
            hits.extend(_walk_for_xml_markers(v, path=child_path))
        return hits
    return hits


def _reject_if_xml_emission(args: dict[str, Any], *, tool_name: str) -> None:
    """Hard-reject tool calls whose JSON input contains XML
    function-call markup.

    Haiku-class models occasionally fall back to the legacy
    ``<parameter name="X">…</parameter>`` / ``<item>…</item>`` /
    ``<![CDATA[]]>`` representation inside JSON values. We don't try
    to reshape that — the canonical wire format is JSON, period. We
    instead surface a precise, instructive rejection so the next
    turn carries enough context for the model to self-correct.

    The detector walks the input recursively so XML inside nested
    objects (e.g. ``injects[0].summary`` or
    ``narrative_arc[1].label``) is caught alongside top-level
    fields. Reported paths name the exact offending leaf so the
    model knows where to look.

    The error message is fed back as ``is_error=True`` on the
    ``tool_result``. The strict-retry path in ``turn_driver.py`` then
    replays it into the next call so the model sees exactly what was
    wrong and how to fix it.
    """

    offending = _walk_for_xml_markers(args)
    if not offending:
        return
    raise _DispatchError(
        f"{tool_name} input contains XML function-call markup at "
        f"field path(s) {offending}. The only accepted format is "
        "JSON matching the tool's input_schema. Re-emit the call "
        'with: "key_objectives": ["obj1", "obj2", "obj3"], '
        '"narrative_arc": [{"beat": 1, "label": "Detection & '
        'triage", "expected_actors": ["CISO", "IR Lead"]}, ...], '
        '"injects": [{"trigger": "after beat 1", "type": "event", '
        '"summary": "..."}, ...]. Do NOT use <parameter '
        'name="...">...</parameter>, <![CDATA[...]]>, or '
        "<item>...</item> markup anywhere in the call (including "
        "inside nested object fields like narrative_arc[].label or "
        "injects[].summary) — those are the legacy XML function-"
        "call format and are not accepted here."
    )


def _normalize_plan(args: dict[str, Any]) -> dict[str, Any]:
    """Best-effort coerce loose model output into ScenarioPlan shape.

    Some model outputs put narrative arc beats / injects as raw dicts;
    the pydantic models accept that natively. We fill in defaults for
    OPTIONAL fields (executive_summary, guardrails, success_criteria,
    out_of_scope) but deliberately do NOT default the required arrays
    (narrative_arc, key_objectives, injects) — letting the model's
    omission slide produced empty plans in production. The Pydantic
    invariants on ``ScenarioPlan`` catch the omission with a clear
    error that the dispatcher reflects back to the model on the next
    turn.
    """

    plan = dict(args)
    plan.setdefault("executive_summary", "")
    plan.setdefault("guardrails", [])
    plan.setdefault("success_criteria", [])
    plan.setdefault("out_of_scope", [])
    # ``narrative_arc``, ``key_objectives``, ``injects`` are NOT
    # defaulted here — see the docstring. Pydantic ``min_length=1`` on
    # the model rejects empty arrays, and ``_validate_plan_completeness``
    # is a defence-in-depth backstop.
    _ = ScenarioBeat
    _ = ScenarioInject
    return plan


def _safe_get_setup(session: Session, key: str) -> str:
    """Pull a setup-note value (e.g. industry) without exposing PII."""

    for note in session.setup_notes:
        if note.topic and note.topic.lower().startswith(key.lower()):
            return note.content[:64]
    return ""
