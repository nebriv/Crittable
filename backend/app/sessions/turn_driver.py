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
    "Reminder: every play turn must end with `set_active_roles` (yield) or "
    "`end_session` (wrap). Free-form prose without a yielding tool is invalid. "
    "Try again."
)


class TurnDriver:
    def __init__(self, *, manager: SessionManager) -> None:
        self._manager = manager

    async def run_setup_turn(self, *, session: Session) -> Session:
        """Drive one setup-tier turn. May loop internally if Claude chains tools."""

        llm = self._manager.llm()
        dispatcher = self._manager.dispatcher()

        for _ in range(4):  # safety cap on chained setup tool calls
            messages = _setup_messages(session)
            result = await llm.acomplete(
                tier="setup",
                system_blocks=build_setup_system_blocks(session),
                messages=messages,
                tools=SETUP_TOOLS,
                max_tokens=1024,
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
            if outcome.finalized_plan is not None:
                return session
            if outcome.proposed_plan is not None:
                return session
            # Otherwise the AI asked a question and is yielding — return.
            if any(
                m.tool_name == "ask_setup_question" for m in outcome.appended_messages
            ):
                return session
        return session

    async def run_play_turn(self, *, session: Session, turn: Turn) -> Session:
        """Drive one play-tier turn. May retry once strictly on missing yield."""

        dispatcher = self._manager.dispatcher()
        registry = self._manager.registry()

        attempt = 0
        strict = False
        while attempt < 2:
            attempt += 1
            tools = PLAY_TOOLS + dispatcher_extension_specs(registry)
            messages = _play_messages(session)
            system_blocks = build_play_system_blocks(session, registry=registry)
            if strict:
                system_blocks.append({"type": "text", "text": _STRICT_RETRY_NOTE})

            result = await self._streamed_play_call(
                session=session,
                turn=turn,
                tier="play",
                system_blocks=system_blocks,
                messages=messages,
                tools=tools,
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
    ) -> LLMResult:
        result_holder: dict[str, Any] = {}
        async for event in self._manager.llm().astream(
            tier="play",
            system_blocks=system_blocks,
            messages=messages,
            tools=tools,
            max_tokens=1024,
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
            await self._manager.connections().broadcast(
                session.id,
                {
                    "type": "plan_proposed",
                    "plan": outcome.proposed_plan.model_dump(),
                },
            )
        if outcome.finalized_plan is not None:
            session.plan = outcome.finalized_plan
            from .turn_engine import assert_transition

            assert_transition(session.state, SessionState.READY)
            session.state = SessionState.READY
            await self._manager.connections().broadcast(
                session.id,
                {
                    "type": "plan_finalized",
                    "plan": outcome.finalized_plan.model_dump(),
                },
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


def _play_messages(session: Session) -> list[dict[str, Any]]:
    msgs: list[dict[str, Any]] = []
    if not session.messages:
        msgs.append(
            {
                "role": "user",
                "content": (
                    "Begin the exercise. Open with a brief situation broadcast and "
                    "yield to the appropriate roles."
                ),
            }
        )
        return msgs
    for m in session.messages:
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
    return msgs


def _tool_uses(result: LLMResult) -> list[dict[str, Any]]:
    return [b for b in result.content if b.get("type") == "tool_use"]


def _all_text(result: LLMResult) -> str:
    return "".join(b.get("text", "") for b in result.content if b.get("type") == "text")


def _now() -> datetime:
    return datetime.now(UTC)
