# Configuration

All configuration is via environment variables, parsed by `pydantic-settings` in `backend/app/config.py` (lands in Phase 2). Phase 1 uses none of these directly; this page is the contract that Phase 2 implements.

## Required

| Var | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key. The app refuses to start without it (except in test mode). |

## Models (tiered)

If `ANTHROPIC_MODEL` is set, it is the fallback for any unset tier.

| Var | Default | Used for |
|---|---|---|
| `ANTHROPIC_MODEL_PLAY` | `claude-sonnet-4-6` | Per-turn facilitation |
| `ANTHROPIC_MODEL_SETUP` | `claude-haiku-4-5` | Setup dialogue with the creator |
| `ANTHROPIC_MODEL_AAR` | `claude-opus-4-7` | Final after-action report generation |
| `ANTHROPIC_MODEL_GUARDRAIL` | `claude-haiku-4-5` | Optional input-side classifier |
| `ANTHROPIC_MAX_RETRIES` | `4` | SDK retry budget on 429/5xx |
| `ANTHROPIC_TIMEOUT_S` | `600` | Per-request timeout in seconds |
| `ANTHROPIC_BASE_URL` | _unset_ | Forwarded to `AsyncAnthropic(base_url=…)`. Lets the engine talk to any Anthropic-compatible endpoint (Bedrock/Vertex via litellm, OpenRouter, internal gateway). See [`llm_providers.md`](llm_providers.md). |

### Per-tier sampling tunables

Each tier has independent `max_tokens`, `temperature`, `top_p`, and
`timeout` knobs. Leave a knob unset to use the per-tier default; the
rationale for each default lives in `backend/app/config.py`
(`_MAX_TOKENS_DEFAULTS`, `_TEMPERATURE_DEFAULTS`).

| Var | Default | Effect |
|---|---|---|
| `LLM_MAX_TOKENS_PLAY` | `1024` | Per-turn cap during play. Bump to ~2048 if Sonnet is truncating beats. |
| `LLM_MAX_TOKENS_SETUP` | `4096` | Per-turn cap during setup. Sized to fit a full `propose_scenario_plan` tool call (≥3 nested beats, 2–3 injects, plus optional arrays); raise further if the model still truncates. |
| `LLM_MAX_TOKENS_AAR` | `4096` | Cap on the AAR report tokens. |
| `LLM_MAX_TOKENS_GUARDRAIL` | `12` | Cap on the guardrail classifier (one-word verdict). |
| `LLM_TEMPERATURE_PLAY` | _SDK default_ | Higher = more narrative variance. |
| `LLM_TEMPERATURE_SETUP` | _SDK default_ | |
| `LLM_TEMPERATURE_AAR` | `0.4` | Lower = more faithful summaries. |
| `LLM_TEMPERATURE_GUARDRAIL` | `0.0` | Deterministic verdict. |
| `LLM_TOP_P_PLAY` / `_SETUP` / `_AAR` / `_GUARDRAIL` | _SDK default_ | Nucleus sampling. Only forwarded when explicitly set. |
| `LLM_TIMEOUT_PLAY` / `_SETUP` / `_AAR` / `_GUARDRAIL` | inherits `ANTHROPIC_TIMEOUT_S` | Per-call timeout (seconds). Operators typically tighten guardrail (e.g. 5s — the per-session lock is held during classification) and loosen AAR (e.g. 900s — Opus on a 30-message exercise can run 1–3 min). |

### Engine retry / loop caps

| Var | Default | Effect |
|---|---|---|
| `LLM_STRICT_RETRY_MAX` | `2` | Per-turn recovery budget shared across all turn-validator violations (`missing_drive` + `missing_yield`). Default 2 covers the worst case (turn missing both) — drive recovery + yield recovery each consume one slot. Lift to `3+` for flakier models; set to `0` to disable recovery entirely (turns errored on first invalid response). |
| `LLM_RECOVERY_DRIVE_REQUIRED` | `true` | When true, every yielding play turn must include a `broadcast` or `address_role`; missing-DRIVE spawns a recovery LLM call narrowed to `broadcast`. Set false to revert to the pre-validator "yield-only" rule (emergency kill-switch). |
| `LLM_RECOVERY_DRIVE_SOFT_ON_OPEN_QUESTION` | `true` | When true, missing-DRIVE is downgraded from a violation to a warning when the most-recent un-replied player message ends in `?` AND no new beat fired this turn (i.e. players are mid-discussion on an open ask). Set false to make missing-DRIVE always recover. |
| `MAX_SETUP_TURNS` | `4` | Safety cap on chained tool calls within a single setup turn. Lift if you want the setup model to chain `ask_setup_question` → `propose_scenario_plan` → `finalize_setup` in one cycle. |
| `MAX_PARTICIPANT_SUBMISSION_CHARS` | `4000` | Hard cap on a player message. Submissions are *truncated* (not rejected); the engine appends a `[message truncated by server]` marker and sends a `submission_truncated` WS event (rendered as a slate info pill, not a red error) so the player knows their text was clipped. |

