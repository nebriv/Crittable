"""Security audit PR 2 — HTTP-edge / front-door hardening.

Covers:

* C1 — dedicated per-IP throttle on ``POST /api/sessions`` (429 +
  Retry-After past the cap, independent of ``RATE_LIMIT_ENABLED``).
* M2 — session capacity maps to 503 + Retry-After, and ending a
  session frees a slot immediately.
* M5 — security-headers middleware present on normal responses and on
  ``/healthz``.
* M11 — curated client errors: representative error responses carry a
  curated message, not the raw exception string, and the raw detail
  still reaches the structlog line.

The C1 boot gate (also part of this PR) is exercised in
``test_app_boot_gate.py``.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import reset_settings_cache
from app.main import create_app
from app.security_headers import DEFAULT_CSP
from tests.conftest import default_settings_body
from tests.mock_chat_client import install_mock_chat_client


def _create_body() -> dict[str, Any]:
    return {
        "scenario_prompt": "Ransomware tabletop",
        "creator_label": "CISO",
        "creator_display_name": "Alex",
        "skip_setup": True,
        **default_settings_body(),
    }


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INPUT_GUARDRAIL_ENABLED", "false")
    reset_settings_cache()


# ---------------------------------------------------------------- C1: create limit


def test_create_session_rate_limited_after_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Past ``SESSION_CREATE_RATE_PER_MIN`` from one IP, creation 429s
    with a Retry-After header — even though RATE_LIMIT_ENABLED is off
    (creation is always throttled)."""

    monkeypatch.setenv("SESSION_CREATE_RATE_PER_MIN", "2")
    monkeypatch.delenv("RATE_LIMIT_ENABLED", raising=False)
    reset_settings_cache()
    app = create_app()
    with TestClient(app) as client:
        install_mock_chat_client(client)
        codes = [client.post("/api/sessions", json=_create_body()).status_code for _ in range(3)]
        assert codes[:2] == [200, 200], codes
        assert codes[2] == 429, codes
        # The 429 carries Retry-After so the client backs off.
        last = client.post("/api/sessions", json=_create_body())
        assert last.status_code == 429
        assert last.headers.get("Retry-After") == "60"
        assert "rate limit" in last.json()["detail"].lower()


