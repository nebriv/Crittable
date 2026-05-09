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

# Per-tier default models. The setup tier was on Haiku 4.5 originally
# (it's a one-time-per-session dialogue and Haiku is dollar-cheap), but
# Haiku 4.5 occasionally falls back to legacy XML function-call markup
# (``<parameter name="X">…</parameter>`` / ``<item>`` / CDATA) inside
# JSON tool inputs — observed in the 2026-04-29 follow-up session where
# ``propose_scenario_plan`` looped on ``tool_use_rejected`` because the
# values were XML strings instead of JSON arrays. We don't accept XML;
# the dispatcher now hard-rejects it (see
# ``dispatch._reject_if_xml_emission``). To prevent the emission in the
# first place, the setup tier defaults to Sonnet 4.6 — same model as
# ``play``, no XML-fallback quirk. Operators who need to dial back to
# Haiku for cost reasons can still set ``LLM_MODEL_SETUP=claude-
# haiku-4-5``; the rejection layer + 12k token budget + JSON-only prompt
# instruction will catch the resulting XML emissions, but the failure
# mode is no longer the default.
_TIER_DEFAULTS: dict[ModelTier, str] = {
    "play": "claude-sonnet-4-6",
    "setup": "claude-sonnet-4-6",
    "aar": "claude-opus-4-7",
    "guardrail": "claude-haiku-4-5",
}

