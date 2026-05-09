"""Tests for the issue #191 upstream-error classification + broadcast path.

Pins the wire shape the creator-side banner reads: any change to
``UpstreamLLMError.to_event_payload`` is a breaking contract change vs.
``frontend/src/lib/ws.ts``'s ``error`` event union.

Three layers:

1. **Classifier unit tests** (`classify_upstream_error`) — cover both
   SDKs (anthropic, litellm) since both ChatClient backends route
   through the same classifier.
2. **Notify-creator broadcast** — verifies the banner is sent via
   ``send_to_role`` to the creator only (players never receive it,
   per issue #191 "Players don't see the creator's error banner").
3. **Event payload shape** — locks the keys the frontend asserts on.
"""

from __future__ import annotations

from typing import Any

import anthropic
import httpx
import litellm
import pytest

from app.llm.errors import (
    UpstreamLLMError,
    classify_upstream_error,
    notify_creator_of_upstream_error,
)


def _anthropic_status_error(
    cls: type[anthropic.APIStatusError],
    *,
    status: int,
    request_id: str | None = "req_test",
    retry_after: str | None = None,
) -> anthropic.APIStatusError:
    headers: dict[str, str] = {}
    if request_id is not None:
        headers["request-id"] = request_id
    if retry_after is not None:
        headers["retry-after"] = retry_after
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    response = httpx.Response(status, request=request, headers=headers)
    return cls("upstream", response=response, body=None)


# -------------------------------------------------------------- classifier


def test_classify_anthropic_overloaded_529() -> None:
    """529 → ``overloaded`` (Anthropic-documented overloaded code)."""

    exc = _anthropic_status_error(anthropic.InternalServerError, status=529)
    classified = classify_upstream_error(exc)
    assert classified is not None
    assert classified.category == "overloaded"
    assert classified.status_code == 529
    assert classified.request_id == "req_test"
    assert classified.retry_hint_seconds is None


def test_classify_anthropic_rate_limit_with_retry_after() -> None:
    """RateLimitError → ``rate_limited``; honors ``retry-after`` seconds."""

    exc = _anthropic_status_error(
        anthropic.RateLimitError, status=429, retry_after="42"
    )
    classified = classify_upstream_error(exc)
    assert classified is not None
    assert classified.category == "rate_limited"
    assert classified.status_code == 429
    assert classified.retry_hint_seconds == 42


def test_classify_anthropic_internal_500() -> None:
    """500 (non-529) → ``server_error``."""

    exc = _anthropic_status_error(anthropic.InternalServerError, status=500)
    classified = classify_upstream_error(exc)
    assert classified is not None
    assert classified.category == "server_error"
    assert classified.status_code == 500


def test_classify_anthropic_timeout() -> None:
    """APITimeoutError → ``timeout`` with no status code."""

    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    exc = anthropic.APITimeoutError(request=request)
    classified = classify_upstream_error(exc)
    assert classified is not None
    assert classified.category == "timeout"
    assert classified.status_code is None


def test_classify_anthropic_connection_error() -> None:
    """APIConnectionError → ``timeout`` (operationally indistinguishable)."""

    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    exc = anthropic.APIConnectionError(request=request)
    classified = classify_upstream_error(exc)
    assert classified is not None
    assert classified.category == "timeout"


def test_classify_anthropic_bad_request_returns_none() -> None:
    """400 BadRequestError is an app-side bug; classifier returns None
    so the LLM client re-raises the original exception unchanged."""

    exc = _anthropic_status_error(anthropic.BadRequestError, status=400)
    assert classify_upstream_error(exc) is None


def test_classify_anthropic_auth_returns_none() -> None:
    """401 AuthenticationError is an operator-side misconfig (bad key);
    not surfaced as an "upstream is overloaded" banner."""

    exc = _anthropic_status_error(anthropic.AuthenticationError, status=401)
    assert classify_upstream_error(exc) is None


def test_classify_non_sdk_error_returns_none() -> None:
    """Non-SDK exceptions (TypeError, ValueError) propagate unchanged."""

    assert classify_upstream_error(ValueError("nope")) is None
    assert classify_upstream_error(RuntimeError("boom")) is None


def test_classify_litellm_rate_limit() -> None:
    """LiteLLM-routed RateLimitError → ``rate_limited`` with status 429."""

    exc = litellm.RateLimitError(
        message="Rate limited",
        llm_provider="anthropic",
        model="claude-opus-4-7",
    )
    classified = classify_upstream_error(exc)
    assert classified is not None
    assert classified.category == "rate_limited"
    assert classified.status_code == 429


def test_classify_litellm_internal_server_error() -> None:
    """LiteLLM InternalServerError (500) → ``server_error``."""

    exc = litellm.InternalServerError(
        message="500",
        llm_provider="anthropic",
        model="claude-opus-4-7",
    )
    classified = classify_upstream_error(exc)
    assert classified is not None
    # LiteLLM's InternalServerError defaults to 500. ``server_error``,
    # not ``overloaded`` (529 is the only code that maps to overloaded).
    assert classified.category == "server_error"


def test_classify_litellm_timeout() -> None:
    """LiteLLM Timeout (subclass of APITimeoutError) → ``timeout``."""

    exc = litellm.Timeout(
        message="timeout",
        model="claude-opus-4-7",
        llm_provider="anthropic",
    )
    classified = classify_upstream_error(exc)
    assert classified is not None
    assert classified.category == "timeout"


