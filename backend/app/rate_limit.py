"""Per-IP token-bucket rate limit middleware.

Off by default. When ``RATE_LIMIT_ENABLED=true``, every HTTP request is
checked against an in-memory token-bucket keyed on the client IP; bursts up to
the per-minute cap are allowed, then 429s land until the bucket refills.

Documented as a single-process MVP — Phase 3 swaps to Redis-backed buckets so
horizontal scale-out keeps a coherent view. The interface here doesn't change.
"""

from __future__ import annotations

import asyncio
import time
from collections import defaultdict
from collections.abc import Awaitable, Callable
from typing import Any

from starlette.types import ASGIApp

from .config import Settings
from .logging_setup import get_logger

_logger = get_logger("rate_limit")


class _Bucket:
    __slots__ = ("last_refill", "tokens")

    def __init__(self, capacity: float, *, full: bool = True) -> None:
        self.tokens = capacity if full else 0.0
        self.last_refill = time.monotonic()


class RateLimitMiddleware:
    """Sliding-window token bucket per client IP.

    Capacity = ``RATE_LIMIT_REQ_PER_MIN``; refill rate = capacity / 60s. So a
    request consumes one token; an idle minute fully refills.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        settings: Settings,
    ) -> None:
        self.app = app
        self._enabled = settings.rate_limit_enabled
        self._capacity = float(settings.rate_limit_req_per_min)
        # tokens-per-second
        self._refill = self._capacity / 60.0
        self._buckets: dict[str, _Bucket] = defaultdict(self._fresh)
        self._lock = asyncio.Lock()

    def _fresh(self) -> _Bucket:
        return _Bucket(self._capacity)

    async def __call__(
        self,
        scope: dict[str, Any],
        receive: Callable[..., Awaitable[Any]],
        send: Callable[..., Awaitable[Any]],
    ) -> None:
        if not self._enabled or scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        # Don't rate-limit health probes; they're called every few seconds by
        # Kubernetes / Docker healthchecks.
        path = scope.get("path", "")
        if path in ("/healthz", "/readyz"):
            await self.app(scope, receive, send)
            return

        ip = _client_ip(scope)
        allowed = await self._consume(ip)
        if not allowed:
            _logger.warning("rate_limited", ip=ip, path=path)
            if scope["type"] == "http":
                await _send_429(send)
            else:
                # WS: refuse the upgrade with 4429 (custom close code).
                await send({"type": "websocket.close", "code": 4429})
            return

        await self.app(scope, receive, send)

    async def _consume(self, ip: str) -> bool:
        async with self._lock:
            bucket = self._buckets[ip]
            now = time.monotonic()
            elapsed = now - bucket.last_refill
            bucket.tokens = min(self._capacity, bucket.tokens + elapsed * self._refill)
            bucket.last_refill = now
            if bucket.tokens >= 1.0:
                bucket.tokens -= 1.0
                return True
            return False


def _client_ip(scope: dict[str, Any]) -> str:
    headers = dict(scope.get("headers") or [])
    fwd = headers.get(b"x-forwarded-for")
    if fwd:
        try:
            return str(fwd.decode("ascii").split(",")[0].strip())
        except (UnicodeDecodeError, AttributeError):
            pass
    client = scope.get("client")
    if client and isinstance(client, (list, tuple)) and client:
        return str(client[0])
    return "unknown"


async def _send_429(send: Callable[..., Awaitable[Any]]) -> None:
    body = b'{"detail":"rate limit exceeded"}'
    await send(
        {
            "type": "http.response.start",
            "status": 429,
            "headers": [
                (b"content-type", b"application/json"),
                (b"retry-after", b"60"),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})