# Per-tier max_tokens defaults. Picked so the model has room to reason +
# emit a small set of tool calls without truncation. Operators can tune
# via ``LLM_MAX_TOKENS_<TIER>`` env vars; the rationale lives in
# ``docs/configuration.md``.
_MAX_TOKENS_DEFAULTS: dict[ModelTier, int] = {
    "play": 1024,
    # ``setup`` needs more headroom than ``play`` because a full plan
    # tool call (title, executive_summary, ≥3 objectives, ≥3 narrative
    # beats with nested ``expected_actors`` arrays, 2–3 injects with
    # trigger/type/summary, plus guardrails / success_criteria /
    # out_of_scope) routinely runs past 1024 output tokens. Truncated
    # plan calls were the cause of the "AI didn't propose a plan yet"
    # loop observed on 2026-04-29 — every retry hit ``stop_reason:
    # max_tokens`` and the partial JSON failed validation.
    #
    # 4096 was still too tight for verbose plans on rich scenarios:
    # in a follow-up session the model emitted JSON for half the
    # fields, hit ``stop_reason=max_tokens``, and on retry switched to
    # the more-compact legacy ``<parameter name="…">…</parameter>``
    # XML format to "save space". Per-PR-#64 policy that XML is
    # rejected outright (see
    # ``llm/dispatch.py::_reject_if_xml_emission``), so the only
    # supported way through is to give the model enough output budget
    # to fit a full JSON plan in one call. 12288 is ~3x typical plan
    # size; cheap on Sonnet 4.6 (the new setup default) and still
    # affordable if an operator overrides back to Haiku. Operators on
    # a tight budget can dial it back via ``LLM_MAX_TOKENS_SETUP``.
    "setup": 12288,
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
# LLM_TIMEOUT_S". The guardrail explicitly tightens to 15 s
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
        # Treat empty-string env vars as unset, so the field default
        # wins instead of pydantic raising a ``bool_parsing`` /
        # ``int_parsing`` error on ``""``. This is the docker-compose
        # ``${VAR:-}`` pattern: when the operator hasn't set ``VAR``
        # in their ``.env`` Compose passes the literal empty string
        # to the container. Without this flag, ``DEV_TOOLS_ENABLED``
        # and similar bool fields crashed the app on startup with
        # ``ValidationError: Input should be a valid boolean, unable
        # to interpret input ''`` — producing a restart loop. Asserted
        # by ``tests/test_config.py::test_empty_env_vars_fall_back_to_defaults``.
        env_ignore_empty=True,
    )

    # ---- LLM (provider-agnostic; see app.llm.protocol.ChatClient) ------
    llm_api_key: SecretStr | None = Field(default=None, alias="LLM_API_KEY")
    # Optional ``base_url`` / ``api_base`` override. Anthropic-direct
    # backend forwards to ``AsyncAnthropic(base_url=…)``; LiteLLM-routed
    # backend forwards to ``litellm.acompletion(api_base=…)``. Either
    # way, points the engine at a non-default endpoint (Anthropic-
    # compatible proxy via litellm sidecar, OpenRouter, internal LLM
    # gateway, self-hosted server, etc.). ``None`` = use the provider
    # SDK default. See ``docs/llm_providers.md`` for worked examples.
    llm_api_base: str | None = Field(default=None, alias="LLM_API_BASE")
    llm_model: str | None = Field(default=None, alias="LLM_MODEL")
    llm_model_play: str | None = Field(default=None, alias="LLM_MODEL_PLAY")
    llm_model_setup: str | None = Field(default=None, alias="LLM_MODEL_SETUP")
    llm_model_aar: str | None = Field(default=None, alias="LLM_MODEL_AAR")
    llm_model_guardrail: str | None = Field(
        default=None, alias="LLM_MODEL_GUARDRAIL"
    )
    llm_max_retries: int = Field(default=4, alias="LLM_MAX_RETRIES", ge=0)
    llm_timeout_s: float = Field(
        default=600.0, alias="LLM_TIMEOUT_S", gt=0.0
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
    # Falls back to ``LLM_TIMEOUT_S`` (default 600s) when unset.
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
    # an emergency kill-switch if the new behavior regresses in
    # production. Lifting this flag does NOT disable the briefing-turn
    # drive guard or the strict-yield path; those run regardless.
    llm_recovery_drive_required: bool = Field(
        default=True, alias="LLM_RECOVERY_DRIVE_REQUIRED"
    )
    # Legacy carve-out kill-switch. When True, missing-DRIVE is
    # downgraded from a violation to a warning if the most-recent
    # un-replied player message carries an ``@facilitator`` mention.
    # The original intent was "players are mid-discussion on the AI's
    # open ask, so the AI yielding silently is fine" — but the
    # predicate (player addressed the AI explicitly) actually matches
    # the *opposite* case (player demanded an answer). Enabling this
    # carve-out causes the AI to silently yield exactly when it must
    # answer a player. Default flipped to False; retained as an
    # emergency kill-switch only. When silence is genuinely wanted,
    # use the operator pause control (Wave 3) rather than re-enabling
    # this flag.
    llm_recovery_drive_soft_on_open_question: bool = Field(
        default=False, alias="LLM_RECOVERY_DRIVE_SOFT_ON_OPEN_QUESTION"
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
    # Wave 1 (issue #134) security review H2: cap how many submissions a
    # single role can post on a single turn. ``can_submit`` was relaxed to
    # support discussion follow-ups (multiple discuss-intent messages
    # before signaling ready), which removed the implicit one-and-done
    # backstop. This cap is the new ceiling — defense against a buggy
    # client looping ``submit_response`` or a griefing player flooding
    # the transcript. The existing 30-second body-dedupe still applies
    # for exact-content repeats; this cap covers the
    # "appended-counter-bypass" case the dedupe doesn't.
    max_submissions_per_role_per_turn: int = Field(
        default=20, alias="MAX_SUBMISSIONS_PER_ROLE_PER_TURN", ge=1
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
    # Reject a participant's submission as a duplicate if it matches the
    # role's previous message body (whitespace-stripped) within this many
    # seconds. Backstop for the no-feedback retype loop in issue #63 once
    # the new ``ai_thinking`` indicator dissolves the underlying confusion.
    # Set to 0 to disable.
    duplicate_submission_window_seconds: int = Field(
        default=30, alias="DUPLICATE_SUBMISSION_WINDOW_SECONDS", ge=0
    )

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

    # When true, the ``/api/dev/scenarios/...`` endpoints (scenario list,
    # play, record) become available. Session-spawning endpoints
    # (``/play``) accept UNAUTHENTICATED requests in this mode — the
    # wizard's "replay scenario" path on the home screen has no token
    # to present yet, and requiring one would block the most common
    # dev use case. The dev-tools gate itself is the security boundary.
    # **Never set this in production**: an unauthenticated caller can
    # mint sessions via ``/play`` and harvest the creator token in the
    # response, then read every join link. ``main.py`` emits a startup
    # WARNING when this flag is on so an accidental deploy is loud in
    # the logs.
    dev_tools_enabled: bool = Field(default=False, alias="DEV_TOOLS_ENABLED")
    # When true, ``end_session`` runs AAR generation inline rather than
    # spawning a background task. Tests need this because Starlette's
    # sync ``TestClient`` doesn't reliably progress cross-request
    # ``asyncio.create_task`` work, and the polling client would otherwise
    # see ``aar_status="pending"`` forever. Production code keeps the
    # background-task path so ``POST /end`` stays fast.
    aar_inline_on_end: bool = Field(default=False, alias="AAR_INLINE_ON_END")
    # Filesystem path the dev-tools scenario loader scans for ``*.json``
    # files. The empty-string default means "auto-detect" — the
    # ``resolved_dev_scenarios_path()`` helper computes the
    # repo-root-relative path from this module's __file__ so the
    # loader works regardless of which cwd uvicorn was started from
    # (running `cd backend && uvicorn ...` would otherwise resolve a
    # cwd-relative `"backend/scenarios"` to `backend/backend/scenarios`
    # and silently show an empty picker). Operators with scenarios
    # checked in elsewhere can still override.
    dev_scenarios_path: str = Field(default="", alias="DEV_SCENARIOS_PATH")

    # ---- Chat declutter -----------------------------------------------
    # docs/plans/chat-decluttering.md §6.8. When True (default — flipped
    # in the iter-4 polish session), the ``declare_workstreams`` tool is
    # exposed to the setup-tier model, the dispatch-time
    # ``workstream_id`` validation engages, and the frontend filter
    # pills + colored stripes + manual override contextmenu are all
    # live. When False the feature is invisible end-to-end (tool
    # hidden from the model, prompt copy omitted, any ``workstream_id``
    # value emitted under a stale prompt cache is dropped to ``None``
    # server-side; the manual-override REST endpoint also rejects
    # non-null targets because the declared set is empty). Single
    # emergency kill-switch per plan §6.8 — flip back to False if the
    # AI behaves badly post-launch. The AAR pipeline is workstream-
    # blind regardless of the flag (plan §6.9).
    workstreams_enabled: bool = Field(default=True, alias="WORKSTREAMS_ENABLED")

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

    @field_validator("llm_max_retries", "max_sessions", "max_roles_per_session")
    @classmethod
    def _positive(cls, v: int) -> int:
        if v < 0:
            raise ValueError("must be non-negative")
        return v

    # ---- Resolved properties ------------------------------------------

    def resolved_dev_scenarios_path(self) -> str:
        """Return the dev-scenarios directory as an absolute path.

        Empty string ``DEV_SCENARIOS_PATH`` (the default) auto-detects:
        we walk up from this module's ``__file__`` to find the repo
        root and return ``<repo_root>/backend/scenarios``. This makes
        the default scenarios-dir cwd-independent — the previous
        cwd-relative default silently rendered an empty picker when
        uvicorn was started from inside ``backend/``.

        A non-empty operator override is returned as-is (still
        ``Path.resolve()``-d at use time by the loader so symlink
        defenses fire).
        """

        from pathlib import Path

        if self.dev_scenarios_path:
            return self.dev_scenarios_path
        # backend/app/config.py → backend/app → backend → <repo_root>
        repo_root = Path(__file__).resolve().parent.parent.parent
        return str(repo_root / "backend" / "scenarios")

    def model_for(self, tier: ModelTier) -> str:
        """Resolve a model id for the given tier.

        Resolution order:
        1. ``LLM_MODEL_<TIER>`` if set,
        2. ``LLM_MODEL`` if set,
        3. tier default from :data:`_TIER_DEFAULTS`.
        """

        tier_attr = f"llm_model_{tier}"
        explicit = getattr(self, tier_attr, None)
        if explicit:
            return str(explicit)
        if self.llm_model:
            return str(self.llm_model)
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
        :data:`_TIMEOUT_DEFAULTS` → ``LLM_TIMEOUT_S`` (the global
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
        return float(self.llm_timeout_s)

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

    def require_llm_api_key(self) -> str:
        """Return ``LLM_API_KEY`` or raise.

        Required when at least one tier targets the ``anthropic/``
        family. For deployments routing only to non-Anthropic providers
        (OpenAI, Bedrock, Vertex, etc.), the provider-native env var
        (``OPENAI_API_KEY``, ``AWS_*``, ``GOOGLE_APPLICATION_CREDENTIALS``)
        is what LiteLLM auto-discovers — ``LLM_API_KEY`` is not used
        and not required.
        """

        if self.llm_api_key is not None:
            return str(self.llm_api_key.get_secret_value())
        raise RuntimeError(
            "LLM_API_KEY is required. Set it in the environment "
            "before starting the app."
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-level cached settings instance."""

    return Settings()


def reset_settings_cache() -> None:
    """Test-only: clear the singleton so a new env can be picked up."""

    get_settings.cache_clear()
