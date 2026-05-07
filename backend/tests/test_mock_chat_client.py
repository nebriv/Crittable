"""Tests for ``MockChatClient`` (Phase 4 of #193).

Locks in the contract that test fixtures rely on:

  * Inherits ``ChatClient`` lifecycle (in_flight tracking,
    set_connections, ai_thinking broadcasts).
  * Per-tier scripted responses pop in order; exhausted scripts fall
    back to a benign default.
  * ``acomplete`` returns the scripted ``LLMResult`` verbatim.
  * ``astream`` synthesizes ``text_delta`` events from text blocks
    + a terminal ``complete`` event with the same ``LLMResult``.
  * ``calls`` log captures kwargs for test assertions.
  * The lifecycle hooks fire even on the mock so tests that observe
    ``ai_thinking`` events still see them.
"""

from __future__ import annotations

import pytest

from app.llm.protocol import ChatClient, InFlightCall
from tests.mock_chat_client import (
    MockChatClient,
    llm_result,
    text_block,
    tool_block,
)


def test_mock_is_chat_client_subclass() -> None:
    assert issubclass(MockChatClient, ChatClient)


def test_lifecycle_inherited_from_base() -> None:
    """``in_flight_for`` / ``set_connections`` / ``_begin_call`` etc.
    come from the base class — the mock didn't reimplement them.
    """

    client = MockChatClient()
    assert client.in_flight_for("any") == []
    # Construct + register an in-flight call manually to verify the
    # base class state structure works.
    call = InFlightCall(tier="play", model="mock", stream=False, started_at=0.0)
    client._in_flight.setdefault("session-x", []).append(call)
    assert client.in_flight_for("session-x") == [call]


@pytest.mark.asyncio
async def test_acomplete_pops_scripted_response() -> None:
    expected = llm_result(text_block("hello"), stop_reason="end_turn")
    client = MockChatClient(scripts={"play": [expected]})
    result = await client.acomplete(
        tier="play",
        system_blocks=[],
        messages=[{"role": "user", "content": "hi"}],
    )
    assert result is expected


@pytest.mark.asyncio
async def test_acomplete_exhausted_script_returns_default() -> None:
    """When the script for a tier is empty (or never registered), the
    benign default response keeps the test from crashing on an
    unexpected extra call.
    """

    client = MockChatClient(scripts={"play": []})
    result = await client.acomplete(
        tier="play",
        system_blocks=[],
        messages=[{"role": "user", "content": "hi"}],
    )
    assert result.stop_reason == "end_turn"
    assert any(b.get("type") == "text" for b in result.content)


@pytest.mark.asyncio
async def test_acomplete_calls_log_captures_kwargs() -> None:
    client = MockChatClient()
    await client.acomplete(
        tier="setup",
        system_blocks=[],
        messages=[{"role": "user", "content": "x"}],
        tools=[{"name": "ask_setup_question", "description": "...", "input_schema": {}}],
        tool_choice={"type": "any"},
        max_tokens=128,
    )
    assert client.calls == [
        {
            "tier": "setup",
            "model": "mock-setup",
            "system": [],
            "messages": [{"role": "user", "content": "x"}],
            "tools": [{"name": "ask_setup_question", "description": "...", "input_schema": {}}],
            "tool_choice": {"type": "any"},
            "max_tokens": 128,
            "extension_tool_names": None,
        }
    ]


@pytest.mark.asyncio
async def test_astream_emits_text_delta_then_complete() -> None:
    expected = llm_result(text_block("hello "), text_block("world"), stop_reason="end_turn")
    client = MockChatClient(scripts={"play": [expected]})
    events = []
    async for event in client.astream(
        tier="play",
        system_blocks=[],
        messages=[{"role": "user", "content": "hi"}],
    ):
        events.append(event)
    assert events[:-1] == [
        {"type": "text_delta", "text": "hello "},
        {"type": "text_delta", "text": "world"},
    ]
    assert events[-1] == {
        "type": "complete",
        "result": expected,
        "text": "hello world",
    }


@pytest.mark.asyncio
async def test_astream_tool_call_response_emits_no_text_deltas() -> None:
    """When the scripted response is a pure tool call (no text), only
    the terminal ``complete`` event fires — same as the LiteLLM and
    Anthropic-direct paths emitting just one ``complete`` for a
    tool-only turn.
    """

    expected = llm_result(
        tool_block("broadcast", {"message": "hi"}),
        stop_reason="tool_use",
    )
    client = MockChatClient(scripts={"play": [expected]})
    events = []
    async for event in client.astream(
        tier="play",
        system_blocks=[],
        messages=[{"role": "user", "content": "hi"}],
    ):
        events.append(event)
    assert len(events) == 1
    assert events[0]["type"] == "complete"
    assert events[0]["result"] is expected


@pytest.mark.asyncio
async def test_in_flight_tracked_across_acomplete() -> None:
    """The mock honors the lifecycle: in-flight bucket is empty before
    AND after the call, but populated during.
    """

    import asyncio

    client = MockChatClient(
        scripts={"play": [llm_result(text_block("ok"), stop_reason="end_turn")]}
    )

    async def run() -> None:
        # We can't observe mid-call via the API; instead verify
        # post-call cleanup.
        await client.acomplete(
            tier="play",
            system_blocks=[],
            messages=[{"role": "user", "content": "x"}],
            session_id="s1",
        )

    assert client.in_flight_for("s1") == []
    await asyncio.create_task(run())
    assert client.in_flight_for("s1") == []


def test_model_for_returns_mock_label() -> None:
    """``model_for`` returns predictable labels so tests can assert
    on which tier was used.
    """

    client = MockChatClient()
    assert client.model_for("play") == "mock-play"
    assert client.model_for("guardrail") == "mock-guardrail"
    assert client.model_for("aar") == "mock-aar"
    assert client.model_for("setup") == "mock-setup"
