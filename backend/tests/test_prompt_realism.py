"""Realism-rail regression net for the play-tier system prompt.

Origin: a creator filed a complaint that, given a sparse "testing"
scenario, the AI asked the system administrator to physically walk to the
server room and visually confirm which servers were being encrypted —
a class of question that doesn't surface in real incident response
(encryption signs live in EDR / file-integrity / backup telemetry, not
on a rack LED). The fix added Block 5b (`_REALISM`) to
`build_play_system_blocks` constraining the AI to anchor every ask in
the addressed role's actual visibility and forbidding physical-world
tropes.

This test asserts:
- the realism rail IS present in the play tier (so a future refactor
  can't silently drop the wiring),
- the user-complaint phrase ``server room`` appears in the play prompt
  (specific regression net for the original failure mode),
- the rail is NOT in the AAR or guardrail prompts (those tiers already
  use the trust-boundary contract and don't need the rail; including it
  there would just waste tokens).

Soft prompt assertions are normally low value; this one is high value
because the failure was a real user complaint with a well-defined
detection signature.
"""

from __future__ import annotations

from typing import Any

from app.extensions.models import ExtensionBundle
from app.extensions.registry import FrozenRegistry, freeze_bundle
from app.llm.prompts import (
    _REALISM,
    build_aar_system_blocks,
    build_guardrail_system_blocks,
    build_play_system_blocks,
)
from app.sessions.models import Role, Session, SessionState


def _empty_registry() -> FrozenRegistry:
    return freeze_bundle(ExtensionBundle())


def _flatten_blocks(blocks: list[dict[str, Any]]) -> str:
    return "\n".join(b.get("text", "") for b in blocks)


def _minimal_session() -> Session:
    return Session(
        scenario_prompt="ransomware exercise",
        state=SessionState.AI_PROCESSING,
        roles=[
            Role(label="CISO", id="r_ciso", is_creator=True),
            Role(label="IR Lead", id="r_ir"),
        ],
        creator_role_id="r_ciso",
    )


def test_realism_block_wired_into_play_system_blocks() -> None:
    text = _flatten_blocks(
        build_play_system_blocks(_minimal_session(), registry=_empty_registry())
    )
    assert _REALISM in text, (
        "_REALISM block missing from play system blocks; check the "
        "wiring in build_play_system_blocks"
    )
    assert "Block 5b — Realism & role visibility" in text, (
        "Block 5b header missing; the realism rail should be slotted "
        "between Block 5 (Style) and Block 6 (Tool-use protocol)"
    )


def test_play_prompt_forbids_physical_inspection() -> None:
    """Specific regression net for the user-reported 'go to the server
    room' failure mode. If this assertion fails, audit any diff that
    touched ``_REALISM`` — the user complaint should remain explicitly
    rejected in the prompt copy."""

    text = _flatten_blocks(
        build_play_system_blocks(_minimal_session(), registry=_empty_registry())
    )
    assert "server room" in text
    assert "physically inspect" in text


def test_play_prompt_forbids_data_extract_asks() -> None:
    """Regression net for the user-reported "Joe — what does Sentinel
    show on info-uapp-003?" failure mode. The AI is the source of
    ground truth for telemetry — players don't have a real Sentinel /
    SIEM / EDR. The DM-style narration rule (Block 5b) and the
    Concrete-handoff rule (Block 6) both forbid the AI from posing
    "what does <tool> show?" as a question to players. If this
    assertion fails, audit any diff that touched ``_REALISM`` or
    ``_TOOL_USE_PROTOCOL`` — both rules need to stay aligned or the
    model regresses to asking players to fabricate telemetry.

    The phrase pins are deliberate: a refactor that re-derives the
    blocks but drops the user-facing example phrasings would still
    break the regression net even though the constant-equality check
    in :func:`test_realism_block_wired_into_play_system_blocks`
    survives.
    """

    text = _flatten_blocks(
        build_play_system_blocks(_minimal_session(), registry=_empty_registry())
    )
    # Block 5b — DM-style narration rule
    assert "DM-style narration" in text
    assert "where to look" in text
    assert "what to do" in text
    # Both blocks — the canonical antipattern phrasings the user complained about
    assert "what does Sentinel show" in text
    # Block 6 — concrete-handoff rule prescribing the right reframe
    assert "direction-of-investigation fork" in text


def test_realism_block_absent_from_aar_prompt() -> None:
    """The AAR pipeline uses the trust-boundary contract documented in
    CLAUDE.md (canonical-IDs block, drop-don't-repair) — it does not
    need the play-tier realism rail. Including it would just waste
    tokens on the AAR call."""

    text = _flatten_blocks(build_aar_system_blocks(_minimal_session()))
    assert _REALISM not in text


def test_realism_block_absent_from_guardrail_prompt() -> None:
    """The guardrail classifier is a yes/no jailbreak detector; the
    play-tier visibility rail is irrelevant to its job."""

    text = _flatten_blocks(build_guardrail_system_blocks())
    assert _REALISM not in text
