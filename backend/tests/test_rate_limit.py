"""Tests for the per-IP token-bucket rate-limit middleware.

Coverage gap addressed: ``app/rate_limit.py`` was at 42% before this
file landed. The token-bucket consume path, the 429 / 4429 send
paths, and the ``x-forwarded-for`` parsing branches were entirely
untested. The middleware is OFF by default in production but is the
only thing standing between an open deployment and a single client
hammering the LLM endpoint, so its branches need to actually run in
CI.

The middleware is plain ASGI — we drive it with a synthetic scope +
recording ``send`` callable and skip starlette/fastapi entirely.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest

from app.config import Settings
from app.rate_limit import RateLimitMiddleware, _client_ip

# ---------------------------------------------------------------- helpers


class _RecordedSend:
    """Captures every ASGI send so tests can assert on response shape."""

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    async def __call__(self, message: dict[str, Any]) -> None:
        self.events.append(message)

    @property
    def status(self) -> int | None:
        for ev in self.events:
            if ev.get("type") == "http.response.start":
                return int(ev["status"])
        return None

    @property
    def body(self) -> bytes:
        return b"".join(
            ev.get("body", b"")
            for ev in self.events
            if ev.get("type") == "http.response.body"
        )


def _http_scope(*, path: str = "/api/sessions", client: tuple[str, int] | None = ("1.2.3.4", 5000), headers: list[tuple[bytes, bytes]] | None = None) -> dict[str, Any]:
    return {
        "type": "http",
        "path": path,
        "client": list(client) if client else None,
        "headers": headers or [],
    }


def _ws_scope(*, path: str = "/ws/sessions/abc") -> dict[str, Any]:
    return {
        "type": "websocket",
        "path": path,
        "client": ["9.9.9.9", 5000],
        "headers": [],
    }


async def _passthrough_app(scope: dict[str, Any], receive: Any, send: Any) -> None:
    """Stand-in downstream ASGI app — sends a 200 so we can tell allowed
    requests apart from rate-limited ones.
    """

    if scope["type"] == "http":
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", b"text/plain")],
            }
        )
        await send({"type": "http.response.body", "body": b"ok"})
    else:
        await send({"type": "websocket.accept"})


def _settings(*, enabled: bool = True, cap: int = 5) -> Settings:
    return Settings(
        ANTHROPIC_API_KEY="x",
        SESSION_SECRET="x" * 32,
        RATE_LIMIT_ENABLED=enabled,
        RATE_LIMIT_REQ_PER_MIN=cap,
    )


# ---------------------------------------------------------------- disabled / bypass


@pytest.mark.asyncio
async def test_disabled_middleware_passes_everything_through() -> None:
    mw = RateLimitMiddleware(_passthrough_app, settings=_settings(enabled=False, cap=1))
    send = _RecordedSend()
    # Burst of 100 — would exceed cap=1 if enabled.
    for _ in range(100):
        await mw(_http_scope(), receive=lambda: None, send=send)  # type: ignore[arg-type]
    # Every send should be a 200.
    statuses = [ev["status"] for ev in send.events if ev.get("type") == "http.response.start"]
    assert statuses == [200] * 100


@pytest.mark.asyncio
async def test_health_probes_are_never_limited() -> None:
    mw = RateLimitMiddleware(_passthrough_app, settings=_settings(enabled=True, cap=1))
    send = _RecordedSend()
    # cap=1, but /healthz + /readyz should bypass entirely.
    for _ in range(50):
        await mw(_http_scope(path="/healthz"), receive=lambda: None, send=send)  # type: ignore[arg-type]
    for _ in range(50):
        await mw(_http_scope(path="/readyz"), receive=lambda: None, send=send)  # type: ignore[arg-type]
    statuses = [ev["status"] for ev in send.events if ev.get("type") == "http.response.start"]
    assert statuses == [200] * 100


@pytest.mark.asyncio
async def test_non_http_non_ws_scopes_pass_through() -> None:
    """ASGI lifespan / custom scope types must not be rate-limited."""

    seen: list[str] = []

    async def app(scope: dict[str, Any], receive: Any, send: Any) -> None:
        seen.append(scope["type"])

    mw_with_app = RateLimitMiddleware(app, settings=_settings(enabled=True, cap=1))
    await mw_with_app({"type": "lifespan"}, receive=lambda: None, send=_RecordedSend())  # type: ignore[arg-type]
    assert seen == ["lifespan"]


# ---------------------------------------------------------------- 429 path (HTTP)


@pytest.mark.asyncio
async def test_http_burst_returns_429_after_cap() -> None:
    mw = RateLimitMiddleware(_passthrough_app, settings=_settings(enabled=True, cap=3))
    send = _RecordedSend()
    for _ in range(5):
        await mw(_http_scope(), receive=lambda: None, send=send)  # type: ignore[arg-type]
    statuses = [ev["status"] for ev in send.events if ev.get("type") == "http.response.start"]
    # First three allowed, last two rate-limited.
    assert statuses == [200, 200, 200, 429, 429]
    # 429 carries Retry-After + JSON body — what the operator's UI keys off.
    rate_starts = [ev for ev in send.events if ev.get("status") == 429]
    headers = dict(rate_starts[0]["headers"])
    assert headers[b"retry-after"] == b"60"
    assert headers[b"content-type"] == b"application/json"
    assert b"rate limit exceeded" in send.body


@pytest.mark.asyncio
async def test_separate_ips_have_separate_buckets() -> None:
    mw = RateLimitMiddleware(_passthrough_app, settings=_settings(enabled=True, cap=2))
    send = _RecordedSend()

    # IP A burns its bucket — last hit should 429.
    for _ in range(3):
        await mw(_http_scope(client=("10.0.0.1", 1)), receive=lambda: None, send=send)  # type: ignore[arg-type]
    # IP B starts fresh.
    for _ in range(2):
        await mw(_http_scope(client=("10.0.0.2", 2)), receive=lambda: None, send=send)  # type: ignore[arg-type]

    statuses = [ev["status"] for ev in send.events if ev.get("type") == "http.response.start"]
    # A: 200, 200, 429 — B: 200, 200.
    assert statuses == [200, 200, 429, 200, 200]


@pytest.mark.asyncio
async def test_bucket_refills_over_time(monkeypatch: pytest.MonkeyPatch) -> None:
    """The bucket refills at capacity / 60 tokens per second; faking
    monotonic time should fully refill it after a minute of idle."""

    fake_now = {"t": 1000.0}

    def fake_monotonic() -> float:
        return fake_now["t"]

    monkeypatch.setattr(time, "monotonic", fake_monotonic)

    mw = RateLimitMiddleware(_passthrough_app, settings=_settings(enabled=True, cap=3))
    send = _RecordedSend()
    # Drain.
    for _ in range(3):
        await mw(_http_scope(), receive=lambda: None, send=send)  # type: ignore[arg-type]
    # Next request should 429.
    await mw(_http_scope(), receive=lambda: None, send=send)  # type: ignore[arg-type]
    statuses = [ev["status"] for ev in send.events if ev.get("type") == "http.response.start"]
    assert statuses[-1] == 429

    # Advance 60s — bucket should be full again.
    fake_now["t"] += 60.0
    send2 = _RecordedSend()
    for _ in range(3):
        await mw(_http_scope(), receive=lambda: None, send=send2)  # type: ignore[arg-type]
    statuses2 = [ev["status"] for ev in send2.events if ev.get("type") == "http.response.start"]
    assert statuses2 == [200, 200, 200]


# ---------------------------------------------------------------- 4429 path (WS)


@pytest.mark.asyncio
async def test_ws_burst_closes_with_4429() -> None:
    mw = RateLimitMiddleware(_passthrough_app, settings=_settings(enabled=True, cap=1))
    send = _RecordedSend()
    # First WS upgrade allowed.
    await mw(_ws_scope(), receive=lambda: None, send=send)  # type: ignore[arg-type]
    # Second over-cap — should be a websocket.close with code 4429.
    await mw(_ws_scope(), receive=lambda: None, send=send)  # type: ignore[arg-type]
    closes = [ev for ev in send.events if ev.get("type") == "websocket.close"]
    assert len(closes) == 1
    assert closes[0]["code"] == 4429


# ---------------------------------------------------------------- _client_ip parsing


def test_client_ip_prefers_xff_first_value() -> None:
    scope = {
        "client": ["10.10.10.10", 9000],
        "headers": [(b"x-forwarded-for", b"203.0.113.7, 10.0.0.1")],
    }
    assert _client_ip(scope) == "203.0.113.7"


def test_client_ip_falls_back_to_scope_client_when_no_xff() -> None:
    scope = {"client": ["192.168.0.1", 9000], "headers": []}
    assert _client_ip(scope) == "192.168.0.1"


def test_client_ip_returns_unknown_when_no_client() -> None:
    scope = {"client": None, "headers": []}
    assert _client_ip(scope) == "unknown"


def test_client_ip_handles_malformed_xff_bytes() -> None:
    """Production has seen the proxy attach garbage bytes here; we
    must fall through to the scope's ``client`` rather than 500-ing."""

    scope = {
        "client": ["10.0.0.5", 9000],
        # Invalid UTF-8 — split() fires on the bytes after .decode("ascii"),
        # which raises UnicodeDecodeError. Caller falls through.
        "headers": [(b"x-forwarded-for", b"\xff\xfe garbage")],
    }
    assert _client_ip(scope) == "10.0.0.5"


