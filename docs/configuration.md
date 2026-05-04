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
| `ANTHROPIC_MODEL_SETUP` | `claude-sonnet-4-6` | Setup dialogue with the creator. Was `claude-haiku-4-5` originally; switched to Sonnet because Haiku occasionally fell back to legacy XML function-call markup inside JSON tool inputs (the dispatcher now hard-rejects that — see [`docs/prompts.md`](prompts.md#tool-call-format-json-only)). Operators can still set `ANTHROPIC_MODEL_SETUP=claude-haiku-4-5` to dial back if cost is a concern; the rejection layer, 12k token budget, and JSON-only prompt instruction catch the resulting failures, they're just no longer the default. |
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
| `LLM_MAX_TOKENS_SETUP` | `12288` | Per-turn cap during setup. Sized to fit a full `propose_scenario_plan` tool call (≥3 nested beats, 2–3 injects, plus optional arrays) with comfortable headroom. Tighter budgets caused Haiku to truncate JSON mid-output and switch to legacy XML markup, which the dispatcher then hard-rejects (see [`docs/prompts.md`](prompts.md#tool-call-format-json-only)). Raise to ~16384 if you still see `tool_use_rejected` on `propose_scenario_plan` for rich scenarios. |
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
| `LLM_RECOVERY_DRIVE_SOFT_ON_OPEN_QUESTION` | `false` | Legacy carve-out kill-switch. When true, missing-DRIVE is downgraded to a warning if the most-recent un-replied player message ends in `?`. The original intent was "players are mid-discussion on the AI's open ask, so the AI yielding silently is fine," but the predicate (player's trailing `?`) actually matches the *opposite* case — a player asking the AI a direct question, exactly when DRIVE is mandatory. Default flipped to `false`; the current product design also doesn't include player-to-player discussion, so the carve-out's premise doesn't apply. Retained as an emergency rollback only — do not re-enable in production without also adding direction classification. **Deep dive in [`turn-lifecycle.md`](turn-lifecycle.md).** A startup warning fires (`legacy_carve_out_enabled` log line) if the flag is enabled. |
| `MAX_SETUP_TURNS` | `4` | Safety cap on chained tool calls within a single setup turn. Lift if you want the setup model to chain `ask_setup_question` → `propose_scenario_plan` → `finalize_setup` in one cycle. |
| `MAX_PARTICIPANT_SUBMISSION_CHARS` | `4000` | Hard cap on a player message. Submissions are *truncated* (not rejected); the engine appends a `[message truncated by server]` marker and sends a `submission_truncated` WS event (rendered as a slate info pill, not a red error) so the player knows their text was clipped. |
| `MAX_SUBMISSIONS_PER_ROLE_PER_TURN` | `20` | Wave 1 (issue #134) flood backstop. `can_submit` was relaxed so a player can post multiple discussion messages on one turn before signalling ready; this cap is the new ceiling. The N+1th submission from a single role on the same turn is rejected with an `IllegalTransitionError` (`scope=submit_response` error frame to the WS client) and a `submission_rate_exceeded` warning is logged. The `proxy_submit_as` and `proxy_submit_pending` solo-test paths share the same cap so the operator escape hatch can't bypass it. The 30-second body-dedupe still applies on top for exact repeats. |

## Session limits

| Var | Default | Effect |
|---|---|---|
| `MAX_SESSIONS` | `10` | Hard cap on concurrent in-memory sessions |
| `MAX_ROLES_PER_SESSION` | `24` | Hard cap on roles in a single session |
| `MAX_TURNS_PER_SESSION` | `40` | Soft warning at 80%, hard stop at limit |
| `AI_TURN_SOFT_WARN_PCT` | `80` | Threshold for the wrap-up nudge in the system prompt |
| `MAX_CRITICAL_INJECTS_PER_5_TURNS` | `1` | Rate limit on `inject_critical_event` |
| `EXPORT_RETENTION_MIN` | `60` | Minutes to keep an ENDED session's export available (covers AAR markdown, structured AAR JSON, **and the shared notepad** — `notepad/export.md` is reachable for the same window). |
| `WS_HEARTBEAT_S` | `20` | WebSocket heartbeat interval |
| `INPUT_GUARDRAIL_ENABLED` | `true` | Toggle the Haiku off-topic pre-classifier |
| `DEV_FAST_SETUP` | `false` | Dev/testing only: skip the AI setup dialogue at session creation, drop a generic default plan, and land in `READY`. **Never enable in production.** A creator can also trigger this mid-flow via `POST /api/sessions/{id}/setup/skip`. |
| `DEV_TOOLS_ENABLED` | `false` | Dev/testing only: expose the `/api/dev/scenarios/...` endpoints (scenario list / play / record). Required for the "Scenarios" panel inside God Mode to load — without this flag the panel renders a "Scenarios — disabled" empty state. `TEST_MODE=true` also implies this. **Never enable in production**: a leaked creator token plus this flag would let an attacker spawn arbitrary sessions and read their join links. See `backend/scenarios/README.md` and the "Scenario replay" section in `CLAUDE.md`. |
| `DEV_SCENARIOS_PATH` | `backend/scenarios` | Filesystem path the dev-tools scenario loader scans for `*.json` files. Resolved at request time via `realpath`; symlinks escaping the resolved root and files >1 MB are skipped (with a `WARNING` audit line). Defaults to a path relative to the working directory — operators running from elsewhere should set this explicitly. |
| `WORKSTREAMS_ENABLED` | `true` | Chat-declutter master toggle ([`docs/plans/chat-decluttering.md`](plans/chat-decluttering.md) §6.8). When `true` (default — flipped in the iter-4 polish session), exposes `declare_workstreams` to the setup-tier model, surfaces `address_role.workstream_id` validation, emits `workstream_declared` / `message_workstream_changed` WS events, lights up the frontend filter pills + colored stripes + manual-override contextmenu, and enables the creator's `/exports/timeline.md` and `/exports/full-record.md` markdown surfaces. When `false`, the feature is invisible end-to-end — the tool is hidden from the model, the prompt copy is omitted, any `workstream_id` value emitted by a model under a stale prompt cache is dropped to `None` server-side, and the manual-override REST endpoint rejects non-null targets (the declared set is empty). The AAR pipeline is workstream-blind regardless of the flag. Single emergency kill-switch — flip back to `false` if the AI behaves badly post-launch. |

### Shared notepad (issue #98)

The shared markdown notepad (`/api/sessions/{id}/notepad/*`) lives on
the same lifecycle as the session — it's locked when the creator ends
the session and stays exportable until the session is reaped per
`EXPORT_RETENTION_MIN` above. There is **no separate retention TTL in
v1**; a `NOTEPAD_RETENTION_DAYS` knob is tracked as a follow-up for
deployments with longer compliance windows. The notepad never appears
in play / setup / interject / guardrail prompts; only the AAR pipeline
reads it (`<player_notepad>` block; see [prompts.md](prompts.md)).

| Var | Default | Effect |
|---|---|---|
| _(none in v1)_ | — | Notepad lifecycle currently inherits `EXPORT_RETENTION_MIN`. |

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
