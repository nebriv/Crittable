"""Structured upstream-LLM error classification (issue #191).

When the LLM provider returns a transient infrastructure error
(``529 OverloadedError``, ``5xx``, sustained ``429`` rate-limit, or a
connection / timeout fault) the SDK's built-in retries can't always
recover within a turn. The exception then propagates up through
``ChatClient.acomplete`` / ``astream`` and the turn ends in
``errored`` status with the generic copy "AI failed to yield." That
copy implies an app-side bug; the right operator response is
"wait 30-60 s and retry."

This module classifies the SDK exception into a category the WS
event + frontend banner can key on, so the creator sees an
actionable banner (with a status-page link) instead of generic copy.
The classifier is duck-typed against parallel exception hierarchies
exposed by every LiteLLM-routed provider (``APIError`` /
``APIConnectionError`` / ``APITimeoutError`` / ``RateLimitError`` /
``InternalServerError``) — they all carry the same ``status_code`` /
``request_id`` / ``response.headers`` attributes, so a single
classifier covers Anthropic, OpenAI, Bedrock, Vertex, etc.

Out of scope (see issue #191): app-level retry beyond what the SDK
already does — masking the operator's awareness of the outage and
burning cost on a known-down service is exactly what we don't want.
"""

from __future__ import annotations

from typing import Any, Literal

UpstreamCategory = Literal[
    "overloaded",
    "rate_limited",
    "server_error",
    "timeout",
    "unknown",
]


class UpstreamLLMError(Exception):
    """LLM provider returned a non-recoverable upstream error after SDK retries.

    Carries enough structured detail for the WS-event broadcaster to
    populate a creator-facing banner ("Anthropic API is currently
    overloaded …") with a status-page link, and for an operator
    paging through logs to grab the provider-side trace id.
    """

    def __init__(
        self,
        *,
        category: UpstreamCategory,
        status_code: int | None,
        request_id: str | None,
        retry_hint_seconds: int | None,
        message: str,
    ) -> None:
        super().__init__(message)
        self.category: UpstreamCategory = category
        self.status_code = status_code
        self.request_id = request_id
        self.retry_hint_seconds = retry_hint_seconds
        self.message = message

    def sanitized_summary(self) -> str:
        """Return a UI-safe summary string suitable for persisting on
        operator-visible session fields (``turn.error_reason``,
        ``session.aar_error``) that leak through ``/activity`` /
        ``/export.md`` / ``SessionActivityPanel``.

        Drops ``self.message`` (the raw ``str(exc)``) for the same
        reason ``to_event_payload`` does — Anthropic's
        ``APIConnectionError`` carries the resolved hostname in its
        message, which on a misconfigured ``LLM_API_BASE`` deploy
        leaks an internal gateway URL into the creator UI. Keep raw
        details on the ``upstream_llm_error`` log line for ops; UI
        surfaces get the structured summary only.
        """

        bits = [f"upstream_{self.category}"]
        meta: list[str] = []
        if self.status_code is not None:
            meta.append(f"status={self.status_code}")
        if self.request_id:
            meta.append(f"req={self.request_id}")
        if meta:
            bits.append("(" + " ".join(meta) + ")")
        return " ".join(bits)

    def to_event_payload(self) -> dict[str, Any]:
        """Serialise into the ``{type: "error", scope: "upstream_llm", …}``
        WS event shape consumed by ``frontend/src/pages/Facilitator.tsx``.

        ``self.message`` (the raw SDK ``str(exc)``) is intentionally
        excluded: the frontend banner renders category-specific copy,
        not the raw provider string, and exposing the SDK's exception
        message would surface internal hostnames on a misconfigured
        ``LLM_API_BASE`` deploy. The ``upstream_llm_error`` log line
        already preserves the raw message for ops.
        """

        return {
            "type": "error",
            "scope": "upstream_llm",
            "category": self.category,
            "status_code": self.status_code,
            "request_id": self.request_id,
            "retry_hint_seconds": self.retry_hint_seconds,
        }


def _parse_retry_after(exc: Any) -> int | None:
    """Extract ``Retry-After`` (in seconds) from the SDK exception's
    response headers. The header may be a number-of-seconds, an HTTP
    date, or absent. We only honor the integer form — date parsing
    isn't worth the complexity for a UX hint and we default to None
    on anything we can't trivially read."""

    response = getattr(exc, "response", None)
    if response is None:
        return None
    headers = getattr(response, "headers", None)
    if headers is None:
        return None
    try:
        raw = headers.get("retry-after")
    except Exception:  # pragma: no cover - defensive
        return None
    if not raw:
        return None
    try:
        n = int(str(raw).strip())
    except (TypeError, ValueError):
        return None
    if n < 0:
        return None
    # Cap at 1 hour. Anything larger almost certainly means the header
    # is an HTTP date that int() somehow consumed; clamp to a sane
    # ceiling so the frontend never shows "retry in 1700000000 seconds".
    return min(n, 3600)


