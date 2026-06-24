"""Curated client-error mapping (security audit M11 / CWE-209).

CodeQL ``py/stack-trace-exposure`` flags any flow where an exception
object's string reaches a client response. The repo returned
``str(exc)`` as the ``HTTPException`` detail at ~57 REST sites and in
~12 WebSocket ``error`` frames. Even when the exception text is
currently benign, that flow is the taint sink CodeQL reports — and it's
a real footgun the moment a swallowed lower-level exception (a
``KeyError`` repr, a pydantic validation dump, a stdlib message naming
an internal path) bubbles into one of these handlers.

The fix breaks the exception→response taint flow with one boundary
helper:

* **Log** the full ``str(exc)`` via structlog (operator keeps the
  detail for debugging — structlog goes to stdout/JSONL, never to the
  client).
* **Return** a curated, *constant* message chosen by the exception
  *type*, never derived from the exception string.

Known domain exceptions map to a short, safe, human message. Anything
unrecognised collapses to a generic ``"operation failed"`` — the
client learns the request failed and the HTTP status; the specifics
live only in the log.

Use :func:`http_error` at every REST ``raise HTTPException`` that would
otherwise carry ``str(exc)``; use :func:`ws_error_message` to build the
``message`` field of a WebSocket ``error`` frame.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from ..auth.authn import InvalidTokenError
from ..auth.authz import AuthorizationError
from ..sessions.repository import SessionCapacityError, SessionNotFoundError
from ..sessions.turn_engine import IllegalTransitionError

# Curated, constant messages keyed on exception type. Ordered most- to
# least-specific; the lookup walks the MRO so a subclass falls back to
# its nearest registered base. None of these strings is derived from the
# exception instance — that's the whole point.
_CURATED: dict[type[BaseException], str] = {
    AuthorizationError: "you are not allowed to perform this action",
    InvalidTokenError: "invalid or expired token",
    SessionNotFoundError: "session not found",
    SessionCapacityError: "the server is at capacity; try again shortly",
    IllegalTransitionError: "the session is not in a state that allows this action",
}

_GENERIC = "operation failed"


def curate(exc: BaseException) -> str:
    """Return the curated client message for ``exc`` (never its string)."""

    for klass in type(exc).__mro__:
        msg = _CURATED.get(klass)
        if msg is not None:
            return msg
    return _GENERIC


def http_error(
    exc: BaseException,
    *,
    status_code: int,
    log: Any,
    log_event: str,
    message: str | None = None,
    **log_ctx: object,
) -> HTTPException:
    """Log ``exc`` in full, return an ``HTTPException`` with a curated detail.

    The caller ``raise``s the return value (so ``raise http_error(...)
    from exc`` preserves the traceback chain in the logs). The detail
    handed to the client is the type-curated constant — the raw
    ``str(exc)`` only ever reaches the structlog line.

    ``message`` lets a call site supply a more specific *constant* detail
    when one curated-per-type string can't capture the context (e.g. an
    ``IllegalTransitionError`` raised for a creator-only gate vs. a
    wrong-state transition). It is still a literal chosen by our code,
    never derived from ``exc`` — so the CWE-209 taint flow stays broken.
    """

    log.warning(log_event, error=str(exc), **log_ctx)
    return HTTPException(status_code, message if message is not None else curate(exc))


def ws_error_message(exc: BaseException, *, message: str | None = None) -> str:
    """Curated ``message`` for a WebSocket ``error`` frame.

    The caller is responsible for logging the raw detail (the WS
    handlers already emit a structlog line at each failure boundary);
    this only sanitises the client-visible string. ``message`` is an
    optional call-site *constant* override (see :func:`http_error`).
    """

    return message if message is not None else curate(exc)


__all__ = ["curate", "http_error", "ws_error_message"]
