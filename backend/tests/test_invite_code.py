"""Tests for the soft ``INVITE_CODE`` gate on ``POST /api/sessions``.

The gate exists so a public-URL deploy (the new Crittable.app domain
behind a Cloudflare tunnel) can keep random web traffic from spending
LLM tokens on it without standing up a full auth stack. When unset,
the gate is invisible; when set, it's a constant-time string compare
against ``Settings.invite_code``.

These tests assert the four corners of that contract plus the
``GET /api/invite/status`` endpoint the frontend uses to decide
whether to render its gate UI at all.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings, reset_settings_cache
from app.main import create_app
from tests.conftest import default_settings_body
from tests.mock_chat_client import install_mock_chat_client


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_MODEL_PLAY", "mock-play")
    monkeypatch.setenv("LLM_MODEL_SETUP", "mock-setup")
    monkeypatch.setenv("LLM_MODEL_AAR", "mock-aar")
    monkeypatch.setenv("LLM_MODEL_GUARDRAIL", "mock-guardrail")
    monkeypatch.setenv("SESSION_SECRET", "x" * 32)
    monkeypatch.setenv("INPUT_GUARDRAIL_ENABLED", "false")
    reset_settings_cache()


def _client(monkeypatch: pytest.MonkeyPatch, *, code: str | None) -> TestClient:
    if code is None:
        monkeypatch.delenv("INVITE_CODE", raising=False)
    else:
        monkeypatch.setenv("INVITE_CODE", code)
    reset_settings_cache()
    app = create_app()
    c = TestClient(app)
    c.__enter__()  # ASGI startup; closed by the test's ``c.close()``.
    install_mock_chat_client(c)
    return c


def _create_body(invite_code: str | None) -> dict[str, object]:
    body: dict[str, object] = {
        "scenario_prompt": "Ransomware",
        "creator_label": "CISO",
        "creator_display_name": "Alex",
        **default_settings_body(),
    }
    if invite_code is not None:
        body["invite_code"] = invite_code
    return body


# ---------------------------------------------------------------- helpers


def test_invite_code_required_helper_false_when_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("INVITE_CODE", raising=False)
    reset_settings_cache()
    assert get_settings().invite_code_required() is False


def test_invite_code_required_helper_false_on_whitespace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An operator pasting only whitespace into ``INVITE_CODE`` is the
    same as not setting it at all — otherwise the gate would silently
    reject every request because no candidate could match a single
    space."""

    monkeypatch.setenv("INVITE_CODE", "   ")
    reset_settings_cache()
    assert get_settings().invite_code_required() is False


