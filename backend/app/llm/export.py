"""End-of-session AAR + markdown export.

One Opus call per session, output sectioned via the structured
``finalize_report`` tool. We render markdown deterministically rather than
trusting freeform model output.
"""

from __future__ import annotations

import json
import re
from typing import Any

from ..auth.audit import AuditEvent, AuditLog
from ..logging_setup import get_logger
from ..sessions.models import Message, Session
from .client import LLMClient
from .prompts import build_aar_system_blocks
from .tools import AAR_TOOL

_logger = get_logger("llm.export")


# Sentinel HTML comments wrap creator-only sections (currently the AI
# decision rationale appendix). Markdown viewers ignore HTML comments,
# so the creator's copy renders normally; the export route strips
# everything between these markers when serving a non-creator role
# (see ``strip_creator_only`` below). See issue #55 + the security
# review on the QoL patch — the AAR is participant-readable and we
# don't want player roles seeing the AI's debug rationale.
CREATOR_ONLY_BEGIN = "<!-- BEGIN_CREATOR_ONLY -->"
CREATOR_ONLY_END = "<!-- END_CREATOR_ONLY -->"

# Anchor the strip pattern to a whole line. Without anchoring, a player
# message that happened to contain the literal marker string (e.g. a
# CISO pasting a copy of the AAR template into chat) would surface in
# the verbatim transcript appendix as ``> <!-- BEGIN_CREATOR_ONLY -->``
# — substring matching would then suppress the rest of the player-
# facing report (DoS, not a leak). The line-anchored regex only matches
# markers the renderer itself emitted at column 0 of their own line.
_CREATOR_ONLY_BLOCK_RE = re.compile(
    r"^"
    + re.escape(CREATOR_ONLY_BEGIN)
    + r"\s*$"
    + r".*?"
    + r"^"
    + re.escape(CREATOR_ONLY_END)
    + r"\s*$"
    + r"\n?",
    re.DOTALL | re.MULTILINE,
)
_CREATOR_ONLY_DANGLING_BEGIN_RE = re.compile(
    r"^" + re.escape(CREATOR_ONLY_BEGIN) + r"\s*$.*",
    re.DOTALL | re.MULTILINE,
)


