---
applyTo: "backend/**"
---

# Backend (Python) review

## Logging (`structlog`)
- `print` or `import logging` in business code → **BLOCK**. Use `from app.logging_setup import get_logger`.
- `event=` kwarg passed to a log call → **HIGH**. `event` is reserved by structlog (the message key). Use `audit_kind`, `tool_name`, etc.
- Re-passing fields already bound by middleware (`request_id`, `session_id`, `turn_id`, `role_id`) → **LOW**. They're inherited automatically.
- New external boundary without `*_start` + `*_complete` / `*_failed` log lines → **HIGH**. LLM calls, DB calls, WS connect/disconnect, tool dispatch, and extension dispatch already do this — match the pattern.
- `try/except` catching a broad exception without logging it before re-raising or swallowing → **BLOCK**. Silent swallows are bugs.
- Logging `SESSION_SECRET`, `ANTHROPIC_API_KEY`, raw join tokens, or full participant message bodies (>120 char preview) → **BLOCK**
- Wide payload logged without the `_is_oversized` helper from `sessions/manager.py` → **HIGH**
- Any review finding that calls out a swallowed exception, missing log at a meaningful boundary, silent fallback path, or anything else that hinders production debugging → **HIGH** even if it would otherwise be MEDIUM/LOW. Logging gaps are not "nits" — they're the difference between a 5-minute and a 5-hour diagnose.

## Config & types
- Hardcoded config value that should be env-driven via `pydantic-settings` → **HIGH**
- New env var without an entry in `docs/configuration.md` → **HIGH**
- `# type: ignore` without a one-line explanation → **MEDIUM**
- `ruff` violations → **MEDIUM**

## Async
- Sync I/O on an async path → **BLOCK**
- Global lock instead of per-session lock → **HIGH**
- New endpoint synchronously awaiting an LLM call (>2s upstream) without an async-then-poll fallback → **HIGH**. Use the long-running-endpoint pattern from `CLAUDE.md`:
  - `POST` → 200 immediately, sets `*_status="pending"`, kicks `asyncio.create_task(...)`
  - `GET` → 425 (Retry-After) while pending/generating, 200 when ready, 500 on fail (status revealed in a header)
  - Optional WS event nudges polling clients to re-fetch

## Auth & WebSocket
- New WS endpoint without origin + token check → **BLOCK**
- New HTTP endpoint without rate-limiting on an LLM-bearing path → **HIGH**
- Authorization done by trusting a client-supplied `role_id` / `session_id` instead of resolving from the auth context → **BLOCK**

## Extensions
- New extension handler that isn't `templated_text` or `static_text` → **BLOCK** (declarative handlers only, per `docs/extensions.md`)
- Extension content flowing into the model as system content instead of `tool_result` → **BLOCK** (prompt-injection guardrail)
