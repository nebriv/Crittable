"""Unit tests for the AAR markdown rendering pipeline.

The :func:`app.llm.export._render_markdown` helper builds the operator-facing
markdown report from the structured ``finalize_report`` payload. Issue #83
flagged two formatting bugs:

* the "what went well" / "gaps" / "recommendations" bullets dropped any
  multi-line markdown the model emitted because the renderer treated each
  item as a single line,
* the full transcript lived near the top of the report and used a flattened
  ``- _ts_ — **Role**: body`` form that collapsed newlines into spaces, so
  any markdown the AI emitted (lists, code fences, tables) became unreadable.

These tests pin the new behavior:

* multi-line bullet items keep their continuation lines indented under the
  parent bullet,
* the transcript renders as ``header + blockquoted body`` so multi-line
  markdown survives,
* the transcript appendix lives at the bottom of the report (after the
  per-role scores) and the analytic sections come first,
* the creator-only block is wrapped in sentinel comments and gets stripped
  cleanly by :func:`strip_creator_only`.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from app.auth.audit import AuditEvent
from app.llm.export import (
    CREATOR_ONLY_BEGIN,
    CREATOR_ONLY_END,
    _flatten_table_cell,
    _format_transcript_entry,
    _render_bullets,
    _render_markdown,
    strip_creator_only,
)
from app.sessions.models import (
    DecisionLogEntry,
    Message,
    MessageKind,
    Role,
    ScenarioBeat,
    ScenarioInject,
    ScenarioPlan,
    Session,
    SessionState,
    SetupNote,
)

# ---------------------------------------------------------------- fixtures


def _ts(seconds: int = 0) -> datetime:
    """Build a deterministic UTC timestamp ``seconds`` past 10:00:00 on
    2026-04-30. Tests use small ints (0–~120) so we keep the formula
    inside the minute/hour bounds explicitly."""

    minute, second = divmod(seconds, 60)
    return datetime(2026, 4, 30, 10, minute, second, tzinfo=UTC)


@pytest.fixture
def ciso() -> Role:
    return Role(
        id="role-ciso",
        label="CISO",
        display_name="Alex",
        is_creator=True,
    )


@pytest.fixture
def soc() -> Role:
    return Role(id="role-soc", label="SOC Analyst", display_name="Bo")


@pytest.fixture
def session_with_messages(ciso: Role, soc: Role) -> Session:
    plan = ScenarioPlan(
        title="Ransomware via vendor portal",
        executive_summary="03:14 Wednesday. Ransomware on finance laptops.",
        key_objectives=["Confirm scope", "Contain"],
        narrative_arc=[
            ScenarioBeat(beat=1, label="Detection & triage", expected_actors=["SOC"]),
        ],
        injects=[
            ScenarioInject(
                trigger="after beat 1",
                type="critical",
                summary="Slack screenshot leaked.",
            ),
        ],
        guardrails=["stay in scope"],
        success_criteria=["containment before beat 3"],
        out_of_scope=["real exploit code"],
    )
    s = Session(
        scenario_prompt="Ransomware via vendor portal",
        state=SessionState.ENDED,
        roles=[ciso, soc],
        creator_role_id=ciso.id,
        plan=plan,
        ended_at=_ts(60),
    )
    s.created_at = _ts(0)
    s.messages.extend(
        [
            Message(
                kind=MessageKind.AI_TEXT,
                tool_name="broadcast",
                ts=_ts(1),
                body=(
                    "**Briefing**\n\n"
                    "- Beat 1: detection\n"
                    "- Beat 2: containment\n\n"
                    "_Who acts first?_"
                ),
            ),
            Message(
                kind=MessageKind.PLAYER,
                role_id=ciso.id,
                ts=_ts(2),
                body="Isolate immediately.\n\nPull IR Lead in.",
            ),
            Message(
                kind=MessageKind.AI_TEXT,
                tool_name="share_data",
                ts=_ts(3),
                body=(
                    "Defender alert queue — 03:14 UTC\n\n"
                    "```\n"
                    "ALERT-001  Critical  FIN-04\n"
                    "ALERT-002  High      FIN-12\n"
                    "```"
                ),
            ),
        ]
    )
    s.setup_notes.append(
        SetupNote(speaker="creator", topic="scope", content="finance only", ts=_ts(0))
    )
    s.decision_log.append(
        DecisionLogEntry(
            ts=_ts(2),
            turn_index=1,
            rationale="CISO answered fast — push briefing forward.",
        )
    )
    return s


@pytest.fixture
def report() -> dict[str, Any]:
    return {
        "executive_summary": "Team contained ransomware in 23 minutes.",
        "narrative": "Para 1.\n\nPara 2.",
        "what_went_well": [
            "**Quick containment** within 3 minutes",
            # Multi-line item — must render as a single bullet with indented
            # continuation lines, not split into two paragraphs.
            "Strong cross-role comms\n  - CISO drove decisions\n  - SOC fed telemetry",
            "  ",  # whitespace-only items are dropped
        ],
        "gaps": [
            "Delayed regulator clock",
            "No comms draft staged",
        ],
        "recommendations": [
            "Pre-draft regulator notification template",
        ],
        "per_role_scores": [
            {
                "role_id": "role-ciso",
                "decision_quality": 4,
                "communication": 4,
                "speed": 5,
                # Pipe + newline in the rationale — must be flattened so the
                # GFM table doesn't break.
                "rationale": "Decisive call early\nfollowed up | clearly",
            },
            {
                "role_id": "role-soc",
                "decision_quality": 3,
                "communication": 4,
                "speed": 4,
                "rationale": "Reliable telemetry feed.",
            },
        ],
        "overall_score": 4,
        "overall_rationale": "Solid response with documentation gaps.",
    }


# ---------------------------------------------------------------- _render_bullets


def test_render_bullets_single_line() -> None:
    out = _render_bullets(["Quick containment", "Clear comms"])
    assert out == ["- Quick containment", "- Clear comms"]


def test_render_bullets_preserves_multiline_continuation() -> None:
    """A multi-line item keeps the first line on the bullet and indents the
    rest with two spaces so the bullet doesn't break."""

    out = _render_bullets(["**Header**\n  - sub-bullet 1\n  - sub-bullet 2"])
    assert out == [
        "- **Header**",
        "    - sub-bullet 1",
        "    - sub-bullet 2",
    ]


