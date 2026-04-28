"""Tool-call dispatcher for the play and setup tiers.

Receives Claude's `tool_use` blocks (already JSON-validated by Anthropic),
routes them to the right side-effect, and synthesises `tool_result` content
that the next API call replays back to the model.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

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
)

if TYPE_CHECKING:
    from ..ws.connection_manager import ConnectionManager

_logger = get_logger("llm.dispatch")


class DispatchOutcome:
    """Aggregates side-effect descriptors so the SessionManager can react."""

    def __init__(self) -> None:
        self.tool_results: list[dict[str, Any]] = []
        self.appended_messages: list[Message] = []
        self.set_active_role_ids: list[str] | None = None
        self.end_session_reason: str | None = None
        self.proposed_plan: ScenarioPlan | None = None
        self.finalized_plan: ScenarioPlan | None = None
        self.critical_inject_fired: bool = False
        self.had_yielding_call: bool = False

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
    ) -> None:
        self._connections = connections
        self._audit = audit
        self._extensions = extension_dispatcher
        self._registry = registry
        self._max_critical = max_critical_injects_per_5_turns

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
        coros = [
            self._dispatch_one(
                session=session,
                tool_use=tu,
                turn_id=turn_id,
                outcome=outcome,
                critical_inject_allowed_cb=critical_inject_allowed_cb,
            )
            for tu in tool_uses
        ]
        await asyncio.gather(*coros)
        return outcome

    async def _dispatch_one(
        self,
        *,
        session: Session,
        tool_use: dict[str, Any],
        turn_id: str | None,
        outcome: DispatchOutcome,
        critical_inject_allowed_cb: Any,
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
            )
            outcome.add_result(tool_use_id=tool_id, content=content)
        except _DispatchError as exc:
            outcome.add_result(
                tool_use_id=tool_id,
                content=str(exc),
                is_error=True,
            )
            self._audit.emit(
                AuditEvent(
                    kind="tool_use_rejected",
                    session_id=session.id,
                    turn_id=turn_id,
                    payload={"name": name, "reason": str(exc)},
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
    ) -> str:
        if state == SessionState.SETUP:
            if name not in {"ask_setup_question", "propose_scenario_plan", "finalize_setup"}:
                raise _DispatchError(f"tool '{name}' not allowed during SETUP")
        elif state == SessionState.ENDED:
            raise _DispatchError("session is ended; no tools may run")
        else:
            if name in {"ask_setup_question", "propose_scenario_plan", "finalize_setup"}:
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
            try:
                plan = ScenarioPlan.model_validate(_normalize_plan(args))
            except Exception as exc:
                raise _DispatchError(f"invalid plan: {exc}") from exc
            outcome.proposed_plan = plan
            outcome.had_yielding_call = True
            return "plan proposed; creator will review or request edits"

        if name == "finalize_setup":
            try:
                plan = ScenarioPlan.model_validate(_normalize_plan(args))
            except Exception as exc:
                raise _DispatchError(f"invalid plan: {exc}") from exc
            outcome.finalized_plan = plan
            outcome.had_yielding_call = True
            return "plan finalized; session is now READY"

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
            return "broadcast queued"

        if name == "address_role":
            outcome.appended_messages.append(
                Message(
                    kind=MessageKind.AI_TEXT,
                    body=f"@{args.get('role_id')}: {args.get('message', '')}",
                    turn_id=turn_id,
                    tool_name=name,
                    tool_args=args,
                )
            )
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

        if name == "inject_critical_event":
            allowed = await _maybe_call(critical_inject_allowed_cb)
            if not allowed:
                raise _DispatchError("critical-event rate limit hit")
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
            role_ids = list(args.get("role_ids") or [])
            unknown = [r for r in role_ids if not session.role_by_id(r)]
            if unknown:
                raise _DispatchError(f"unknown role_ids: {unknown}")
            outcome.set_active_role_ids = role_ids
            outcome.had_yielding_call = True
            return f"yielded to {role_ids}"

        if name == "request_artifact":
            outcome.appended_messages.append(
                Message(
                    kind=MessageKind.AI_TEXT,
                    body=(
                        f"[Artifact request] {args.get('artifact_type','')} from "
                        f"{args.get('role_id','')}: {args.get('instructions','')}"
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
    pass


async def _maybe_call(cb: Any) -> Any:
    if cb is None:
        return True
    if asyncio.iscoroutinefunction(cb):
        return await cb()
    result = cb()
    if asyncio.iscoroutine(result):
        return await result
    return result


def _normalize_plan(args: dict[str, Any]) -> dict[str, Any]:
    """Best-effort coerce loose model output into ScenarioPlan shape.

    Some model outputs put narrative arc beats / injects as raw dicts; the
    pydantic models accept that natively. We fill in defaults for missing
    optional fields.
    """

    plan = dict(args)
    plan.setdefault("executive_summary", "")
    plan.setdefault("key_objectives", [])
    plan.setdefault("narrative_arc", [])
    plan.setdefault("injects", [])
    plan.setdefault("guardrails", [])
    plan.setdefault("success_criteria", [])
    plan.setdefault("out_of_scope", [])
    # If beats/injects were passed as plain dicts, ScenarioBeat / ScenarioInject
    # validate them — no extra coercion needed. This call is a no-op assertion.
    _ = ScenarioBeat
    _ = ScenarioInject
    return plan


def _safe_get_setup(session: Session, key: str) -> str:
    """Pull a setup-note value (e.g. industry) without exposing PII."""

    for note in session.setup_notes:
        if note.topic and note.topic.lower().startswith(key.lower()):
            return note.content[:64]
    return ""