def strip_creator_only(markdown: str) -> str:
    """Remove every ``CREATOR_ONLY_BEGIN`` … ``CREATOR_ONLY_END`` block
    from ``markdown``. Line-anchored: only markers occupying their own
    line are matched, so a player message body that happens to contain
    the literal sentinel string (now visible in the verbatim transcript
    appendix per issue #83) doesn't trigger spurious stripping."""

    stripped = _CREATOR_ONLY_BLOCK_RE.sub("", markdown)
    # Unterminated BEGIN: drop everything from the marker line onwards.
    # Better to truncate than risk leaking creator-only content into a
    # player download.
    stripped = _CREATOR_ONLY_DANGLING_BEGIN_RE.sub("", stripped)
    return stripped


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
            # Per-tier default lives in settings.max_tokens_for("aar").
            session_id=session.id,
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
    # The model SHOULD have called ``finalize_report`` (Block 1 of the AAR
    # system prompt makes this an explicit instruction). Reaching this branch
    # means a prompt regression, an Anthropic-side change, or a malformed
    # response — log loudly so the on-call operator finds the cause from
    # production logs alone rather than from a "the AAR looks empty" ticket.
    text = "".join(
        block.get("text", "") for block in content if block.get("type") == "text"
    )
    block_types = [block.get("type") for block in content]
    _logger.warning(
        "aar_finalize_report_missing",
        text_preview=text[:200],
        block_types=block_types,
        block_count=len(content),
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

    lines.append("## After-action narrative")
    lines.append(report.get("narrative", "").strip() or "_(none)_")
    lines.append("")

    # Bullet-list sections from the structured report. Items can carry their
    # own markdown (bold, links, sub-bullets); the formatter preserves
    # multi-line content by indenting continuation lines under the parent
    # bullet so renderers don't reflow them into a sibling paragraph (issue
    # #83 — the original `- {item}` form broke any item that contained a
    # newline because the second line escaped the list).
    if report.get("what_went_well"):
        lines.append("### What went well")
        lines.extend(_render_bullets(report["what_went_well"]))
        lines.append("")
    if report.get("gaps"):
        lines.append("### Gaps")
        lines.extend(_render_bullets(report["gaps"]))
        lines.append("")
    if report.get("recommendations"):
        lines.append("### Recommendations")
        lines.extend(_render_bullets(report["recommendations"]))
        lines.append("")

    lines.append("## Per-role scores")
    lines.append("| Role | Decision quality | Communication | Speed | Rationale |")
    lines.append("|---|:-:|:-:|:-:|---|")
    scores = list(report.get("per_role_scores", []))
    by_role: dict[str, dict[str, Any]] = {s.get("role_id", ""): s for s in scores}
    for role in sorted(session.roles, key=lambda r: r.label):
        row = by_role.get(role.id) or {}
        # Cell-internal newlines / pipes break GFM tables — fold them so the
        # row stays on one line and any pipe in the rationale doesn't open a
        # phantom column.
        rationale = _flatten_table_cell(row.get("rationale", "–"))
        lines.append(
            f"| {role.label} | {row.get('decision_quality', '–')} | "
            f"{row.get('communication', '–')} | {row.get('speed', '–')} | "
            f"{rationale} |"
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

    # Appendix D — full transcript. Issue #83: the transcript used to live
    # near the top of the report (right after the executive summary), which
    # buried the analytic content under a wall of dialogue and made the AAR
    # unreadable on real sessions. Pushed it to the appendix so the
    # narrative / scores / recommendations come first; the rich per-message
    # rendering (timestamp + role header + blockquoted body) preserves any
    # markdown the AI emitted rather than collapsing it onto one line.
    lines.append("## Appendix D — Full transcript")
    if session.messages:
        for msg in session.messages:
            lines.extend(_format_transcript_entry(session, msg))
    else:
        lines.append("_(no messages recorded)_")
    lines.append("")

    # Appendix E is creator-only (the AI's debug rationale leaks
    # narrative reasoning that players shouldn't see). Wrapped in
    # sentinel HTML comments so the export endpoint strips this section
    # for non-creator downloads. Markdown viewers ignore HTML comments,
    # so the creator's copy renders normally.
    lines.append(CREATOR_ONLY_BEGIN)
    lines.append("## Appendix E — AI decision rationale log _(facilitator only)_")
    if session.decision_log:
        for entry in session.decision_log:
            ts = entry.ts.isoformat()
            beat = (
                f"turn {entry.turn_index}"
                if entry.turn_index is not None
                else "pre-turn"
            )
            rationale = entry.rationale.replace("\n", " ").strip()
            lines.append(f"- _{ts}_ — **{beat}**: {rationale}")
    else:
        lines.append("_(no rationale entries recorded)_")
    lines.append("")
    lines.append(CREATOR_ONLY_END)

    return "\n".join(lines)


def _render_bullets(items: Any) -> list[str]:
    """Render a list of report items as markdown bullets.

    A single-line item becomes ``- {item}``. A multi-line item keeps its
    first line on the bullet and indents continuation lines by two spaces
    so CommonMark / GFM treat them as a continuation of the same list
    item instead of breaking out into a sibling paragraph.

    The input is **defensively coerced**. The AAR ``finalize_report``
    tool schema declares each list field as ``array of string``, but the
    model occasionally emits a lone string (when there's only one item)
    or a non-string scalar (e.g. ``null``, an int) inside the array. The
    AAR pipeline is operator-critical — a TypeError here would surface
    to the user as a 500 on the export endpoint and block the entire
    download. Coerce defensively, log when we had to.
    """

    if items is None:
        return []
    # A lone string instead of a list — wrap it.
    if isinstance(items, str):
        items = [items]
    # Anything that isn't iterable at this point means schema drift —
    # log and bail out with an empty list rather than propagating a
    # TypeError from the for-loop.
    try:
        iterator = iter(items)
    except TypeError:
        _logger.warning(
            "aar_render_bullets_unexpected_type",
            value_type=type(items).__name__,
            value_preview=str(items)[:120],
        )
        return []

    out: list[str] = []
    for raw in iterator:
        if raw is None:
            continue
        # Coerce non-strings (numbers, bools) into their str repr; the
        # alternative is a hard crash in ``.strip()``. The AAR will read
        # slightly oddly with a bare number as a bullet, but at least it
        # ships.
        if not isinstance(raw, str):
            raw = str(raw)
        cleaned = raw.strip()
        if not cleaned:
            continue
        first, *rest = cleaned.split("\n")
        out.append(f"- {first}")
        for line in rest:
            # Drop blank continuation lines entirely — emitting an empty
            # line would force CommonMark into "loose list" mode, which
            # wraps every ``<li>`` in ``<p>`` and produces visibly ragged
            # bullet spacing in the AAR popup. Dropping the blank still
            # keeps the next non-blank line indented under the parent
            # bullet, so the multi-line markdown structure (sub-bullets,
            # continuation prose) survives in tight-list rendering.
            if not line.strip():
                continue
            out.append(f"  {line}")
    return out


def _flatten_table_cell(text: Any) -> str:
    """Make ``text`` safe to drop into a GFM table cell.

    GFM tables use unescaped ``|`` as a column separator and treat raw
    newlines as a row terminator. Rationales coming back from the model
    occasionally contain either, which silently corrupts the score table.
    Fold whitespace and escape pipes.

    The input is **defensively coerced** (per Copilot review on PR #85):
    although the ``finalize_report`` tool schema declares ``rationale``
    as a string, the model occasionally emits ``null`` or a non-string
    scalar. ``(text or "–").split()`` raises on those — the AAR is
    operator-critical so we can't afford a hard crash here. Coerce to
    ``str(text)`` for non-None / non-string inputs and keep the
    "–" placeholder for the empty/None case.
    """

    if text is None or text == "":
        return "–"
    if not isinstance(text, str):
        text = str(text)
    flat = " ".join(text.split()) or "–"
    return flat.replace("|", "\\|")


def _format_transcript_entry(session: Session, msg: Message) -> list[str]:
    """Render one transcript entry as a header + blockquoted body.

    Issue #83: the previous ``- _ts_ — **Role**: body`` form collapsed
    newlines into spaces and made any markdown the AI emitted (lists,
    code fences, tables in ``share_data``, etc.) unreadable. The new
    form puts the metadata on its own line and quotes every line of the
    body so multi-line markdown survives.
    """

    role = session.role_by_id(msg.role_id) if msg.role_id else None
    if role:
        actor = f"**{role.label}**"
        if role.display_name:
            actor += f" ({role.display_name})"
    elif msg.kind.value.startswith("ai"):
        actor = "**AI Facilitator**"
    else:
        actor = "**System**"

    tag = f" _[{msg.tool_name}]_" if msg.tool_name else ""
    header = f"**{msg.ts.isoformat()}** — {actor}{tag}"
    body = (msg.body or "").rstrip()
    if not body:
        body = "_(empty)_"

    out: list[str] = [header, ""]
    for line in body.split("\n"):
        # Blockquote-prefix every line, including blanks, so a paragraph
        # break inside the body doesn't terminate the quote (which would
        # otherwise let the next line escape into a top-level paragraph).
        out.append(f"> {line}" if line else ">")
    out.append("")
    return out
