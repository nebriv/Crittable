"""Tests for the soft ``INVITE_CODES`` gate on ``POST /api/sessions``.

The gate exists so a public-URL deploy (the Crittable.app domain behind
a Cloudflare tunnel) can keep random web traffic from spending LLM
tokens on it without standing up a full auth stack. ``INVITE_CODES`` is
a JSON array of code objects; each may carry an operator ``label`` and
an optional ``expires`` date. When the array is empty / unset the gate
is invisible; when non-empty the creator must supply a code matching one
of the listed, non-expired entries.

These tests assert the parse/match contract, per-code expiry, the four
corners of the create gate, the multi-code path, the label-only logging,
and the ``GET /api/invite/status`` endpoint the frontend uses to decide
whether to render its gate UI.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings, reset_settings_cache
from app.main import create_app
from tests.conftest import default_settings_body
from tests.mock_chat_client import install_mock_chat_client


def _codes_json(*entries: dict[str, object]) -> str:
    return json.dumps(list(entries))


def _date_offset(days: int) -> str:
    return (datetime.now(UTC) + timedelta(days=days)).date().isoformat()


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_MODEL_PLAY", "mock-play")
    monkeypatch.setenv("LLM_MODEL_SETUP", "mock-setup")
    monkeypatch.setenv("LLM_MODEL_AAR", "mock-aar")
    monkeypatch.setenv("LLM_MODEL_GUARDRAIL", "mock-guardrail")
    monkeypatch.setenv("SESSION_SECRET", "x" * 32)
    monkeypatch.setenv("INPUT_GUARDRAIL_ENABLED", "false")
    monkeypatch.delenv("INVITE_CODES", raising=False)
    reset_settings_cache()


def _set_codes(monkeypatch: pytest.MonkeyPatch, codes_json: str | None) -> None:
    if codes_json is None:
        monkeypatch.delenv("INVITE_CODES", raising=False)
    else:
        monkeypatch.setenv("INVITE_CODES", codes_json)
    reset_settings_cache()


def _client(
    monkeypatch: pytest.MonkeyPatch, *, codes_json: str | None
) -> TestClient:
    _set_codes(monkeypatch, codes_json)
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


# ---------------------------------------------------------------- config: parse / required


def test_invite_code_required_false_when_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_codes(monkeypatch, None)
    assert get_settings().invite_code_required() is False


def test_invite_code_required_false_on_empty_array(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_codes(monkeypatch, "[]")
    assert get_settings().invite_code_required() is False


def test_invite_code_required_true_with_codes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_codes(monkeypatch, _codes_json({"code": "tabletop-2026"}))
    assert get_settings().invite_code_required() is True


def test_invite_codes_malformed_json_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_codes(monkeypatch, "{not json")
    with pytest.raises(ValueError, match="not valid JSON"):
        get_settings().invite_codes()


def test_invite_codes_non_array_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_codes(monkeypatch, '{"code": "x"}')  # object, not array
    with pytest.raises(ValueError, match="must be a JSON array"):
        get_settings().invite_codes()


def test_invite_codes_blank_code_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_codes(monkeypatch, _codes_json({"code": "   "}))
    with pytest.raises(ValueError, match="blank"):
        get_settings().invite_codes()


def test_invite_codes_unknown_key_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    # ``extra="forbid"`` — a typo'd key fails loudly instead of silently
    # ungating the entry.
    _set_codes(monkeypatch, _codes_json({"code": "x", "expries": "2026-12-31"}))
    with pytest.raises(ValueError):
        get_settings().invite_codes()


# ---------------------------------------------------------------- config: match / expiry


def test_match_invite_code_basic(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_codes(
        monkeypatch, _codes_json({"code": "tabletop-2026", "label": "Group A"})
    )
    cfg = get_settings()
    assert cfg.match_invite_code("tabletop-2026") is not None
    # Whitespace from a copy-paste is stripped.
    assert cfg.match_invite_code("  tabletop-2026\n") is not None
    assert cfg.match_invite_code("tabletop-2027") is None
    assert cfg.match_invite_code(None) is None
    assert cfg.match_invite_code("") is None


def test_match_invite_code_returns_matched_label(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_codes(
        monkeypatch,
        _codes_json(
            {"code": "acme-7Fq2", "label": "Acme Corp"},
            {"code": "globex-9z", "label": "Globex"},
        ),
    )
    cfg = get_settings()
    a = cfg.match_invite_code("acme-7Fq2")
    g = cfg.match_invite_code("globex-9z")
    assert a is not None and a.label == "Acme Corp"
    assert g is not None and g.label == "Globex"


def test_match_invite_code_future_expiry_accepted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_codes(
        monkeypatch, _codes_json({"code": "valid", "expires": _date_offset(365)})
    )
    assert get_settings().match_invite_code("valid") is not None


def test_match_invite_code_expired_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_codes(
        monkeypatch, _codes_json({"code": "stale", "expires": _date_offset(-1)})
    )
    # Correct value, but expired → no match.
    assert get_settings().match_invite_code("stale") is None


def test_match_invite_code_expiry_inclusive_of_today(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_codes(
        monkeypatch, _codes_json({"code": "lastday", "expires": _date_offset(0)})
    )
    # The code works THROUGH the expiry day (inclusive).
    assert get_settings().match_invite_code("lastday") is not None


# ---------------------------------------------------------------- boot: malformed fails loud


def test_boot_fails_on_malformed_invite_codes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A malformed ``INVITE_CODES`` must fail ``create_app`` loudly — a
    deploy the operator believed was gated must not silently boot
    ungated."""

    monkeypatch.setenv("INVITE_CODES", "{not-an-array")
    reset_settings_cache()
    with pytest.raises(ValueError):
        create_app()


