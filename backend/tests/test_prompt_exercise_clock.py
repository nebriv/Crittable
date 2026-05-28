"""Exercise-clock (temporal anchor) regression net for the LLM tiers.

Origin: a creator reported that the AI rendered a ``share_data`` brief
headed "Sign-In Log — Last 30 Days" whose only hit was dated months
outside that window ("Oct 14"). The model had no notion of the current
date, so every synthetic timestamp it invented for scenario telemetry
was ungrounded and mutually inconsistent. The fix anchors the setup,
play, and AAR tiers on ``session.created_at`` via
``_exercise_clock_block`` so the plan's inject timeline, the live data
briefs, and the AAR all share one "now".

These tests assert:
- the clock block is present in the setup / play / AAR tiers,
- in the play tier it lands in the STABLE (cached) prefix and NOT the
  volatile suffix — it's frozen per session, so re-billing it every
  turn would defeat the prompt cache for no benefit,
- the rendered human date + UTC clock track ``created_at``,
- the directly-reported failure mode ("last 30 days") is named so the
  model is taught the exact constraint it violated,
- it is absent from the guardrail tier, which classifies a single
  message and has no scenario clock to anchor.

Soft prompt assertions are normally low value; this one is high value
because the failure was a concrete user report with a well-defined
detection signature.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from app.extensions.models import ExtensionBundle
from app.extensions.registry import FrozenRegistry, freeze_bundle
from app.llm.prompts import (
    _exercise_clock_block,
    build_aar_system_blocks,
    build_guardrail_system_blocks,
    build_play_system_blocks,
    build_setup_system_blocks,
)
from app.sessions.models import Role, Session, SessionState

# 2026-05-28 is a Thursday; pinned so the human-date assertion is exact.
_CREATED = datetime(2026, 5, 28, 14, 23, tzinfo=UTC)
_HUMAN = "Thursday, May 28, 2026"
_CLOCK = "14:23 UTC"


def _empty_registry() -> FrozenRegistry:
    return freeze_bundle(ExtensionBundle())


def _flatten(blocks: list[dict[str, Any]]) -> str:
    return "\n".join(b.get("text", "") for b in blocks)


def _session() -> Session:
    return Session(
        scenario_prompt="ransomware exercise",
        state=SessionState.AI_PROCESSING,
        created_at=_CREATED,
        roles=[
            Role(label="CISO", id="r_ciso", is_creator=True),
            Role(label="IR Lead", id="r_ir"),
        ],
        creator_role_id="r_ciso",
    )


def test_clock_block_renders_anchor_and_teaches_the_window_rule() -> None:
    text = _exercise_clock_block(_session())
    assert _HUMAN in text
    assert _CLOCK in text
    # The exact failure mode that prompted the fix: a "last 30 days"
    # window whose contents fell outside it. The block must name it.
    assert "last 30 days" in text.lower()


def test_clock_in_play_lives_in_stable_prefix_only() -> None:
    blocks = build_play_system_blocks(_session(), registry=_empty_registry())
    # blocks[0] is the cached stable prefix; blocks[1] is the volatile
    # suffix (presence / follow-ups / settings) that re-bills per turn.
    stable, volatile = blocks[0]["text"], blocks[1]["text"]
    assert "## Block 2b — Exercise clock" in stable
    assert _HUMAN in stable
    # Frozen per session — it must not leak into the volatile suffix,
    # or the prompt cache pays for it on every single turn.
    assert "Exercise clock" not in volatile
    assert _HUMAN not in volatile


def test_clock_in_setup_tier() -> None:
    text = _flatten(build_setup_system_blocks(_session()))
    assert "## Exercise clock" in text
    assert _HUMAN in text


def test_clock_in_aar_tier() -> None:
    text = _flatten(build_aar_system_blocks(_session()))
    assert "## Exercise clock" in text
    assert _HUMAN in text


def test_clock_absent_from_guardrail_tier() -> None:
    text = _flatten(build_guardrail_system_blocks())
    assert "Exercise clock" not in text
    assert _HUMAN not in text


def test_clock_handles_tz_naive_created_at() -> None:
    # A fixture or legacy row could carry a tz-naive created_at. The
    # block must assume UTC rather than raise on the tz comparison.
    s = Session(
        scenario_prompt="x",
        created_at=datetime(2026, 5, 28, 14, 23),  # naive — no tzinfo
        roles=[Role(label="CISO", id="r_ciso", is_creator=True)],
        creator_role_id="r_ciso",
    )
    text = _exercise_clock_block(s)
    assert _HUMAN in text
    assert _CLOCK in text
