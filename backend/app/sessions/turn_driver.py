"""Drive a single AI turn end-to-end.

Sits on top of :class:`~.manager.SessionManager`. Pulled out of the
manager so the manager file stays focused on state transitions and
locking.

Flow per play turn:
1. Build messages from current transcript.
2. Call the LLM (streamed); fan text deltas to clients.
3. Dispatch tool_use blocks via the ToolDispatcher; collect slots.
4. Run the turn validator against a state-aware contract. If the
   outcome is incomplete, the validator emits one or more
   :class:`~.turn_validator.RecoveryDirective`s — for each (in
   priority order, sharing one budget) run a narrowed follow-up LLM
   call that splices the prior tool-loop in for context.
5. Apply outcome: append messages, persist plan, set active roles,
   end session.

Recovery infrastructure used to be two ad-hoc paths inline here
(strict-retry + briefing-broadcast). They are now expressed as
directive factories in ``turn_validator.py``.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from ..auth.audit import AuditEvent
from ..extensions.registry import FrozenRegistry
from ..llm.client import LLMResult
from ..llm.dispatch import DispatchOutcome
from ..llm.prompts import (
    build_play_system_blocks,
    build_setup_system_blocks,
)
from ..llm.tools import PLAY_TOOLS, SETUP_TOOLS
from ..logging_setup import get_logger
from .active_roles import narrow_active_roles
from .manager import SessionManager
from .models import (
    DecisionLogEntry,
    Message,
    MessageKind,
    Session,
    SessionState,
    Turn,
)
from .phase_policy import assert_state, tool_choice_for
from .slots import Slot
from .turn_engine import critical_inject_allowed
from .turn_validator import (
    RecoveryDirective,
    contract_for,
    order_directives,
    validate,
)

_logger = get_logger("session.turn_driver")


class TurnDriver:
    def __init__(self, *, manager: SessionManager) -> None:
        self._manager = manager

    async def _emit_ai_status(
        self,
        session_id: str,
        *,
        phase: str | None,
        attempt: int | None = None,
        budget: int | None = None,
        recovery: str | None = None,
        turn_index: int | None = None,
        for_role_id: str | None = None,
    ) -> None:
        """Broadcast a labelled "what is the AI doing?" breadcrumb.

        ``ai_thinking`` (emitted from the LLM-call boundary) answers
        "is anything running"; ``ai_status`` (this method) answers
        "what should the human see?". Failure to emit must NOT break
        the turn — wrap and log.

        ``record=False`` because the breadcrumb is stale on reconnect.
        """

        try:
            await self._manager.connections().broadcast(
                session_id,
                {
                    "type": "ai_status",
                    "phase": phase,
                    "attempt": attempt,
                    "budget": budget,
                    "recovery": recovery,
                    "turn_index": turn_index,
                    "for_role_id": for_role_id,
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

    def _check_truncation(
        self,
        *,
        session_id: str,
        tier: str,
        result: LLMResult,
        turn_id: str | None = None,
    ) -> None:
        """Emit an audit event when an LLM call hit ``max_tokens``.

        ``stop_reason == "max_tokens"`` always means the per-tier
        budget is too small for the call the prompt is asking for —
        the model is truncated mid-output. That used to surface only
        in container stdout; now it lives in the audit ring buffer so
        the creator's activity panel and ``/setup/reply`` can show it
        without an SSH session.
        """

        if result.stop_reason != "max_tokens":
            return
        output_tokens = result.usage.get("output")
        _logger.warning(
            "llm_truncated",
            session_id=session_id,
            tier=tier,
            model=result.model,
            output_tokens=output_tokens,
        )
        self._manager.audit().emit(
            AuditEvent(
                kind="llm_truncated",
                session_id=session_id,
                turn_id=turn_id,
                payload={
                    "tier": tier,
                    "model": result.model,
                    "output_tokens": output_tokens,
                    "hint": (
                        "raise LLM_MAX_TOKENS_"
                        + tier.upper()
                        + " — current call hit the per-tier ceiling"
                    ),
                },
            )
        )

    async def run_setup_turn(self, *, session: Session) -> Session:
        """Drive one setup-tier turn. May loop internally if Claude chains tools."""

        # Engine-side guardrail: setup tier may only run in SETUP state.
        # The dispatcher already rejects play-tier tools during SETUP,
        # but this prevents an upstream caller (refactor / new code
        # path) from invoking the setup driver in the wrong state.
        assert_state("setup", session.state)

        llm = self._manager.llm()
        dispatcher = self._manager.dispatcher()
        _logger.info(
            "setup_turn_start",
            session_id=session.id,
            note_count=len(session.setup_notes),
            has_plan=session.plan is not None,
        )
        # Light up the labelled indicator so the creator sees "AI —
        # Designing the scenario" while the setup tier is at work.
        # The ``finally`` clause clears it on every return path; the
        # ``ai_thinking`` events from the LLM-call boundary handle the
        # binary "is something running" signal.
        await self._emit_ai_status(session.id, phase="setup")

        try:
            # Safety cap on chained setup tool calls — operator-tunable via
            # ``MAX_SETUP_TURNS``. Lifting it lets a model that wants to
            # ``ask_setup_question`` → ``propose_scenario_plan`` →
            # ``finalize_setup`` in one cycle do so without a premature break.
            for _ in range(self._manager.settings().max_setup_turns):
                messages = _setup_messages(session)
                result = await llm.acomplete(
                    tier="setup",
                    system_blocks=build_setup_system_blocks(session),
                    messages=messages,
                    # Pin ``tool_choice`` to "any" so the model MUST emit a
                    # setup tool call. Eliminates the bare-text leak path
                    # entirely — the only way the setup tier can produce
                    # text without a tool is if the SDK contract is
                    # violated, in which case we discard below.
                    tool_choice=tool_choice_for("setup"),
                    tools=SETUP_TOOLS,
                    # Per-tier default from settings.max_tokens_for(tier) — call passes None.
                    session_id=session.id,
                )
                await self._apply_cost(session.id, result)
                self._check_truncation(session_id=session.id, tier="setup", result=result)

                tool_uses = _tool_uses(result)
                if not tool_uses:
                    # Bare text from the setup tier should be impossible:
                    # ``tool_choice={"type":"any"}`` forces a tool call.
                    # If we land here anyway (SDK contract violation, mock
                    # in tests, or a future refactor that drops the pin),
                    # discard the text rather than persist it — the
                    # transcript belongs to the play tier and we don't
                    # want setup-style assistant prose leaking into the
                    # play history. Log loudly so the regression is
                    # visible.
                    text = _all_text(result)
                    if text:
                        _logger.warning(
                            "setup_tier_bare_text_discarded",
                            session_id=session.id,
                            chars=len(text),
                        )
                    return session

                outcome = await dispatcher.dispatch(
                    session=session,
                    tool_uses=tool_uses,
                    turn_id=None,
                    critical_inject_allowed_cb=lambda: True,
                )
                await self._apply_setup_outcome(session, outcome)
                # All three setup tools (ask_setup_question / propose / finalize)
                # set ``had_yielding_call`` — that's our single yield signal.
                if outcome.had_yielding_call:
                    return session
            return session
        finally:
            await self._emit_ai_status(session.id, phase=None)

    async def run_play_turn(self, *, session: Session, turn: Turn) -> Session:
        """Drive one play-tier turn end-to-end via the turn validator.

        Loop shape:
          1. Run the LLM with the full play tool palette.
          2. Dispatch the resulting tool_uses; collect slots.
          3. Validate the cumulative slots against a state-aware
             contract.
          4. If the contract is satisfied: apply the outcome, return.
          5. Otherwise: pick the highest-priority recovery directive
             (DRIVE before YIELD), run a narrowed follow-up LLM call
             with the prior tool-loop spliced in, dispatch it, merge
             slots/messages/tool_results into a *cumulative* outcome,
             and re-validate.
          6. Repeat until satisfied or the shared budget
             (``LLM_STRICT_RETRY_MAX + 1``) is exhausted.

        The cumulative outcome means a DRIVE produced on attempt 1
        still counts toward the contract on attempt 2, so a single
        recovery pass that yields without re-driving doesn't blow up
        the validation.
        """

        assert_state("play", session.state)

        dispatcher = self._manager.dispatcher()
        registry = self._manager.registry()
        settings = self._manager.settings()
        # Issue #78 + PR #86 review: count *all* out-of-turn
        # interjections persisted on this session and *also* the
        # subset attached to the current turn. ``_play_messages``
        # currently feeds the entire ``session.messages`` array to the
        # model, so ``interjections_in_prompt`` is the count the model
        # actually sees; ``interjections_this_turn`` is the narrower
        # "since the turn opened" view operators usually want when
        # debugging "the AI is addressing the wrong people on THIS
        # beat." Both shipped to keep correlation cheap when the prompt
        # window or transcript-trim policy changes.
        interjections_in_prompt = sum(
            1
            for m in session.messages
            if m.kind == MessageKind.PLAYER and m.is_interjection
        )
        interjections_this_turn = sum(
            1
            for m in session.messages
            if m.kind == MessageKind.PLAYER
            and m.is_interjection
            and m.turn_id == turn.id
        )
        _logger.info(
            "play_turn_start",
            session_id=session.id,
            turn_index=turn.index,
            roster=len(session.roles),
            roster_size=session.roster_size,
            interjections_in_prompt=interjections_in_prompt,
            interjections_this_turn=interjections_this_turn,
        )

        contract = contract_for(
            tier="play",
            state=session.state,
            mode="normal",
            drive_required=settings.llm_recovery_drive_required,
        )

        # Shared budget across the whole turn — the user explicitly
        # asked for this in the plan-design step. A turn missing both
        # DRIVE and YIELD does not amplify the budget; both directives
        # share the same total cap.
        budget = 1 + settings.llm_strict_retry_max
        attempt = 0

        # Phase label for the labelled "what is the AI doing?" indicator.
        # When state is BRIEFING we expose ``phase=briefing`` so the UI
        # can render "Briefing the team" instead of a generic play
        # status; otherwise it's a normal play turn. The ``finally``
        # clause guarantees a ``phase=None`` clear on every exit path
        # — including exceptions from the streamed LLM call, dispatcher,
        # or apply-outcome — so the indicator can never show a stale
        # label on the next thinking cycle.
        status_phase = "briefing" if session.state == SessionState.BRIEFING else "play"

        # Cumulative outcome across attempts. Holds the merged slot
        # set + appended messages + tool_results so the validator sees
        # everything that fired this turn, not just the latest attempt.
        cumulative = DispatchOutcome()

        # The directive (if any) that informed THIS attempt's narrowing.
        # On attempt 1 it's None (full palette). On recovery passes it
        # narrows tools + pins tool_choice + appends a system note.
        active_directive: RecoveryDirective | None = None

        # Prior LLM result + tool_results to splice into the next
        # attempt's messages array (the tool-loop feedback that lets
        # the model see what it just did + the dispatcher's response).
        prior_assistant_blocks: list[dict[str, Any]] | None = None
        prior_tool_results: list[dict[str, Any]] | None = None

        try:
            while attempt < budget:
                attempt += 1
                recovery = active_directive is not None
                # Labelled status: surface attempt N/M and the recovery kind
                # so the operator can tell "AI is on attempt 2/3 because
                # the first response missed a yield" from "AI is stuck"
                # (issue #63 — the strict-retry loop was previously
                # invisible to clients).
                # Only the directive ``kind`` (e.g. ``"missing_yield"``) goes
                # on the wire — NEVER the full ``user_nudge`` /
                # ``system_addendum`` text. Those carry plan-derived
                # structure that's creator-only; broadcasting them would
                # leak via the WS to participants.
                await self._emit_ai_status(
                    session.id,
                    phase=status_phase,
                    attempt=attempt,
                    budget=budget,
                    recovery=active_directive.kind if active_directive else None,
                    turn_index=turn.index,
                )

                # Build messages. On a recovery pass replace the trailing
                # kickoff/strict nudge with the directive's user_nudge,
                # then splice the prior assistant tool_use blocks +
                # dispatcher tool_results in as a proper Anthropic tool-
                # loop pair.
                messages = _play_messages(session, strict=recovery)
                if (
                    recovery
                    and active_directive is not None
                    and active_directive.replays_prior_tool_loop
                    and prior_assistant_blocks is not None
                    and prior_tool_results is not None
                ):
                    # Drop the trailing user nudge that ``_play_messages``
                    # appended; we'll re-insert a directive-specific one
                    # *after* the tool-loop pair.
                    if messages and messages[-1]["role"] == "user":
                        messages.pop()
                    messages.append({"role": "assistant", "content": prior_assistant_blocks})
                    # tool_results + the directive's user_nudge in one user
                    # turn so the message sequence stays user → assistant →
                    # user (Anthropic accepts mixed tool_result + text
                    # blocks within a single user message).
                    recovery_blocks: list[dict[str, Any]] = list(prior_tool_results)
                    recovery_blocks.append(
                        {"type": "text", "text": active_directive.user_nudge}
                    )
                    messages.append({"role": "user", "content": recovery_blocks})

                system_blocks = build_play_system_blocks(session, registry=registry)
                if active_directive is not None:
                    system_blocks.append(
                        {"type": "text", "text": active_directive.system_addendum}
                    )

                # Tool surface. Recovery narrows to the directive's
                # allowlist and pins tool_choice; first attempt exposes
                # the full palette + extensions.
                if active_directive is not None:
                    tools = [
                        t
                        for t in PLAY_TOOLS
                        if t["name"] in active_directive.tools_allowlist
                    ]
                    tool_choice = active_directive.tool_choice
                else:
                    tools = PLAY_TOOLS + dispatcher_extension_specs(registry)
                    tool_choice = None

                result = await self._streamed_play_call(
                    session=session,
                    turn=turn,
                    tier="play",
                    system_blocks=system_blocks,
                    messages=messages,
                    tools=tools,
                    tool_choice=tool_choice,
                )
                await self._apply_cost(session.id, result)
                self._check_truncation(
                    session_id=session.id, tier="play", result=result, turn_id=turn.id
                )

                tool_uses = _tool_uses(result)
                outcome = await dispatcher.dispatch(
                    session=session,
                    tool_uses=tool_uses,
                    turn_id=turn.id,
                    critical_inject_allowed_cb=lambda: critical_inject_allowed(
                        session,
                        max_per_5_turns=settings.max_critical_injects_per_5_turns,
                    ),
                )

                # Harvest the model's natural text content as the
                # creator-only decision rationale. Replaces the legacy
                # ``record_decision_rationale`` tool: when the model
                # emits a text block alongside its tool_use blocks
                # (its "thinking"), capture it for the creator log
                # without exposing it to players. Skipped on recovery
                # passes — the directive's intent is already known and
                # the prior turn's rationale still stands. Idempotent
                # per turn (one entry max).
                if not recovery and not any(
                    e.turn_id == turn.id for e in session.decision_log
                ):
                    rationale_text = _trim_rationale(_all_text(result))
                    if rationale_text:
                        from .models import DecisionLogEntry

                        entry = DecisionLogEntry(
                            turn_index=turn.index,
                            turn_id=turn.id,
                            rationale=rationale_text,
                        )
                        session.decision_log.append(entry)
                        if session.creator_role_id:
                            try:
                                await self._manager.connections().send_to_role(
                                    session.id,
                                    session.creator_role_id,
                                    {
                                        "type": "decision_logged",
                                        "entry": entry.model_dump(mode="json"),
                                    },
                                )
                            except Exception as exc:
                                _logger.warning(
                                    "decision_log_broadcast_failed",
                                    session_id=session.id,
                                    turn_id=turn.id,
                                    error=str(exc),
                                )

                # Merge into the cumulative outcome — this is what the
                # validator inspects.
                _merge_outcomes(cumulative, outcome)

                # Validate cumulative state against the contract.
                validation = validate(
                    session=session,
                    cumulative_slots=cumulative.slots,
                    contract=contract,
                    soft_drive_carve_out_enabled=settings.llm_recovery_drive_soft_on_open_question,
                )

                _logger.info(
                    "turn_validation",
                    session_id=session.id,
                    turn_index=turn.index,
                    attempt=attempt,
                    slots=sorted(s.value for s in cumulative.slots),
                    violations=[d.kind for d in validation.violations],
                    warnings=validation.warnings,
                    ok=validation.ok,
                )

                if validation.ok:
                    # Persist + advance state.
                    await self._apply_play_outcome(
                        session,
                        turn,
                        cumulative,
                        result_text=_all_text(result),
                    )
                    return session

                # Not ok — pick the highest-priority directive and run
                # another attempt (sequential calls, per the plan: DRIVE
                # before YIELD).
                if attempt >= budget:
                    break

                ordered = order_directives(validation.violations)
                active_directive = ordered[0]
                turn.retried_with_strict = True
                prior_assistant_blocks = result.content
                prior_tool_results = list(outcome.tool_results)
                _logger.info(
                    "turn_recovery_directive",
                    session_id=session.id,
                    turn_index=turn.index,
                    attempt=attempt,
                    kind=active_directive.kind,
                    tools=sorted(active_directive.tools_allowlist),
                )

            # Budget exhausted with violations remaining. If a YIELD did
            # land at some point we can still apply the outcome — players
            # at least see the partial work. If no YIELD ever fired the
            # turn is errored.
            if Slot.YIELD in cumulative.slots or Slot.TERMINATE in cumulative.slots:
                await self._apply_play_outcome(
                    session, turn, cumulative, result_text=""
                )
                return session

            turn.status = "errored"
            turn.error_reason = "model did not yield via a tool call"
            await self._manager.connections().broadcast(
                session.id,
                {
                    "type": "error",
                    "scope": "turn",
                    "message": "AI failed to yield. Use force-advance or retry.",
                    "turn_index": turn.index,
                },
            )
            return session
        finally:
            await self._emit_ai_status(session.id, phase=None)

    async def run_interject(
        self, *, session: Session, turn: Turn, for_role_id: str | None = None
    ) -> Session:
        """Side-channel AI response that does NOT advance the turn.

        Triggered when a player asks the facilitator a direct question
        mid-turn (heuristic: trailing ``?``). The AI is restricted to
        ``broadcast`` / ``address_role`` / ``share_data`` / ``pose_choice``,
        with ``tool_choice={"type":"any"}`` forcing at least one call.
        ``set_active_roles`` and ``end_session`` are deliberately
        excluded — the asking player's submission still counts toward
        the active turn and the other roles continue to owe their own
        responses; the interject just appends the AI's answer to the
        chat. State stays ``AWAITING_PLAYERS`` throughout.

        Engine-side guardrail: state must be ``AWAITING_PLAYERS`` (the
        play tier policy permits all three play states; this path
        narrows further).

        Pre-fix the operator had to either wait for every active role
        to submit (so the AI could process the full batch) or hit
        force-advance (which skipped the other roles entirely). Neither
        was right when the question was simple ("what open items do we
        have?") and the operator just wanted the AI to answer inline.
        """

        # Stricter than the play-tier policy: interject only ever runs
        # while we're waiting on players. If the engine called this in
        # AI_PROCESSING that'd indicate a state-machine bug — fail loud.
        if session.state != SessionState.AWAITING_PLAYERS:
            from .phase_policy import PhaseViolation

            raise PhaseViolation(
                "run_interject requires state=AWAITING_PLAYERS; "
                f"got {session.state.value!r}"
            )

        from ..llm.prompts import INTERJECT_NOTE

        dispatcher = self._manager.dispatcher()
        registry = self._manager.registry()
        _logger.info(
            "interject_start",
            session_id=session.id,
            turn_index=turn.index,
            for_role_id=for_role_id,
        )
        # Light up the labelled "Replying to {role}" status so the asking
        # participant + everyone else knows the AI received the question
        # and is composing an answer (issue #63 — without this the entire
        # interject path was invisible because it doesn't change
        # ``session.state``). The ``finally`` clause guarantees the
        # ``phase=None`` clear even if the streamed LLM call, dispatcher,
        # or persist raises — without try/finally a stale "Replying to X"
        # would otherwise be displayed on the next thinking cycle.
        await self._emit_ai_status(
            session.id,
            phase="interject",
            turn_index=turn.index,
            for_role_id=for_role_id,
        )

        try:
            messages = _play_messages(session, strict=False)
            system_blocks = build_play_system_blocks(session, registry=registry)
            system_blocks.append({"type": "text", "text": INTERJECT_NOTE})
            # Surface ``for_role_id`` directly in the system context so
            # the model doesn't have to guess which transcript message
            # triggered this interject (issue #78 prompt-expert review:
            # multiple roles posting in quick succession can confuse the
            # "look at the most recent ?" heuristic). Cheap — ~30 tokens.
            asker_role = (
                session.role_by_id(for_role_id) if for_role_id else None
            )
            if asker_role is not None:
                asker_label = asker_role.label
                if asker_role.display_name:
                    asker_label = f"{asker_role.label} / {asker_role.display_name}"
                system_blocks.append(
                    {
                        "type": "text",
                        "text": (
                            "## Interject context\n"
                            f"The player who triggered this interject is "
                            f"role_id=`{for_role_id}` ({asker_label}). "
                            "Answer them directly, by name, in your "
                            "first tool call."
                        ),
                    }
                )

            # Narrow tools to non-yielding narration only. ``set_active_roles``
            # / ``end_session`` are the two yielding/terminal calls; excluding
            # them guarantees the interject can't accidentally advance the
            # turn or end the session.
            # Player-facing replies. Includes ``share_data`` for "show
            # me the logs" / "give me the IOCs" interjects, and
            # ``pose_choice`` for "should I A or B?" interjects where
            # a structured option list helps.
            allowed = {
                "broadcast",
                "address_role",
                "share_data",
                "pose_choice",
            }
            tools = [t for t in PLAY_TOOLS if t["name"] in allowed]
            tool_choice: dict[str, Any] = {"type": "any"}

            result = await self._streamed_play_call(
                session=session,
                turn=turn,
                tier="play",
                system_blocks=system_blocks,
                messages=messages,
                tools=tools,
                tool_choice=tool_choice,
            )
            await self._apply_cost(session.id, result)

            tool_uses = _tool_uses(result)
            outcome = await dispatcher.dispatch(
                session=session,
                tool_uses=tool_uses,
                turn_id=turn.id,
                critical_inject_allowed_cb=lambda: critical_inject_allowed(
                    session,
                    max_per_5_turns=self._manager.settings().max_critical_injects_per_5_turns,
                ),
            )
            # Persist appended messages but do NOT touch turn state — the
            # interject is purely additive content.
            for msg in outcome.appended_messages:
                session.messages.append(msg)
                await self._manager.connections().broadcast(
                    session.id,
                    {
                        "type": "message_complete",
                        "kind": msg.kind.value,
                        "body": msg.body,
                        "tool_name": msg.tool_name,
                        "tool_args": msg.tool_args,
                        "turn_id": turn.id,
                    },
                )
            await self._manager._repo.save(session)
            return session
        finally:
            await self._emit_ai_status(session.id, phase=None)

    # ------------------------------------------------- internals
    async def _streamed_play_call(
        self,
        *,
        session: Session,
        turn: Turn,
        tier: str,
        system_blocks: list[dict[str, Any]],
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        tool_choice: dict[str, Any] | None = None,
    ) -> LLMResult:
        result_holder: dict[str, Any] = {}
        async for event in self._manager.llm().astream(
            tier="play",
            system_blocks=system_blocks,
            messages=messages,
            tools=tools,
            # Per-tier default from settings.max_tokens_for(tier) — call passes None.
            session_id=session.id,
            tool_choice=tool_choice,
        ):
            etype = event.get("type")
            if etype == "text_delta":
                await self._manager.connections().broadcast(
                    session.id,
                    {
                        "type": "message_chunk",
                        "turn_id": turn.id,
                        "text": event.get("text", ""),
                    },
                )
            elif etype == "complete":
                result_holder["result"] = event["result"]
        result = result_holder["result"]
        assert isinstance(result, LLMResult)
        return result

    async def _apply_setup_outcome(
        self, session: Session, outcome: DispatchOutcome
    ) -> None:
        # Append AI messages produced
        for msg in outcome.appended_messages:
            session.messages.append(msg)
        if outcome.proposed_plan is not None:
            # Persist the proposal as a draft on the session so the snapshot
            # endpoint can surface it to the creator. State stays SETUP — only
            # ``finalize_setup`` (AI- or operator-initiated) flips to READY.
            session.plan = outcome.proposed_plan
            # IMPORTANT: plan content is creator-only (docs/prompts.md Block 4
            # rule #4). Broadcasting it would leak via the WS replay buffer to
            # any future-connecting non-creator role. Send the body only to the
            # creator; broadcast a content-free announcement so other clients
            # know a plan is in flight.
            if session.creator_role_id:
                await self._manager.connections().send_to_role(
                    session.id,
                    session.creator_role_id,
                    {
                        "type": "plan_proposed",
                        "plan": outcome.proposed_plan.model_dump(),
                    },
                )
            await self._manager.connections().broadcast(
                session.id,
                {"type": "plan_proposed_announcement"},
            )
        if outcome.finalized_plan is not None:
            session.plan = outcome.finalized_plan
            from .turn_engine import assert_transition

            assert_transition(session.state, SessionState.READY)
            session.state = SessionState.READY
            if session.creator_role_id:
                await self._manager.connections().send_to_role(
                    session.id,
                    session.creator_role_id,
                    {
                        "type": "plan_finalized",
                        "plan": outcome.finalized_plan.model_dump(),
                    },
                )
            await self._manager.connections().broadcast(
                session.id,
                {"type": "plan_finalized_announcement"},
            )
        # Always persist via repository
        await self._manager._repo.save(session)

    async def _apply_play_outcome(
        self,
        session: Session,
        turn: Turn,
        outcome: DispatchOutcome,
        *,
        result_text: str,
    ) -> None:
        if result_text and not any(
            m.kind == MessageKind.AI_TEXT and m.tool_name is None for m in outcome.appended_messages
        ):
            # Capture freeform AI text if no tool already captured it
            session.messages.append(
                Message(
                    kind=MessageKind.AI_TEXT,
                    body=result_text,
                    turn_id=turn.id,
                )
            )

        for msg in outcome.appended_messages:
            session.messages.append(msg)
            await self._manager.connections().broadcast(
                session.id,
                {
                    "type": "message_complete",
                    "kind": msg.kind.value,
                    "body": msg.body,
                    "tool_name": msg.tool_name,
                    "turn_id": msg.turn_id,
                },
            )

        if outcome.critical_inject_fired:
            session.critical_injects_window.append(turn.index)
            session.critical_injects_window = [
                i for i in session.critical_injects_window if turn.index - i < 5
            ]

        if outcome.end_session_reason is not None:
            from .turn_engine import assert_transition

            turn.status = "complete"
            turn.ended_at = _now()
            assert_transition(session.state, SessionState.ENDED)
            session.state = SessionState.ENDED
            session.ended_at = _now()
            session.aar_status = "pending"
            await self._manager._repo.save(session)
            await self._manager.connections().broadcast(
                session.id,
                {
                    "type": "state_changed",
                    "state": session.state.value,
                    "active_role_ids": [],
                    "turn_index": turn.index,
                },
            )
            # AI-initiated end — kick the AAR generator. Mirrors what the
            # creator-initiated /end REST path does.
            await self._manager.trigger_aar_generation(session.id)
            return

        if outcome.set_active_role_ids is not None:
            # Server-side audience-vs-yield safety net. The play-tier
            # model habitually yields wider than its actual audience
            # (broadcasts "Ben — your call?" and yields to [Ben, Eng]
            # even though Eng wasn't asked anything), which stalls the
            # turn until force-advance. The narrower drops role_ids
            # whose canonical name isn't addressed in the same-turn
            # player-facing text. See ``active_roles.py`` for the
            # heuristic + edge-case coverage in
            # ``tests/test_active_roles_narrowing.py``.
            narrow_result = narrow_active_roles(
                roles=session.roles,
                appended_messages=outcome.appended_messages,
                ai_set=list(outcome.set_active_role_ids),
            )
            final_active_role_ids = narrow_result.kept
            if narrow_result.narrowed:
                # Build human-readable label list for the audit + decision
                # log so the creator can see what the engine did. We
                # intentionally use ``label`` here (not display_name)
                # because the AI Decision Log surface is operator-
                # focused.
                role_by_id = {r.id: r for r in session.roles}
                dropped_labels = [
                    role_by_id[rid].label
                    for rid in narrow_result.dropped
                    if rid in role_by_id
                ]
                kept_labels = [
                    role_by_id[rid].label
                    for rid in narrow_result.kept
                    if rid in role_by_id
                ]
                _logger.info(
                    "active_roles_narrowed",
                    session_id=session.id,
                    turn_id=turn.id,
                    turn_index=turn.index,
                    ai_set=list(outcome.set_active_role_ids),
                    kept=narrow_result.kept,
                    dropped=narrow_result.dropped,
                    dropped_labels=dropped_labels,
                    # The full set of roles the matcher considered
                    # addressed — including any the AI didn't yield
                    # to. Surfaces the "AI under-yielded" failure
                    # mode (addressed Ben in text but yield was
                    # [Eng]) as a diagnostic without requiring a
                    # re-run.
                    addressed_role_ids=sorted(narrow_result.addressed_role_ids),
                    reason=narrow_result.reason,
                )
                # Surface to the creator-only decision log so the
                # operator can see the engine's reasoning. Players
                # never see this — exposing engine internals to them
                # is confusing. The structlog line above is the
                # canonical audit record.
                rationale = (
                    f"Narrowed active roles: kept {kept_labels}, "
                    f"dropped {dropped_labels} — not addressed in this "
                    f"turn's message."
                )
                entry = DecisionLogEntry(
                    turn_index=turn.index,
                    turn_id=turn.id,
                    rationale=rationale,
                )
                session.decision_log.append(entry)
                if session.creator_role_id:
                    try:
                        await self._manager.connections().send_to_role(
                            session.id,
                            session.creator_role_id,
                            {
                                "type": "decision_logged",
                                "entry": entry.model_dump(mode="json"),
                            },
                        )
                    except Exception as exc:
                        # Correlation context: turn_id + entry_id let the
                        # operator find the persisted decision_log entry
                        # (it was already appended to session.decision_log
                        # before we attempted the broadcast) so they can
                        # tell the creator what the engine decided even
                        # though the WS event didn't reach them. The
                        # session repo save is the durable record; this
                        # log is the breadcrumb that ties the failure to
                        # a specific row.
                        _logger.warning(
                            "narrow_decision_log_broadcast_failed",
                            session_id=session.id,
                            turn_id=turn.id,
                            entry_id=entry.id,
                            error=str(exc),
                        )
            turn.status = "complete"
            turn.ended_at = _now()
            new_index = len(session.turns)
            new_turn = Turn(
                index=new_index,
                active_role_ids=final_active_role_ids,
                status="awaiting",
            )
            session.turns.append(new_turn)
            session.state = SessionState.AWAITING_PLAYERS
            await self._manager._repo.save(session)
            await self._manager.connections().broadcast(
                session.id,
                {
                    "type": "turn_changed",
                    "turn_index": new_turn.index,
                    "active_role_ids": new_turn.active_role_ids,
                },
            )
            await self._manager.connections().broadcast(
                session.id,
                {
                    "type": "state_changed",
                    "state": session.state.value,
                    "active_role_ids": new_turn.active_role_ids,
                    "turn_index": new_turn.index,
                },
            )
        else:
            # No yielding tool fired AND no end_session — the turn engine
            # stays in AI_PROCESSING. Intentional: the run_play_turn caller
            # will either spin the strict retry (and the frontend's
            # ``aiThinking`` predicate keeps the typing indicator lit
            # without a flicker) or mark the turn errored if both attempts
            # have been exhausted.
            await self._manager._repo.save(session)

    async def _apply_cost(self, session_id: str, result: LLMResult) -> None:
        await self._manager.add_cost(
            session_id=session_id,
            usage=result.usage,
            estimated_usd=result.estimated_usd,
        )


def dispatcher_extension_specs(registry: FrozenRegistry) -> list[dict[str, Any]]:
    return [
        {
            "name": tool.name,
            "description": tool.description,
            "input_schema": tool.input_schema,
        }
        for tool in registry.tools.values()
    ]


def _setup_messages(session: Session) -> list[dict[str, Any]]:
    msgs: list[dict[str, Any]] = []
    for note in session.setup_notes:
        role = "assistant" if note.speaker == "ai" else "user"
        msgs.append({"role": role, "content": note.content})
    if not msgs:
        msgs.append({"role": "user", "content": session.scenario_prompt})
    return msgs


_SETUP_TOOL_NAMES = frozenset(
    {
        "ask_setup_question",
        "propose_scenario_plan",
        "finalize_setup",
        # Synthetic marker: see ``run_setup_turn`` bare-text branch.
        # Tagging the setup-tier AI text with this name lets
        # ``_play_messages`` filter it the same way actual setup-tool
        # messages are filtered — keeping the setup conversation out
        # of the play tier's history.
        "setup_bare_text",
    }
)

_KICKOFF_USER_MSG = (
    "Begin the exercise. Your FIRST tool call MUST be `broadcast` with the "
    "situation brief — what just happened, what the active roles need to "
    "do, ≤200 words. THEN call `set_active_roles` to yield to those roles. "
    "Do NOT call only bookkeeping tools (`track_role_followup`, "
    "`request_artifact`, etc.) — those produce no chat bubble and leave "
    "players with nothing to respond to. The brief is mandatory on this "
    "turn."
)

# Per-turn reminder appended after the player batch on EVERY normal play
# turn. Without this the model often picks one tool (e.g. `share_data`)
# and stops, never yielding. The reminder lands as the last user-message
# block before the model's response and counters the "first tool wins,
# stop" attractor. Anthropic merges consecutive same-role user blocks,
# so this concatenates with the player message label without producing a
# malformed message sequence.
_TURN_REMINDER = (
    "[system] Your turn. Emit your tool calls in ONE response: a player-"
    "facing tool (`broadcast`, `address_role`, or `share_data`) AND "
    "`set_active_roles` (or `end_session`). A short text block with "
    "your reasoning is fine; the engine harvests it as the creator-only "
    "rationale. Stopping after a single tool call is a bug — players "
    "see no message and the turn never advances."
)


def _play_messages(session: Session, *, strict: bool = False) -> list[dict[str, Any]]:
    """Build the Anthropic ``messages`` array for a play-tier call.

    Invariants enforced here:

    1. Setup-tool messages never appear (they belong in ``setup_notes`` only).
       This is belt-and-braces: ``dispatch.py`` is the primary gate.
    2. The list is non-empty.
    3. The last message is ``role="user"``. Sonnet rejects conversations that
       end with an assistant turn ("does not support assistant message
       prefill"). When the cleaned transcript has no entries or trails on an
       assistant turn we append a kickoff prompt as the user message.

    On the strict-retry path (``strict=True``), the trailing user message
    becomes a strict-specific nudge instead of the kickoff. The kickoff text
    ("Begin the exercise. Open with a brief situation broadcast and yield...")
    actively encourages another broadcast — exactly what we're trying to
    prevent on the retry.
    """

    msgs: list[dict[str, Any]] = []

    for m in session.messages:
        if m.tool_name in _SETUP_TOOL_NAMES:
            continue  # setup conversation lives in setup_notes
        if m.kind == MessageKind.PLAYER:
            label = ""
            role = session.role_by_id(m.role_id) if m.role_id else None
            if role:
                label = f"[{role.label}"
                if role.display_name:
                    label += f" / {role.display_name}"
                label += "] "
            # Issue #78: mark out-of-turn interjections so the model
            # doesn't mistake the speaker for an active responder. The
            # play-tier system prompt (Block 6) and ``INTERJECT_NOTE``
            # both reference this exact prefix — change here means
            # change there.
            if m.is_interjection:
                label = "[OUT-OF-TURN] " + label
            msgs.append({"role": "user", "content": label + m.body})
        elif m.kind in (
            MessageKind.AI_TEXT,
            MessageKind.AI_TOOL_CALL,
            MessageKind.AI_TOOL_RESULT,
        ):
            msgs.append({"role": "assistant", "content": m.body})
        elif m.kind == MessageKind.SYSTEM:
            msgs.append({"role": "user", "content": f"[system] {m.body}"})
        elif m.kind == MessageKind.CRITICAL_INJECT:
            msgs.append({"role": "assistant", "content": m.body})

    # Per-turn reminder block — counters the "first tool wins, stop"
    # attractor we observed against the live model. Appended on every
    # normal turn (skipped when ``strict=True`` because the recovery
    # pass replaces this trailing block with its own directive nudge
    # anyway). Anthropic merges consecutive same-role user blocks at
    # the wire level, so two user-blocks in a row is fine — we keep
    # them as separate dict entries here only because the recovery
    # path expects to pop the last user block and re-insert its own.
    if not strict and msgs and msgs[-1]["role"] == "user":
        msgs.append({"role": "user", "content": _TURN_REMINDER})

    if not msgs or msgs[-1]["role"] != "user":
        # On a recovery pass the driver pops this trailing nudge and
        # replaces it with a directive-specific user message that
        # carries the prior tool_results + the directive's nudge. So
        # the kickoff text only ever lands on the *first* attempt of
        # the BRIEFING turn (or any subsequent play turn that needs a
        # synthetic trailing user message because the transcript ends
        # on assistant). The ``strict`` parameter is preserved as a
        # hook for callers that need a generic placeholder (no longer
        # used by the driver, kept so external tests don't break).
        _ = strict
        msgs.append({"role": "user", "content": _KICKOFF_USER_MSG})
    return msgs


def _tool_uses(result: LLMResult) -> list[dict[str, Any]]:
    return [b for b in result.content if b.get("type") == "tool_use"]


def _all_text(result: LLMResult) -> str:
    return "".join(b.get("text", "") for b in result.content if b.get("type") == "text")


# Cap so a runaway model can't explode the snapshot payload or AAR.
# Mirrors the cap from the legacy ``record_decision_rationale`` tool.
_RATIONALE_MAX_CHARS = 600


def _trim_rationale(text: str) -> str:
    text = text.strip()
    if len(text) <= _RATIONALE_MAX_CHARS:
        return text
    return text[: _RATIONALE_MAX_CHARS - 1] + "…"


def _merge_outcomes(target: DispatchOutcome, src: DispatchOutcome) -> None:
    """Fold ``src`` into ``target`` in place. Used by the validator
    loop to maintain a cumulative outcome across recovery attempts.

    Slot semantics: union (a DRIVE on attempt 1 still satisfies the
    contract on attempt 2 even if attempt 2 only emitted YIELD).

    Message / tool_result semantics: append in order so the chat
    timeline reflects the order things actually happened.

    State-singleton fields (``set_active_role_ids``, ``end_session_reason``,
    plan fields): last-write-wins. The driver runs DRIVE before YIELD,
    so the YIELD attempt's ``set_active_role_ids`` correctly wins.
    """

    target.tool_results.extend(src.tool_results)
    target.appended_messages.extend(src.appended_messages)
    target.slots |= src.slots
    if src.set_active_role_ids is not None:
        target.set_active_role_ids = src.set_active_role_ids
    if src.end_session_reason is not None:
        target.end_session_reason = src.end_session_reason
    if src.proposed_plan is not None:
        target.proposed_plan = src.proposed_plan
    if src.finalized_plan is not None:
        target.finalized_plan = src.finalized_plan
    target.critical_inject_fired = (
        target.critical_inject_fired or src.critical_inject_fired
    )
    target.had_yielding_call = target.had_yielding_call or src.had_yielding_call
    target.had_player_facing_message = (
        target.had_player_facing_message or src.had_player_facing_message
    )


def _now() -> datetime:
    return datetime.now(UTC)