# ---------------------------------------------------------------- endpoint: status


def test_invite_status_not_required_when_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _client(monkeypatch, codes_json=None)
    try:
        r = client.get("/api/invite/status")
        assert r.status_code == 200
        # M7: ``valid`` was removed — the endpoint reports ONLY whether
        # the gate is on, never verifies a candidate.
        assert r.json() == {"required": False}
    finally:
        client.close()


def test_invite_status_required_with_codes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _client(monkeypatch, codes_json=_codes_json({"code": "tabletop-2026"}))
    try:
        r = client.get("/api/invite/status")
        assert r.status_code == 200
        assert r.json() == {"required": True}
    finally:
        client.close()


def test_invite_status_never_reports_valid(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """M7 regression net: the oracle is gone. Even with a ``?code=``
    query (ignored by the handler), the response never carries
    ``valid`` — no online verification of a candidate."""

    client = _client(monkeypatch, codes_json=_codes_json({"code": "tabletop-2026"}))
    try:
        for code in ("tabletop-2026", "wrong"):
            r = client.get("/api/invite/status", params={"code": code})
            assert r.status_code == 200
            assert r.json() == {"required": True}
            assert "valid" not in r.json()
    finally:
        client.close()


# ---------------------------------------------------------------- endpoint: create gate


def test_create_no_gate_works_without_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When ``INVITE_CODES`` is unset, the field is ignored — the creator
    can omit it and the request succeeds. Keeps local dev frictionless."""

    client = _client(monkeypatch, codes_json=None)
    try:
        r = client.post("/api/sessions", json=_create_body(invite_code=None))
        assert r.status_code == 200, r.text
        assert "creator_token" in r.json()
    finally:
        client.close()


def test_create_gated_missing_code_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _client(monkeypatch, codes_json=_codes_json({"code": "tabletop-2026"}))
    try:
        r = client.post("/api/sessions", json=_create_body(invite_code=None))
        assert r.status_code == 403, r.text
        assert "invite" in r.json()["detail"].lower()
    finally:
        client.close()


def test_create_gated_wrong_code_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _client(monkeypatch, codes_json=_codes_json({"code": "tabletop-2026"}))
    try:
        r = client.post("/api/sessions", json=_create_body(invite_code="nope"))
        assert r.status_code == 403, r.text
    finally:
        client.close()


def test_create_gated_correct_code_accepted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _client(monkeypatch, codes_json=_codes_json({"code": "tabletop-2026"}))
    try:
        r = client.post(
            "/api/sessions", json=_create_body(invite_code="tabletop-2026")
        )
        assert r.status_code == 200, r.text
        assert "creator_token" in r.json()
    finally:
        client.close()


def test_create_gated_any_listed_code_accepted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Multi-code: each group's distinct code is accepted independently."""

    client = _client(
        monkeypatch,
        codes_json=_codes_json(
            {"code": "acme-7Fq2", "label": "Acme"},
            {"code": "globex-9z", "label": "Globex"},
        ),
    )
    try:
        for code in ("acme-7Fq2", "globex-9z"):
            r = client.post("/api/sessions", json=_create_body(invite_code=code))
            assert r.status_code == 200, r.text
    finally:
        client.close()


def test_create_gated_expired_code_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _client(
        monkeypatch,
        codes_json=_codes_json({"code": "stale", "expires": _date_offset(-1)}),
    )
    try:
        r = client.post("/api/sessions", json=_create_body(invite_code="stale"))
        assert r.status_code == 403, r.text
    finally:
        client.close()


def test_create_gated_empty_string_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A client that wires the field but sends an empty string must not
    slip past — the gate is a positive check on a matching value."""

    client = _client(monkeypatch, codes_json=_codes_json({"code": "tabletop-2026"}))
    try:
        r = client.post("/api/sessions", json=_create_body(invite_code=""))
        assert r.status_code == 403, r.text
    finally:
        client.close()


# ---------------------------------------------------------------- logging contracts
#
# CLAUDE.md elevates "missing log line at a meaningful boundary" to a
# must-fix even at LOW. These tests lock the WARNING level on rejection
# and assert the code VALUE never reaches the log on either path.


def test_create_invite_rejected_emits_warning(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    client = _client(monkeypatch, codes_json=_codes_json({"code": "tabletop-2026"}))
    try:
        r = client.post("/api/sessions", json=_create_body(invite_code="nope"))
        assert r.status_code == 403
        out = capsys.readouterr().out
        assert "create_session_invite_rejected" in out, out
        # The candidate must never reach the audit log.
        assert "nope" not in out, out
    finally:
        client.close()


def test_create_invite_ok_logs_label_not_value(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A successful gated create logs the operator label so the session
    is attributable to its group — but NEVER the code value itself."""

    client = _client(
        monkeypatch,
        codes_json=_codes_json({"code": "s3cret-code", "label": "Acme Corp"}),
    )
    try:
        capsys.readouterr()  # drain boot noise (incl. the labels boot log)
        r = client.post(
            "/api/sessions", json=_create_body(invite_code="s3cret-code")
        )
        assert r.status_code == 200, r.text
        out = capsys.readouterr().out
        assert "create_session_invite_ok" in out, out
        assert "Acme Corp" in out, out
        # The secret value must never hit the log.
        assert "s3cret-code" not in out, out
    finally:
        client.close()


def test_invite_status_query_is_scrubbed_from_access_log(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The structlog access-log middleware logs the request path. The
    invite-code query value must be redacted there or the operator's
    normal log scan exposes every probed candidate."""

    client = _client(monkeypatch, codes_json=_codes_json({"code": "tabletop-2026"}))
    try:
        r = client.get("/api/invite/status", params={"code": "supersecret"})
        assert r.status_code == 200
        out = capsys.readouterr().out
        # ``code=`` survives, the value is replaced with ``***``.
        assert "code=" in out, out
        assert "supersecret" not in out, out
    finally:
        client.close()


# ---------------------------------------------------------------- config: hardening edges


def test_invite_codes_non_string_code_does_not_leak_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A bare JSON number as ``code`` makes pydantic embed the raw value
    in its error BEFORE SecretStr can mask it — and that string is logged
    at boot. The parser must surface the bad entry by index + error type,
    never the value (security audit PR3 / LOW-1)."""

    _set_codes(monkeypatch, '[{"code": 12345678}]')
    with pytest.raises(ValueError) as ei:
        get_settings().invite_codes()
    msg = str(ei.value)
    assert "12345678" not in msg, msg
    assert "entry #0" in msg, msg


def test_invite_codes_oversize_array_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A fat misconfigured array would re-parse on the create path; it's
    bounded so an oversize value fails loud at boot (security MEDIUM-1)."""

    big = _codes_json(*[{"code": f"c{i}"} for i in range(257)])
    _set_codes(monkeypatch, big)
    with pytest.raises(ValueError, match="maximum is 256"):
        get_settings().invite_codes()


def test_invite_codes_datetime_expires_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``expires`` is a date; a datetime string fails loud at boot rather
    than silently truncating to midnight. Lock the strict behavior so
    nobody relaxes the field to ``datetime`` later (QA review)."""

    _set_codes(
        monkeypatch,
        _codes_json({"code": "x", "expires": "2026-12-31T23:59:59"}),
    )
    with pytest.raises(ValueError):
        get_settings().invite_codes()


def test_match_invite_code_strips_configured_whitespace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The configured code value is stripped too, so a stray space in the
    .env entry doesn't lock out a correctly-typed candidate (QA review)."""

    _set_codes(monkeypatch, _codes_json({"code": "  spacey  "}))
    assert get_settings().match_invite_code("spacey") is not None


def test_match_invite_code_duplicate_last_wins(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two entries share a code value; the non-short-circuit match loop
    keeps the LAST match, so the last entry's metadata wins. Pin it so a
    loop refactor can't silently flip precedence (QA review)."""

    _set_codes(
        monkeypatch,
        _codes_json(
            {"code": "dup", "label": "First"},
            {"code": "dup", "label": "Second"},
        ),
    )
    m = get_settings().match_invite_code("dup")
    assert m is not None and m.label == "Second"


def test_create_invite_ok_unlabeled_logs_placeholder(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A successful create against a code with NO label logs the
    ``(unlabeled)`` placeholder — the label-None branch of
    create_session_invite_ok (QA review)."""

    client = _client(monkeypatch, codes_json=_codes_json({"code": "nolabel"}))
    try:
        capsys.readouterr()  # drain boot noise
        r = client.post("/api/sessions", json=_create_body(invite_code="nolabel"))
        assert r.status_code == 200, r.text
        out = capsys.readouterr().out
        assert "create_session_invite_ok" in out, out
        assert "(unlabeled)" in out, out
        assert "nolabel" not in out, out  # code value never logged
    finally:
        client.close()
