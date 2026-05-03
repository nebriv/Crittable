from __future__ import annotations

import warnings

import pytest

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
    # Setup defaults to Sonnet (same as play) — Haiku occasionally
    # falls back to legacy XML tool-call markup which the dispatcher
    # hard-rejects, so we use a model that doesn't have that quirk.
    assert s.model_for("setup") == "claude-sonnet-4-6"
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


# --------------------------- per-tier sampling knobs -----------------------


def test_max_tokens_for_uses_tier_defaults(monkeypatch) -> None:
    """Without env overrides ``max_tokens_for`` returns the per-tier
    constants in ``_MAX_TOKENS_DEFAULTS``. Lock the contract so a
    refactor doesn't silently shrink the AAR budget."""

    for key in (
        "LLM_MAX_TOKENS_PLAY",
        "LLM_MAX_TOKENS_SETUP",
        "LLM_MAX_TOKENS_AAR",
        "LLM_MAX_TOKENS_GUARDRAIL",
    ):
        monkeypatch.delenv(key, raising=False)
    s = Settings()
    assert s.max_tokens_for("play") == 1024
    # Setup tier needs comfortable headroom: tight budgets cause Haiku
    # to truncate the plan body and fall back to legacy XML tool-call
    # format mid-output, which the dispatcher then hard-rejects (see
    # ``backend/app/llm/dispatch.py::_reject_if_xml_emission``). The
    # 12288 default is sized so a full JSON plan fits in one call.
    assert s.max_tokens_for("setup") == 12288
    assert s.max_tokens_for("aar") == 4096
    assert s.max_tokens_for("guardrail") == 12


def test_max_tokens_env_override_wins(monkeypatch) -> None:
    monkeypatch.setenv("LLM_MAX_TOKENS_PLAY", "2048")
    monkeypatch.setenv("LLM_MAX_TOKENS_GUARDRAIL", "16")
    s = Settings()
    assert s.max_tokens_for("play") == 2048
    assert s.max_tokens_for("guardrail") == 16
    # Untouched tiers keep their defaults.
    assert s.max_tokens_for("setup") == 12288
    assert s.max_tokens_for("aar") == 4096


def test_temperature_for_uses_tier_defaults(monkeypatch) -> None:
    for key in (
        "LLM_TEMPERATURE_PLAY",
        "LLM_TEMPERATURE_SETUP",
        "LLM_TEMPERATURE_AAR",
        "LLM_TEMPERATURE_GUARDRAIL",
    ):
        monkeypatch.delenv(key, raising=False)
    s = Settings()
    # ``play`` and ``setup`` keep the SDK default (return ``None``); ``aar``
    # and ``guardrail`` have explicit defaults so the AAR is faithful and
    # the classifier deterministic.
    assert s.temperature_for("play") is None
    assert s.temperature_for("setup") is None
    assert s.temperature_for("aar") == 0.4
    assert s.temperature_for("guardrail") == 0.0


def test_temperature_env_override_wins(monkeypatch) -> None:
    monkeypatch.setenv("LLM_TEMPERATURE_PLAY", "0.7")
    monkeypatch.setenv("LLM_TEMPERATURE_AAR", "0.0")
    s = Settings()
    assert s.temperature_for("play") == 0.7
    assert s.temperature_for("aar") == 0.0


def test_top_p_only_returned_when_explicitly_set(monkeypatch) -> None:
    for key in (
        "LLM_TOP_P_PLAY",
        "LLM_TOP_P_SETUP",
        "LLM_TOP_P_AAR",
        "LLM_TOP_P_GUARDRAIL",
    ):
        monkeypatch.delenv(key, raising=False)
    s = Settings()
    for tier in ("play", "setup", "aar", "guardrail"):
        assert s.top_p_for(tier) is None  # type: ignore[arg-type]
    monkeypatch.setenv("LLM_TOP_P_PLAY", "0.9")
    s2 = Settings()
    assert s2.top_p_for("play") == 0.9
    assert s2.top_p_for("setup") is None


def test_anthropic_base_url_default_is_unset(monkeypatch) -> None:
    monkeypatch.delenv("ANTHROPIC_BASE_URL", raising=False)
    s = Settings()
    assert s.anthropic_base_url is None


