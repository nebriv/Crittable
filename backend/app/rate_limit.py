"""Per-IP token-bucket rate limit middleware.

Off by default. When ``RATE_LIMIT_ENABLED=true``, every HTTP request is
checked against an in-memory token-bucket keyed on the client IP; bursts up to
the per-minute cap are allowed, then 429s land until the bucket refills.

Documented as a single-process MVP — Phase 3 swaps to Redis-backed buckets so
horizontal scale-out keeps a coherent view. The interface here doesn't change.
"""

from __future__ import annotations

import asyncio
import ipaddress
import time
from collections import defaultdict
from functools import lru_cache

from starlette.types import ASGIApp, Receive, Scope, Send

from .config import Settings
from .logging_setup import get_logger

_logger = get_logger("rate_limit")

_SECONDS_PER_MINUTE = 60.0


@lru_cache(maxsize=32)
def _parse_trusted_networks(
    raw: tuple[str, ...],
) -> tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]:
    """Validate raw ``TRUSTED_PROXIES`` strings into ``ip_network`` objects.

    A bad entry is logged once (the cache makes this idempotent across
    requests) and dropped — a typo in one CIDR must not crash every
    request. ``strict=False`` lets an operator write ``10.0.0.7/8``
    (host bits set) without a ``ValueError``.
    """

    nets: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
    for entry in raw:
        try:
            nets.append(ipaddress.ip_network(entry, strict=False))
        except ValueError:
            _logger.warning("trusted_proxy_parse_failed", entry=entry)
    return tuple(nets)


def _ip_in_networks(
    ip: str,
    networks: tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...],
) -> bool:
    """True iff ``ip`` parses and is a member of any trusted network."""

    if not networks:
        return False
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(addr in net for net in networks)


def _peer_ip(scope: Scope) -> str:
    """The immediate socket peer IP from the ASGI scope, or ``"unknown"``."""

    client = scope.get("client")
    if client and isinstance(client, (list, tuple)) and client:
        return str(client[0])
    return "unknown"


def resolve_client_ip(scope: Scope, settings: Settings) -> str:
    """Resolve the real client IP, hardened against ``X-Forwarded-For`` spoofing.

    Security audit H7. The legacy implementation trusted the *first*
    ``X-Forwarded-For`` value unconditionally, which any direct client
    can forge to evade per-IP throttling (or to frame another address).

    Policy:

    * Default to the socket peer (``scope["client"][0]``).
    * Only consult ``X-Forwarded-For`` when ``TRUST_FORWARDED_FOR`` is
      true AND the immediate peer is itself in ``TRUSTED_PROXIES``
      (i.e. the request actually came through a proxy we control).
    * When honoured, walk the XFF list **right-to-left** and return the
      first entry that is *not* in the trusted set — that's the hop the
      outermost trusted proxy observed, i.e. the real client. A client
      can prepend junk to the left of the header, but it cannot control
      what the trusted proxy appends on the right, so the right-most
      untrusted entry is the trustworthy one.
    * If every XFF entry is trusted (or the header is empty/garbage),
      fall back to the peer.

    This resolver is shared by the request limiter and the C1
    session-create limiter so both key on an identical, spoof-resistant
    value.
    """

    peer = _peer_ip(scope)
    if not settings.trust_forwarded_for:
        return peer

    networks = _parse_trusted_networks(tuple(settings.trusted_proxy_list()))
    # The immediate peer must be a trusted proxy before we believe ANY
    # forwarded header — otherwise a direct attacker just sets the header
    # themselves.
    if not _ip_in_networks(peer, networks):
        return peer

    headers: dict[bytes, bytes] = dict(scope.get("headers") or [])
    fwd: bytes | None = headers.get(b"x-forwarded-for")
    if not fwd:
        return peer
    try:
        chain = [p.strip() for p in fwd.decode("ascii").split(",") if p.strip()]
    except (UnicodeDecodeError, AttributeError):
        return peer
    # Right-to-left: the first hop the trusted proxy chain didn't add.
    for candidate in reversed(chain):
        if not _ip_in_networks(candidate, networks):
            return candidate
    # Every entry was a trusted proxy — no real client hop to extract.
    return peer


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
        self._settings = settings
        self._enabled = settings.rate_limit_enabled
        self._capacity = float(settings.rate_limit_req_per_min)
        # tokens-per-second
        self._refill = self._capacity / _SECONDS_PER_MINUTE
        self._buckets: dict[str, _Bucket] = defaultdict(self._fresh)
        self._lock = asyncio.Lock()

    def _fresh(self) -> _Bucket:
        return _Bucket(self._capacity)

    async def __call__(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
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

        ip = resolve_client_ip(scope, self._settings)
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


class SessionCreateRateLimiter:
    """Dedicated per-IP token bucket for ``POST /api/sessions`` (audit C1).

    Session creation fires a setup-tier LLM call, so it's the costliest
    request the app serves. This limiter is independent of the general
    ``RateLimitMiddleware`` and runs even when ``RATE_LIMIT_ENABLED`` is
    false — the cost asymmetry means the create path is always throttled
    (tunable / disable-able via ``SESSION_CREATE_RATE_PER_MIN``).

    Constructed once in the lifespan and stored on ``app.state`` so the
    route handler can call :meth:`check` per request. Keyed on the
    hardened :func:`resolve_client_ip` so a spoofed ``X-Forwarded-For``
    can't shard the bucket into unlimited fresh allowances.

    Single-process MVP, same as ``RateLimitMiddleware`` — a multi-worker
    deploy needs the Phase-3 Redis backend for a coherent view.
    """

    __slots__ = ("_buckets", "_capacity", "_enabled", "_lock", "_refill", "_settings")

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        cap = settings.session_create_rate_per_min
        self._enabled = cap > 0
        self._capacity = float(cap)
        self._refill = self._capacity / _SECONDS_PER_MINUTE
        self._buckets: dict[str, _Bucket] = defaultdict(self._fresh)
        self._lock = asyncio.Lock()

    def _fresh(self) -> _Bucket:
        return _Bucket(self._capacity)

    async def check(self, scope: Scope) -> bool:
        """Consume one token for the request's client IP.

        Returns ``True`` when the request is allowed (or the limiter is
        disabled), ``False`` when the per-IP bucket is empty. The caller
        is responsible for translating ``False`` into an HTTP 429.
        """

        if not self._enabled:
            return True
        ip = resolve_client_ip(scope, self._settings)
        async with self._lock:
            bucket = self._buckets[ip]
            now = time.monotonic()
            elapsed = now - bucket.last_refill
            bucket.tokens = min(self._capacity, bucket.tokens + elapsed * self._refill)
            bucket.last_refill = now
            if bucket.tokens >= 1.0:
                bucket.tokens -= 1.0
                return True
            _logger.warning("session_create_rate_limited", ip=ip)
            return False


async def _send_429(send: Send) -> None:
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
