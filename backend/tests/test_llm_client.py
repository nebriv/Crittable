"""Tests for the LLM client's ``ai_thinking`` boundary broadcasts.

The session UI's "AI is thinking" indicator was previously gated on
``session.state``, leaving interject / guardrail / setup / AAR work
invisible to clients. Issue #63 fixed that by promoting the LLM-call
boundary tracker to a real-time WS broadcast — these tests pin the
contract: every call begins with ``ai_thinking active=True`` and ends
with ``active=False`` (matching ``call_id``), on success **and** on
exception.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from app.config import Settings
from app.llm.client import LLMClient, _with_cache, _with_message_cache
from tests.mock_anthropic import MockAnthropic, response, text_block


class _RecordingConnections:
    """Minimal ``ConnectionManager`` stand-in. Captures every broadcast
    call so tests can assert on the event stream.
    """

    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any], bool]] = []

    async def broadcast(
        self, session_id: str, event: dict[str, Any], *, record: bool = True
    ) -> None:
        self.events.append((session_id, event, record))

    def ai_thinking_events(self) -> list[dict[str, Any]]:
        return [evt for _, evt, _ in self.events if evt.get("type") == "ai_thinking"]


@pytest.fixture
def settings(monkeypatch) -> Settings:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
    monkeypatch.setenv("ANTHROPIC_MODEL_PLAY", "mock-play")
    monkeypatch.setenv("ANTHROPIC_MODEL_SETUP", "mock-setup")
    monkeypatch.setenv("ANTHROPIC_MODEL_AAR", "mock-aar")
    monkeypatch.setenv("ANTHROPIC_MODEL_GUARDRAIL", "mock-guardrail")
    monkeypatch.setenv("SESSION_SECRET", "x" * 32)
    return Settings()


async def _drain() -> None:
    """Yield to the loop so fire-and-forget broadcast tasks complete."""

    for _ in range(5):
        await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_acomplete_emits_paired_thinking_events(settings: Settings) -> None:
    llm = LLMClient(settings=settings)
    conns = _RecordingConnections()
    llm.set_connections(conns)
    mock = MockAnthropic({"play": [response(text_block("ok"))]})
    llm.set_transport(mock.messages)

    await llm.acomplete(
        tier="play",
        system_blocks=[{"type": "text", "text": "sys"}],
        messages=[{"role": "user", "content": "hi"}],
        session_id="sess-1",
    )
    await _drain()

    events = conns.ai_thinking_events()
    assert len(events) == 2, events
    start, stop = events
    assert start["active"] is True
    assert stop["active"] is False
    assert start["call_id"] == stop["call_id"]
    assert start["tier"] == "play"
    # Ephemeral broadcast — record=False so a reconnect doesn't replay
    # a stale "thinking" event for a call that finished long ago.
    assert all(record is False for _, evt, record in conns.events if evt.get("type") == "ai_thinking")


@pytest.mark.asyncio
async def test_acomplete_emits_stop_event_on_exception(settings: Settings) -> None:
    """``CancelledError`` / generic exceptions in the LLM call must not
    leave the indicator pinned. The ``finally`` block in ``acomplete``
    is what guarantees the stop event."""

    llm = LLMClient(settings=settings)
    conns = _RecordingConnections()
    llm.set_connections(conns)

    class _Boom:
        async def create(self, **kwargs: Any) -> Any:
            raise RuntimeError("upstream blew up")

        def stream(self, **kwargs: Any) -> Any:
            raise NotImplementedError

    llm.set_transport(_Boom())

    with pytest.raises(RuntimeError):
        await llm.acomplete(
            tier="play",
            system_blocks=[{"type": "text", "text": "sys"}],
            messages=[{"role": "user", "content": "hi"}],
            session_id="sess-2",
        )
    await _drain()

    events = conns.ai_thinking_events()
    assert [e["active"] for e in events] == [True, False]
    assert events[0]["call_id"] == events[1]["call_id"]


@pytest.mark.asyncio
async def test_astream_emits_paired_thinking_events(settings: Settings) -> None:
    llm = LLMClient(settings=settings)
    conns = _RecordingConnections()
    llm.set_connections(conns)
    mock = MockAnthropic({"play": [response(text_block("streamed"))]})
    llm.set_transport(mock.messages)

    final: dict[str, Any] = {}
    async for event in llm.astream(
        tier="play",
        system_blocks=[{"type": "text", "text": "sys"}],
        messages=[{"role": "user", "content": "hi"}],
        session_id="sess-3",
    ):
        if event.get("type") == "complete":
            final["result"] = event["result"]
    await _drain()

    assert "result" in final
    events = conns.ai_thinking_events()
    assert [e["active"] for e in events] == [True, False]
    assert events[0]["call_id"] == events[1]["call_id"]
    assert events[0]["tier"] == "play"


@pytest.mark.asyncio
async def test_no_broadcast_without_session_id(settings: Settings) -> None:
    """Calls without a ``session_id`` (e.g. one-off probes) should not
    emit per-session ``ai_thinking`` events — there's no UI to update."""

    llm = LLMClient(settings=settings)
    conns = _RecordingConnections()
    llm.set_connections(conns)
    mock = MockAnthropic({"play": [response(text_block("ok"))]})
    llm.set_transport(mock.messages)

    await llm.acomplete(
        tier="play",
        system_blocks=[{"type": "text", "text": "sys"}],
        messages=[{"role": "user", "content": "hi"}],
        session_id=None,
    )
    await _drain()

    assert conns.ai_thinking_events() == []