def test_render_bullets_drops_blank_items() -> None:
    out = _render_bullets(["", "   ", "real item", "\n\n"])
    assert out == ["- real item"]


def test_render_bullets_drops_blank_continuation_lines() -> None:
    """Blank continuation lines inside a bullet are dropped, not preserved.

    Preserving them flips CommonMark into "loose list" mode, which wraps
    every ``<li>`` in a ``<p>`` and produces visibly uneven bullet spacing
    in the AAR popup (UI/UX review finding). Dropping blanks keeps the
    list tight while still letting non-blank continuation lines stay
    indented under the parent bullet.
    """

    out = _render_bullets(["first\n\nsecond"])
    assert out == ["- first", "  second"]


# ---------------------------------------------------------------- _flatten_table_cell


def test_flatten_table_cell_handles_pipes_and_newlines() -> None:
    out = _flatten_table_cell("split | here\nand\twrap")
    assert "\n" not in out
    assert "\\|" in out
    assert out == "split \\| here and wrap"


def test_flatten_table_cell_falls_back_for_empty() -> None:
    assert _flatten_table_cell("") == "–"
    assert _flatten_table_cell(None) == "–"  # type: ignore[arg-type]


# ---------------------------------------------------------------- _format_transcript_entry


def test_transcript_entry_blockquotes_multiline_body(
    session_with_messages: Session,
) -> None:
    """Multi-line message body must render as a series of blockquote lines
    so markdown blocks (bold, lists, code fences) stay intact."""

    msg = session_with_messages.messages[0]  # AI broadcast with markdown body
    out = _format_transcript_entry(session_with_messages, msg)

    # Header line carries timestamp + actor + tool tag.
    assert out[0].startswith("**2026-04-30T10:00:01")
    assert "AI Facilitator" in out[0]
    assert "_[broadcast]_" in out[0]

    # Body lines are blockquoted.
    body_lines = [line for line in out[2:] if line.strip()]
    assert all(line.startswith(">") for line in body_lines), out
    # The blank line between paragraphs is preserved as a bare ``>``.
    assert ">" in out
    # The original markdown survives.
    assert any("**Briefing**" in line for line in out)
    assert any("- Beat 1" in line for line in out)