def classify_upstream_error(exc: BaseException) -> UpstreamLLMError | None:
    """Classify an SDK exception into ``UpstreamLLMError``, or return
    ``None`` if the exception is not an upstream-provider issue.

    Both ``anthropic`` and ``litellm`` are required runtime deps in
    this project (see ``backend/pyproject.toml``); imports are
    unconditional. The classifier checks the litellm hierarchy first
    only because LiteLLM's ``RateLimitError`` is a subclass of its
    own ``APIStatusError`` which is *not* a subclass of Anthropic's —
    keeping the order deterministic avoids surprises if an exception
    happens to satisfy both isinstance checks (it doesn't today).

    Returning ``None`` means the caller should re-raise the original
    exception unchanged — it's an app-side bug or a non-LLM error,
    not an upstream-provider blip.
    """

    import anthropic
    from litellm.exceptions import (
        APIConnectionError as LiteLLMAPIConnectionError,
    )
    from litellm.exceptions import (
        InternalServerError as LiteLLMInternalServerError,
    )
    from litellm.exceptions import (
        RateLimitError as LiteLLMRateLimitError,
    )
    from litellm.exceptions import (
        Timeout as LiteLLMTimeout,
    )

    # Connection / timeout errors first — they have no ``status_code``.
    # The user-visible category is ``timeout`` for both flavors;
    # operationally indistinguishable from the operator's perspective
    # (the call didn't reach the provider, retry in a moment).
    if isinstance(
        exc,
        (
            anthropic.APITimeoutError,
            anthropic.APIConnectionError,
            LiteLLMTimeout,
            LiteLLMAPIConnectionError,
        ),
    ):
        return UpstreamLLMError(
            category="timeout",
            status_code=None,
            request_id=getattr(exc, "request_id", None),
            retry_hint_seconds=None,
            message=str(exc) or type(exc).__name__,
        )

    # Status-coded errors. The duck-typed ``status_code`` attribute is
    # present on both SDKs' ``APIStatusError`` subclasses.
    status_code: int | None = None
    raw_sc = getattr(exc, "status_code", None)
    if isinstance(raw_sc, int):
        status_code = raw_sc

    is_rate_limit = isinstance(
        exc, (anthropic.RateLimitError, LiteLLMRateLimitError)
    )
    is_server_error = isinstance(
        exc, (anthropic.InternalServerError, LiteLLMInternalServerError)
    )

    if not (is_rate_limit or is_server_error or (status_code and 500 <= status_code < 600)):
        # Not an upstream-provider issue we know how to surface.
        # ``BadRequestError`` / ``AuthenticationError`` /
        # ``PermissionDeniedError`` etc are app-side bugs; the existing
        # ``llm_call_failed`` log + propagation is the right behavior.
        return None

    request_id = getattr(exc, "request_id", None)
    retry_hint = _parse_retry_after(exc)

    if is_rate_limit:
        category: UpstreamCategory = "rate_limited"
    elif status_code == 529:
        # Anthropic's documented overloaded-error code. Both SDKs
        # surface 529 as ``InternalServerError`` (no dedicated
        # ``OverloadedError`` class on either side).
        category = "overloaded"
    else:
        category = "server_error"

    return UpstreamLLMError(
        category=category,
        status_code=status_code,
        request_id=request_id,
        retry_hint_seconds=retry_hint,
        message=str(exc) or type(exc).__name__,
    )


async def notify_creator_of_upstream_error(
    *,
    connections: Any,
    session: Any,
    err: UpstreamLLMError,
) -> None:
    """Push the structured upstream-error event to the creator only.

    Players are intentionally excluded — the creator owns the retry
    decision (Force-advance / Retry); a banner on the player side
    implies an action they can't take. Players continue to see "AI is
    thinking" until the creator acts.

    Silently no-ops when ``session.creator_role_id`` is unset (early
    setup, before the creator role exists) — the operator will still
    get the LLM-client-side WARNING with the request_id.
    """

    creator_role_id = getattr(session, "creator_role_id", None)
    if not creator_role_id:
        return
    session_id = getattr(session, "id", None)
    if not session_id:
        return
    await connections.send_to_role(
        session_id, creator_role_id, err.to_event_payload()
    )


__all__ = [
    "UpstreamCategory",
    "UpstreamLLMError",
    "classify_upstream_error",
    "notify_creator_of_upstream_error",
]