## Session limits

| Var | Default | Effect |
|---|---|---|
| `MAX_SESSIONS` | `10` | Hard cap on concurrent in-memory sessions |
| `MAX_ROLES_PER_SESSION` | `24` | Hard cap on roles in a single session |
| `MAX_TURNS_PER_SESSION` | `40` | Soft warning at 80%, hard stop at limit |
| `AI_TURN_SOFT_WARN_PCT` | `80` | Threshold for the wrap-up nudge in the system prompt |
| `MAX_CRITICAL_INJECTS_PER_5_TURNS` | `1` | Rate limit on `inject_critical_event` |
| `EXPORT_RETENTION_MIN` | `60` | Minutes to keep an ENDED session's export available |
| `WS_HEARTBEAT_S` | `20` | WebSocket heartbeat interval |
| `INPUT_GUARDRAIL_ENABLED` | `true` | Toggle the Haiku off-topic pre-classifier |
| `DEV_FAST_SETUP` | `false` | Dev/testing only: skip the AI setup dialogue at session creation, drop a generic default plan, and land in `READY`. **Never enable in production.** A creator can also trigger this mid-flow via `POST /api/sessions/{id}/setup/skip`. |

## Frontend (Vite build-time)

> **Build-time, not runtime.** These vars are read by `vite.config.ts`
> during `npm run build` and baked into the bundle as numeric literals.
> Setting them in your runtime environment after the bundle is built has
> no effect — re-run `npm run build` (or rebuild the docker image) to
> pick up changes.

Defaults preserve historical behaviour so unset = no change.

| Var | Default | Effect |
|---|---|---|
| `VITE_ACTIVITY_POLL_MS` | `3000` | Cadence at which the creator's activity panel polls `/api/sessions/{id}/activity`. |
| `VITE_AAR_POLL_MS` | `2500` | Cadence at which `EndedView` polls `/api/sessions/{id}/export.md` while the AAR is generating. |

## Logging

| Var | Default | Effect |
|---|---|---|
| `LOG_LEVEL` | `INFO` | `DEBUG` / `INFO` / `WARNING` / `ERROR` |
| `LOG_FORMAT` | `json` | `json` (default) or `console` |

## Security / hardening

| Var | Default | Effect |
|---|---|---|
| `SESSION_SECRET` | randomly generated at startup (warn) | HMAC key for join tokens. **Set explicitly for any non-toy deploy.** |
| `CORS_ORIGINS` | `*` | Comma-separated allowlist. **Set explicitly before going public.** |
| `RATE_LIMIT_ENABLED` | `false` | Toggle the rate-limit middleware |
| `RATE_LIMIT_REQ_PER_MIN` | `60` | Per-IP request cap when enabled |

## Extensions

| Var | Effect |
|---|---|
| `EXTENSIONS_TOOLS_JSON` / `EXTENSIONS_TOOLS_PATH` | JSON list of `ExtensionTool` definitions, inline or from a file path |
| `EXTENSIONS_RESOURCES_JSON` / `EXTENSIONS_RESOURCES_PATH` | Same for `ExtensionResource` |
| `EXTENSIONS_PROMPTS_JSON` / `EXTENSIONS_PROMPTS_PATH` | Same for `ExtensionPrompt` |

## Before going public — hardening checklist

1. Set `SESSION_SECRET` to a long random value (minimum 32 bytes).
2. Set `CORS_ORIGINS` to your actual origin(s).
3. Set `RATE_LIMIT_ENABLED=true` and tune `RATE_LIMIT_REQ_PER_MIN`.
4. Restrict the GHCR image's port exposure to the reverse proxy only.
5. Front the container with a TLS-terminating proxy (Caddy / Cloudflare / etc.).
6. Confirm `ANTHROPIC_API_KEY` is supplied via the runtime secret store, not baked in.