def test_transcript_entry_renders_player_with_display_name(
    session_with_messages: Session,
) -> None:
    msg = session_with_messages.messages[1]  # CISO player message
    out = _format_transcript_entry(session_with_messages, msg)
    assert "**CISO**" in out[0]
    assert "(Alex)" in out[0]


def test_transcript_entry_handles_empty_body(
    session_with_messages: Session,
) -> None:
    """An empty-body message renders an explicit ``_(empty)_`` placeholder
    inside the blockquote rather than a stray header with no content."""

    blank = Message(
        kind=MessageKind.SYSTEM,
        ts=_ts(99),
        body="",
    )
    out = _format_transcript_entry(session_with_messages, blank)
    assert any("_(empty)_" in line for line in out)


# ---------------------------------------------------------------- _render_markdown


def test_render_markdown_section_order(
    session_with_messages: Session, report: dict[str, Any]
) -> None:
    """Issue #83: the transcript appendix must come AFTER the analytic
    sections (executive summary, narrative, what-went-well, scores)."""

    md = _render_markdown(session_with_messages, report, audit_events=[])

    # All headlines must be present once.
    for header in (
        "## Executive summary",
        "## After-action narrative",
        "### What went well",
        "### Gaps",
        "### Recommendations",
        "## Per-role scores",
        "## Overall session score",
        "## Appendix A — Setup conversation",
        "## Appendix B — Frozen scenario plan",
        "## Appendix C — Audit log",
        "## Appendix D — Full transcript",
    ):
        assert header in md, f"missing header: {header}"

    # Strict ordering check.
    headers_in_order = [
        "## Executive summary",
        "## After-action narrative",
        "### What went well",
        "## Per-role scores",
        "## Appendix A — Setup conversation",
        "## Appendix D — Full transcript",
    ]
    positions = [md.index(h) for h in headers_in_order]
    assert positions == sorted(positions), (
        "section order regressed: "
        f"{list(zip(headers_in_order, positions, strict=True))}"
    )


def test_render_markdown_what_went_well_preserves_markdown(
    session_with_messages: Session, report: dict[str, Any]
) -> None:
    """The bold prefix and the multi-line sub-bullets must survive into the
    output instead of being collapsed onto a single line."""

    md = _render_markdown(session_with_messages, report, audit_events=[])
    assert "- **Quick containment** within 3 minutes" in md
    # Multi-line item: continuation lines stay indented under the bullet.
    assert "- Strong cross-role comms" in md
    assert "    - CISO drove decisions" in md
    assert "    - SOC fed telemetry" in md


def test_render_markdown_drops_whitespace_only_bullets(
    session_with_messages: Session, report: dict[str, Any]
) -> None:
    md = _render_markdown(session_with_messages, report, audit_events=[])
    # Whitespace-only "  " entry from the fixture should not produce an
    # empty bullet.
    assert "\n- \n" not in md
    assert "\n-  \n" not in md


def test_render_markdown_per_role_scores_handles_pipe_in_rationale(
    session_with_messages: Session, report: dict[str, Any]
) -> None:
    """A pipe character in the rationale used to break the GFM table layout.
    The flattener must escape the pipe and fold any newlines."""

    md = _render_markdown(session_with_messages, report, audit_events=[])
    table_section = md.split("## Per-role scores", 1)[1].split("##", 1)[0]
    # The rationale row must be a single line with the pipe escaped.
    assert "Decisive call early followed up \\| clearly" in table_section
    # And there's no naked newline inside the rationale row.
    rationale_row = next(
        line for line in table_section.splitlines() if "CISO" in line
    )
    # Five-column row → six unescaped pipes (one before each cell + one
    # after the last). The ``\|`` inside the rationale doesn't count as a
    # column separator. Validate by counting only ``|`` chars NOT preceded
    # by a backslash.
    import re

    column_pipes = re.findall(r"(?<!\\)\|", rationale_row)
    assert len(column_pipes) == 6, (
        f"row column-pipe count regressed; row was: {rationale_row!r}"
    )