@pytest.mark.asyncio
async def test_call_id_appears_in_in_flight(settings: Settings) -> None:
    """The activity endpoint serialises ``InFlightCall`` and now exposes
    ``call_id`` so the operator UI can cross-reference an entry with the
    matching WS event stream."""

    llm = LLMClient(settings=settings)

    class _SlowMessages:
        async def create(self, **kwargs: Any) -> Any:
            # While this awaits, the in_flight tracker should have one entry.
            in_flight = llm.in_flight_for("sess-4")
            assert len(in_flight) == 1
            assert in_flight[0].call_id  # non-empty
            assert isinstance(in_flight[0].call_id, str)
            from tests.mock_anthropic import _ContentBlock, _Response

            return _Response(content=[_ContentBlock(type="text", text="ok")])

        def stream(self, **kwargs: Any) -> Any:
            raise NotImplementedError

    llm.set_transport(_SlowMessages())
    await llm.acomplete(
        tier="play",
        system_blocks=[{"type": "text", "text": "sys"}],
        messages=[{"role": "user", "content": "hi"}],
        session_id="sess-4",
    )


# ---------------------------------------------------------------- cache helpers


def test_with_cache_marks_first_block_only() -> None:
    """``_with_cache`` plants the breakpoint on the first (stable) block.

    The convention across all four prompt builders is *stable content
    first* — Blocks 1-9 of the play tier sit in block[0]; volatile
    presence / follow-ups / rate-limit live in block[1]. Putting
    ``cache_control`` on block[0] tells Anthropic the cacheable prefix
    ends there, which means a presence flip on the next turn doesn't
    invalidate the cache.
    """

    blocks = [
        {"type": "text", "text": "stable prefix"},
        {"type": "text", "text": "volatile suffix"},
    ]
    out = _with_cache(blocks)
    assert out[0]["cache_control"] == {"type": "ephemeral"}
    assert "cache_control" not in out[1]
    # Original list must not be mutated.
    assert "cache_control" not in blocks[0]


def test_with_cache_single_block_still_marked() -> None:
    """Setup / AAR / guardrail tiers return a single text block — the
    breakpoint must still land on it (the only block IS the stable
    prefix in those single-block tiers)."""

    blocks = [{"type": "text", "text": "all stable"}]
    out = _with_cache(blocks)
    assert out[0]["cache_control"] == {"type": "ephemeral"}


def test_with_cache_empty_returns_empty() -> None:
    assert _with_cache([]) == []


def test_with_message_cache_promotes_string_content() -> None:
    """The standard message shape from ``_play_messages`` is
    ``content: str``; the cache helper must promote that to a list of
    text blocks so it can carry ``cache_control``."""

    msgs = [
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "second"},
        {"role": "user", "content": "last"},
    ]
    out = _with_message_cache(msgs)
    last_content = out[-1]["content"]
    assert isinstance(last_content, list)
    assert last_content[-1]["type"] == "text"
    assert last_content[-1]["text"] == "last"
    assert last_content[-1]["cache_control"] == {"type": "ephemeral"}
    # Earlier messages untouched.
    assert out[0]["content"] == "first"
    # Original list must not be mutated.
    assert msgs[-1]["content"] == "last"


def test_with_message_cache_preserves_structured_content() -> None:
    """The recovery / strict-retry path builds a list of
    ``tool_result`` blocks plus a trailing text directive nudge. The
    cache helper must NOT mutate ``tool_result`` blocks (they carry
    ``tool_use_id`` / ``is_error`` semantics) — only the trailing
    block gets the ``cache_control`` marker."""

    recovery_blocks: list[dict[str, Any]] = [
        {"type": "tool_result", "tool_use_id": "a", "content": "r1"},
        {"type": "tool_result", "tool_use_id": "b", "content": "r2"},
        {"type": "text", "text": "recovery directive"},
    ]
    msgs = [
        {"role": "user", "content": "kickoff"},
        {"role": "assistant", "content": "tool calls"},
        {"role": "user", "content": recovery_blocks},
    ]
    out = _with_message_cache(msgs)
    last_content = out[-1]["content"]
    assert last_content[-1]["cache_control"] == {"type": "ephemeral"}
    # The two ``tool_result`` blocks must NOT have grown a cache_control field.
    assert "cache_control" not in last_content[0]
    assert "cache_control" not in last_content[1]
    # Original list must not be mutated.
    assert "cache_control" not in recovery_blocks[-1]


