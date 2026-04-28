"""Structlog configuration and FastAPI middleware that binds request context.

Every business-code log call goes through ``structlog.get_logger()``. ``print``
and stdlib ``logging`` are forbidden in business code (enforced by review).

Bound contextvars
-----------------
* ``request_id`` — set by :class:`RequestContextMiddleware` on every HTTP /
  WS request (UUID4).
* ``session_id``, ``turn_id``, ``role_id`` — bound by the WS / API entry
  points when relevant. Always set before passing control deeper.
"""

from __future__ import annotations

import logging
import sys
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

import structlog
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp

from .config import Settings


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

    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(level),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
        cache_logger_on_first_use=True,
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

    async def __call__(self, scope: dict[str, Any], receive: Callable[..., Awaitable[Any]], send: Callable[..., Awaitable[Any]]) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        request_id = _extract_or_mint_request_id(scope)
        structlog.contextvars.bind_contextvars(request_id=request_id)
        try:
            await self.app(scope, receive, send)
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
