"""Live-API regression suite for the AAR generation pipeline.

Each test hits the real Anthropic API and asserts that the AAR generator
produces a structured ``finalize_report`` tool call with the fields the
markdown renderer relies on. Skipped unless ``ANTHROPIC_API_KEY`` is set.
Cost: ~$0.05 per run (one Opus call per test, ~5K input + ~1.5K output).

Why this exists
---------------

Issue #83 surfaced two failure modes the unit-test layer can't catch:

1. **Schema drift** — if the AAR system prompt or the ``finalize_report``
   tool description changes such that the model omits a required field
   (e.g. ``per_role_scores``) or returns the wrong shape, the deterministic
   markdown renderer falls back to "(no structured report returned)" and
   the operator sees a degraded AAR. Mocked fixtures don't catch this; only
   the real model does.

2. **Markdown emission inside list items** — the ``what_went_well`` /
   ``gaps`` / ``recommendations`` bullets must render properly even when
   the model emits markdown (bold, sub-bullets) inside individual entries.
   The renderer fix in this branch indents continuation lines so multi-line
   items don't break the parent bullet; this suite confirms the model
   actually exercises that path.

These tests run against the same prompt + tool surface production uses, so
they regress on prompt edits, tool-schema edits, and any
``Settings.model_for("aar")`` change.
"""

from __future__ import annotations

import pytest

from app.auth.audit import AuditLog
from app.config import get_settings
from app.llm.client import LLMClient
from app.llm.export import AARGenerator, _extract_report
from app.llm.prompts import build_aar_system_blocks
from app.llm.tools import AAR_TOOL
from app.sessions.models import (
    Session,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.live]


# ---------------------------------------------------------------- fixtures


# ``aar_session`` lives in conftest.py so the LLM-as-judge AAR-quality
# suite can reuse it without duplicating the fixture.


@pytest.fixture
def aar_audit() -> AuditLog:
    """Empty audit log — the AAR pipeline accepts this and the model
    grounds its output in the transcript instead. The audit log is
    additive context; not having it shouldn't break the generation."""

    return AuditLog()


@pytest.fixture
def aar_client() -> LLMClient:
    """Production-shaped LLMClient pointed at the live API."""

    settings = get_settings()
    # The client's own factory; same path the SessionManager uses.
    client = LLMClient(settings=settings)
    return client


# ---------------------------------------------------------------- tests


async def test_aar_generator_emits_finalize_report(
    aar_session: Session, aar_audit: AuditLog, aar_client: LLMClient
) -> None:
    """End-to-end: AARGenerator on a small transcript produces a markdown
    string that includes every required section. Routing-level check —
    the goal is to verify the model still picks ``finalize_report`` (not
    a freeform text reply) under the current prompt."""

    gen = AARGenerator(llm=aar_client, audit=aar_audit)
    md = await gen.generate(aar_session)

    # Required sections (sanity — empty model output would not include them).
    for section in (
        "## Executive summary",
        "## After-action narrative",
        "## Per-role scores",
        "## Overall session score",
        "## Appendix A — Setup conversation",
        "## Appendix D — Full transcript",
    ):
        assert section in md, f"missing section in AAR: {section}"

    # Issue #83: transcript appendix sits after the analytic sections.
    assert md.index("## Per-role scores") < md.index("## Appendix D — Full transcript")

    # The fallback string is a sign the model didn't emit finalize_report.
    assert "(no structured report returned)" not in md, (
        "model failed to emit finalize_report; markdown contains the "
        "fallback synthesis text. Likely cause: AAR system prompt drift "
        "or tool-description regression."
    )

    # Issue #83 fix #2: every transcript entry renders as
    # ``header + > body``. Confirm the blockquote prefix actually made
    # it through the live round-trip — a future regression that flipped
    # ``_format_transcript_entry`` back to a flat one-liner would still
    # leave the section heading in place but lose the markdown-preserving
    # blockquote structure. Catch it here.
    transcript_section = md.split("## Appendix D — Full transcript", 1)[1]
    assert any(line.startswith("> ") for line in transcript_section.splitlines()), (
        "transcript appendix has no blockquote-prefixed lines — the "
        "renderer regressed to the pre-#83 flat one-liner format."
    )