def test_create_session_limit_disabled_when_zero(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``SESSION_CREATE_RATE_PER_MIN=0`` disables the dedicated limiter
    (the boot gate still demands a front door on real deploys, but a
    local CORS=* deploy can opt out)."""

    monkeypatch.setenv("SESSION_CREATE_RATE_PER_MIN", "0")
    reset_settings_cache()
    app = create_app()
    with TestClient(app) as client:
        install_mock_chat_client(client)
        codes = [client.post("/api/sessions", json=_create_body()).status_code for _ in range(6)]
        assert codes == [200] * 6, codes


def test_create_limit_does_not_block_other_routes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The create limiter is scoped to POST /api/sessions only — a
    drained create bucket must not 429 unrelated reads."""

    monkeypatch.setenv("SESSION_CREATE_RATE_PER_MIN", "1")
    reset_settings_cache()
    app = create_app()
    with TestClient(app) as client:
        install_mock_chat_client(client)
        assert client.post("/api/sessions", json=_create_body()).status_code == 200
        # Second create is throttled...
        assert client.post("/api/sessions", json=_create_body()).status_code == 429
        # ...but the health probe and invite-status are unaffected.
        assert client.get("/healthz").status_code == 200
        assert client.get("/api/invite/status").status_code == 200


# ---------------------------------------------------------------- M2: capacity 503


def _end_session(client: TestClient, sid: str, token: str) -> int:
    return client.post(
        f"/api/sessions/{sid}/end?token={token}",
        json={"reason": "done"},
    ).status_code


def test_capacity_returns_503_with_retry_after(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """M2: a full repository maps to 503 + Retry-After (server full),
    not 400 (bad request). The frontend renders its at-capacity card
    off the 503."""

    monkeypatch.setenv("MAX_SESSIONS", "1")
    # Don't let the create-rate limiter mask the capacity path.
    monkeypatch.setenv("SESSION_CREATE_RATE_PER_MIN", "0")
    reset_settings_cache()
    app = create_app()
    with TestClient(app) as client:
        install_mock_chat_client(client)
        first = client.post("/api/sessions", json=_create_body())
        assert first.status_code == 200, first.text
        # Second create — repo is full (1 LIVE session).
        second = client.post("/api/sessions", json=_create_body())
        assert second.status_code == 503, second.text
        assert second.headers.get("Retry-After") == "30"
        assert "capacity" in second.json()["detail"].lower()


def test_ending_a_session_frees_a_slot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """M2: ENDED sessions no longer count toward MAX_SESSIONS — ending
    one immediately frees capacity for a new create (the tombstone
    lingers for GC but doesn't hold a slot)."""

    monkeypatch.setenv("MAX_SESSIONS", "1")
    monkeypatch.setenv("SESSION_CREATE_RATE_PER_MIN", "0")
    reset_settings_cache()
    app = create_app()
    with TestClient(app) as client:
        install_mock_chat_client(client)
        first = client.post("/api/sessions", json=_create_body()).json()
        sid, token = first["session_id"], first["creator_token"]
        # Full → 503.
        assert client.post("/api/sessions", json=_create_body()).status_code == 503
        # End the first session.
        assert _end_session(client, sid, token) == 200
        # Slot is free again.
        retry = client.post("/api/sessions", json=_create_body())
        assert retry.status_code == 200, retry.text


# ---------------------------------------------------------------- M5: security headers


def _assert_security_headers(headers: Any) -> None:
    assert headers["referrer-policy"] == "no-referrer"
    assert headers["x-content-type-options"] == "nosniff"
    assert headers["x-frame-options"] == "DENY"
    assert headers["content-security-policy"] == DEFAULT_CSP


def test_security_headers_on_normal_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reset_settings_cache()
    app = create_app()
    with TestClient(app) as client:
        install_mock_chat_client(client)
        r = client.get("/api/invite/status")
        assert r.status_code == 200
        _assert_security_headers(r.headers)


def test_security_headers_on_healthz(monkeypatch: pytest.MonkeyPatch) -> None:
    reset_settings_cache()
    app = create_app()
    with TestClient(app) as client:
        r = client.get("/healthz")
        assert r.status_code == 200
        _assert_security_headers(r.headers)


def test_security_headers_on_error_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Headers ride EVERY response, including 4xx — a token-less
    snapshot fetch 401s but must still carry no-referrer etc."""

    reset_settings_cache()
    app = create_app()
    with TestClient(app) as client:
        r = client.get("/api/sessions/nope")
        assert r.status_code == 401
        _assert_security_headers(r.headers)


def test_csp_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CONTENT_SECURITY_POLICY", "default-src 'none'")
    reset_settings_cache()
    app = create_app()
    with TestClient(app) as client:
        r = client.get("/healthz")
        assert r.headers["content-security-policy"] == "default-src 'none'"


# ---------------------------------------------------------------- M11: curated errors


def test_unauthorized_snapshot_returns_curated_detail(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A bad token yields the curated 'invalid or expired token'
    message, not the raw verifier internals."""

    reset_settings_cache()
    app = create_app()
    with TestClient(app) as client:
        install_mock_chat_client(client)
        created = client.post("/api/sessions", json=_create_body()).json()
        sid = created["session_id"]
        r = client.get(f"/api/sessions/{sid}?token=garbage.token.value")
        assert r.status_code == 401
        assert r.json()["detail"] == "invalid or expired token"


def test_curated_detail_logs_raw_exception(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The curated client message hides the detail, but the raw
    ``str(exc)`` must still hit the structlog line so operators can
    debug from the log."""

    reset_settings_cache()
    app = create_app()
    with TestClient(app) as client:
        install_mock_chat_client(client)
        created = client.post("/api/sessions", json=_create_body()).json()
        sid = created["session_id"]
        capsys.readouterr()  # drain create noise
        r = client.get(f"/api/sessions/{sid}?token=garbage.token.value")
        assert r.status_code == 401
        out = capsys.readouterr().out
        # The boundary log fires with the raw verifier detail.
        assert "token_verify_failed" in out, out
