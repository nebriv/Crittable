# Architecture

> **Source of truth: [`PLAN.md`](PLAN.md).** This document is the
> living, diagram-rich version of that plan and is updated as design
> evolves. If they ever conflict, `PLAN.md` wins until this doc is
> updated to match.

## High-level shape

Single Docker container. Python 3.12 + FastAPI backend serves both the
REST/WebSocket API and the built React+Vite SPA from the same origin.
State is held in process memory; the durable artifact is a markdown
export at session end.

```
┌──────────── browser (creator + N participants) ─────────────┐
│  React + Vite SPA (Tailwind, dark mode default)             │
│   ├ Facilitator page  (/)                                    │
│   └ Participant page  (/play/{sid}/{token})                  │
│           │                                                  │
│           │  HTTPS (REST)        WSS (streaming + control)   │
└───────────┼───────────────────────────────────────┼──────────┘
            ▼                                       ▼
┌──────────────────── FastAPI app (single process) ────────────┐
│  api/   REST                ws/   WebSocket + ConnectionMgr  │
│  auth/  (HMAC tokens, role-AuthZ, audit ring buffer)         │
│  sessions/   models · repository(InMemory) · turn_engine     │
│              · phase_policy · turn_driver · manager          │
│              (per-session asyncio.Lock)                      │
│  llm/    AsyncAnthropic client · prompts · tools             │
│          · dispatch · guardrail · export                     │
│  extensions/   ToolRegistry · ResourceRegistry ·             │
│                PromptRegistry · loaders/env                  │
│  logging_setup.py — structlog + http_access middleware       │
│  audit/  JSONL stdout + ring buffer                          │
└────────────────────────────┬─────────────────────────────────┘
                             │
                             ▼
                    Anthropic API (HTTPS)
                    (or any Anthropic-compatible
                     endpoint via ANTHROPIC_BASE_URL)
```

## Session state machine

```
CREATED ──▶ SETUP ◀──┐ creator ↔ AI dialogue
                     │ (ask_setup_question / propose_scenario_plan
                     │  / finalize_setup loop). Setup_skip + dev mode
                     │  short-circuit straight to READY.
                     ▼
                  READY (frozen scenario plan committed)
                     │
                     ▼
                 BRIEFING (AI initial situation broadcast)
                     │
                     ▼
   AWAITING_PLAYERS(active_role_ids) ◀──┐
                     │                  │ wait for ALL active roles,
                     ▼                  │ OR a force-advance from
                AI_PROCESSING            │ any participant. AI also
                     │                  │ runs a side-channel
                     │                  │ `run_interject` here when
                     │                  │ a player asks a direct
                     │                  │ question (trailing `?`).
                     └──────────────────┘
                     │
                     ▼
                  ENDED  ─▶  AAR + scores → markdown export
                              (async; polled at /export.md
                               with 425/200/500 shape)
```

`SessionManager` owns a per-session `asyncio.Lock`; transitions on one
session never block another. `TurnEngine` is a pure state machine with
no I/O.

## Phase policy — engine-side guardrails

[`backend/app/sessions/phase_policy.py`](../backend/app/sessions/phase_policy.py)
is the single source of truth for "what is the LLM allowed to do in
tier X at session state Y?" The engine does **not** trust the prompt
to keep the model on track; it enforces the rules in Python at three
boundaries:

| Boundary | Module | What it does |
|---|---|---|
| **Entry-state check** | `turn_driver.py` (each `run_*_turn`) | Calls `assert_state(tier, state)` at function entry. Raises `PhaseViolation` if a refactor would call the play tier during ENDED, etc. |
| **Tool-list filter** | `llm/client.py::acomplete + astream` | Calls `filter_allowed_tools(tier, tools, extension_tool_names)` before forwarding to Anthropic. Drops any tool not in the tier's `allowed_tool_names` and logs the dropped names so a regression is visible in the audit trail. |
| **Runtime tool-call rejection** | `llm/dispatch.py` | When the model emits a tool call that's forbidden in the current state (e.g. `ask_setup_question` during play), the dispatcher returns `is_error=True` in the `tool_result` block. The strict-retry path then feeds those `tool_result` blocks back to the model so it can self-correct rather than retry blind. |