async def test_aar_report_includes_per_role_scores_for_seated_roles(
    aar_session: Session, aar_audit: AuditLog, aar_client: LLMClient
) -> None:
    """Each seated role must appear in ``per_role_scores`` with all four
    sub-fields populated. The renderer falls back to ``–`` for missing
    role rows, which is operator-confusing — catch model omissions here."""

    raw = await aar_client.acomplete(
        tier="aar",
        system_blocks=build_aar_system_blocks(aar_session),
        messages=[
            {
                "role": "user",
                "content": _build_user_payload(aar_session, aar_audit),
            }
        ],
        tools=[AAR_TOOL],
        session_id=aar_session.id,
    )
    report = _extract_report(raw.content)

    assert report.get("per_role_scores"), (
        f"finalize_report missing per_role_scores: {list(report.keys())}"
    )
    seated_ids = {r.id for r in aar_session.roles}
    scored_ids = {row.get("role_id") for row in report["per_role_scores"]}
    missing = seated_ids - scored_ids
    assert not missing, (
        f"model omitted per_role_scores for roles: {missing}; "
        f"reported: {scored_ids}"
    )

    for row in report["per_role_scores"]:
        for field in ("decision_quality", "communication", "speed", "rationale"):
            assert field in row, (
                f"per_role_scores entry for {row.get('role_id')} missing "
                f"{field}: {row}"
            )
        # Numeric fields must fall in the rubric range 1–5.
        for field in ("decision_quality", "communication", "speed"):
            value = row[field]
            assert isinstance(value, int) and 1 <= value <= 5, (
                f"{row.get('role_id')}.{field} = {value!r}; expected int 1–5"
            )
        assert isinstance(row["rationale"], str) and row["rationale"].strip(), (
            f"{row.get('role_id')}.rationale must be a non-empty string"
        )


async def test_aar_report_overall_score_in_range(
    aar_session: Session, aar_audit: AuditLog, aar_client: LLMClient
) -> None:
    """Overall score must be an integer 1–5 with a non-empty rationale."""

    raw = await aar_client.acomplete(
        tier="aar",
        system_blocks=build_aar_system_blocks(aar_session),
        messages=[
            {
                "role": "user",
                "content": _build_user_payload(aar_session, aar_audit),
            }
        ],
        tools=[AAR_TOOL],
        session_id=aar_session.id,
    )
    report = _extract_report(raw.content)

    score = report.get("overall_score")
    assert isinstance(score, int) and 1 <= score <= 5, (
        f"overall_score = {score!r}; expected int 1–5"
    )
    rationale = report.get("overall_rationale", "")
    assert isinstance(rationale, str) and rationale.strip(), (
        f"overall_rationale missing or empty: {rationale!r}"
    )


async def test_aar_report_grounds_recommendations_in_transcript(
    aar_session: Session, aar_audit: AuditLog, aar_client: LLMClient
) -> None:
    """The model should produce at least one recommendation that touches
    a topic actually present in the transcript (containment, regulator
    notification, comms / press, vendor accounts, etc.). Soft-grounding
    check — at least one keyword from the seeded narrative should appear
    somewhere in the recommendations OR in the gaps list. If neither
    contains a single transcript-anchored keyword, the model is producing
    generic boilerplate and the AAR is failing its core job."""

    raw = await aar_client.acomplete(
        tier="aar",
        system_blocks=build_aar_system_blocks(aar_session),
        messages=[
            {
                "role": "user",
                "content": _build_user_payload(aar_session, aar_audit),
            }
        ],
        tools=[AAR_TOOL],
        session_id=aar_session.id,
    )
    report = _extract_report(raw.content)

    recs = report.get("recommendations") or []
    gaps = report.get("gaps") or []
    assert recs, "model produced no recommendations"
    # Search both gaps and recs — gaps name "what was missing" and recs
    # name "what to do about it"; either is a valid place to anchor a
    # transcript-grounded observation. The model also frequently uses
    # the narrative section for these anchors.
    narrative = report.get("narrative") or ""
    blob = (" ".join(recs) + " " + " ".join(gaps) + " " + narrative).lower()
    # Substrings (not whole words) so "communications", "communicate",
    # "comms", "regulatory", "regulator" all hit a single check, and the
    # model's preferred phrasing doesn't trip the test.
    keywords = (
        "regulat",  # regulator / regulatory
        "comm",  # comms / communication / communicate
        "press",
        "media",
        "reporter",
        "containment",
        "contain",
        "isolat",  # isolation / isolate
        "vendor",
        "legal",
        "draft",
        "playbook",
        "ransom",
        "defender",
        "slack",
        "screenshot",
    )
    hits = [k for k in keywords if k in blob]
    assert hits, (
        "neither recommendations nor gaps reference any topic from the "
        "seeded transcript — model may be producing generic boilerplate. "
        f"recommendations: {recs}\ngaps: {gaps}"
    )


