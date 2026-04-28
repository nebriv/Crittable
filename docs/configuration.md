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
