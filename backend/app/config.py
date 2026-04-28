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
    anthropic_model: str | None = Field(default=None, alias="ANTHROPIC_MODEL")
    anthropic_model_play: str | None = Field(default=None, alias="ANTHROPIC_MODEL_PLAY")
    anthropic_model_setup: str | None = Field(default=None, alias="ANTHROPIC_MODEL_SETUP")
    anthropic_model_aar: str | None = Field(default=None, alias="ANTHROPIC_MODEL_AAR")
    anthropic_model_guardrail: str | None = Field(
        default=None, alias="ANTHROPIC_MODEL_GUARDRAIL"
    )
    anthropic_max_retries: int = Field(default=4, alias="ANTHROPIC_MAX_RETRIES", ge=0)

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