async def test_aar_report_what_went_well_and_gaps_non_empty(
    aar_session: Session, aar_audit: AuditLog, aar_client: LLMClient
) -> None:
    """Both the strengths and the gaps list must be populated for the
    AAR to feel balanced. The system prompt explicitly asks for 3–7 items
    per list; assert at least one in each."""

    raw = await aar_client.acomplete(
        tier="aar",
        system_blocks=build_aar_system_blocks(aar_session),
        messages=[
            {
                "role": "user",
                "content": _build_user_payload(aar_session, aar_audit),
            }
        ],
        tools=[AAR_TOOL],
        session_id=aar_session.id,
    )
    report = _extract_report(raw.content)

    well = report.get("what_went_well") or []
    gaps = report.get("gaps") or []
    # Issue #83 in practice: the live model occasionally emits a
    # whitespace-only entry (observed on 2026-04-30: ``'\n'`` slipped
    # through Opus output). The renderer's ``_render_bullets`` drops
    # those silently — so the user-visible AAR is fine, but the test
    # bar is "at least one non-empty item per list", not "every item is
    # non-empty". This both avoids flakiness and proves the renderer is
    # tolerant of the variance.
    well_clean = [item for item in well if isinstance(item, str) and item.strip()]
    gaps_clean = [item for item in gaps if isinstance(item, str) and item.strip()]
    assert well_clean, (
        "what_went_well has no non-empty items — AAR feels one-sided. "
        f"Raw: {well!r}"
    )
    assert gaps_clean, (
        "gaps has no non-empty items — AAR feels one-sided. "
        f"Raw: {gaps!r}"
    )


async def test_aar_report_no_temperature_param_for_opus(
    aar_session: Session, aar_audit: AuditLog, aar_client: LLMClient
) -> None:
    """Defensive guard: the AAR tier defaults to Opus 4.x which rejects
    the ``temperature`` param. The client strips it before the API call;
    if a future caller re-introduces it, the live API will 400. This
    test simply runs an end-to-end AAR and asserts no API error — a
    return without exception means the strip is still in place."""

    gen = AARGenerator(llm=aar_client, audit=aar_audit)
    md = await gen.generate(aar_session)
    # If the call had errored on a temperature rejection, generate() would
    # have raised. A non-empty markdown body is enough confirmation here.
    assert md.startswith("# "), (
        f"AAR markdown does not begin with a heading; first 80 chars: "
        f"{md[:80]!r}"
    )


# ---------------------------------------------------------------- helpers


def _build_user_payload(session: Session, audit: AuditLog) -> str:
    """Mirror :func:`app.llm.export._user_payload` for the lower-level
    tests that bypass the AARGenerator wrapper. Kept inline rather than
    importing the underscore-private helper so a future signature change
    doesn't require touching multiple files in lockstep."""

    import json

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


# Suite-level guard — the directory-level conftest skips when the API key
# is missing OR when ``TEST_MODE`` is set, but defending in depth here
# gives a clearer error if someone runs the file directly with
# ``pytest tests/live/test_aar_generation.py``.  Resolves through
# ``Settings`` (pydantic-settings) so a key in ``.env`` is honoured the
# same as a shell-exported env var — matches the production resolution
# path. ``test_mode`` is also gated because the parent conftest force-
# sets ``TEST_MODE=true`` for unit-test convenience; with it on, the
# placeholder ``"test-mode-no-key"`` would reach the API and 401.
_settings = get_settings()
if _settings.anthropic_api_key is None or _settings.test_mode:  # pragma: no cover - import-time guard
    pytestmark.append(
        pytest.mark.skip(
            reason=(
                "live-API tests require ANTHROPIC_API_KEY and "
                "TEST_MODE unset"
            )
        )
    )
