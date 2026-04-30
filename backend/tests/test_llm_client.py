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
from app.llm.client import LLMClient
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
    monkeypatch.setenv("TEST_MODE", "true")
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
