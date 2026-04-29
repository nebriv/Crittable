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
        tool_uses = self._dedupe_setup_questions(session, tool_uses, outcome=outcome)
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
            outcome.appended_messages.append(
                Message(
                    kind=MessageKind.AI_TEXT,
                    body=f"@{label}: {args.get('message', '')}",
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

        if name == "mark_timeline_point":
            # The actual title/note are stored in ``tool_args`` so the
            # frontend Timeline can extract them. The visible message body
            # is just the note (or the title if no note); keep this short
            # because it shows in the chat too.
            title = str(args.get("title", "")).strip()
            note = str(args.get("note", "")).strip()
            outcome.appended_messages.append(
                Message(
                    kind=MessageKind.AI_TEXT,
                    body=note or title,
                    turn_id=turn_id,
                    tool_name=name,
                    tool_args=args,
                )
            )
            return "timeline point pinned"

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
    pass


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