def test_anthropic_base_url_can_be_overridden(monkeypatch) -> None:
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://litellm:4000")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("TEST_MODE", "false")
    s = Settings()
    assert s.anthropic_base_url == "http://litellm:4000"
    # Anthropic key is still required (the override doesn't bypass it).
    import pytest

    with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY"):
        s.require_anthropic_key()


# --------------------------- access-log scrubber ---------------------------


def test_scrub_path_strips_token_query() -> None:
    """Token query fragments must be redacted before logging. Pre-fix the
    middleware logged ``?token=eyJ…`` verbatim, exposing creator + player
    bearer credentials in the JSON pipeline."""

    from app.logging_setup import _scrub_path_bytes

    assert _scrub_path_bytes(b"/api/x?token=secret") == "/api/x?token=***"
    assert _scrub_path_bytes(b"/api/x?foo=1&token=secret&bar=2") == (
        "/api/x?foo=1&token=***&bar=2"
    )
    # Case insensitivity.
    assert _scrub_path_bytes(b"/api/x?Token=SECRET") == "/api/x?Token=***"
    # Doesn't over-match unrelated query keys.
    assert _scrub_path_bytes(b"/api/x?access_token=foo") == "/api/x?access_token=foo"


def test_scrub_path_strips_path_token() -> None:
    """``/play/<sid>/<token>`` is the join-link shape; the token segment
    must be redacted but the session id preserved (it's already public)."""

    from app.logging_setup import _scrub_path_bytes

    assert (
        _scrub_path_bytes(b"/play/abc123/eyJhbGciOiJIUzI1NiJ9.zzz")
        == "/play/abc123/***"
    )
    # Trailing path segments after the token are also redacted.
    assert _scrub_path_bytes(b"/play/abc/secret/extra") == "/play/abc/***/extra"


def test_scrub_path_passthrough_for_unrelated_paths() -> None:
    from app.logging_setup import _scrub_path_bytes

    assert _scrub_path_bytes(b"/api/sessions/abc") == "/api/sessions/abc"
    assert _scrub_path_bytes(b"/healthz") == "/healthz"
    assert _scrub_path_bytes(b"") == ""


# --------------------------- LLMClient kwargs contract --------------------


