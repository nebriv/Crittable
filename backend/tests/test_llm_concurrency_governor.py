"""Cost/abuse H2 — global LLM concurrency governor.

``ChatClient.__init__(max_concurrency, acquire_timeout_s)`` builds two
independent ``asyncio.Semaphore`` lanes — a heavy lane shared by the
play / setup / aar tiers and a separate guardrail lane, each of size
``max_concurrency`` (both ``None`` when the cap is 0/None).
``_acquire_slot`` acquires the right lane, returns the semaphore (or
``None``), and on timeout raises ``UpstreamLLMError(category="overloaded")``.
``_notify_backend_degraded`` fans a creator-only, per-session-throttled
``backend_status`` notice via ``ConnectionManager.broadcast_to_creator``.

These tests run against a *minimal* concrete ``ChatClient`` subclass —
no litellm, no real provider. The four abstractmethods are implemented
trivially because the governor lives entirely in the base class.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import pytest

from app.config import ModelTier
from app.llm.errors import UpstreamLLMError
from app.llm.protocol import ChatClient, LLMResult


class _MinimalChatClient(ChatClient):
    """Smallest legal ``ChatClient`` — exercises only the base-class
    concurrency governor. The four abstractmethods are stubbed; the
    governor (``_acquire_slot`` / ``_concurrency_slot`` /
    ``_notify_backend_degraded``) is inherited unchanged."""

    def model_for(self, tier: ModelTier) -> str:
        return f"minimal-{tier}"

    async def aclose(self) -> None:  # pragma: no cover - trivial
        return None

    async def acomplete(self, **kwargs: Any) -> LLMResult:  # pragma: no cover
        raise NotImplementedError

    def astream(self, **kwargs: Any) -> AsyncIterator[dict[str, Any]]:  # pragma: no cover
        raise NotImplementedError


@pytest.mark.asyncio
async def test_heavy_lane_serializes_at_concurrency_one() -> None:
    """With ``max_concurrency=1`` the second heavy acquire BLOCKS until
    the first releases — the whole point of the cap."""

    client = _MinimalChatClient(max_concurrency=1, acquire_timeout_s=None)

    sem1 = await client._acquire_slot(tier="play", session_id="s1")
    assert sem1 is not None

    # A second heavy acquire (setup shares the heavy lane) must not
    # complete while the only permit is held.
    second = asyncio.ensure_future(
        client._acquire_slot(tier="setup", session_id="s1")
    )
    await asyncio.sleep(0.02)
    assert not second.done(), "second heavy acquire should block on a full lane"

    # Releasing the first permit lets the queued acquire through.
    sem1.release()
    sem2 = await asyncio.wait_for(second, timeout=1.0)
    assert sem2 is not None
    sem2.release()


@pytest.mark.asyncio
async def test_guardrail_uses_a_separate_lane() -> None:
    """A saturated heavy lane must NOT block a guardrail acquire and
    vice-versa — the two lanes are independent."""

    client = _MinimalChatClient(max_concurrency=1, acquire_timeout_s=None)

    # Saturate the heavy lane.
    heavy = await client._acquire_slot(tier="play", session_id="s1")
    assert heavy is not None

    # Guardrail acquires immediately despite the heavy lane being full.
    guard = await asyncio.wait_for(
        client._acquire_slot(tier="guardrail", session_id="s1"), timeout=1.0
    )
    assert guard is not None

    # Now saturate the guardrail lane and confirm the heavy lane is
    # still independently reachable once we free the heavy permit.
    heavy.release()
    heavy2 = await asyncio.wait_for(
        client._acquire_slot(tier="aar", session_id="s1"), timeout=1.0
    )
    assert heavy2 is not None
    # The single guardrail permit is still held, so a 2nd guardrail
    # acquire blocks — proving the guardrail lane is its own size-1 lane.
    second_guard = asyncio.ensure_future(
        client._acquire_slot(tier="guardrail", session_id="s1")
    )
    await asyncio.sleep(0.02)
    assert not second_guard.done()

    guard.release()
    sg = await asyncio.wait_for(second_guard, timeout=1.0)
    assert sg is not None
    sg.release()
    heavy2.release()


@pytest.mark.asyncio
async def test_disabled_when_max_concurrency_zero() -> None:
    """``max_concurrency=0`` disables capping entirely: both lanes are
    ``None``, ``_acquire_slot`` returns ``None`` and never blocks even
    when called many times without releasing."""

    client = _MinimalChatClient(max_concurrency=0, acquire_timeout_s=0.01)
    assert client._heavy_sem is None
    assert client._guardrail_sem is None

    for _ in range(5):
        slot = await asyncio.wait_for(
            client._acquire_slot(tier="play", session_id="s1"), timeout=1.0
        )
        assert slot is None
    # Guardrail tier is equally uncapped.
    assert await client._acquire_slot(tier="guardrail", session_id="s1") is None


@pytest.mark.asyncio
async def test_acquire_timeout_raises_overloaded() -> None:
    """Holding the only permit and racing a tiny ``acquire_timeout_s``
    surfaces a retryable ``UpstreamLLMError(category="overloaded")`` so
    the turn ends gracefully instead of hanging the per-session lock."""

    client = _MinimalChatClient(max_concurrency=1, acquire_timeout_s=0.05)
    held = await client._acquire_slot(tier="play", session_id="s1")
    assert held is not None
    try:
        with pytest.raises(UpstreamLLMError) as ei:
            await client._acquire_slot(tier="play", session_id="s1")
        assert ei.value.category == "overloaded"
    finally:
        held.release()


@pytest.mark.asyncio
async def test_concurrency_slot_cm_releases_on_exit() -> None:
    """``_concurrency_slot`` is the async-CM wrapper for the non-streamed
    path: it acquires on enter and releases on exit so the next caller
    can proceed."""

    client = _MinimalChatClient(max_concurrency=1, acquire_timeout_s=0.2)

    async with client._concurrency_slot(tier="play", session_id="s1"):
        # Lane is saturated inside the block — a bare acquire times out.
        with pytest.raises(UpstreamLLMError):
            await client._acquire_slot(tier="play", session_id="s1")

    # After the CM exits the permit is back; acquire succeeds.
    slot = await asyncio.wait_for(
        client._acquire_slot(tier="play", session_id="s1"), timeout=1.0
    )
    assert slot is not None
    slot.release()


@pytest.mark.asyncio
async def test_concurrency_slot_disabled_is_noop_cm() -> None:
    """When capping is disabled the CM is a no-op and never blocks."""

    client = _MinimalChatClient(max_concurrency=0, acquire_timeout_s=0.01)
    async with client._concurrency_slot(tier="play", session_id="s1"):
        # Re-entering while "inside" must not block — no lane exists.
        async with client._concurrency_slot(tier="play", session_id="s1"):
            pass


class _FakeConnections:
    """Captures ``broadcast_to_creator`` calls. ``_notify_backend_degraded``
    only ever uses this one method (creator-only fan-out)."""

    def __init__(self) -> None:
        self.creator_events: list[tuple[str, dict[str, Any]]] = []

    async def broadcast_to_creator(
        self, session_id: str, event: dict[str, Any]
    ) -> None:
        self.creator_events.append((session_id, event))


@pytest.mark.asyncio
async def test_notify_backend_degraded_targets_creator() -> None:
    """``_notify_backend_degraded`` fans a degraded ``backend_status``
    notice to the creator only (via ``broadcast_to_creator``)."""

    client = _MinimalChatClient(max_concurrency=1, acquire_timeout_s=None)
    fake = _FakeConnections()
    client.set_connections(fake)  # type: ignore[arg-type]

    client._notify_backend_degraded("s1")
    # Fire-and-forget: let the scheduled task run.
    await asyncio.sleep(0)

    assert len(fake.creator_events) == 1
    sid, event = fake.creator_events[0]
    assert sid == "s1"
    assert event["type"] == "backend_status"
    assert event["status"] == "degraded"
    # Low-information by design — no counts/tiers/internals leaked.
    assert set(event) == {"type", "status", "message"}


@pytest.mark.asyncio
async def test_notify_backend_degraded_throttled_per_session() -> None:
    """A burst of notices for the same session collapses to ONE within
    the throttle window; a different session is unaffected."""

    client = _MinimalChatClient(max_concurrency=1, acquire_timeout_s=None)
    fake = _FakeConnections()
    client.set_connections(fake)  # type: ignore[arg-type]

    for _ in range(4):
        client._notify_backend_degraded("s1")
    client._notify_backend_degraded("s2")
    await asyncio.sleep(0)

    by_session = [sid for sid, _ in fake.creator_events]
    assert by_session.count("s1") == 1, "s1 burst should throttle to one notice"
    assert by_session.count("s2") == 1, "distinct session has its own throttle"


@pytest.mark.asyncio
async def test_notify_backend_degraded_noop_without_connections() -> None:
    """No wired connection manager → silent no-op (never raises)."""

    client = _MinimalChatClient(max_concurrency=1, acquire_timeout_s=None)
    # No set_connections() call.
    client._notify_backend_degraded("s1")
    client._notify_backend_degraded(None)
    await asyncio.sleep(0)  # nothing scheduled; must not raise
