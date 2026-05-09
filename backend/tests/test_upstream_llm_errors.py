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


def test_sanitized_summary_excludes_raw_message() -> None:
    """``sanitized_summary`` is what ``turn.error_reason`` and
    ``session.aar_error`` are persisted as — both leak via
    ``/activity`` / ``/export.md`` / ``SessionActivityPanel`` to the
    creator UI. It MUST NOT carry the raw SDK exception string,
    same security rationale as the WS payload (Copilot review on
    PR #219). Format: ``upstream_<category> (status=N req=R)``."""

    err = UpstreamLLMError(
        category="overloaded",
        status_code=529,
        request_id="req_xyz",
        retry_hint_seconds=None,
        message="Connection error: HTTPSConnectionPool(host='internal-gw.corp', port=443)",
    )
    summary = err.sanitized_summary()
    assert summary == "upstream_overloaded (status=529 req=req_xyz)"
    # Defense-in-depth: the precise hostname format above is the
    # canonical leak vector. Spot-check that nothing remotely
    # exception-shaped survives the sanitization.
    assert "internal-gw" not in summary
    assert "HTTPSConnectionPool" not in summary


def test_sanitized_summary_drops_optional_fields_cleanly() -> None:
    """A timeout error (no status_code, no request_id) collapses to
    just the category — no empty parens, no trailing whitespace."""

    err = UpstreamLLMError(
        category="timeout",
        status_code=None,
        request_id=None,
        retry_hint_seconds=None,
        message="Connection error.",
    )
    assert err.sanitized_summary() == "upstream_timeout"


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


# -------------------------------------------------------------- integration