def test_retry_hint_clamped_to_one_hour() -> None:
    """Defensive: an HTTP-date Retry-After that int() somehow consumed
    as a huge number gets clamped, not surfaced as "retry in 1.7B s"."""

    exc = _anthropic_status_error(
        anthropic.RateLimitError, status=429, retry_after="9999999"
    )
    classified = classify_upstream_error(exc)
    assert classified is not None
    assert classified.retry_hint_seconds == 3600


def test_retry_hint_negative_is_dropped() -> None:
    """A malformed negative ``retry-after`` is treated as absent."""

    exc = _anthropic_status_error(
        anthropic.RateLimitError, status=429, retry_after="-5"
    )
    classified = classify_upstream_error(exc)
    assert classified is not None
    assert classified.retry_hint_seconds is None


def test_retry_hint_non_numeric_is_dropped() -> None:
    """An HTTP-date ``retry-after`` we can't trivially parse is None."""

    exc = _anthropic_status_error(
        anthropic.RateLimitError,
        status=429,
        retry_after="Wed, 21 Oct 2026 07:28:00 GMT",
    )
    classified = classify_upstream_error(exc)
    assert classified is not None
    assert classified.retry_hint_seconds is None


# -------------------------------------------------------------- payload shape


def test_event_payload_locks_wire_keys() -> None:
    """Pin the event payload exactly — frontend ``ws.ts`` ``ServerEvent``
    union asserts on these fields. Adding / renaming a key here is a
    breaking contract change.

    ``message`` is intentionally absent from the wire shape: the
    banner renders category-specific copy, never the raw SDK
    exception string. Surfacing ``str(exc)`` would leak the
    operator's ``LLM_API_BASE`` (e.g. an internal gateway URL) in
    connection-error messages on misconfigured deploys (security
    review, 2026-05-09)."""

    err = UpstreamLLMError(
        category="overloaded",
        status_code=529,
        request_id="req_abc",
        retry_hint_seconds=30,
        message="Overloaded - this raw text must NOT be in the payload",
    )
    payload = err.to_event_payload()
    assert payload == {
        "type": "error",
        "scope": "upstream_llm",
        "category": "overloaded",
        "status_code": 529,
        "request_id": "req_abc",
        "retry_hint_seconds": 30,
    }
    assert "message" not in payload, "raw SDK exception string must not leak"


# -------------------------------------------------------------- broadcast


class _RecordingConnections:
    """Captures ``send_to_role`` and ``broadcast`` calls so tests can
    assert that upstream-error banners are creator-targeted (issue
    #191: "Players don't see the creator's error banner")."""

    def __init__(self) -> None:
        self.role_targeted: list[tuple[str, str, dict[str, Any]]] = []
        self.broadcasted: list[tuple[str, dict[str, Any]]] = []

    async def send_to_role(
        self, session_id: str, role_id: str, event: dict[str, Any]
    ) -> None:
        self.role_targeted.append((session_id, role_id, event))

    async def broadcast(
        self,
        session_id: str,
        event: dict[str, Any],
        *,
        record: bool = True,
    ) -> None:
        self.broadcasted.append((session_id, event))


class _FakeSession:
    def __init__(self, *, session_id: str, creator_role_id: str | None) -> None:
        self.id = session_id
        self.creator_role_id = creator_role_id


@pytest.mark.asyncio
async def test_notify_creator_targets_creator_role_only() -> None:
    """The banner goes to the creator via ``send_to_role`` — players
    never receive it. ``broadcast`` is NOT called."""

    conns = _RecordingConnections()
    session = _FakeSession(session_id="s1", creator_role_id="role_creator")
    err = UpstreamLLMError(
        category="overloaded",
        status_code=529,
        request_id="req_abc",
        retry_hint_seconds=None,
        message="Overloaded",
    )

    await notify_creator_of_upstream_error(
        connections=conns, session=session, err=err
    )

    assert conns.broadcasted == []
    assert len(conns.role_targeted) == 1
    sid, rid, payload = conns.role_targeted[0]
    assert sid == "s1"
    assert rid == "role_creator"
    assert payload["scope"] == "upstream_llm"
    assert payload["category"] == "overloaded"


@pytest.mark.asyncio
async def test_notify_no_creator_role_is_noop() -> None:
    """Pre-creator-role sessions (very early setup) silently no-op
    rather than blowing up. The LLM-client-side WARNING already
    captures the request_id for ops."""

    conns = _RecordingConnections()
    session = _FakeSession(session_id="s1", creator_role_id=None)
    err = UpstreamLLMError(
        category="server_error",
        status_code=500,
        request_id=None,
        retry_hint_seconds=None,
        message="x",
    )

    await notify_creator_of_upstream_error(
        connections=conns, session=session, err=err
    )

    assert conns.role_targeted == []
    assert conns.broadcasted == []


# Future work (issue #191 follow-up): an end-to-end integration test
# that simulates an Anthropic 529 mid-play-turn through the real
# turn-driver and asserts the turn ends ``errored`` with the
# ``upstream_overloaded:`` reason while the creator gets a
# ``send_to_role`` and players get nothing on ``broadcast``. The
# unit-level pieces (classifier, payload shape, notify helper) are
# locked above; the integration weaves them together but takes a
# nontrivial amount of FastAPI/TestClient scaffolding to drive a
# play turn end-to-end. Punted to a follow-up rather than rushing a
# brittle test.
