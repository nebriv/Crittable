from __future__ import annotations

import warnings

from app.config import Settings


def test_defaults_match_docs(monkeypatch) -> None:
    for key in (
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_MODEL",
        "SESSION_SECRET",
        "CORS_ORIGINS",
    ):
        monkeypatch.delenv(key, raising=False)
    s = Settings()
    assert s.max_sessions == 10
    assert s.max_roles_per_session == 24
    assert s.max_turns_per_session == 40
    assert s.ai_turn_soft_warn_pct == 80
    assert s.input_guardrail_enabled is True
    assert s.cors_origins == "*"
    assert s.cors_origin_list() == "*"


def test_model_tier_resolution(monkeypatch) -> None:
    monkeypatch.setenv("ANTHROPIC_MODEL_PLAY", "play-explicit")
    monkeypatch.setenv("ANTHROPIC_MODEL", "fallback-everything")
    s = Settings()
    assert s.model_for("play") == "play-explicit"
    assert s.model_for("setup") == "fallback-everything"
    assert s.model_for("aar") == "fallback-everything"
    assert s.model_for("guardrail") == "fallback-everything"


def test_model_tier_default(monkeypatch) -> None:
    for key in (
        "ANTHROPIC_MODEL",
        "ANTHROPIC_MODEL_PLAY",
        "ANTHROPIC_MODEL_SETUP",
        "ANTHROPIC_MODEL_AAR",
        "ANTHROPIC_MODEL_GUARDRAIL",
    ):
        monkeypatch.delenv(key, raising=False)
    s = Settings()
    assert s.model_for("play") == "claude-sonnet-4-6"
    assert s.model_for("aar") == "claude-opus-4-7"
    assert s.model_for("guardrail") == "claude-haiku-4-5"


def test_cors_origin_list(monkeypatch) -> None:
    monkeypatch.setenv("CORS_ORIGINS", "https://a.example, https://b.example")
    s = Settings()
    assert s.cors_origin_list() == ["https://a.example", "https://b.example"]


def test_session_secret_warning_when_unset(monkeypatch) -> None:
    monkeypatch.delenv("SESSION_SECRET", raising=False)
    s = Settings()
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        secret = s.resolve_session_secret()
    assert len(secret) >= 32
    assert any("SESSION_SECRET unset" in str(w.message) for w in caught)


def test_require_anthropic_key_test_mode(monkeypatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("TEST_MODE", "true")
    s = Settings()
    assert s.require_anthropic_key() == "test-mode-no-key"


def test_require_anthropic_key_strict(monkeypatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("TEST_MODE", "false")
    s = Settings()
    import pytest

    with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY"):
        s.require_anthropic_key()
