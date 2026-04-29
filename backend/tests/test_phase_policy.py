"""Tests for the engine-side phase policy.

These tests lock the contract: every tier has the right allowed
states + tool names + tool_choice + bare-text discipline. A refactor
that breaks any of these would also need to update this file —
making the breakage visible in code review.
"""

from __future__ import annotations

import pytest

from app.sessions.models import SessionState
from app.sessions.phase_policy import (
    POLICIES,
    PhaseViolation,
    assert_state,
    bare_text_allowed,
    filter_allowed_tools,
    tool_choice_for,
)


def test_setup_policy_shape() -> None:
    """Setup tier: SETUP-only state, setup-only tools, tool_choice=any
    (force tool emission), bare text not allowed."""

    p = POLICIES["setup"]
    assert p.allowed_states == frozenset({SessionState.SETUP})
    assert p.allowed_tool_names == frozenset(
        {"ask_setup_question", "propose_scenario_plan", "finalize_setup"}
    )
    assert p.tool_choice == {"type": "any"}
    assert p.bare_text_allowed is False


def test_play_policy_shape() -> None:
    """Play tier: 3 allowed states, full PLAY_TOOLS list, tool_choice
    auto by default (callers override for strict-retry / interject),
    bare text allowed (narration alongside tool use)."""

    p = POLICIES["play"]
    assert p.allowed_states == frozenset(
        {
            SessionState.BRIEFING,
            SessionState.AI_PROCESSING,
            SessionState.AWAITING_PLAYERS,
        }
    )
    # A few representative names — full list lives in tools.py and
    # changes more frequently than the policy.
    assert "broadcast" in p.allowed_tool_names
    assert "set_active_roles" in p.allowed_tool_names
    assert "end_session" in p.allowed_tool_names
    # Setup-only tools must NOT be in the play set.
    assert "ask_setup_question" not in p.allowed_tool_names
    assert "finalize_setup" not in p.allowed_tool_names
    assert p.tool_choice is None
    assert p.bare_text_allowed is True


def test_aar_policy_shape() -> None:
    p = POLICIES["aar"]
    assert p.allowed_states == frozenset({SessionState.ENDED})
    assert p.allowed_tool_names == frozenset({"finalize_report"})
    assert p.tool_choice == {"type": "tool", "name": "finalize_report"}
    assert p.bare_text_allowed is False


def test_guardrail_policy_shape() -> None:
    """Guardrail runs on raw participant text in any state — no
    state precondition, no tools, no tool_choice."""

    p = POLICIES["guardrail"]
    assert p.allowed_states == frozenset()
    assert p.allowed_tool_names == frozenset()
    assert p.tool_choice is None
    assert p.bare_text_allowed is True


def test_assert_state_raises_for_wrong_state() -> None:
    with pytest.raises(PhaseViolation, match="cannot run in state 'ENDED'"):
        assert_state("setup", SessionState.ENDED)
    with pytest.raises(PhaseViolation, match="cannot run in state 'SETUP'"):
        assert_state("play", SessionState.SETUP)
    with pytest.raises(PhaseViolation, match="cannot run in state 'BRIEFING'"):
        assert_state("aar", SessionState.BRIEFING)


def test_assert_state_passes_for_allowed_states() -> None:
    # No exception expected.
    assert_state("setup", SessionState.SETUP)
    assert_state("play", SessionState.BRIEFING)
    assert_state("play", SessionState.AI_PROCESSING)
    assert_state("play", SessionState.AWAITING_PLAYERS)
    assert_state("aar", SessionState.ENDED)


def test_assert_state_skips_check_for_guardrail() -> None:
    """Guardrail runs in any state."""

    for s in SessionState:
        assert_state("guardrail", s)


def test_filter_allowed_tools_drops_forbidden_tools() -> None:
    tools = [
        {"name": "broadcast", "description": "x", "input_schema": {}},
        {"name": "ask_setup_question", "description": "x", "input_schema": {}},
    ]
    kept, dropped = filter_allowed_tools("play", tools)
    kept_names = {t["name"] for t in kept}
    assert kept_names == {"broadcast"}
    assert dropped == ["ask_setup_question"]


def test_filter_allowed_tools_accepts_extension_names_on_play() -> None:
    """Extension specs aren't in the static policy — they're operator-
    provided at startup. The filter accepts them when the play tier
    is queried with explicit ``extension_tool_names``."""

    tools = [
        {"name": "broadcast", "description": "x", "input_schema": {}},
        {"name": "lookup_threat_intel", "description": "x", "input_schema": {}},
    ]
    # Without extension hint: extension is dropped.
    kept, dropped = filter_allowed_tools("play", tools)
    assert dropped == ["lookup_threat_intel"]
    # With extension hint: kept.
    kept, dropped = filter_allowed_tools(
        "play",
        tools,
        extension_tool_names=frozenset({"lookup_threat_intel"}),
    )
    assert {t["name"] for t in kept} == {"broadcast", "lookup_threat_intel"}
    assert dropped == []


def test_filter_allowed_tools_ignores_extension_names_outside_play() -> None:
    """Extension allowance is play-tier-only; passing extension names
    to the setup tier must NOT widen its allowed set."""

    tools = [
        {"name": "ask_setup_question", "description": "x", "input_schema": {}},
        {"name": "lookup_threat_intel", "description": "x", "input_schema": {}},
    ]
    kept, dropped = filter_allowed_tools(
        "setup",
        tools,
        extension_tool_names=frozenset({"lookup_threat_intel"}),
    )
    assert {t["name"] for t in kept} == {"ask_setup_question"}
    assert dropped == ["lookup_threat_intel"]


def test_tool_choice_for_returns_tier_default() -> None:
    assert tool_choice_for("setup") == {"type": "any"}
    assert tool_choice_for("aar") == {"type": "tool", "name": "finalize_report"}
    assert tool_choice_for("play") is None
    assert tool_choice_for("guardrail") is None


def test_bare_text_allowed_per_tier() -> None:
    assert bare_text_allowed("setup") is False
    assert bare_text_allowed("aar") is False
    assert bare_text_allowed("play") is True
    assert bare_text_allowed("guardrail") is True


def test_llm_client_drops_forbidden_tools(monkeypatch) -> None:
    """End-to-end: ``LLMClient.acomplete`` filters the ``tools``
    list against the tier's policy before forwarding to Anthropic.
    Pre-fix a misbehaving caller could pass setup-tier tools to a
    play call and the model would have access to ``ask_setup_question``
    mid-exercise."""

    import asyncio

    from app.config import Settings
    from app.llm.client import LLMClient
    from tests.mock_anthropic import MockAnthropic

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    s = Settings()
    mock = MockAnthropic({"play": []})
    llm = LLMClient(settings=s)
    llm.set_transport(mock.messages)

    async def _go() -> None:
        await llm.acomplete(
            tier="play",
            system_blocks=[{"type": "text", "text": "x"}],
            messages=[{"role": "user", "content": "hi"}],
            tools=[
                {"name": "broadcast", "input_schema": {}},
                {"name": "ask_setup_question", "input_schema": {}},
            ],
        )

    asyncio.run(_go())
    sent_tools = mock.messages.calls[0].get("tools", [])
    sent_names = {t["name"] for t in sent_tools}
    # ``ask_setup_question`` was dropped at the engine boundary; only
    # ``broadcast`` reached Anthropic.
    assert sent_names == {"broadcast"}
