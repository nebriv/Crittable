"""Pydantic-settings configuration sourced entirely from environment variables.

Reference: ``docs/configuration.md`` is the authoritative env-var contract;
this module is the implementation. Defaults match that doc.

Conventions
-----------
* All knobs are env vars. No `.env` parsing in code (the operator can use
  `dotenv` at the shell level if they want).
* Permissive defaults for ease of Codespaces dev. The ``Before going public``
  checklist in ``docs/configuration.md`` lists what to flip.
* :func:`get_settings` is a process-level singleton; callers must never mutate
  the result.
"""

from __future__ import annotations

import secrets
import warnings
from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ModelTier = Literal["play", "setup", "aar", "guardrail"]

_TIER_DEFAULTS: dict[ModelTier, str] = {
    "play": "claude-sonnet-4-6",
    "setup": "claude-haiku-4-5",
    "aar": "claude-opus-4-7",
    "guardrail": "claude-haiku-4-5",
}

# Per-tier max_tokens defaults. Picked so the model has room to reason +
# emit a small set of tool calls without truncation. Operators can tune
# via ``LLM_MAX_TOKENS_<TIER>`` env vars; the rationale lives in
# ``docs/configuration.md``.
_MAX_TOKENS_DEFAULTS: dict[ModelTier, int] = {
    "play": 1024,
    "setup": 1024,
    "aar": 4096,
    "guardrail": 12,
}

# Per-tier temperature defaults. ``None`` means "let Anthropic pick"
# (currently 1.0). Lower temperatures are safer for the guardrail
# classifier (we want deterministic verdicts) and for the AAR (we want
# faithful summaries). Play and setup stay at the default to preserve
# narrative variance.
_TEMPERATURE_DEFAULTS: dict[ModelTier, float | None] = {
    "play": None,
    "setup": None,
    "aar": 0.4,
    "guardrail": 0.0,
}

# Per-tier timeout defaults (seconds). ``None`` means "inherit
# ANTHROPIC_TIMEOUT_S". The guardrail explicitly tightens to 15 s
# because the per-session lock is held during classification — a hung
# Haiku call would otherwise freeze the session for the full 600 s.
# AAR loosens to 900 s because Opus on a 30-message exercise can
# legitimately run 1–3 minutes.
_TIMEOUT_DEFAULTS: dict[ModelTier, float | None] = {
    "play": None,
    "setup": None,
    "aar": 900.0,
    "guardrail": 15.0,
}