def test_client_ip_handles_empty_xff() -> None:
    scope = {
        "client": ["10.0.0.5", 9000],
        "headers": [(b"x-forwarded-for", b"")],
    }
    # Empty xff is falsy — falls through to scope.client.
    assert _client_ip(scope) == "10.0.0.5"


# ---------------------------------------------------------------- concurrency


@pytest.mark.asyncio
async def test_concurrent_consume_is_atomic(monkeypatch: pytest.MonkeyPatch) -> None:
    """The asyncio.Lock in ``_consume`` means cap=N must hold across
    concurrent gather, never N+1.

    ``time.monotonic`` is frozen for the duration of this test so
    the bucket can't refill during gather (cap=10 + refill = 10/60
    tokens/s; under a CI machine pause >6s gather could otherwise
    hand out an 11th token and the test would flake).
    """

    fake_now = {"t": 1000.0}
    monkeypatch.setattr(time, "monotonic", lambda: fake_now["t"])

    mw = RateLimitMiddleware(_passthrough_app, settings=_settings(enabled=True, cap=10))
    send = _RecordedSend()

    async def hit() -> None:
        await mw(_http_scope(), receive=lambda: None, send=send)  # type: ignore[arg-type]

    await asyncio.gather(*(hit() for _ in range(50)))
    statuses = [ev["status"] for ev in send.events if ev.get("type") == "http.response.start"]
    allowed = sum(1 for s in statuses if s == 200)
    rejected = sum(1 for s in statuses if s == 429)
    assert allowed == 10
    assert rejected == 40


@pytest.mark.asyncio
async def test_bucket_refill_clamps_at_capacity(monkeypatch: pytest.MonkeyPatch) -> None:
    """A ten-minute idle gap should not over-refill the bucket past
    ``capacity``; the ``min(self._capacity, ...)`` clamp must hold."""

    fake_now = {"t": 5000.0}
    monkeypatch.setattr(time, "monotonic", lambda: fake_now["t"])

    mw = RateLimitMiddleware(_passthrough_app, settings=_settings(enabled=True, cap=3))
    send = _RecordedSend()
    # Drain.
    for _ in range(3):
        await mw(_http_scope(), receive=lambda: None, send=send)  # type: ignore[arg-type]
    # Sleep ten minutes (way past the 60s window). The clamp should
    # cap the bucket back at exactly 3 tokens, not 30.
    fake_now["t"] += 600.0
    send2 = _RecordedSend()
    for _ in range(5):
        await mw(_http_scope(), receive=lambda: None, send=send2)  # type: ignore[arg-type]
    statuses = [ev["status"] for ev in send2.events if ev.get("type") == "http.response.start"]
    # Exactly 3 allowed, the rest rate-limited — proves the clamp.
    assert statuses == [200, 200, 200, 429, 429]
