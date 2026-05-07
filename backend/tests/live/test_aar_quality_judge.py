"""LLM-as-judge AAR quality regression suite.

Companion to ``test_aar_generation.py``: that file checks the AAR
markdown contains the required SECTIONS (executive summary, per-role
scores, etc.) — a routing-level smoke test. This file checks the
QUALITY of the content within those sections by asking a Haiku judge
to evaluate the AAR against rubrics that encode the contract:

* the AAR grounds claims in the transcript (no hallucinated decisions),
* per-role scores are differentiated rather than uniform 5/5s,
* gaps + recommendations are concrete (not vague boilerplate),
* the report doesn't leak the hidden plan into the participant view.

Cost: ~$0.07 per test (one Opus AAR call + one Haiku judge call).
Skipped unless ``LLM_API_KEY`` is set.
"""

from __future__ import annotations

from typing import Any

import pytest
from anthropic import AsyncAnthropic

from app.auth.audit import AuditLog
from app.config import get_settings
from app.llm.client import LLMClient
from app.llm.export import AARGenerator, strip_creator_only

from .judge import assert_judge_passes

pytestmark = [pytest.mark.asyncio, pytest.mark.live]


@pytest.fixture
def aar_audit() -> AuditLog:
    return AuditLog()


@pytest.fixture
def aar_client() -> LLMClient:
    return LLMClient(settings=get_settings())


@pytest.fixture
def judge_client() -> AsyncAnthropic:
    """Shared judge transport — reused across all judge calls in a
    test so the cached system block (``cache_control: ephemeral``)
    actually hits on the second + Nth invocation.

    Reads the API key via ``Settings.require_llm_api_key()`` rather
    than ``os.environ`` directly — see ``conftest.py`` for the
    rationale (matches the production resolution path; ``.env`` works
    the same as a shell env var).

    Asserts the resolved key is not the parent-conftest dummy
    defensively — the conftest auto-skip should have caught a dummy-
    key run already, but the dummy slipping into a real API call is
    exactly the failure mode the multi-layer guard exists to prevent.
    The dummy-key constant is imported from ``tests/conftest.py`` so
    the three callsites stay in lockstep.
    """

    from tests.conftest import DUMMY_LLM_API_KEY

    settings = get_settings()
    key = settings.require_llm_api_key()
    assert key != DUMMY_LLM_API_KEY, (
        "judge_client fixture must not run with the test-conftest "
        "dummy key; the live conftest's auto-skip should have "
        "intercepted this."
    )
    return AsyncAnthropic(
        api_key=key,
        base_url=settings.llm_api_base,
    )


def _truncate_for_judge(md: str, *, cap_chars: int = 12_000) -> str:
    """Cap the AAR length passed to the judge to keep its input cost
    bounded. The judge only needs the leading sections (exec summary,
    narrative, per-role, gaps, recs) — the appendices are repeats."""

    if len(md) <= cap_chars:
        return md
    return md[:cap_chars] + "\n\n[...truncated for judge input...]"


# ---------------------------------------------------------------- tests


async def test_aar_grounds_claims_in_transcript(
    aar_session: Any,  # imported indirectly via test_aar_generation conftest
    aar_audit: AuditLog,
    aar_client: LLMClient,
    judge_client: AsyncAnthropic,
) -> None:
    """Every concrete claim in the AAR (decisions, role actions, what
    went well/badly) must be traceable to a transcript event. The
    transcript fixture has 6 well-defined turns; the AAR must not
    invent a 7th decision."""

    gen = AARGenerator(llm=aar_client, audit=aar_audit)
    md, _ = await gen.generate(aar_session)
    artifact = _truncate_for_judge(md)

    rubric = """
    The AAR markdown below was generated from this transcript:

      Beat 1: AI broadcasts detection on three finance laptops; asks
      CISO to choose isolate vs monitor.
      CISO: "Isolate now. Pull IR Lead in. Start the regulator clock."
      AI: acknowledges; asks SOC for alert queue.
      SOC: "Three FIN-* hosts with Defender alert + lateral SMB
      attempts to FIN-08. Pulling Defender logs now."
      Critical inject: reporter calls about leaked Slack screenshot.
      CISO: "No comment to press. Have Comms draft a holding
      statement with Legal."

    The roster is exactly two roles: CISO and SOC.

    Required for PASS — the AAR must not:
    1. **MECHANICAL CHECK — count entries in the "## Per-role scores"
       section only.** Locate the structured section that lists each
       scored role with sub-scores (decision_quality / communication /
       speed) and a rationale. If that section has EXACTLY two entries
       and they are CISO and SOC (case-insensitive label match,
       opaque-id role_id is fine), criterion 1 PASSES — regardless of
       any other content anywhere else in the AAR. Do NOT read the
       narrative, executive summary, gaps, or recommendations for
       this criterion: only the per-role scores section. Narrative
       mention or critique of Legal / Comms / IR Lead is EXPECTED
       (the transcript has the CISO explicitly pull them in) and
       MUST NOT influence this criterion. Criterion 1 fails ONLY
       when the per-role scores section adds a third (or more) entry
       — e.g. a row with role "Comms" or "Legal" or "IR Lead" with
       its own decision_quality / communication / speed sub-scores.
       Example PASS: per-role scores has exactly CISO + SOC; the
       narrative recommends the team loop Legal in earlier.
       Example FAIL: per-role scores has CISO + SOC + Legal, where
       Legal has decision_quality=4, communication=3, speed=2.
    2. Invent decisions that didn't happen. The CISO did not, e.g.,
       "decide to pay the ransom" or "shut down the data center" —
       any AAR claim attributing such a decision to CISO fails.
    3. Misattribute decisions across roles (e.g. claim SOC made the
       legal-comms call that CISO actually made).
    4. Cite specific timestamps not present in the transcript (e.g.
       "at 03:47" when the transcript only mentions 03:14).

    A properly grounded AAR uses ONLY the events listed above.
    """
    await assert_judge_passes(
        rubric=rubric,
        artifact=artifact,
        artifact_kind="generated AAR markdown",
        client=judge_client,
    )


