"""Tests for the ChatClient base-class lifecycle + cache helpers.

The session UI's "AI is thinking" indicator was previously gated on
``session.state``, leaving interject / guardrail / setup / AAR work
invisible to clients. Issue #63 fixed that by promoting the LLM-call
boundary tracker to a real-time WS broadcast — these tests pin the
contract: every call begins with ``ai_thinking active=True`` and ends
with ``active=False`` (matching ``call_id``), on success **and** on
exception.

Lifecycle now lives on ``ChatClient`` (the base class), so these tests
exercise it via ``MockChatClient`` rather than the Anthropic-direct
``LLMClient``. The same broadcast logic runs on every backend.

Cache-helper tests below test the shared
``with_system_cache`` / ``with_message_cache`` from ``app.llm._shared``.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from app.config import Settings
from app.llm._shared import with_message_cache, with_system_cache
from app.llm.protocol import LLMResult
from tests.mock_chat_client import MockChatClient, llm_result, text_block

# Aliases keep the test names readable; the helpers live in _shared
# (used by both Anthropic-direct and LiteLLM clients).
_with_cache = with_system_cache


def _with_message_cache_compat(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return with_message_cache(messages)


_with_message_cache = _with_message_cache_compat


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
def settings(monkeypatch: pytest.MonkeyPatch) -> Settings:
    monkeypatch.setenv("LLM_API_KEY", "x")
    monkeypatch.setenv("LLM_MODEL_PLAY", "mock-play")
    monkeypatch.setenv("LLM_MODEL_SETUP", "mock-setup")
    monkeypatch.setenv("LLM_MODEL_AAR", "mock-aar")
    monkeypatch.setenv("LLM_MODEL_GUARDRAIL", "mock-guardrail")
    monkeypatch.setenv("SESSION_SECRET", "x" * 32)
    return Settings()


async def _drain() -> None:
    """Yield to the loop so fire-and-forget broadcast tasks complete."""

    for _ in range(5):
        await asyncio.sleep(0)


# ---------------------------------------------------------------- lifecycle


@pytest.mark.asyncio
async def test_acomplete_emits_paired_thinking_events(settings: Settings) -> None:
    llm = MockChatClient({"play": [llm_result(text_block("ok"))]})
    conns = _RecordingConnections()
    llm.set_connections(conns)

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
    assert all(
        record is False for _, evt, record in conns.events if evt.get("type") == "ai_thinking"
    )


@pytest.mark.asyncio
async def test_acomplete_emits_stop_event_on_exception(settings: Settings) -> None:
    """``CancelledError`` / generic exceptions in the LLM call must not
    leave the indicator pinned. The ``finally`` block in ``acomplete``
    is what guarantees the stop event.
    """

    class _BoomMock(MockChatClient):
        async def acomplete(self, **kwargs: Any) -> LLMResult:
            call = self._begin_call(
                session_id=kwargs.get("session_id"),
                tier=kwargs.get("tier", "play"),
                model=self.model_for(kwargs.get("tier", "play")),
                stream=False,
            )
            try:
                raise RuntimeError("upstream blew up")
            finally:
                self._end_call(kwargs.get("session_id"), call)

    llm = _BoomMock()
    conns = _RecordingConnections()
    llm.set_connections(conns)

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
    llm = MockChatClient({"play": [llm_result(text_block("streamed"))]})
    conns = _RecordingConnections()
    llm.set_connections(conns)

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
    emit per-session ``ai_thinking`` events — there's no UI to update.
    """

    llm = MockChatClient({"play": [llm_result(text_block("ok"))]})
    conns = _RecordingConnections()
    llm.set_connections(conns)

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
    """The activity endpoint serialises ``InFlightCall`` and exposes
    ``call_id`` so the operator UI can cross-reference an entry with
    the matching WS event stream.
    """

    class _SlowMock(MockChatClient):
        async def acomplete(self, **kwargs: Any) -> LLMResult:
            session_id = kwargs.get("session_id")
            tier = kwargs.get("tier", "play")
            call = self._begin_call(
                session_id=session_id,
                tier=tier,
                model=self.model_for(tier),
                stream=False,
            )
            try:
                in_flight = self.in_flight_for(session_id)
                assert len(in_flight) == 1
                assert in_flight[0].call_id  # non-empty
                assert isinstance(in_flight[0].call_id, str)
                return llm_result(text_block("ok"))
            finally:
                self._end_call(session_id, call)

    llm = _SlowMock()
    await llm.acomplete(
        tier="play",
        system_blocks=[{"type": "text", "text": "sys"}],
        messages=[{"role": "user", "content": "hi"}],
        session_id="sess-4",
    )


