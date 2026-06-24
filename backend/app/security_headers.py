"""Security-headers middleware (security audit M5).

Sets a small, fixed set of hardening headers on every HTTP response:

* ``Referrer-Policy: no-referrer`` — **the priority**. Player join links
  carry their per-role HMAC token in the URL path (``/play/<token>``);
  without this header a click-through to any external link would leak
  the token in the ``Referer`` request header. ``no-referrer`` stops
  the browser sending a Referer at all.
* ``X-Content-Type-Options: nosniff`` — block MIME-sniffing.
* ``X-Frame-Options: DENY`` — legacy clickjacking guard (paired with
  ``frame-ancestors 'none'`` in the CSP for modern browsers).
* ``Content-Security-Policy`` — self-hosted-only by default. Fonts and
  assets are bundled (CLAUDE.md: no Google Fonts CDN, no external
  runtime assets), so ``default-src 'self'`` is sufficient.
  ``connect-src 'self'`` covers the same-origin WebSocket.

The CSP is overridable via the ``CONTENT_SECURITY_POLICY`` env var for
the rare deploy that needs a looser policy; the default is the hardened
constant below.

Implemented as plain ASGI (no per-request object allocation beyond the
header rewrite) so it sits cheaply at the top of the middleware stack
and applies uniformly to API responses, the SPA fallback, and the
static asset mounts. ``/healthz`` / ``/readyz`` get the headers too —
they're harmless on a JSON health probe and keeping the path
unconditional avoids a "which routes are covered?" gap.
"""

from __future__ import annotations

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .config import Settings

# Self-hosted-only default. Kept as a module constant so tests can assert
# the exact string and a future tightening lands in one place.
DEFAULT_CSP = (
    "default-src 'self'; "
    "img-src 'self' data:; "
    "style-src 'self' 'unsafe-inline'; "
    "connect-src 'self'; "
    "frame-ancestors 'none'; "
    "base-uri 'none'"
)


class SecurityHeadersMiddleware:
    """Inject fixed hardening headers on every HTTP response."""

    __slots__ = ("_csp", "app")

    def __init__(self, app: ASGIApp, *, settings: Settings) -> None:
        self.app = app
        override = settings.content_security_policy.strip()
        self._csp = override or DEFAULT_CSP

    async def __call__(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
    ) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers: list[tuple[bytes, bytes]] = message.setdefault("headers", [])
                # Append our headers; never clobber an existing value a
                # handler set deliberately (none currently do, but keep
                # the contract explicit). Header names are matched
                # case-insensitively per RFC, so we lowercase both sides.
                present = {name.lower() for name, _ in headers}
                for raw_name, raw_value in (
                    (b"referrer-policy", b"no-referrer"),
                    (b"x-content-type-options", b"nosniff"),
                    (b"x-frame-options", b"DENY"),
                    (b"content-security-policy", self._csp.encode("latin-1")),
                ):
                    if raw_name not in present:
                        headers.append((raw_name, raw_value))
            await send(message)

        await self.app(scope, receive, send_with_headers)


__all__ = ["DEFAULT_CSP", "SecurityHeadersMiddleware"]