async def test_aar_per_role_scores_are_differentiated(
    aar_session: Any,
    aar_audit: AuditLog,
    aar_client: LLMClient,
    judge_client: AsyncAnthropic,
) -> None:
    """A common failure mode: the model gives every role 5/5 across
    every sub-score. We want graded judgement, even if the overall is
    high. The transcript has CISO making the harder calls (isolate,
    legal/comms decision); their sub-scores should plausibly differ
    from SOC's, who mostly reported telemetry."""

    gen = AARGenerator(llm=aar_client, audit=aar_audit)
    md, _ = await gen.generate(aar_session)
    artifact = _truncate_for_judge(md)

    rubric = """
    The AAR contains a "## Per-role scores" section with one entry per
    role. Each entry has sub-scores (decision_quality, communication,
    speed) on a 0-5 scale, plus a rationale.

    Required for PASS:
    1. The per-role section shows BOTH CISO and SOC (the roster has
       exactly these two roles).
    2. The sub-scores for the two roles are NOT IDENTICAL across
       every dimension AND show MEANINGFUL differentiation: at least
       one sub-score differs by ≥ 1 point between CISO and SOC, AND
       the two rationales reference DIFFERENT transcript events
       (CISO's rationale should cite their isolation/legal-comms
       calls; SOC's should cite their telemetry / Defender work).
       A model that emits 5/5/5 vs 5/5/4 with copy-paste rationales
       fails.
    3. Each role's rationale is a SUBSTANTIVE sentence (more than
       6 words) that references a concrete action from the
       transcript. Boilerplate like "did well overall" with no
       transcript reference fails.
    4. No score is outside the 0-5 range.
    """
    await assert_judge_passes(
        rubric=rubric,
        artifact=artifact,
        artifact_kind="AAR per-role scores",
        client=judge_client,
    )


async def test_aar_gaps_and_recommendations_are_concrete(
    aar_session: Any,
    aar_audit: AuditLog,
    aar_client: LLMClient,
    judge_client: AsyncAnthropic,
) -> None:
    """The "Gaps" and "Recommendations" sections must be actionable.
    Generic boilerplate ("improve communication", "follow the runbook")
    is the failure mode this test guards against."""

    gen = AARGenerator(llm=aar_client, audit=aar_audit)
    md, _ = await gen.generate(aar_session)
    artifact = _truncate_for_judge(md)

    rubric = """
    The AAR contains "Gaps" and "Recommendations" sub-sections under the
    after-action narrative or as standalone sections.

    Required for PASS:
    1. There is at least one gap and at least one recommendation
       listed.
    2. Each gap names a CONCRETE thing that was missed or could have
       gone better — referencing a transcript event, a missing role
       (e.g. Legal not yet looped in proactively), or a specific
       artifact (Defender logs not preserved, comms draft not
       prepared in advance, etc.). A gap that says only "team should
       improve coordination" with no specifics fails.
    3. Each recommendation is ACTIONABLE — names a specific change
       (pre-stage X, draft Y in advance, integrate Z into the
       runbook). Vague advice ("communicate better") fails.
    4. Recommendations should be implementable by a security org
       in the next quarter (not science-fiction).

    Two concrete gaps + two concrete recommendations PASS. One
    boilerplate item fails the whole rubric.
    """
    await assert_judge_passes(
        rubric=rubric,
        artifact=artifact,
        artifact_kind="AAR gaps + recommendations",
        client=judge_client,
    )


async def test_aar_participant_view_strips_creator_only(
    aar_session: Any,
    aar_audit: AuditLog,
    aar_client: LLMClient,
    judge_client: AsyncAnthropic,
) -> None:
    """The non-creator markdown (``strip_creator_only``) must not
    contain the AI rationale appendix or anything else flagged
    creator-only. We use the judge to confirm the stripping is
    semantically clean — content from a stripped section shouldn't
    leak via paraphrase elsewhere."""

    gen = AARGenerator(llm=aar_client, audit=aar_audit)
    full, _ = await gen.generate(aar_session)
    stripped = strip_creator_only(full)
    artifact = _truncate_for_judge(stripped)

    rubric = """
    The AAR markdown below is the version sent to NON-CREATOR roles.
    The creator-only sections (notably the "AI decision rationale"
    appendix) have been stripped before this view is served.

    Required for PASS:
    1. The artifact does NOT contain a section heading or paragraph
       discussing the AI's internal decision rationale ("why the AI
       chose X", "AI rationale", "AI internal reasoning").
    2. The artifact does NOT contain a creator-only marker like
       "(creator only)" or "[creator only]".
    3. The artifact still contains the standard player-facing
       sections: executive summary, per-role scores, gaps,
       recommendations. Stripping should not have removed the
       legitimate sections.

    Note: in-narrative references to the AI's facilitator action
    ("the AI then asked the CISO …") are FINE — those describe
    what happened, not the model's internal reasoning. Only an
    explicit "AI rationale" / "AI's internal logic" section is
    creator-only.
    """
    await assert_judge_passes(
        rubric=rubric,
        artifact=artifact,
        artifact_kind="participant-facing AAR (creator-only stripped)",
        client=judge_client,
    )