def test_render_markdown_transcript_lives_in_appendix_d(
    session_with_messages: Session, report: dict[str, Any]
) -> None:
    """Transcript content must appear under Appendix D — Full transcript,
    not inline in the main report."""

    md = _render_markdown(session_with_messages, report, audit_events=[])
    transcript_idx = md.index("## Appendix D — Full transcript")
    scores_idx = md.index("## Per-role scores")
    assert scores_idx < transcript_idx, (
        "Per-role scores must come BEFORE the transcript appendix"
    )
    # Transcript content exists under the heading.
    after = md[transcript_idx:]
    assert "**2026-04-30T10:00:01" in after
    assert "_[broadcast]_" in after
    assert "**Briefing**" in after


def test_render_markdown_creator_only_block_is_wrapped(
    session_with_messages: Session, report: dict[str, Any]
) -> None:
    md = _render_markdown(session_with_messages, report, audit_events=[])
    assert CREATOR_ONLY_BEGIN in md
    assert CREATOR_ONLY_END in md
    begin = md.index(CREATOR_ONLY_BEGIN)
    end = md.index(CREATOR_ONLY_END)
    assert begin < end
    assert "Appendix E — AI decision rationale log" in md[begin:end]
    assert "CISO answered fast" in md[begin:end]


def test_render_markdown_with_audit_events(
    session_with_messages: Session, report: dict[str, Any]
) -> None:
    audit = [
        AuditEvent(
            session_id=session_with_messages.id,
            kind="state_change",
            ts=_ts(0),
            payload={"from": "READY", "to": "BRIEFING"},
        ),
    ]
    md = _render_markdown(session_with_messages, report, audit_events=audit)
    audit_section = md.split("## Appendix C — Audit log", 1)[1].split("##", 1)[0]
    assert "```jsonl" in audit_section
    assert "state_change" in audit_section


def test_render_markdown_handles_empty_session(ciso: Role) -> None:
    """A session that ends with no plan / no messages still produces a
    well-formed report — every required heading present, no exceptions."""

    s = Session(
        scenario_prompt="Empty",
        state=SessionState.ENDED,
        roles=[ciso],
        creator_role_id=ciso.id,
    )
    md = _render_markdown(
        s,
        {
            "executive_summary": "",
            "narrative": "",
            "what_went_well": [],
            "gaps": [],
            "recommendations": [],
            "per_role_scores": [],
            "overall_score": 0,
            "overall_rationale": "",
        },
        audit_events=[],
    )
    # Empty fields render as fallback markers, not crashes.
    assert "_(none)_" in md
    assert "_(no setup notes recorded)_" in md
    assert "_(no plan was finalized)_" in md
    assert "_(no audit events captured)_" in md
    assert "_(no messages recorded)_" in md
    assert "_(no rationale entries recorded)_" in md
    # Headings still in order.
    assert "## Appendix D — Full transcript" in md


# ---------------------------------------------------------------- strip_creator_only


def test_strip_creator_only_removes_block(
    session_with_messages: Session, report: dict[str, Any]
) -> None:
    md = _render_markdown(session_with_messages, report, audit_events=[])
    stripped = strip_creator_only(md)
    assert CREATOR_ONLY_BEGIN not in stripped
    assert CREATOR_ONLY_END not in stripped
    assert "Appendix E — AI decision rationale log" not in stripped
    assert "CISO answered fast" not in stripped
    # Non-creator content survives.
    assert "## Executive summary" in stripped
    assert "## Appendix D — Full transcript" in stripped


def test_strip_creator_only_handles_unterminated_marker() -> None:
    """A missing END marker must not leak the rest of the document — the
    renderer drops everything after the dangling BEGIN."""

    md = (
        f"safe content\n{CREATOR_ONLY_BEGIN}\nsecret rationale\nthen abrupt eof"
    )
    stripped = strip_creator_only(md)
    assert "safe content" in stripped
    assert "secret" not in stripped
    assert CREATOR_ONLY_BEGIN not in stripped


def test_strip_creator_only_idempotent(
    session_with_messages: Session, report: dict[str, Any]
) -> None:
    md = _render_markdown(session_with_messages, report, audit_events=[])
    once = strip_creator_only(md)
    twice = strip_creator_only(once)
    assert once == twice