def test_play_turn_529_marks_errored_and_targets_creator_only() -> None:
    """End-to-end: an Anthropic 529 mid-play-turn must produce
    (a) ``turn.status == "errored"`` with a ``upstream_overloaded:``
    reason, (b) a creator-targeted ``send_to_role`` carrying the
    structured banner event, and (c) NO ``broadcast`` of the banner
    so players don't see it.

    Pins the wiring contract that the unit tests above can't reach
    on their own — the unit tests prove each piece works in
    isolation; this test proves they're plugged in to each other
    inside ``turn_driver.run_play_turn``. Without this, swapping
    ``notify_creator_of_upstream_error`` for ``connections.broadcast``
    in a future refactor would pass every unit test while leaking
    the banner to every player (the explicit anti-requirement on
    issue #191: "Players don't see the creator's error banner").

    The test drives the BRIEFING turn (turn 0 fired at ``/start``)
    with the erroring transport pre-installed — that's the cleanest
    entry point because ``setup/skip`` synthesises a plan without an
    LLM call, so the only LLM call is the one we're testing.
    """

    from collections.abc import AsyncIterator

    from fastapi.testclient import TestClient

    from app.config import ModelTier, reset_settings_cache
    from app.llm.errors import UpstreamLLMError
    from app.llm.protocol import LLMResult
    from app.main import create_app
    from app.sessions.models import SessionState
    from tests.conftest import default_settings_body
    from tests.mock_chat_client import MockChatClient, install_mock_chat_client

    reset_settings_cache()
    app = create_app()
    with TestClient(app) as client:
        # Baseline mock so the server boots.
        install_mock_chat_client(client)

        # Seat creator + one player.
        resp = client.post(
            "/api/sessions",
            json={
                "scenario_prompt": "Ransomware via vendor portal",
                "creator_label": "CISO",
                "creator_display_name": "Alex",
                **default_settings_body(),
            },
        )
        assert resp.status_code == 200, resp.text
        created = resp.json()
        sid = created["session_id"]
        creator_token = created["creator_token"]
        creator_role_id = created["creator_role_id"]
        r = client.post(
            f"/api/sessions/{sid}/roles?token={creator_token}",
            json={"label": "Player_1", "display_name": "P1"},
        )
        assert r.status_code == 200, r.text

        # Skip setup (no LLM call) → READY.
        client.post(f"/api/sessions/{sid}/setup/skip?token={creator_token}")

        # Wrap connections to observe role-targeted vs. broadcast
        # event flow. Pattern lifted from
        # ``tests/test_turn_driver.py::_RecordingConnections`` — a
        # transparent proxy that records each call before delegating
        # to the real connection manager so the rest of the system
        # behaves identically.
        real_connections = client.app.state.connections
        rec_role_targeted: list[tuple[str, str, dict[str, Any]]] = []
        rec_broadcasted: list[dict[str, Any]] = []

        class _Observing:
            async def broadcast(
                self,
                session_id: str,
                event: dict[str, Any],
                *,
                record: bool = True,
            ) -> None:
                rec_broadcasted.append(event)
                await real_connections.broadcast(
                    session_id, event, record=record
                )

            async def send_to_role(
                self, session_id: str, role_id: str, event: dict[str, Any]
            ) -> None:
                rec_role_targeted.append((session_id, role_id, event))
                await real_connections.send_to_role(
                    session_id, role_id, event
                )

            def __getattr__(self, name: str) -> Any:
                return getattr(real_connections, name)

        observer = _Observing()
        client.app.state.connections = observer
        client.app.state.manager._connections = observer
        client.app.state.llm.set_connections(observer)

        # Swap in a ChatClient whose play-tier ``astream`` raises the
        # same ``UpstreamLLMError`` that ``LiteLLMChatClient.astream``
        # synthesises from a 529 ``InternalServerError`` via
        # ``classify_upstream_error``. By raising the classified
        # exception directly we exercise the turn-driver's catch +
        # ``notify_creator_of_upstream_error`` path without having to
        # mock the whole LiteLLM streaming surface. The classifier
        # itself is unit-tested separately
        # (``test_upstream_llm_errors.py::test_classify_*``); this
        # integration test owns the wiring contract.
        class _OverloadedMockChat(MockChatClient):
            async def astream(
                self,
                *,
                tier: ModelTier,
                system_blocks: list[dict[str, Any]],
                messages: list[dict[str, Any]],
                tools: list[dict[str, Any]] | None = None,
                max_tokens: int | None = None,
                session_id: str | None = None,
                tool_choice: dict[str, Any] | None = None,
                extension_tool_names: frozenset[str] | None = None,
            ) -> AsyncIterator[dict[str, Any]]:
                raise UpstreamLLMError(
                    category="overloaded",
                    status_code=529,
                    request_id="req_int_test_529",
                    retry_hint_seconds=None,
                    message="Overloaded",
                )
                # Unreachable but required for ``AsyncIterator`` type.
                if False:  # pragma: no cover
                    yield {"type": "complete"}

            async def acomplete(self, **kwargs: Any) -> LLMResult:
                raise UpstreamLLMError(
                    category="overloaded",
                    status_code=529,
                    request_id="req_int_test_529",
                    retry_hint_seconds=None,
                    message="Overloaded",
                )

        erroring = _OverloadedMockChat()
        erroring.set_connections(observer)
        client.app.state.llm = erroring
        client.app.state.manager._llm = erroring

        # Fire the BRIEFING turn. The route awaits ``run_play_turn``
        # synchronously, so by the time the response lands the
        # turn-driver's exception path has already run.
        start_resp = client.post(
            f"/api/sessions/{sid}/start?token={creator_token}"
        )
        # 200 is correct: the turn errored gracefully; the banner is
        # the operator-visible signal, not the HTTP status. The route
        # handler doesn't (and shouldn't) propagate an upstream blip
        # as a 5xx — that'd hide the new structured signal behind a
        # generic gateway-style error toast.
        assert start_resp.status_code == 200, start_resp.text

    # -------- assertion 1: turn flipped to "errored" with the
    # upstream-prefixed reason. Read straight from the in-memory
    # repo, not via REST, so we see the field as the driver wrote
    # it before any serialiser round-trips it.
    import asyncio

    manager = client.app.state.manager

    async def _read_turn_status() -> tuple[str, str | None]:
        session = await manager._repo.get(sid)
        # Snapshot just turn 0 — the BRIEFING turn the test drove.
        turn = next((t for t in session.turns if t.index == 0), None)
        assert turn is not None, "expected the BRIEFING turn (index 0)"
        return turn.status, turn.error_reason

    status_, reason = asyncio.run(_read_turn_status())
    assert status_ == "errored", (
        f"expected turn.status='errored' on upstream blip; got {status_!r}"
    )
    # Sanitized format: ``upstream_<category> (status=N req=...)``.
    # Critically must NOT contain the raw SDK message — it leaks via
    # /activity and SessionActivityPanel (Copilot review on PR #219).
    assert reason is not None and reason.startswith("upstream_overloaded"), (
        f"expected upstream_overloaded prefix; got {reason!r}"
    )
    assert "Overloaded" not in reason, (
        f"raw SDK exception text leaked into turn.error_reason: {reason!r}"
    )
    assert "req=req_int_test_529" in reason, (
        f"expected request_id in sanitized reason; got {reason!r}"
    )

    # -------- assertion 2: the creator got the structured banner
    # event via send_to_role.
    creator_payloads = [
        evt
        for _sid, rid, evt in rec_role_targeted
        if rid == creator_role_id
        and evt.get("type") == "error"
        and evt.get("scope") == "upstream_llm"
    ]
    assert len(creator_payloads) == 1, (
        f"expected exactly one creator-targeted upstream_llm event; "
        f"saw {len(creator_payloads)}: {rec_role_targeted!r}"
    )
    payload = creator_payloads[0]
    assert payload["category"] == "overloaded"
    assert payload["status_code"] == 529
    assert payload["request_id"] == "req_int_test_529"
    # Wire-shape lock: ``message`` MUST NOT be in the payload (the
    # raw SDK string can leak ``LLM_API_BASE`` URLs on misconfigured
    # deploys; banner copy is category-derived).
    assert "message" not in payload, (
        f"raw SDK message leaked to wire payload: {payload!r}"
    )

    # -------- assertion 3: NO broadcast carried the upstream banner.
    # This is the user's explicit anti-requirement on issue #191
    # ("regular players don't need to see it"). A future refactor
    # that swaps ``send_to_role`` for ``broadcast`` here would fail
    # this assertion specifically.
    upstream_in_broadcast = [
        e
        for e in rec_broadcasted
        if e.get("type") == "error" and e.get("scope") == "upstream_llm"
    ]
    assert upstream_in_broadcast == [], (
        f"upstream_llm event leaked to broadcast (visible to players): "
        f"{upstream_in_broadcast!r}"
    )

    # -------- assertion 4: the session state is consistent with an
    # errored turn — neither wedged in AI_PROCESSING (the prior
    # bug pattern) nor accidentally completed. The exact state may
    # be ``BRIEFING`` (the turn errored before yielding so we never
    # transitioned out) or ``AWAITING_PLAYERS`` if a future
    # refactor opens the door for "errored turn → wait for player
    # nudge". Either is acceptable; ``AI_PROCESSING`` is not.

    async def _read_state() -> SessionState:
        session = await manager._repo.get(sid)
        return session.state

    final_state = asyncio.run(_read_state())
    assert final_state != SessionState.AI_PROCESSING, (
        f"session wedged in AI_PROCESSING after upstream blip; "
        f"got {final_state!r}"
    )