### Tier policies

| Tier | Allowed states | Tools | `tool_choice` posture | Bare text? |
|---|---|---|---|---|
| `setup` | SETUP | `ask_setup_question`, `propose_scenario_plan`, `finalize_setup` | **`{"type":"any"}` always** — pinned so the model cannot produce bare text (eliminates the historical setup-text-leak bug) | Not allowed; discarded on the rare SDK-violation path |
| `play` | BRIEFING, AI_PROCESSING, AWAITING_PLAYERS | `PLAY_TOOLS` + operator extensions | `auto` by default; strict-retry pins `{"type":"tool","name":"set_active_roles"}`; interject uses `{"type":"any"}` over a narrowed tool surface | Allowed (narration alongside tool use) |
| `aar` | ENDED | `finalize_report` only | `{"type":"tool","name":"finalize_report"}` | Not allowed |
| `guardrail` | _any_ — runs on raw participant text | _none_ | `auto` | One-word verdict |

## Strict-retry + retry-feedback loop

When a play turn completes without a yielding tool call (no
`set_active_roles` and no `end_session`), the engine retries with a
narrowed tool surface and `tool_choice` pinned to `set_active_roles`.

The retry's message context now includes the **prior attempt's
`tool_use` blocks + the dispatcher's `tool_result` blocks** as a
proper Anthropic tool-loop pair. Pre-fix the dispatcher's
`is_error=True` results were recorded but the model never saw them on
the retry — so it would try the same thing again. Now it sees:

```
…earlier transcript…
assistant: [tool_use(name="broadcast", input={...})]
user:      [tool_result(tool_use_id=..., is_error=False, content="broadcast queued")]
user:      [system] STRICT_RETRY_USER_NUDGE
```

If the prior turn's tool calls failed dispatcher validation (e.g.
`unknown role_ids`), `is_error=True` content reads back as
"unknown role_ids: ['IR Lead'] — pass the opaque role_id (column 1
of the roster), not the label." The model self-corrects.

The retry count is operator-tunable via `LLM_STRICT_RETRY_MAX`
(default 1, `ge=0 le=10`). Set `=0` to disable retry entirely; set
`=2`–`3` for flakier models.

## WebSocket fan-out

`ConnectionManager` keeps one `asyncio.Queue` per connection. Producer
code calls only `broadcast(session_id, event)` and
`send_to_role(session_id, role_id, event)` — a slow client never
blocks fan-out, and Phase 3 can swap the in-process queues for Redis
pub-sub without touching the call sites.

A replay buffer (per session, capped at the last ~200 events) lets a
WS reconnect rehydrate the transcript without polling REST.

Ephemeral events (typing indicators, in-flight cost ticks) use
`broadcast(..., record=False)` so they don't evict legitimate state
events from the replay buffer.

## LLM boundary

Single `AsyncAnthropic` instance, instantiated at app startup, reused
for HTTP keep-alive. Streaming is the default for play turns; deltas
relay to the WebSocket as `message_chunk` events. The system prompt
is composed each turn from a stable cached block (identity, mission,
boundaries, frozen scenario plan, active extension prompts, roster,
open follow-ups) plus the live transcript. Parallel `tool_use` blocks
are dispatched concurrently with `asyncio.gather`.

### Tiered models + per-call sampling

Each tier has independent env knobs (see
[`configuration.md`](configuration.md)):

- `ANTHROPIC_MODEL_<TIER>` — model id (Sonnet / Haiku / Opus / Haiku
  defaults).
- `LLM_MAX_TOKENS_<TIER>` — output cap (1024 / 1024 / 4096 / 12).
- `LLM_TEMPERATURE_<TIER>` — sampling temperature (None / None / 0.4
  / 0.0).
- `LLM_TOP_P_<TIER>` — only forwarded when explicitly set.
- `LLM_TIMEOUT_<TIER>` — per-tier timeout (None / None / 900 / 15).