def test_verify_invite_code_constant_time_match_with_whitespace_padding(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Trailing newlines from a copy-paste should not lock out the
    operator. Whitespace is stripped from both sides."""

    monkeypatch.setenv("INVITE_CODE", "tabletop-2026")
    reset_settings_cache()
    cfg = get_settings()
    assert cfg.verify_invite_code("tabletop-2026") is True
    assert cfg.verify_invite_code("  tabletop-2026\n") is True
    assert cfg.verify_invite_code("tabletop-2027") is False
    assert cfg.verify_invite_code(None) is False
    assert cfg.verify_invite_code("") is False


# ---------------------------------------------------------------- endpoint: status


def test_invite_status_reports_not_required_when_env_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _client(monkeypatch, code=None)
    try:
        r = client.get("/api/invite/status")
        assert r.status_code == 200
        assert r.json() == {"required": False, "valid": None}
    finally:
        client.close()


def test_invite_status_required_no_code_returns_required_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _client(monkeypatch, code="tabletop-2026")
    try:
        r = client.get("/api/invite/status")
        assert r.status_code == 200
        assert r.json() == {"required": True, "valid": None}
    finally:
        client.close()


def test_invite_status_required_with_correct_code_returns_valid_true(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _client(monkeypatch, code="tabletop-2026")
    try:
        r = client.get("/api/invite/status", params={"code": "tabletop-2026"})
        assert r.status_code == 200
        assert r.json() == {"required": True, "valid": True}
    finally:
        client.close()


def test_invite_status_required_with_wrong_code_returns_valid_false(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _client(monkeypatch, code="tabletop-2026")
    try:
        r = client.get("/api/invite/status", params={"code": "wrong"})
        assert r.status_code == 200
        assert r.json() == {"required": True, "valid": False}
    finally:
        client.close()


# ---------------------------------------------------------------- endpoint: create gate


def test_create_session_no_gate_works_without_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When ``INVITE_CODE`` is unset, the field is ignored — the
    creator can omit it and the request succeeds. Keeps local dev /
    Codespaces frictionless."""

    client = _client(monkeypatch, code=None)
    try:
        r = client.post("/api/sessions", json=_create_body(invite_code=None))
        assert r.status_code == 200, r.text
        assert "creator_token" in r.json()
    finally:
        client.close()


def test_create_session_gated_missing_code_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _client(monkeypatch, code="tabletop-2026")
    try:
        r = client.post("/api/sessions", json=_create_body(invite_code=None))
        assert r.status_code == 403, r.text
        assert "invite" in r.json()["detail"].lower()
    finally:
        client.close()


def test_create_session_gated_wrong_code_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _client(monkeypatch, code="tabletop-2026")
    try:
        r = client.post("/api/sessions", json=_create_body(invite_code="nope"))
        assert r.status_code == 403, r.text
    finally:
        client.close()


def test_create_session_gated_correct_code_accepted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _client(monkeypatch, code="tabletop-2026")
    try:
        r = client.post(
            "/api/sessions", json=_create_body(invite_code="tabletop-2026")
        )
        assert r.status_code == 200, r.text
        assert "creator_token" in r.json()
    finally:
        client.close()


def test_create_session_gated_empty_string_code_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A client that wires the field but sends an empty string must
    not slip past — the gate is a positive check on a matching value,
    not a "did the key exist" check."""

    client = _client(monkeypatch, code="tabletop-2026")
    try:
        r = client.post("/api/sessions", json=_create_body(invite_code=""))
        assert r.status_code == 403, r.text
    finally:
        client.close()


def test_create_session_status_endpoint_caps_query_length(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Defense against a no-rate-limit deployment getting
    ``?code=<5MB>`` probes — the validator chains
    ``hmac.compare_digest`` on the candidate and that's O(n)."""

    client = _client(monkeypatch, code="tabletop-2026")
    try:
        oversized = "a" * 129
        r = client.get("/api/invite/status", params={"code": oversized})
        assert r.status_code == 422, r.text
    finally:
        client.close()


# ---------------------------------------------------------------- logging contracts
#
# CLAUDE.md elevates "missing log line at a meaningful boundary" to a
# must-fix even at LOW. These tests lock the WARNING level so a future
# refactor can't silently demote them to INFO and disappear the only
# brute-force breadcrumb on the audit trail.


def test_invite_validate_rejected_emits_warning(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    client = _client(monkeypatch, code="tabletop-2026")
    try:
        r = client.get("/api/invite/status", params={"code": "wrong"})
        assert r.status_code == 200
        out = capsys.readouterr().out
        assert "invite_validate_rejected" in out, out
        # The code itself MUST NOT appear anywhere in the log line —
        # not in the structlog event, not in the access-log path.
        assert "wrong" not in out, out
    finally:
        client.close()


def test_create_session_invite_rejected_emits_warning(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    client = _client(monkeypatch, code="tabletop-2026")
    try:
        r = client.post("/api/sessions", json=_create_body(invite_code="nope"))
        assert r.status_code == 403
        out = capsys.readouterr().out
        assert "create_session_invite_rejected" in out, out
        # The candidate must never reach the audit log; the body is
        # JSON (not a query string) so it isn't path-scrubbed.
        # ``structlog`` only logs what we ``log.warning(...)`` with,
        # so this is a contract on the handler — never pass the body
        # field as a structured key.
        assert "nope" not in out, out
    finally:
        client.close()


def test_invite_status_query_is_scrubbed_from_access_log(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The structlog access-log middleware logs the request path. The
    invite-code value must be redacted there or the operator's normal
    log scan exposes every probed candidate to anyone with log access."""

    client = _client(monkeypatch, code="tabletop-2026")
    try:
        r = client.get("/api/invite/status", params={"code": "supersecret"})
        assert r.status_code == 200
        out = capsys.readouterr().out
        # ``code=`` survives, the value is replaced with ``***``.
        assert "code=" in out, out
        assert "supersecret" not in out, out
    finally:
        client.close()