class Settings(BaseSettings):
    """Application configuration. One instance per process."""

    model_config = SettingsConfigDict(
        env_file=None,
        case_sensitive=True,
        extra="ignore",
    )

    # ---- Mode ----------------------------------------------------------
    test_mode: bool = Field(default=False, alias="TEST_MODE")

    # ---- Anthropic -----------------------------------------------------
    anthropic_api_key: SecretStr | None = Field(default=None, alias="ANTHROPIC_API_KEY")
    # Optional ``base_url`` override for the AsyncAnthropic client. Lets
    # the operator point the engine at an Anthropic-compatible proxy
    # (Bedrock-via-litellm, OpenRouter's anthropic-compat endpoint, an
    # internal LLM gateway, a self-hosted Anthropic-shaped server, etc.)
    # without code changes. ``None`` = use the SDK default
    # (``https://api.anthropic.com``). See ``docs/llm_providers.md`` for
    # worked examples.
    anthropic_base_url: str | None = Field(default=None, alias="ANTHROPIC_BASE_URL")
    anthropic_model: str | None = Field(default=None, alias="ANTHROPIC_MODEL")
    anthropic_model_play: str | None = Field(default=None, alias="ANTHROPIC_MODEL_PLAY")
    anthropic_model_setup: str | None = Field(default=None, alias="ANTHROPIC_MODEL_SETUP")
    anthropic_model_aar: str | None = Field(default=None, alias="ANTHROPIC_MODEL_AAR")
    anthropic_model_guardrail: str | None = Field(
        default=None, alias="ANTHROPIC_MODEL_GUARDRAIL"
    )
    anthropic_max_retries: int = Field(default=4, alias="ANTHROPIC_MAX_RETRIES", ge=0)
    anthropic_timeout_s: float = Field(
        default=600.0, alias="ANTHROPIC_TIMEOUT_S", gt=0.0
    )

    # ---- Per-tier sampling tunables ------------------------------------
    # Each tier has independent ``max_tokens``, ``temperature`` and
    # ``top_p`` knobs. ``None`` means "use the SDK default".
    llm_max_tokens_play: int | None = Field(default=None, alias="LLM_MAX_TOKENS_PLAY", ge=1)
    llm_max_tokens_setup: int | None = Field(default=None, alias="LLM_MAX_TOKENS_SETUP", ge=1)
    llm_max_tokens_aar: int | None = Field(default=None, alias="LLM_MAX_TOKENS_AAR", ge=1)
    llm_max_tokens_guardrail: int | None = Field(
        default=None, alias="LLM_MAX_TOKENS_GUARDRAIL", ge=1
    )
    llm_temperature_play: float | None = Field(
        default=None, alias="LLM_TEMPERATURE_PLAY", ge=0.0, le=2.0
    )
    llm_temperature_setup: float | None = Field(
        default=None, alias="LLM_TEMPERATURE_SETUP", ge=0.0, le=2.0
    )
    llm_temperature_aar: float | None = Field(
        default=None, alias="LLM_TEMPERATURE_AAR", ge=0.0, le=2.0
    )
    llm_temperature_guardrail: float | None = Field(
        default=None, alias="LLM_TEMPERATURE_GUARDRAIL", ge=0.0, le=2.0
    )
    llm_top_p_play: float | None = Field(default=None, alias="LLM_TOP_P_PLAY", gt=0.0, le=1.0)
    llm_top_p_setup: float | None = Field(default=None, alias="LLM_TOP_P_SETUP", gt=0.0, le=1.0)
    llm_top_p_aar: float | None = Field(default=None, alias="LLM_TOP_P_AAR", gt=0.0, le=1.0)
    llm_top_p_guardrail: float | None = Field(
        default=None, alias="LLM_TOP_P_GUARDRAIL", gt=0.0, le=1.0
    )

    # ---- Per-tier timeout overrides ------------------------------------
    # Falls back to ``ANTHROPIC_TIMEOUT_S`` (default 600s) when unset.
    # Operators typically want a *short* guardrail timeout (the per-session
    # lock is held during classification; a 10-minute hang freezes a
    # session) and a *long* AAR timeout (Opus on a 30-message exercise can
    # legitimately run 1–3 minutes).
    llm_timeout_play: float | None = Field(
        default=None, alias="LLM_TIMEOUT_PLAY", gt=0.0
    )
    llm_timeout_setup: float | None = Field(
        default=None, alias="LLM_TIMEOUT_SETUP", gt=0.0
    )
    llm_timeout_aar: float | None = Field(
        default=None, alias="LLM_TIMEOUT_AAR", gt=0.0
    )
    llm_timeout_guardrail: float | None = Field(
        default=None, alias="LLM_TIMEOUT_GUARDRAIL", gt=0.0
    )

    # ---- Engine retry / loop caps -------------------------------------
    # Number of strict retries the play turn driver attempts when the AI
    # fails to yield via ``set_active_roles``. Default 1 — operators on
    # local / smaller models that struggle with tool-use enforcement may
    # want 2 or 3 to reduce force-advance churn. Upper-bounded at 10 to
    # cap the worst-case token spend per stuck turn (a misconfigured
    # ``LLM_STRICT_RETRY_MAX=1000`` would otherwise burn the per-session
    # lock + tokens on a thousand strict-pin'd calls).
    # Renamed semantics in the validator refactor: this is now the
    # "max recovery LLM calls per turn" budget shared across all
    # validation violations, not just strict-yield retries. With
    # ``LLM_RECOVERY_DRIVE_REQUIRED=True`` (default) the worst case is
    # missing-DRIVE + missing-YIELD on the same turn, which needs
    # *two* recovery passes (drive first, yield second). Default
    # bumped from 1 → 2 so that worst case is recoverable without
    # the operator having to know to lift it. Set 0 to disable
    # recovery entirely; lift to 3+ for flakier models.
    llm_strict_retry_max: int = Field(
        default=2, alias="LLM_STRICT_RETRY_MAX", ge=0, le=10
    )
    # When True (default) the turn validator requires DRIVE
    # (``broadcast`` / ``address_role``) on every yielding play turn,
    # spawning a recovery LLM call narrowed to ``broadcast`` if missing.
    # Set False to revert to the pre-validator "yield-only" semantics —
    # an emergency kill-switch if the new behaviour regresses in
    # production. Lifting this flag does NOT disable the briefing-turn
    # drive guard or the strict-yield path; those run regardless.
    llm_recovery_drive_required: bool = Field(
        default=True, alias="LLM_RECOVERY_DRIVE_REQUIRED"
    )
    # When True (default) missing-DRIVE is downgraded from a violation
    # to a warning when the most-recent un-replied player message ends
    # in ``?`` AND no new beat fired this turn (i.e. players are
    # clearly mid-discussion on an open ask). Set False to make
    # missing-DRIVE always recover.
    llm_recovery_drive_soft_on_open_question: bool = Field(
        default=True, alias="LLM_RECOVERY_DRIVE_SOFT_ON_OPEN_QUESTION"
    )
    # Cap on chained tool calls within a single setup turn. The setup-tier
    # model occasionally chains ``ask_setup_question`` → ``propose_plan``
    # → ``finalize_setup`` in one response cycle; the cap prevents an
    # infinite loop if the model never yields. Default 4. Upper bound 20.
    max_setup_turns: int = Field(default=4, alias="MAX_SETUP_TURNS", ge=1, le=20)
    # Hard cap on the byte length of a participant submission (player
    # message). Mirrors the per-call backend cap that previously lived as
    # a magic ``[:2000]`` slice; tunable so operators with chatty teams
    # can lift it without recompiling.
    max_participant_submission_chars: int = Field(
        default=4000, alias="MAX_PARTICIPANT_SUBMISSION_CHARS", ge=1
    )

    # ---- Session limits -----------------------------------------------
    max_sessions: int = Field(default=10, alias="MAX_SESSIONS", ge=1)
    max_roles_per_session: int = Field(default=24, alias="MAX_ROLES_PER_SESSION", ge=2)
    max_turns_per_session: int = Field(default=40, alias="MAX_TURNS_PER_SESSION", ge=1)
    ai_turn_soft_warn_pct: int = Field(default=80, alias="AI_TURN_SOFT_WARN_PCT", ge=1, le=100)
    max_critical_injects_per_5_turns: int = Field(
        default=1, alias="MAX_CRITICAL_INJECTS_PER_5_TURNS", ge=0
    )
    export_retention_min: int = Field(default=60, alias="EXPORT_RETENTION_MIN", ge=1)
    ws_heartbeat_s: int = Field(default=20, alias="WS_HEARTBEAT_S", ge=1)
    input_guardrail_enabled: bool = Field(default=True, alias="INPUT_GUARDRAIL_ENABLED")

    # ---- Logging -------------------------------------------------------
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = Field(
        default="INFO", alias="LOG_LEVEL"
    )
    log_format: Literal["json", "console"] = Field(default="json", alias="LOG_FORMAT")

    # ---- Security / hardening -----------------------------------------
    session_secret: SecretStr | None = Field(default=None, alias="SESSION_SECRET")
    cors_origins: str = Field(default="*", alias="CORS_ORIGINS")
    rate_limit_enabled: bool = Field(default=False, alias="RATE_LIMIT_ENABLED")
    rate_limit_req_per_min: int = Field(default=60, alias="RATE_LIMIT_REQ_PER_MIN", ge=1)

    # ---- Audit ---------------------------------------------------------
    audit_ring_size: int = Field(default=2000, alias="AUDIT_RING_SIZE", ge=10)

    # ---- Developer ergonomics -----------------------------------------
    # When true, ``POST /api/sessions`` skips the AI setup dialogue, populates a
    # minimal default scenario plan, and lands the session straight in READY so
    # the operator can iterate on the play / lobby UI without burning model
    # tokens or waiting for setup turns. **Never set this in production.**
    dev_fast_setup: bool = Field(default=False, alias="DEV_FAST_SETUP")

    # ---- Extensions ----------------------------------------------------
    extensions_tools_json: str | None = Field(default=None, alias="EXTENSIONS_TOOLS_JSON")
    extensions_tools_path: str | None = Field(default=None, alias="EXTENSIONS_TOOLS_PATH")
    extensions_resources_json: str | None = Field(default=None, alias="EXTENSIONS_RESOURCES_JSON")
    extensions_resources_path: str | None = Field(default=None, alias="EXTENSIONS_RESOURCES_PATH")
    extensions_prompts_json: str | None = Field(default=None, alias="EXTENSIONS_PROMPTS_JSON")
    extensions_prompts_path: str | None = Field(default=None, alias="EXTENSIONS_PROMPTS_PATH")
    extension_template_max_bytes: int = Field(
        default=8192, alias="EXTENSION_TEMPLATE_MAX_BYTES", ge=64
    )

    @field_validator("anthropic_max_retries", "max_sessions", "max_roles_per_session")
    @classmethod
    def _positive(cls, v: int) -> int:
        if v < 0:
            raise ValueError("must be non-negative")
        return v

    # ---- Resolved properties ------------------------------------------
    def model_for(self, tier: ModelTier) -> str:
        """Resolve a model id for the given tier.

        Resolution order:
        1. ``ANTHROPIC_MODEL_<TIER>`` if set,
        2. ``ANTHROPIC_MODEL`` if set,
        3. tier default from :data:`_TIER_DEFAULTS`.
        """

        tier_attr = f"anthropic_model_{tier}"
        explicit = getattr(self, tier_attr, None)
        if explicit:
            return str(explicit)
        if self.anthropic_model:
            return str(self.anthropic_model)
        return _TIER_DEFAULTS[tier]

    def max_tokens_for(self, tier: ModelTier) -> int:
        """Resolve ``max_tokens`` for the tier.

        Order: ``LLM_MAX_TOKENS_<TIER>`` env override → tier default in
        :data:`_MAX_TOKENS_DEFAULTS`.
        """

        explicit = getattr(self, f"llm_max_tokens_{tier}", None)
        if explicit is not None:
            return int(explicit)
        return _MAX_TOKENS_DEFAULTS[tier]

    def temperature_for(self, tier: ModelTier) -> float | None:
        """Resolve ``temperature`` for the tier; ``None`` = SDK default.

        Order: ``LLM_TEMPERATURE_<TIER>`` env override → tier default in
        :data:`_TEMPERATURE_DEFAULTS`.
        """

        explicit = getattr(self, f"llm_temperature_{tier}", None)
        if explicit is not None:
            return float(explicit)
        return _TEMPERATURE_DEFAULTS[tier]

    def top_p_for(self, tier: ModelTier) -> float | None:
        """Resolve ``top_p`` for the tier. No tier default — only
        forwarded to Anthropic when explicitly set."""

        explicit = getattr(self, f"llm_top_p_{tier}", None)
        if explicit is not None:
            return float(explicit)
        return None

    def timeout_for(self, tier: ModelTier) -> float:
        """Resolve the per-call timeout for the tier.

        Order: ``LLM_TIMEOUT_<TIER>`` env override → tier default in
        :data:`_TIMEOUT_DEFAULTS` → ``ANTHROPIC_TIMEOUT_S`` (the global
        SDK-wide default). The guardrail tier defaults to a tight 15 s
        so a hung classifier doesn't freeze the per-session lock for
        the full 600 s; AAR defaults to 900 s for long Opus runs.
        """

        explicit = getattr(self, f"llm_timeout_{tier}", None)
        if explicit is not None:
            return float(explicit)
        per_tier_default = _TIMEOUT_DEFAULTS.get(tier)
        if per_tier_default is not None:
            return float(per_tier_default)
        return float(self.anthropic_timeout_s)

    def cors_origin_list(self) -> list[str] | Literal["*"]:
        """Parse ``CORS_ORIGINS``: ``*`` returns the literal ``"*"``, else a list."""

        raw = self.cors_origins.strip()
        if raw == "*":
            return "*"
        return [item.strip() for item in raw.split(",") if item.strip()]

    def resolve_session_secret(self) -> str:
        """Return the configured secret, or generate (and warn about) a transient one."""

        if self.session_secret is not None:
            return str(self.session_secret.get_secret_value())
        # Permissive default per PLAN; warn loudly so it lands in container logs.
        warnings.warn(
            "SESSION_SECRET unset; generating a transient HMAC key. "
            "Sessions will not survive a restart and link tokens will be invalidated. "
            "Set SESSION_SECRET to a 32+ byte random value before any non-toy deploy.",
            stacklevel=2,
        )
        return secrets.token_urlsafe(32)

    def require_anthropic_key(self) -> str:
        """Return the Anthropic API key or raise unless we're in test mode."""

        if self.anthropic_api_key is not None:
            return str(self.anthropic_api_key.get_secret_value())
        if self.test_mode:
            return "test-mode-no-key"
        raise RuntimeError(
            "ANTHROPIC_API_KEY is required. Set it in the environment, "
            "or set TEST_MODE=true if you are running unit tests."
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-level cached settings instance."""

    return Settings()


def reset_settings_cache() -> None:
    """Test-only: clear the singleton so a new env can be picked up."""

    get_settings.cache_clear()
