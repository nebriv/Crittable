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
        "flagged_for_review": [
            "Isolated finance subnet at T+04:12 (CISO call)",
            "Open question: was the ransom ever revisited after the backup decision?",
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


def test_render_bullets_coerces_non_string_items() -> None:
    """Per Copilot review on PR #85: the AAR tool input is forwarded
    raw, so the model can emit non-strings (``null``, numbers, bools)
    inside what's declared as ``array of string``. The renderer must
    coerce instead of crashing — the AAR pipeline is operator-critical.
    """

    out = _render_bullets(["string item", 42, None, True, "tail item"])
    # ``None`` is dropped (whitespace-only-equivalent); the others are
    # coerced via ``str()`` into bullets.
    assert out == ["- string item", "- 42", "- True", "- tail item"]


def test_render_bullets_handles_lone_string() -> None:
    """The model occasionally emits a lone string for a single-item
    array. Wrap it as a single-bullet list rather than iterating
    characters."""

    out = _render_bullets("the only item")
    assert out == ["- the only item"]


def test_render_bullets_handles_none_and_non_iterable(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """``None`` returns empty. A non-iterable scalar (e.g. an int from
    severe schema drift) logs a warning and returns empty rather than
    propagating a ``TypeError``."""

    assert _render_bullets(None) == []
    capsys.readouterr()  # discard
    assert _render_bullets(7) == []
    log_blob = capsys.readouterr().out
    assert "aar_render_bullets_unexpected_type" in log_blob


def test_flatten_table_cell_coerces_non_string() -> None:
    """Per Copilot review on PR #85: a non-string rationale (``null``,
    a number) used to crash ``(text or "–").split()``. Coerce."""

    assert _flatten_table_cell(None) == "–"
    assert _flatten_table_cell("") == "–"
    assert _flatten_table_cell(0) == "0"
    assert _flatten_table_cell(4.5) == "4.5"
    # Whitespace-only after coercion → fall back to "–".
    assert _flatten_table_cell("   ") == "–"
    # Pipe in coerced value still gets escaped.
    assert _flatten_table_cell("a | b") == "a \\| b"


# ---------------------------------------------------------------- _flatten_table_cell


def test_flatten_table_cell_handles_pipes_and_newlines() -> None:
    out = _flatten_table_cell("split | here\nand\twrap")
    assert "\n" not in out
    assert "\\|" in out
    assert out == "split \\| here and wrap"


def test_flatten_table_cell_falls_back_for_empty() -> None:
    assert _flatten_table_cell("") == "–"
    assert _flatten_table_cell(None) == "–"


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
        "### Flagged for review",
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

    The post-2026-05-01 boundary fix moved sanitisation into
    ``_extract_report`` itself; the function now requires ``session``
    so it can validate ``per_role_scores[].role_id`` against the real
    roster. The fallback path doesn't exercise that validation (no
    tool call → empty scores), so a minimal Session with no roles is
    enough.
    """

    from app.llm.export import _extract_report
    from app.sessions.models import Session, SessionState

    session = Session(
        scenario_prompt="(unused)",
        state=SessionState.ENDED,
        roles=[],
        creator_role_id="",
    )

    fallback = _extract_report(
        [
            {"type": "text", "text": "free-form reply, no tool call"},
        ],
        session=session,
    )
    # Sanity: fallback shape preserved (sanitiser passes through the
    # synthesised executive_summary / narrative; integer fields land
    # at the safe-default 0).
    assert fallback["overall_score"] == 0
    assert fallback["per_role_scores"] == []
    assert fallback["what_went_well"] == []

    captured = capsys.readouterr()
    log_blob = captured.out + captured.err
    assert "aar_finalize_report_missing" in log_blob, (
        "expected an `aar_finalize_report_missing` warning when the "
        f"fallback path fires; saw stdout: {captured.out!r}, stderr: {captured.err!r}"
    )


# ---------------------------------------------------------------- AAR trust-boundary fuzz
#
# These tests probe the trust-boundary helpers in ``_extract_report`` /
# ``_sanitise_report`` with deliberately misshapen model output, locking
# in the contract: every shape the model has ever emitted must produce
# a well-formed report (or an empty default), never a crash and never
# a corrupt downstream render. Live-API tests catch the average model
# behavior; these tests catch the rare-shape behavior the live tests
# don't reliably hit.


def _two_role_session() -> Session:
    """Minimal ENDED session with two scoreable roles. Reused by the
    fuzz tests below so the role-id resolver has real ids to validate
    against."""

    return Session(
        scenario_prompt="(fuzz)",
        state=SessionState.ENDED,
        roles=[
            Role(id="role-ciso", label="CISO", display_name="Alex", is_creator=True),
            Role(id="role-soc", label="SOC", display_name="Bo"),
        ],
        creator_role_id="role-ciso",
    )


def test_coerce_dict_list_passthroughs() -> None:
    """``_coerce_dict_list`` returns the input list unchanged when the
    model emitted a real list (the happy path)."""

    from app.llm.export import _coerce_dict_list

    payload = [{"role_id": "role-ciso"}, {"role_id": "role-soc"}]
    assert _coerce_dict_list(payload) is payload


def test_coerce_dict_list_wraps_lone_dict() -> None:
    """A single object (not a list) gets wrapped — rare model variant
    where the schema's ``array<object>`` came back as a bare object."""

    from app.llm.export import _coerce_dict_list

    one = {"role_id": "role-ciso"}
    assert _coerce_dict_list(one) == [one]


def test_coerce_dict_list_decodes_json_string_array() -> None:
    """The bug from the 2026-05-04 sweep: ``per_role_scores`` arrived
    as a JSON-encoded string. ``_coerce_dict_list`` json.loads's it
    and returns the parsed list."""

    from app.llm.export import _coerce_dict_list

    encoded = (
        '[{"role_id": "role-ciso", "decision_quality": 4, '
        '"communication": 3, "speed": 5, "rationale": "called isolate"}]'
    )
    decoded = _coerce_dict_list(encoded)
    assert isinstance(decoded, list)
    assert len(decoded) == 1
    assert decoded[0]["role_id"] == "role-ciso"
    assert decoded[0]["decision_quality"] == 4


def test_coerce_dict_list_decodes_json_string_object() -> None:
    """Variant: model wrapped the array in an object and stringified
    it. Decode yields a dict; we wrap in a one-element list."""

    from app.llm.export import _coerce_dict_list

    encoded = '{"role_id": "role-ciso", "decision_quality": 4}'
    decoded = _coerce_dict_list(encoded)
    assert isinstance(decoded, list)
    assert len(decoded) == 1
    assert decoded[0]["role_id"] == "role-ciso"


def test_coerce_dict_list_garbage_inputs_return_empty() -> None:
    """None, empty string, garbled string, scalar, and JSON-decode-but-
    not-list-or-dict (e.g. JSON number, JSON string) all return ``[]``
    and let the caller log the drop. The only path that returns a
    non-empty list is a list/dict/decoded list/decoded object input."""

    from app.llm.export import _coerce_dict_list

    assert _coerce_dict_list(None) == []
    assert _coerce_dict_list("") == []
    assert _coerce_dict_list("   ") == []
    # JSON-decodable but wrong shape (number, string).
    assert _coerce_dict_list("42") == []
    assert _coerce_dict_list('"hello"') == []
    # Not JSON-decodable at all.
    assert _coerce_dict_list("not json{[") == []
    # Non-string scalar — deliberately NOT coerced. Empty list lets
    # the caller's per-entry validator log the drop, instead of
    # silently promoting 5 → [5] and hiding the bug.
    assert _coerce_dict_list(5) == []
    assert _coerce_dict_list(True) == []


def test_coerce_dict_list_emits_warning_on_decode(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Per Copilot review #1 / #8: every coercion or whole-field drop
    must emit a WARNING with enough context that a prompt regression
    is visible from the audit log alone. Silent success (model
    already returned a list) emits nothing — that's the happy path.

    structlog writes to stdout via PrintLoggerFactory, so we capture
    via capsys rather than the python-logging caplog."""

    from app.llm.export import _coerce_dict_list

    # Happy path — no warning.
    _coerce_dict_list([{"role_id": "role-ciso"}])
    out, err = capsys.readouterr()
    assert "aar_dict_list_coerced" not in (out + err)
    assert "aar_dict_list_dropped" not in (out + err)

    # JSON-string array — coerced + warning.
    _coerce_dict_list('[{"role_id": "role-ciso"}]')
    out, err = capsys.readouterr()
    log = out + err
    assert "aar_dict_list_coerced" in log
    assert "json_string_array" in log

    # Single dict wrap — coerced + warning.
    _coerce_dict_list({"role_id": "role-ciso"})
    out, err = capsys.readouterr()
    log = out + err
    assert "aar_dict_list_coerced" in log

    # Garbage string — dropped + warning.
    _coerce_dict_list("not json{[")
    out, err = capsys.readouterr()
    log = out + err
    assert "aar_dict_list_dropped" in log
    assert "json_decode_failed" in log

    # JSON-decoded to wrong shape — dropped + warning.
    _coerce_dict_list("42")
    out, err = capsys.readouterr()
    log = out + err
    assert "aar_dict_list_dropped" in log
    assert "json_decoded_to_unsupported_shape" in log

    # Non-string scalar — dropped + warning.
    _coerce_dict_list(5)
    out, err = capsys.readouterr()
    log = out + err
    assert "aar_dict_list_dropped" in log
    assert "unsupported_scalar" in log


def test_extract_report_recovers_from_stringified_per_role_scores() -> None:
    """End-to-end: a tool_use whose ``per_role_scores`` is the JSON-
    encoded string from the live failure mode. The post-fix extractor
    decodes it, validates the role_ids against the session roster, and
    produces a populated per_role_scores section.
    """

    from app.llm.export import _extract_report

    session = _two_role_session()
    encoded_scores = (
        '[{"role_id": "role-ciso", "decision_quality": 4, '
        '"communication": 4, "speed": 5, "rationale": "called isolate"}, '
        '{"role_id": "role-soc", "decision_quality": 3, '
        '"communication": 4, "speed": 4, "rationale": "pulled telemetry"}]'
    )
    content = [
        {
            "type": "tool_use",
            "name": "finalize_report",
            "input": {
                "executive_summary": "good run",
                "narrative": "beat 1: detection. beat 2: contained.",
                "per_role_scores": encoded_scores,  # ← the bug shape
                "overall_score": 4,
                "overall_rationale": "solid",
            },
        }
    ]
    report = _extract_report(content, session=session)
    scores = report["per_role_scores"]
    assert len(scores) == 2, (
        f"expected 2 per-role scores after decoding the JSON string; "
        f"got {len(scores)}: {scores}"
    )
    by_id = {s["role_id"]: s for s in scores}
    assert by_id["role-ciso"]["decision_quality"] == 4
    assert by_id["role-soc"]["rationale"] == "pulled telemetry"


def test_extract_report_resolves_case_insensitive_label_as_role_id() -> None:
    """Per-role-scores entry with a role *label* in the ``role_id`` field
    (instead of the canonical opaque id) is RESOLVED, not dropped. This
    is the documented contract — see ``_sanitise_report``'s
    ``by_label_lower`` lookup. The "drop, don't repair" rule from
    CLAUDE.md applies to identifiers we can't resolve; case-insensitive
    label resolution against the seated roster IS resolution, not
    repair, because the roster is canonical and the label is
    unambiguous within it.

    This test pins that contract so a future "drop labels too" change
    is a deliberate decision, not silent drift. Per Copilot review #10,
    without this test the existing ``unknown_role_id`` test reads as
    if the trust-boundary rule were stricter than it actually is."""

    from app.llm.export import _extract_report

    session = _two_role_session()
    content = [
        {
            "type": "tool_use",
            "name": "finalize_report",
            "input": {
                "executive_summary": "x",
                "narrative": "y",
                "per_role_scores": [
                    {
                        "role_id": "CISO",  # ← label, not opaque id
                        "decision_quality": 4,
                        "communication": 4,
                        "speed": 4,
                        "rationale": "label resolves to canonical id",
                    },
                    {
                        "role_id": "soc",  # ← lowercase label
                        "decision_quality": 3,
                        "communication": 3,
                        "speed": 3,
                        "rationale": "lowercase also resolves",
                    },
                ],
                "overall_score": 3,
                "overall_rationale": "ok",
            },
        }
    ]
    report = _extract_report(content, session=session)
    scores = report["per_role_scores"]
    # Both labels resolve — neither is dropped.
    assert len(scores) == 2
    by_id = {s["role_id"]: s for s in scores}
    assert "role-ciso" in by_id
    assert "role-soc" in by_id
    # The canonical id is what got written — not the label the model
    # supplied. The extractor rewrites to canonical.
    assert by_id["role-ciso"]["rationale"] == "label resolves to canonical id"
    assert by_id["role-soc"]["rationale"] == "lowercase also resolves"


def test_extract_report_drops_unknown_role_ids_in_array_input() -> None:
    """``per_role_scores`` arrives as a real list with one valid role and
    one invented role. The validator drops the invented one and keeps
    the real one — the contract documented in CLAUDE.md's model-output
    trust-boundary section ("drop, don't repair")."""

    from app.llm.export import _extract_report

    session = _two_role_session()
    content = [
        {
            "type": "tool_use",
            "name": "finalize_report",
            "input": {
                "executive_summary": "x",
                "narrative": "y",
                "per_role_scores": [
                    {
                        "role_id": "role-ciso",
                        "decision_quality": 3,
                        "communication": 3,
                        "speed": 3,
                        "rationale": "ok",
                    },
                    {
                        "role_id": "role-comms",  # ← invented
                        "decision_quality": 5,
                        "communication": 5,
                        "speed": 5,
                        "rationale": "made up",
                    },
                ],
                "overall_score": 3,
                "overall_rationale": "ok",
            },
        }
    ]
    report = _extract_report(content, session=session)
    scores = report["per_role_scores"]
    assert len(scores) == 1
    assert scores[0]["role_id"] == "role-ciso"


def test_extract_report_clamps_out_of_range_subscores() -> None:
    """Numeric fields are clamped to 0-5. The model emits 7 (above
    range) and -1 (below range); the extractor clamps to 5 / 0."""

    from app.llm.export import _extract_report

    session = _two_role_session()
    content = [
        {
            "type": "tool_use",
            "name": "finalize_report",
            "input": {
                "executive_summary": "x",
                "narrative": "y",
                "per_role_scores": [
                    {
                        "role_id": "role-ciso",
                        "decision_quality": 7,   # over
                        "communication": -1,     # under
                        "speed": "not a number", # garbage → 0
                        "rationale": "edge",
                    },
                ],
                "overall_score": 99,
                "overall_rationale": "z",
            },
        }
    ]
    report = _extract_report(content, session=session)
    scores = report["per_role_scores"]
    assert len(scores) == 1
    assert scores[0]["decision_quality"] == 5
    assert scores[0]["communication"] == 0
    assert scores[0]["speed"] == 0
    assert report["overall_score"] == 5


def test_extract_report_coerces_string_blob_in_array_string_fields() -> None:
    """``what_went_well`` / ``gaps`` / ``recommendations`` declared
    array<string> in the schema. The model occasionally emits a single
    string blob. ``_coerce_str_list`` wraps it as ``[blob]`` so the
    renderer doesn't iterate the string per-character."""

    from app.llm.export import _extract_report

    session = _two_role_session()
    content = [
        {
            "type": "tool_use",
            "name": "finalize_report",
            "input": {
                "executive_summary": "x",
                "narrative": "y",
                "what_went_well": "single string instead of an array",
                "gaps": [],  # legitimately empty — not a coercion test
                "recommendations": ["a real first item"],
                "per_role_scores": [],
                "overall_score": 3,
                "overall_rationale": "z",
            },
        }
    ]
    report = _extract_report(content, session=session)
    assert report["what_went_well"] == ["single string instead of an array"]
    assert report["recommendations"] == ["a real first item"]
    assert report["gaps"] == []


def test_extract_report_round_trips_flagged_for_review() -> None:
    """Issue #117 — ``flagged_for_review`` is part of the AAR tool
    schema and is deliberately category-agnostic (a flag might be a
    decision, question, follow-up, debrief item, etc.). The extractor
    coerces it through the same string-list path as the other bullet
    sections, and the field defaults to ``[]`` when the model omits
    it (older mock fixtures, pre-#117 recordings)."""

    from app.llm.export import _extract_report

    session = _two_role_session()
    content = [
        {
            "type": "tool_use",
            "name": "finalize_report",
            "input": {
                "executive_summary": "x",
                "narrative": "y",
                "flagged_for_review": [
                    "Isolated finance subnet at T+04:12 (CISO call)",
                    "Open question: was the ransom ever revisited after the backup decision?",
                    "Follow-up: legal sign-off on the holding statement",
                ],
                "per_role_scores": [],
                "overall_score": 3,
                "overall_rationale": "z",
            },
        }
    ]
    report = _extract_report(content, session=session)
    assert report["flagged_for_review"] == [
        "Isolated finance subnet at T+04:12 (CISO call)",
        "Open question: was the ransom ever revisited after the backup decision?",
        "Follow-up: legal sign-off on the holding statement",
    ]


def test_extract_report_flagged_for_review_defaults_to_empty_list_when_omitted() -> None:
    """Backwards-compat with mock fixtures and any recorded scenarios
    captured before the field existed: an absent ``flagged_for_review``
    MUST return ``[]`` so the renderer's empty-section gate hides the
    heading instead of crashing on a missing key."""

    from app.llm.export import _extract_report

    session = _two_role_session()
    content = [
        {
            "type": "tool_use",
            "name": "finalize_report",
            "input": {
                "executive_summary": "x",
                "narrative": "y",
                # No ``flagged_for_review`` at all.
                "per_role_scores": [],
                "overall_score": 3,
                "overall_rationale": "z",
            },
        }
    ]
    report = _extract_report(content, session=session)
    assert report["flagged_for_review"] == []


def test_extract_report_coerces_string_blob_in_flagged_for_review() -> None:
    """Same string-blob recovery path as the other array<string>
    fields — issue #117 added a fourth such field."""

    from app.llm.export import _extract_report

    session = _two_role_session()
    content = [
        {
            "type": "tool_use",
            "name": "finalize_report",
            "input": {
                "executive_summary": "x",
                "narrative": "y",
                "flagged_for_review": "Single flagged sentence as a blob",
                "per_role_scores": [],
                "overall_score": 3,
                "overall_rationale": "z",
            },
        }
    ]
    report = _extract_report(content, session=session)
    assert report["flagged_for_review"] == ["Single flagged sentence as a blob"]


def test_render_markdown_hides_flagged_for_review_section_when_empty() -> None:
    """An exercise where nobody clicked Mark-for-AAR (and the model
    didn't flag anything from the transcript) should not render an
    empty ``### Flagged for review`` heading. Mirrors the existing
    what-went-well / gaps / recommendations empty-section behavior."""

    from app.llm.export import _render_markdown

    session = _two_role_session()
    report = {
        "executive_summary": "x",
        "narrative": "y",
        "what_went_well": ["did the thing"],
        "gaps": [],
        "recommendations": [],
        "flagged_for_review": [],  # empty
        "per_role_scores": [],
        "overall_score": 3,
        "overall_rationale": "z",
    }
    md = _render_markdown(session, report, audit_events=[])
    assert "### Flagged for review" not in md


# ---------------------------------------------------------------- prompt ↔ renderer


def test_aar_prompt_documents_section_order_matching_renderer() -> None:
    """The AAR system prompt tells the model "the markdown export
    renders these in a fixed order: ..." so the model can plan flow
    and transitions correctly. If the prompt's order drifts from the
    renderer's actual order (or omits a section), the model writes
    against a stale mental model — the May 2026 bug-scrub caught
    `flagged_for_review` missing from the documented order even
    though the renderer placed it between gaps and recommendations.
    """

    from app.llm.export import _render_markdown
    from app.llm.prompts import _AAR_SYSTEM

    # Sections the prompt documents in its order line, in canonical
    # markdown-header form. Anchored to the snake_case field names
    # the prompt uses; map each to the heading the renderer emits.
    prompt_to_header = {
        "executive_summary": "## Executive summary",
        "narrative": "## After-action narrative",
        "what_went_well": "### What went well",
        "gaps": "### Gaps",
        "flagged_for_review": "### Flagged for review",
        "recommendations": "### Recommendations",
        "per_role_scores": "## Per-role scores",
        "overall_score": "## Overall session score",
    }

    # Verify the prompt actually mentions the order line and every
    # field appears in it. A regression that drops one of these from
    # the prompt copy fails this assertion.
    order_line = None
    for line in _AAR_SYSTEM.splitlines():
        if "fixed order" in line:
            order_line = line
            break
    assert order_line is not None, "AAR prompt must document section order"
    for field in prompt_to_header:
        assert field in order_line, (
            f"AAR prompt order line is missing '{field}': {order_line!r}"
        )

    # Now verify the prompt's order matches the renderer's order.
    # Build a session + report with every section populated so the
    # renderer emits each header.
    session = _two_role_session()
    report = {
        "executive_summary": "exec",
        "narrative": "narr",
        "what_went_well": ["item"],
        "gaps": ["item"],
        "flagged_for_review": ["item"],
        "recommendations": ["item"],
        "per_role_scores": [],
        "overall_score": 3,
        "overall_rationale": "ovr",
    }
    md = _render_markdown(session, report, audit_events=[])

    # Prompt order → rendered header positions. Each must be > the prior.
    rendered_positions = []
    for field, header in prompt_to_header.items():
        if field == "overall_score":
            # Renderer header includes the digit; just check the prefix.
            idx = md.index("## Overall session score")
        else:
            assert header in md, f"renderer didn't emit {header!r}"
            idx = md.index(header)
        rendered_positions.append((field, idx))

    sorted_positions = sorted(rendered_positions, key=lambda p: p[1])
    assert rendered_positions == sorted_positions, (
        "AAR prompt's documented order disagrees with renderer order. "
        f"prompt order: {[f for f, _ in rendered_positions]}; "
        f"actual order: {[f for f, _ in sorted_positions]}. "
        "Update _AAR_SYSTEM (the line with 'fixed order') to match "
        "_render_markdown."
    )


def test_aar_prompt_documents_zero_as_skipped_in_rubric() -> None:
    """PR #204 introduced the skip-zero feature: a sub-score of 0
    renders as a dash, and ``compute_avg_subscore`` skips zeros when
    averaging. The prompt's rubric must tell the model that 0 is the
    correct emit when it has no observable evidence — otherwise the
    model defaults to 3 ('at bar') to fill the slot, defeating the
    feature and making the report read as evasive (the bunching anti-
    pattern the rubric explicitly warns against)."""

    from app.llm.prompts import _AAR_SYSTEM

    rubric_block = _AAR_SYSTEM
    # Must mention 0 in the score range (rubric is "0–5" not "1–5").
    assert "0–5" in rubric_block or "0-5" in rubric_block, (
        "AAR rubric must declare scores as 0–5 (not 1–5) — the "
        "extractor accepts 0 and the renderer treats 0 as 'skipped'."
    )
    # Must explicitly tell the model what 0 means.
    assert "0 = no observable evidence" in rubric_block, (
        "AAR rubric must tell the model 0 = no observable evidence "
        "and not to default to 3."
    )
    # Must explicitly tell the model NOT to default to 3.
    lowered = rubric_block.lower()
    assert "do not default to 3" in lowered or "never default to 3" in lowered, (
        "AAR rubric must tell the model not to default to 3 when "
        "evidence is absent — the bunching pattern is the failure "
        "mode the skip-zero feature exists to fix."
    )
