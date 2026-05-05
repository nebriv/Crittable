"""Structlog configuration and FastAPI middleware that binds request context.

Every business-code log call goes through ``structlog.get_logger()``. ``print``
and stdlib ``logging`` are forbidden in business code (enforced by review).

Bound contextvars
-----------------
* ``request_id`` — set by :class:`RequestContextMiddleware` on every HTTP /
  WS request (UUID4).
* ``session_id``, ``turn_id``, ``role_id`` — bound by the WS / API entry
  points when relevant. Always set before passing control deeper.

Access log
----------
:class:`RequestContextMiddleware` also emits one structured ``http_access``
log line per HTTP request (post-response) with method, scrubbed path,
status code, and duration. This complements (rather than replaces) the
uvicorn access log so the JSON pipeline carries the same per-request
context as the rest of our logs.
"""

from __future__ import annotations

import logging
import re
import sys
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

import structlog
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp

from .config import Settings

_TOKEN_QUERY_RE = re.compile(rb"([?&]token=)[^&]+", re.IGNORECASE)
_TOKEN_PATH_RE = re.compile(rb"(/play/[^/?#]+/)[^/?#]+", re.IGNORECASE)


def _scrub_path_bytes(raw: bytes) -> str:
    """Strip ``?token=…`` / ``/play/<sid>/<token>`` fragments before logging."""

    scrubbed = _TOKEN_QUERY_RE.sub(rb"\1***", raw)
    scrubbed = _TOKEN_PATH_RE.sub(rb"\1***", scrubbed)
    try:
        return scrubbed.decode("ascii", errors="replace")
    except Exception:
        return "<unparseable path>"


def configure_logging(settings: Settings) -> None:
    """Configure structlog + stdlib bridge. Idempotent."""

    level = getattr(logging, settings.log_level)
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=level,
        force=True,
    )

    processors: list[structlog.types.Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]

    if settings.log_format == "json":
        processors.append(structlog.processors.JSONRenderer(sort_keys=True))
    else:
        processors.append(structlog.dev.ConsoleRenderer(colors=False))

    # Omit ``file=`` so ``PrintLoggerFactory`` looks up ``sys.stdout``
    # per call, and disable caching so every log emits through that
    # fresh path. The combination is what lets capsys-using tests
    # capture log output: ``capsys`` swaps ``sys.stdout`` per-test,
    # and a cached logger pinned to a specific ``sys.stdout`` reference
    # would freeze the bound stream at config time and leave later
    # tests writing to a closed buffer (raising ``ValueError: I/O
    # operation on closed file``). The per-call lookup is also
    # marginally more robust in production where an operator might
    # redirect stdout (e.g. via ``contextlib.redirect_stdout``); the
    # per-call structlog cost is microseconds and well below noise.
    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(level),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=False,
    )


def get_logger(name: str | None = None) -> Any:
    """Convenience wrapper so business code never imports structlog directly."""

    return structlog.get_logger(name) if name else structlog.get_logger()


class RequestContextMiddleware:
    """Bind ``request_id`` for the lifetime of an HTTP request.

    Implemented as raw ASGI rather than starlette's ``BaseHTTPMiddleware`` so
    contextvars set here propagate to the route handler without the
    ``BaseHTTPMiddleware`` thread-pool gotcha.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        self._access = structlog.get_logger("http.access")

    async def __call__(self, scope: dict[str, Any], receive: Callable[..., Awaitable[Any]], send: Callable[..., Awaitable[Any]]) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        request_id = _extract_or_mint_request_id(scope)
        structlog.contextvars.bind_contextvars(request_id=request_id)
        method = scope.get("method", "")
        raw_path = scope.get("raw_path") or scope.get("path", "").encode("utf-8")
        if isinstance(raw_path, str):
            raw_path = raw_path.encode("utf-8")
        # ``raw_path`` excludes the query string in Starlette/uvicorn —
        # combine it with ``query_string`` so the access log + scrubber
        # both see the full ``?token=…`` portion.
        query_string = scope.get("query_string") or b""
        if query_string:
            raw_path = (raw_path or b"") + b"?" + query_string
        scrubbed_path = _scrub_path_bytes(raw_path or b"")
        is_http = scope["type"] == "http"
        # Don't spam the access log with healthcheck noise; uvicorn already
        # emits an INFO line per /healthz, and the docker compose
        # healthcheck hits it every 5s.
        skip_access = is_http and scope.get("path") in {"/healthz", "/readyz"}
        started = time.monotonic()
        status_holder: dict[str, int] = {"status": 0}

        from collections.abc import MutableMapping

        async def send_wrapper(message: MutableMapping[str, Any]) -> None:
            if message.get("type") == "http.response.start":
                status_holder["status"] = int(message.get("status", 0))
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception as exc:
            duration_ms = int((time.monotonic() - started) * 1000)
            self._access.error(
                "http_access",
                method=method,
                path=scrubbed_path,
                status=500,
                duration_ms=duration_ms,
                error=str(exc),
            )
            raise
        else:
            if is_http and not skip_access:
                duration_ms = int((time.monotonic() - started) * 1000)
                status = status_holder["status"]
                level = (
                    "warning"
                    if 400 <= status < 500
                    else "error"
                    if status >= 500
                    else "info"
                )
                getattr(self._access, level)(
                    "http_access",
                    method=method,
                    path=scrubbed_path,
                    status=status,
                    duration_ms=duration_ms,
                )
        finally:
            structlog.contextvars.unbind_contextvars("request_id")


def _extract_or_mint_request_id(scope: dict[str, Any]) -> str:
    headers = dict(scope.get("headers") or [])
    for key in (b"x-request-id", b"X-Request-Id"):
        if key in headers:
            try:
                return str(headers[key].decode("ascii"))
            except (UnicodeDecodeError, AttributeError):
                break
    return uuid.uuid4().hex


def bind_session_context(
    *,
    session_id: str | None = None,
    turn_id: str | None = None,
    role_id: str | None = None,
) -> None:
    """Bind session-scoped fields onto the current logger context."""

    extra: dict[str, str] = {}
    if session_id is not None:
        extra["session_id"] = session_id
    if turn_id is not None:
        extra["turn_id"] = turn_id
    if role_id is not None:
        extra["role_id"] = role_id
    if extra:
        structlog.contextvars.bind_contextvars(**extra)


def clear_session_context() -> None:
    """Reset session-scoped fields. Call at the end of a WS connection."""

    structlog.contextvars.unbind_contextvars("session_id", "turn_id", "role_id")


__all__ = [
    "Request",  # re-export so callers don't need a starlette import for typing
    "RequestContextMiddleware",
    "Response",
    "bind_session_context",
    "clear_session_context",
    "configure_logging",
    "get_logger",
]
