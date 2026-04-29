"""Drive a single AI turn end-to-end.

Sits on top of :class:`~.manager.SessionManager`. Pulled out of the manager so
the manager file stays focused on state transitions and locking.

Flow per turn (BRIEFING / AI_PROCESSING):
1. Build messages from current transcript.
2. Call the LLM (streamed for play, non-streamed for setup).
3. If the model returned text deltas, fan them out as ``message_chunk``
   events.
4. Dispatch tool_use blocks via the ToolDispatcher.
5. If the dispatcher reports no yielding tool call, retry once with a strict
   "you must yield via a tool" system note. Mark errored if it still fails.
6. Apply outcome: append messages, persist plan, set active roles, end session.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from ..extensions.registry import FrozenRegistry
from ..llm.client import LLMResult
from ..llm.dispatch import DispatchOutcome
from ..llm.prompts import (
    build_play_system_blocks,
    build_setup_system_blocks,
)
from ..llm.tools import PLAY_TOOLS, SETUP_TOOLS
from ..logging_setup import get_logger
from .manager import SessionManager
from .models import (
    Message,
    MessageKind,
    Session,
    SessionState,
    Turn,
)
from .turn_engine import critical_inject_allowed

_logger = get_logger("session.turn_driver")


_STRICT_RETRY_NOTE = (
    "STRICT RETRY: your previous attempt did not yield. The narrative beat "
    "has already been narrated — DO NOT repeat or rephrase it. Your only "
    "job on this turn is to call `set_active_roles` with the role_ids that "
    "should respond next. The tool surface has been narrowed and "
    "tool_choice forces a call to `set_active_roles`; you cannot end the "
    "session on a strict-retry pass."
)

# Replaces the generic ``_KICKOFF_USER_MSG`` on the strict-retry pass so the
# trailing user turn doesn't tell the model to "begin the exercise" (which
# would conflict with the strict note's "do not re-narrate").
_STRICT_RETRY_USER_NUDGE = (
    "[system] Your previous tool calls did not include a yielding tool. "
    "The narrative is already in the transcript. Call `set_active_roles` "
    "now with the role_ids that should respond."
)


class TurnDriver:
    def __init__(self, *, manager: SessionManager) -> None:
        self._manager = manager

    async def run_setup_turn(self, *, session: Session) -> Session:
        """Drive one setup-tier turn. May loop internally if Claude chains tools."""

        llm = self._manager.llm()
        dispatcher = self._manager.dispatcher()
        _logger.info(
            "setup_turn_start",
            session_id=session.id,
            note_count=len(session.setup_notes),
            has_plan=session.plan is not None,
        )

        for _ in range(4):  # safety cap on chained setup tool calls
            messages = _setup_messages(session)
            result = await llm.acomplete(
                tier="setup",
                system_blocks=build_setup_system_blocks(session),
                messages=messages,
                tools=SETUP_TOOLS,
                # Per-tier default from settings.max_tokens_for(tier) — call passes None.
                session_id=session.id,
            )
            await self._apply_cost(session.id, result)

            tool_uses = _tool_uses(result)
            if not tool_uses:
                # Bare text — append and yield to creator
                text = _all_text(result)
                if text:
                    session.messages.append(
                        Message(kind=MessageKind.AI_TEXT, body=text)
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

    async def run_play_turn(self, *, session: Session, turn: Turn) -> Session:
        """Drive one play-tier turn. May retry once strictly on missing yield."""

        dispatcher = self._manager.dispatcher()
        registry = self._manager.registry()
        _logger.info(
            "play_turn_start",
            session_id=session.id,
            turn_index=turn.index,
            roster=len(session.roles),
            roster_size=session.roster_size,
        )

        attempt = 0
        strict = False
        while attempt < 2:
            attempt += 1
            messages = _play_messages(session, strict=strict)
            system_blocks = build_play_system_blocks(session, registry=registry)
            tool_choice: dict[str, Any] | None = None

            if strict:
                # Sonnet has been observed running ``broadcast`` only and
                # ignoring the "yield via a tool" instruction even when the
                # strict-retry note is appended. To make recovery
                # *structural* rather than relying on prompt obedience:
                #
                #   1. Narrow the tool list to only ``set_active_roles``.
                #   2. Pin ``tool_choice`` to that specific tool so Anthropic
                #      MUST emit a ``set_active_roles`` call — the model
                #      cannot end the session on a recovery pass (which
                #      would be a worse UX than the original stuck turn).
                #
                # End-of-exercise still happens via the AI's normal
                # ``end_session`` call on a regular play turn — never as a
                # side-effect of recovery.
                tools = [t for t in PLAY_TOOLS if t["name"] == "set_active_roles"]
                tool_choice = {"type": "tool", "name": "set_active_roles"}
                system_blocks.append(
                    {
                        "type": "text",
                        "text": _STRICT_RETRY_NOTE,
                    }
                )
            else:
                tools = PLAY_TOOLS + dispatcher_extension_specs(registry)

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
            await self._apply_play_outcome(session, turn, outcome, result_text=_all_text(result))

            if outcome.had_yielding_call:
                return session

            strict = True
            turn.retried_with_strict = True

        # Both attempts failed — mark errored
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

    async def run_interject(self, *, session: Session, turn: Turn) -> Session:
        """Side-channel AI response that does NOT advance the turn.

        Triggered when a player asks the facilitator a direct question
        mid-turn (heuristic: trailing ``?``). The AI is restricted to
        ``broadcast`` / ``address_role`` / ``mark_timeline_point``, with
        ``tool_choice={"type":"any"}`` forcing at least one call.
        ``set_active_roles`` and ``end_session`` are deliberately
        excluded — the asking player's submission still counts toward
        the active turn and the other roles continue to owe their own
        responses; the interject just appends the AI's answer to the
        chat. State stays ``AWAITING_PLAYERS`` throughout.

        Pre-fix the operator had to either wait for every active role
        to submit (so the AI could process the full batch) or hit
        force-advance (which skipped the other roles entirely). Neither
        was right when the question was simple ("what open items do we
        have?") and the operator just wanted the AI to answer inline.
        """

        from ..llm.prompts import INTERJECT_NOTE

        dispatcher = self._manager.dispatcher()
        registry = self._manager.registry()
        _logger.info(
            "interject_start",
            session_id=session.id,
            turn_index=turn.index,
        )

        messages = _play_messages(session, strict=False)
        system_blocks = build_play_system_blocks(session, registry=registry)
        system_blocks.append({"type": "text", "text": INTERJECT_NOTE})

        # Narrow tools to non-yielding narration only. ``set_active_roles``
        # / ``end_session`` are the two yielding/terminal calls; excluding
        # them guarantees the interject can't accidentally advance the
        # turn or end the session.
        allowed = {"broadcast", "address_role", "mark_timeline_point"}
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
            turn.status = "complete"
            turn.ended_at = _now()
            new_index = len(session.turns)
            new_turn = Turn(
                index=new_index,
                active_role_ids=outcome.set_active_role_ids,
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
    {"ask_setup_question", "propose_scenario_plan", "finalize_setup"}
)

_KICKOFF_USER_MSG = (
    "Begin the exercise. Open with a brief situation broadcast and yield to "
    "the appropriate roles."
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

    if not msgs or msgs[-1]["role"] != "user":
        # On strict retry the trailing user turn must NOT say "begin the
        # exercise" — that contradicts the strict-retry system note and
        # nudges the model toward another broadcast. Use a focused nudge.
        nudge = _STRICT_RETRY_USER_NUDGE if strict else _KICKOFF_USER_MSG
        msgs.append({"role": "user", "content": nudge})
    return msgs


def _tool_uses(result: LLMResult) -> list[dict[str, Any]]:
    return [b for b in result.content if b.get("type") == "tool_use"]


def _all_text(result: LLMResult) -> str:
    return "".join(b.get("text", "") for b in result.content if b.get("type") == "text")


def _now() -> datetime:
    return datetime.now(UTC)