def test_strip_creator_only_ignores_marker_inside_blockquote(ciso: Role) -> None:
    """Security review finding: a player-typed marker string (now visible
    on its own line under the ``> `` blockquote in the transcript appendix
    per issue #83) used to trigger the substring-based stripper and silently
    drop subsequent transcript content from non-creator downloads.

    The line-anchored regex must match ONLY markers at column 0 (i.e. the
    sentinel ones the renderer itself emits). A player message containing
    the literal marker remains visible in the player download.
    """

    s = Session(
        scenario_prompt="hostile player",
        state=SessionState.ENDED,
        roles=[ciso],
        creator_role_id=ciso.id,
    )
    s.messages.append(
        Message(
            kind=MessageKind.PLAYER,
            role_id=ciso.id,
            ts=_ts(1),
            body=(
                "Look, the rationale appendix template is "
                f"{CREATOR_ONLY_BEGIN}\nsecret\n{CREATOR_ONLY_END} — "
                "shouldn't that be standardized?"
            ),
        )
    )
    md = _render_markdown(
        s,
        {
            "executive_summary": "exec",
            "narrative": "narr",
            "what_went_well": [],
            "gaps": [],
            "recommendations": [],
            "per_role_scores": [],
            "overall_score": 1,
            "overall_rationale": "x",
        },
        audit_events=[],
    )
    stripped = strip_creator_only(md)

    # The rendered transcript still contains the player's message body
    # (the marker shows up under a ``> `` blockquote prefix).
    assert "shouldn't that be standardized?" in stripped, (
        "player message should survive the strip — the marker only "
        "matches at column 0 of its own line, not inside a quoted body"
    )
    # And the legitimate creator-only appendix is still removed.
    assert "Appendix E — AI decision rationale log" not in stripped


def test_format_transcript_entry_actor_for_critical_inject(
    session_with_messages: Session,
) -> None:
    """A CRITICAL_INJECT message with no ``role_id`` and a
    non-``ai``-prefixed kind value falls through to ``**System**`` —
    pin this so a future kind-enum reshuffle (e.g. renaming the prefix)
    catches in CI rather than silently mislabeling banner injects."""

    inject = Message(
        kind=MessageKind.CRITICAL_INJECT,
        ts=_ts(5),
        body="Reporter calls about leaked screenshot.",
        tool_name="inject_critical_event",
    )
    out = _format_transcript_entry(session_with_messages, inject)
    assert "**System**" in out[0], out[0]
    assert "_[inject_critical_event]_" in out[0]


def test_format_transcript_entry_ai_message_without_tool_name(
    session_with_messages: Session,
) -> None:
    """An AI message with no ``tool_name`` (e.g. raw text content emitted
    alongside tool calls) renders without the ``_[...]_`` tag — guards
    against accidentally interpolating ``None`` into the header."""

    raw_ai = Message(
        kind=MessageKind.AI_TEXT,
        ts=_ts(6),
        body="thinking aloud",
    )
    out = _format_transcript_entry(session_with_messages, raw_ai)
    assert "**AI Facilitator**" in out[0]
    assert "_[" not in out[0], (
        f"unexpected tool-name tag rendered for tool_name=None: {out[0]!r}"
    )


def test_render_markdown_logs_when_finalize_report_missing(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """``_extract_report`` synthesizes a fallback when the model didn't
    call ``finalize_report``. The fallback path used to be silent — the
    operator only learned about it from a "the AAR looks empty" ticket.
    Confirm the warn-level log line fires so production logs catch the
    regression. ``structlog`` writes to stdout via ``PrintLoggerFactory``,
    so we capture via ``capsys`` rather than the python-logging ``caplog``.
    """

    from app.llm.export import _extract_report

    fallback = _extract_report(
        [
            {"type": "text", "text": "free-form reply, no tool call"},
        ]
    )
    # Sanity: fallback shape preserved.
    assert fallback["overall_score"] == 0

    captured = capsys.readouterr()
    log_blob = captured.out + captured.err
    assert "aar_finalize_report_missing" in log_blob, (
        "expected an `aar_finalize_report_missing` warning when the "
        f"fallback path fires; saw stdout: {captured.out!r}, stderr: {captured.err!r}"
    )