def test_with_message_cache_empty_returns_empty() -> None:
    assert _with_message_cache([]) == []


def test_with_cache_recovery_shape_marks_only_first_block() -> None:
    """The recovery / strict-retry path appends a directive system
    addendum on top of the play-tier two-block list (and the AAR
    interject path may add more), producing a 3- or 4-block shape.
    The cache breakpoint must still land on block[0] (the stable
    prefix) and never on the appended addenda — a future
    refactor that flipped to ``[-1]`` semantics would silently
    relocate the breakpoint past the volatile suffix and pollute the
    cache key with directive-specific text."""

    blocks = [
        {"type": "text", "text": "stable prefix"},
        {"type": "text", "text": "volatile suffix"},
        {"type": "text", "text": "recovery directive addendum"},
        {"type": "text", "text": "extra addendum"},
    ]
    out = _with_cache(blocks)
    assert out[0]["cache_control"] == {"type": "ephemeral"}
    for i in range(1, len(out)):
        assert "cache_control" not in out[i], f"block[{i}] should not be cached"


def test_play_system_blocks_split_invariant() -> None:
    """Regression net for the cache contract itself: the play-tier
    builder MUST return TWO blocks (stable prefix + volatile suffix).
    A future refactor merging them or moving Block 11 into the stable
    prefix would silently break the cache invariant — Anthropic would
    invalidate the cache on every per-turn flip and the ~85% input-
    cost reduction this design buys would quietly disappear.
    """

    from app.extensions.registry import FrozenRegistry
    from app.llm.prompts import build_play_system_blocks
    from app.sessions.models import (
        Role,
        ScenarioBeat,
        ScenarioInject,
        ScenarioPlan,
        Session,
        SessionState,
    )

    session = Session(
        scenario_prompt="x",
        state=SessionState.AWAITING_PLAYERS,
        roles=[Role(id="r1", label="CISO", is_creator=True)],
        creator_role_id="r1",
        plan=ScenarioPlan(
            title="t",
            executive_summary="s",
            key_objectives=["k"],
            narrative_arc=[
                ScenarioBeat(beat=1, label="b", expected_actors=["CISO"])
            ],
            injects=[ScenarioInject(trigger="x", summary="y")],
        ),
    )
    blocks = build_play_system_blocks(
        session, registry=FrozenRegistry(tools={}, resources={}, prompts={})
    )
    assert len(blocks) == 2, (
        f"play system blocks must split into 2 (stable + volatile); got {len(blocks)}"
    )
    stable, volatile = blocks
    # Stable prefix carries Blocks 1-9 (Identity through Strategy).
    assert "## Block 1 — Identity" in stable["text"]
    assert "## Block 9 — Roster-size strategy" in stable["text"]
    # Volatile suffix carries Block 10 (presence-bearing roster) and
    # Block 11 (open follow-ups). Critically, the actual block headers
    # must live ONLY in volatile so a presence flip doesn't invalidate
    # the cached prefix.
    assert "## Block 10 — Roster" in volatile["text"]
    assert "## Block 11 — Open per-role follow-ups" in volatile["text"]
    assert "## Block 10 — Roster" not in stable["text"]
    assert "## Block 11 — Open per-role follow-ups" not in stable["text"]
    # The presence column lives in volatile, not stable.
    assert "| role_id | label | display_name | kind | presence |" in volatile["text"]
    assert "| role_id | label | display_name | kind | presence |" not in stable["text"]


def test_with_message_cache_logs_skip_on_non_coercible_content(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Per CLAUDE.md "logging-and-debuggability" rule: the silent
    fallback when message content has an unexpected shape (None,
    int, empty list) must emit a WARNING so a future refactor
    passing the wrong shape doesn't quietly drop the ~10× cache-
    read win without any log signal."""

    from app.llm import client as client_mod

    captured: list[dict[str, Any]] = []

    class _CapturingLogger:
        def warning(self, event: str, **kw: Any) -> None:
            captured.append({"event": event, **kw})

    monkeypatch.setattr(client_mod, "_logger", _CapturingLogger())

    # None content triggers the else branch.
    msgs = [{"role": "user", "content": None}]
    out = _with_message_cache(msgs)
    assert out is msgs  # unchanged
    assert any(c["event"] == "message_cache_skipped" for c in captured)
    skip = next(c for c in captured if c["event"] == "message_cache_skipped")
    assert skip["reason"] == "non_coercible_content"
    assert skip["content_type"] == "NoneType"