def test_llm_client_omits_temperature_and_top_p_when_unset(monkeypatch) -> None:
    """The Anthropic SDK is forgiving but this contract matters when the
    operator points ``ANTHROPIC_BASE_URL`` at a stricter Anthropic-shaped
    proxy (some validate-then-reject unknown keys). Pin it: when no
    per-tier env override is set, the kwargs dict passed to
    ``messages.create`` must NOT contain ``temperature`` (for tiers
    where the default is ``None``) or ``top_p``."""

    import asyncio

    from app.config import Settings
    from app.llm.client import LLMClient
    from tests.mock_anthropic import MockAnthropic

    # Defaults: play+setup temperature is None, top_p is None for all tiers.
    for key in (
        "LLM_TEMPERATURE_PLAY",
        "LLM_TEMPERATURE_SETUP",
        "LLM_TOP_P_PLAY",
        "LLM_TOP_P_SETUP",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    s = Settings()
    mock = MockAnthropic({"play": [], "setup": []})
    llm = LLMClient(settings=s)
    llm.set_transport(mock.messages)

    async def _go() -> None:
        await llm.acomplete(
            tier="play",
            system_blocks=[{"type": "text", "text": "x"}],
            messages=[{"role": "user", "content": "hi"}],
        )

    asyncio.run(_go())
    kwargs = mock.messages.calls[0]
    assert "temperature" not in kwargs
    assert "top_p" not in kwargs
    # max_tokens always present + comes from the per-tier default.
    assert kwargs["max_tokens"] == 1024


def test_strict_retry_max_default_and_override(monkeypatch) -> None:
    """``LLM_STRICT_RETRY_MAX`` is the per-turn recovery budget shared
    across all validator violations (drive + yield). Default 2 so the
    worst-case "missing both" turn has room for one drive recovery
    pass + one yield recovery pass without the operator having to
    lift the cap."""

    monkeypatch.delenv("LLM_STRICT_RETRY_MAX", raising=False)
    s = Settings()
    assert s.llm_strict_retry_max == 2
    monkeypatch.setenv("LLM_STRICT_RETRY_MAX", "3")
    assert Settings().llm_strict_retry_max == 3
    monkeypatch.setenv("LLM_STRICT_RETRY_MAX", "0")
    assert Settings().llm_strict_retry_max == 0


def test_max_setup_turns_default_and_override(monkeypatch) -> None:
    monkeypatch.delenv("MAX_SETUP_TURNS", raising=False)
    s = Settings()
    assert s.max_setup_turns == 4
    monkeypatch.setenv("MAX_SETUP_TURNS", "2")
    assert Settings().max_setup_turns == 2


def test_max_participant_submission_chars_default_and_override(monkeypatch) -> None:
    monkeypatch.delenv("MAX_PARTICIPANT_SUBMISSION_CHARS", raising=False)
    s = Settings()
    assert s.max_participant_submission_chars == 4000
    monkeypatch.setenv("MAX_PARTICIPANT_SUBMISSION_CHARS", "500")
    assert Settings().max_participant_submission_chars == 500


def test_timeout_for_uses_per_tier_defaults(monkeypatch) -> None:
    """Per-tier timeout resolution: explicit env override → per-tier
    default → global ``ANTHROPIC_TIMEOUT_S``. The guardrail tier defaults
    to a tight 15 s (locks the per-session lock during classification);
    AAR defaults to 900 s (long Opus runs); play/setup inherit the
    global 600 s default."""

    for key in (
        "LLM_TIMEOUT_PLAY",
        "LLM_TIMEOUT_SETUP",
        "LLM_TIMEOUT_AAR",
        "LLM_TIMEOUT_GUARDRAIL",
        "ANTHROPIC_TIMEOUT_S",
    ):
        monkeypatch.delenv(key, raising=False)
    s = Settings()
    assert s.timeout_for("play") == 600.0
    assert s.timeout_for("setup") == 600.0
    assert s.timeout_for("aar") == 900.0
    assert s.timeout_for("guardrail") == 15.0
    monkeypatch.setenv("LLM_TIMEOUT_GUARDRAIL", "5")
    monkeypatch.setenv("LLM_TIMEOUT_AAR", "1200")
    s2 = Settings()
    assert s2.timeout_for("guardrail") == 5.0
    assert s2.timeout_for("aar") == 1200.0
    # Tiers that didn't get an override still inherit the global.
    assert s2.timeout_for("play") == 600.0


def test_llm_client_forwards_temperature_when_set(monkeypatch) -> None:
    """Counter-example: when the env knob IS set, the value must reach the
    Anthropic kwargs."""

    import asyncio

    from app.config import Settings
    from app.llm.client import LLMClient
    from tests.mock_anthropic import MockAnthropic

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("LLM_TEMPERATURE_PLAY", "0.3")
    monkeypatch.setenv("LLM_TOP_P_PLAY", "0.85")
    monkeypatch.setenv("LLM_MAX_TOKENS_PLAY", "777")
    s = Settings()
    mock = MockAnthropic({"play": []})
    llm = LLMClient(settings=s)
    llm.set_transport(mock.messages)

    async def _go() -> None:
        await llm.acomplete(
            tier="play",
            system_blocks=[{"type": "text", "text": "x"}],
            messages=[{"role": "user", "content": "hi"}],
        )

    asyncio.run(_go())
    kwargs = mock.messages.calls[0]
    assert kwargs["temperature"] == 0.3
    assert kwargs["top_p"] == 0.85
    assert kwargs["max_tokens"] == 777


def test_empty_env_vars_fall_back_to_defaults(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Empty-string env vars must NOT crash ``Settings()`` — they
    fall back to the field default.

    This is the ``docker-compose.yml`` ``${VAR:-}`` pattern: when
    the operator hasn't set ``VAR`` in their ``.env``, Compose
    passes the literal empty string ``""`` to the container.
    Without ``env_ignore_empty=True`` on ``SettingsConfigDict``,
    pydantic raised ``bool_parsing`` / ``int_parsing`` errors on
    every empty-string-valued bool / int field and the container
    crash-looped on startup.

    Covers the production crash on 2026-05-02 caused by adding
    ``DEV_TOOLS_ENABLED: ${DEV_TOOLS_ENABLED:-}`` to compose
    without any of the dev flags being set on the host.
    """

    from app.config import Settings, reset_settings_cache

    # Bool fields — these were the actual crash trigger.
    monkeypatch.setenv("DEV_TOOLS_ENABLED", "")
    monkeypatch.setenv("TEST_MODE", "")
    monkeypatch.setenv("DEV_FAST_SETUP", "")
    monkeypatch.setenv("INPUT_GUARDRAIL_ENABLED", "")
    # String fields with non-empty defaults — empty env value should
    # NOT clobber the default (would silently break path resolution
    # for ``DEV_SCENARIOS_PATH`` etc.).
    monkeypatch.setenv("DEV_SCENARIOS_PATH", "")
    monkeypatch.setenv("SESSION_SECRET", "")
    reset_settings_cache()

    # Must not raise.
    s = Settings()
    assert s.dev_tools_enabled is False
    assert s.test_mode is False
    assert s.dev_fast_setup is False
    assert s.input_guardrail_enabled is True  # default is True
    # ``dev_scenarios_path`` field default is "" (empty string is the
    # auto-detect sentinel — the ``resolved_dev_scenarios_path``
    # method then computes a real path). Either "" or absent is fine.
    assert s.dev_scenarios_path == ""
    # ``resolved_dev_scenarios_path`` must still produce something
    # usable.
    resolved = s.resolved_dev_scenarios_path()
    assert resolved.endswith("backend/scenarios")


def test_create_app_refuses_without_anthropic_api_key() -> None:
    """Issue #118: importing ``app.main`` (which evaluates
    ``app = create_app()`` at module level) must fail at the process
    boundary when ``ANTHROPIC_API_KEY`` is unset and ``TEST_MODE`` is
    off.

    Pre-fix the check lived in the lifespan, so uvicorn printed
    ``Started server process``, swallowed the lifespan traceback, then
    exited with code 0 — silently restart-looping under
    ``docker compose restart: unless-stopped``. Post-fix the import
    itself raises so uvicorn never binds the port and exits non-zero.

    Runs in a subprocess for two reasons:

    * The pytest process imports ``app.main`` once at startup with
      ``TEST_MODE=true`` (set in ``conftest.py``). Re-asserting against
      that already-imported module would skip the actual import-time
      gate. A subprocess gives us a fresh, never-imported module space.
    * ``create_app`` calls ``configure_logging(cfg)`` which, when
      ``test_mode=False``, reconfigures structlog into production mode
      (logger caching + ``sys.stdout`` pin). Running that in-process
      would break subsequent ``capsys``-based tests (see
      ``test_logging_setup_test_mode.py`` for the failure mode).
    """

    import os
    import subprocess
    import sys

    env = os.environ.copy()
    env.pop("ANTHROPIC_API_KEY", None)
    env["TEST_MODE"] = "false"
    env.setdefault("SESSION_SECRET", "x" * 32)

    result = subprocess.run(
        [sys.executable, "-c", "import app.main"],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode != 0, (
        "Expected import of ``app.main`` to fail with a non-zero exit, "
        f"got {result.returncode}.\nstdout:\n{result.stdout}\n"
        f"stderr:\n{result.stderr}"
    )
    assert "ANTHROPIC_API_KEY" in result.stderr, (
        "Error message must name the missing variable so the operator "
        f"knows what to fix. stderr:\n{result.stderr}"
    )


def test_app_boots_with_empty_env_vars(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end smoke: ``create_app()`` must succeed when every
    optional env var is set to empty string. Catches the
    docker-compose passthrough regression at the ``app.main``
    boundary, not just ``Settings``."""

    from fastapi.testclient import TestClient

    from app.config import reset_settings_cache
    from app.main import create_app

    monkeypatch.setenv("DEV_TOOLS_ENABLED", "")
    monkeypatch.setenv("TEST_MODE", "true")  # so the API-key check passes
    monkeypatch.setenv("DEV_FAST_SETUP", "")
    monkeypatch.setenv("INPUT_GUARDRAIL_ENABLED", "")
    monkeypatch.setenv("DEV_SCENARIOS_PATH", "")
    monkeypatch.setenv("SESSION_SECRET", "x" * 32)
    reset_settings_cache()

    app = create_app()
    with TestClient(app) as c:
        # A trivial endpoint that doesn't need any of the disabled
        # features — confirms the lifespan startup didn't blow up.
        resp = c.get("/healthz")
        assert resp.status_code == 200
