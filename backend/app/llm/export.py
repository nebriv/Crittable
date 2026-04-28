"""End-of-session AAR + markdown export.

One Opus call per session, output sectioned via the structured
``finalize_report`` tool. We render markdown deterministically rather than
trusting freeform model output.
"""

from __future__ import annotations

import json
from typing import Any

from ..auth.audit import AuditEvent, AuditLog
from ..logging_setup import get_logger
from ..sessions.models import Message, Session
from .client import LLMClient
from .prompts import build_aar_system_blocks
from .tools import AAR_TOOL

_logger = get_logger("llm.export")


class AARGenerator:
    def __init__(self, *, llm: LLMClient, audit: AuditLog) -> None:
        self._llm = llm
        self._audit = audit

    async def generate(self, session: Session) -> str:
        messages = [
            {
                "role": "user",
                "content": _user_payload(session, self._audit),
            }
        ]
        result = await self._llm.acomplete(
            tier="aar",
            system_blocks=build_aar_system_blocks(session),
            messages=messages,
            tools=[AAR_TOOL],
            max_tokens=4096,
        )
        report = _extract_report(result.content)
        return _render_markdown(session, report, audit_events=self._audit.dump(session.id))


def _user_payload(session: Session, audit: AuditLog) -> str:
    transcript = "\n".join(
        f"[{m.kind.value}] role={m.role_id or 'AI'}: {m.body}" for m in session.messages
    )
    setup = "\n".join(
        f"[{n.speaker}] {n.topic or '-'}: {n.content}" for n in session.setup_notes
    )
    audit_lines = "\n".join(
        json.dumps({"kind": e.kind, "ts": e.ts.isoformat(), "payload": e.payload})
        for e in audit.dump(session.id)
    )
    return (
        "Session transcript:\n"
        f"{transcript}\n\n"
        "Setup conversation:\n"
        f"{setup}\n\n"
        "Audit log (JSONL):\n"
        f"{audit_lines}\n\n"
        "Call finalize_report with your structured report."
    )


def _extract_report(content: list[dict[str, Any]]) -> dict[str, Any]:
    for block in content:
        if block.get("type") == "tool_use" and block.get("name") == "finalize_report":
            return dict(block.get("input") or {})
    # Fallback: synthesize a minimal report from any text the model produced.
    text = "".join(
        block.get("text", "") for block in content if block.get("type") == "text"
    )
    return {
        "executive_summary": text[:500] or "(no structured report returned)",
        "narrative": text or "(no narrative returned)",
        "what_went_well": [],
        "gaps": [],
        "recommendations": [],
        "per_role_scores": [],
        "overall_score": 0,
        "overall_rationale": "structured report missing",
    }


def _render_markdown(
    session: Session,
    report: dict[str, Any],
    audit_events: list[AuditEvent],
) -> str:
    plan = session.plan
    lines: list[str] = []
    title = (plan.title if plan else "Cybersecurity tabletop exercise") or "Exercise"
    lines.append(f"# {title} — After-Action Report")
    lines.append("")
    lines.append("## Header")
    lines.append(f"- Session ID: `{session.id}`")
    lines.append(f"- Created: {session.created_at.isoformat()}")
    lines.append(f"- Ended: {session.ended_at.isoformat() if session.ended_at else 'n/a'}")
    lines.append("- Roster:")
    for role in session.roles:
        creator_tag = " *(creator)*" if role.is_creator else ""
        dn = f" — {role.display_name}" if role.display_name else ""
        lines.append(f"  - **{role.label}**{dn}{creator_tag}")
    lines.append("")

    lines.append("## Executive summary")
    lines.append(report.get("executive_summary", "").strip() or "_(none)_")
    lines.append("")

    lines.append("## Full transcript")
    for msg in session.messages:
        lines.append(_format_transcript_line(session, msg))
    lines.append("")

    lines.append("## After-action narrative")
    lines.append(report.get("narrative", "").strip() or "_(none)_")
    lines.append("")

    if report.get("what_went_well"):
        lines.append("### What went well")
        for item in report["what_went_well"]:
            lines.append(f"- {item}")
        lines.append("")
    if report.get("gaps"):
        lines.append("### Gaps")
        for item in report["gaps"]:
            lines.append(f"- {item}")
        lines.append("")
    if report.get("recommendations"):
        lines.append("### Recommendations")
        for item in report["recommendations"]:
            lines.append(f"- {item}")
        lines.append("")

    lines.append("## Per-role scores")
    lines.append("| Role | Decision quality | Communication | Speed | Rationale |")
    lines.append("|---|:-:|:-:|:-:|---|")
    scores = list(report.get("per_role_scores", []))
    by_role: dict[str, dict[str, Any]] = {s.get("role_id", ""): s for s in scores}
    for role in sorted(session.roles, key=lambda r: r.label):
        row = by_role.get(role.id) or {}
        lines.append(
            f"| {role.label} | {row.get('decision_quality', '–')} | "
            f"{row.get('communication', '–')} | {row.get('speed', '–')} | "
            f"{row.get('rationale', '–')} |"
        )
    lines.append("")

    lines.append("## Overall session score")
    lines.append(f"**{report.get('overall_score', 0)} / 5** — {report.get('overall_rationale', '')}")
    lines.append("")

    lines.append("## Appendix A — Setup conversation")
    if session.setup_notes:
        for note in session.setup_notes:
            lines.append(f"**[{note.speaker}]** {note.topic or '-'}: {note.content}")
    else:
        lines.append("_(no setup notes recorded)_")
    lines.append("")

    lines.append("## Appendix B — Frozen scenario plan")
    if plan:
        lines.append("```json")
        lines.append(json.dumps(plan.model_dump(), indent=2, sort_keys=True))
        lines.append("```")
    else:
        lines.append("_(no plan was finalized)_")
    lines.append("")

    lines.append("## Appendix C — Audit log")
    if audit_events:
        lines.append("```jsonl")
        for evt in audit_events:
            lines.append(json.dumps(evt.model_dump(mode="json"), sort_keys=True))
        lines.append("```")
    else:
        lines.append("_(no audit events captured)_")
    lines.append("")

    return "\n".join(lines)


def _format_transcript_line(session: Session, msg: Message) -> str:
    role = session.role_by_id(msg.role_id) if msg.role_id else None
    actor = (
        f"**{role.label}** ({role.display_name})"
        if role
        else "**AI Facilitator**"
        if msg.kind.value.startswith("ai")
        else "**System**"
    )
    tag = f" _[{msg.tool_name}]_" if msg.tool_name else ""
    body = msg.body.replace("\n", " ").strip()
    return f"- _{msg.ts.isoformat()}_ — {actor}{tag}: {body}"