The guardrail timeout is intentionally tight (15 s) because the
per-session lock is held during classification — a 600 s hang would
freeze a session for ten minutes.

### Provider swap

`ANTHROPIC_BASE_URL` retargets the SDK to any Anthropic-compatible
endpoint (Bedrock proxy, OpenRouter anthropic-compat, internal LLM
gateway, local Ollama via litellm). A startup warning fires if the
URL uses plain `http://` to a non-loopback host (cleartext prompt
egress). See [`llm_providers.md`](llm_providers.md).

## Tools surfaced to Claude

Built-ins (play tier):

- `address_role`, `broadcast`, `inject_event`,
  `inject_critical_event` — narration tools.
- `set_active_roles` — yield (the only "advance the turn" tool).
- `request_artifact` — ask a role for a structured deliverable.
- `mark_timeline_point` — pin a beat to the right-sidebar timeline
  (sidebar-only; produces no chat bubble).
- `track_role_followup` / `resolve_role_followup` — per-role todo
  list the AI maintains across turns; surfaced back to the model as
  Block 11 of the system prompt.
- `use_extension_tool`, `lookup_resource` — operator extensions.
- `end_session` — wrap the exercise.

Setup-only:

- `ask_setup_question`, `propose_scenario_plan`, `finalize_setup`.

AAR-only: `finalize_report`.

Tool descriptions in
[`backend/app/llm/tools.py`](../backend/app/llm/tools.py) carry the
detail; the tool-use protocol in
[`prompts.md`](prompts.md) covers the chaining patterns.

## Extensions (Skills-style)

Three registries (`ToolRegistry`, `ResourceRegistry`, `PromptRegistry`),
populated at startup by pluggable `ExtensionLoader`s. MVP ships a
single `EnvLoader` reading JSON from env vars or files; Phase 3 adds
DB / UI / MCP loaders behind the same Protocol. Extension content
always reaches Claude as `tool_result` role — never as system content.
See [`extensions.md`](extensions.md).

## Logging

Two layers, both visible in docker compose logs:

1. **Uvicorn access log** (text, INFO).
2. **Structlog JSON pipeline** with bound contextvars (`request_id`,
   `session_id`, `turn_id`, `role_id`). The
   `RequestContextMiddleware` also emits one `http_access` event per
   non-health HTTP request with method / scrubbed path / status /
   `duration_ms`. Token query strings (`?token=...`) and path tokens
   (`/play/<sid>/<token>`) are redacted before logging.

Every external boundary logs entry + exit + error: LLM calls
(`llm_call_start` / `_complete` / `_failed`), state transitions
(`session_event`), tool dispatch (`tool_use` / `tool_use_rejected`),
WebSocket connect/disconnect, extension dispatch, AAR generation.

`LOG_LEVEL=DEBUG` is the docker-compose default during development
(reverts to INFO via env override for production). Browser-side, the
WS / API wrappers log at `console.debug` — set DevTools to "Verbose"
to see the trace.

## Phase scope

- **Phase 1** — devcontainer, Dockerfile, CI, Docker workflow,
  scaffolding, docs. **Complete** (milestone #1, all 10 issues
  closed).
- **Phase 2** — full MVP. **Complete** (milestone #2, all 9 epics
  closed: #11–#19). Bow-tying additions in PR #29:
  - Per-tier sampling + timeout knobs, `ANTHROPIC_BASE_URL`,
    `LLM_STRICT_RETRY_MAX`, `MAX_SETUP_TURNS`,
    `MAX_PARTICIPANT_SUBMISSION_CHARS`.
  - `phase_policy.py` engine-side guardrails (state assertions,
    tool filter, tool-choice posture).
  - Retry-feedback loop (model sees its own prior tool_use +
    dispatcher rejections on strict retry).
  - HTTP access log middleware with token scrubber.
  - AI auto-interject on direct questions.
  - Multi-section setup intro + dev-mode auto-start.
- **Phase 3** — value-add (persistence, OAuth/SSO, scenario library,
  voice, observability, scale-out, native non-Anthropic LLM
  adapters). Tracked under epics labelled `phase-3` (#20–#25).