# ---------------------------------------------------------------- cache helpers


def test_with_cache_marks_first_block_only() -> None:
    """``with_system_cache`` plants the breakpoint on the first (stable) block.

    The convention across all four prompt builders is *stable content
    first* (identity / mission / hard boundaries / tool protocol /
    frozen plan); volatile content (presence column, follow-ups,
    rate-limit notices) sits in later blocks. Putting cache_control on
    block 0 means the prefix [tools + first_block] is the cached
    chunk, and any volatile block afterwards re-processes cheaply.
    """

    blocks = [
        {"type": "text", "text": "stable"},
        {"type": "text", "text": "volatile"},
    ]
    out = _with_cache(blocks)
    assert out[0]["cache_control"] == {"type": "ephemeral"}
    assert "cache_control" not in out[1]
    # Original list must not be mutated.
    assert "cache_control" not in blocks[0]


def test_with_cache_single_block_still_marked() -> None:
    """One-block prompt — first-and-only block gets the breakpoint."""

    blocks = [{"type": "text", "text": "single"}]
    out = _with_cache(blocks)
    assert out[0]["cache_control"] == {"type": "ephemeral"}


def test_with_cache_empty_returns_empty() -> None:
    assert _with_cache([]) == []


def test_with_message_cache_promotes_string_content() -> None:
    """The last message's string content is promoted to a ``[{type:text,
    text:..., cache_control:ephemeral}]`` list so the cache marker
    rides with the content.
    """

    msgs = [
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "second"},
    ]
    out = _with_message_cache(msgs)
    assert out is not msgs
    assert out[-1]["content"] == [
        {
            "type": "text",
            "text": "second",
            "cache_control": {"type": "ephemeral"},
        }
    ]
    # Earlier message untouched.
    assert out[0]["content"] == "first"
    # Input message list/content remains unchanged.
    assert msgs[1]["content"] == "second"


def test_with_message_cache_preserves_structured_content() -> None:
    """Structured tool_result content already in list form gets the
    cache_control on its last block — non-tool_result blocks are
    untouched.
    """

    msgs = [
        {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "tu_1",
                    "content": "ok",
                    "is_error": False,
                },
                {"type": "text", "text": "follow-up"},
            ],
        }
    ]
    out = _with_message_cache(msgs)
    assert out is not msgs
    last_block = out[-1]["content"][-1]
    assert last_block["cache_control"] == {"type": "ephemeral"}
    # tool_result block in the same content list is NOT mutated.
    tr_block = out[-1]["content"][0]
    assert "cache_control" not in tr_block
    # Input content list remains unchanged.
    assert "cache_control" not in msgs[0]["content"][-1]


def test_with_message_cache_empty_returns_empty() -> None:
    assert _with_message_cache([]) == []


def test_with_cache_recovery_shape_marks_only_first_block() -> None:
    """Recovery messages (system + addendum + recovery hint) — block 0
    is still the stable identity / boundaries / plan, so it gets the
    breakpoint; addendum / hint blocks come later and re-process.
    """

    blocks = [
        {"type": "text", "text": "stable identity + plan"},
        {"type": "text", "text": "system addendum: drive recovery"},
        {"type": "text", "text": "user nudge: include broadcast"},
    ]
    out = _with_cache(blocks)
    assert out[0]["cache_control"] == {"type": "ephemeral"}
    assert "cache_control" not in out[1]
    assert "cache_control" not in out[2]
