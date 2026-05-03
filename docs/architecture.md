# Architecture

> **Source of truth: [`PLAN.md`](PLAN.md).** This document is the
> living, diagram-rich version of that plan and is updated as design
> evolves. If they ever conflict, `PLAN.md` wins until this doc is
> updated to match.
>
> **For the play-turn engine specifically** (slots, contracts,
> validator, recovery cascade, and the 2026-04-30 silent-yield
> regression) read [`turn-lifecycle.md`](turn-lifecycle.md) — full
> decision tree with flowcharts.

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
                     │                  │ wait for ALL active roles to
                     ▼                  │ signal `intent="ready"` (Wave 1,
                AI_PROCESSING            │ issue #134) — i.e.
                     │                  │ `set(active) ⊆ set(ready_role_ids)`.
                     │                  │ A `discuss`-intent submission
                     │                  │ records the message but does
                     │                  │ NOT add the role to the ready
                     │                  │ quorum; a follow-up `discuss`
                     │                  │ from a role who had marked
                     │                  │ ready walks them back. Force-
                     │                  │ advance from any participant
                     │                  │ bypasses the quorum (operator
                     │                  │ escape hatch). AI also runs a
                     │                  │ side-channel `run_interject`
                     │                  │ here when a player explicitly
                     │                  │ `@facilitator`s the AI (Wave 2).
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

## Turn validator — slot-based composition + recovery

[`backend/app/sessions/turn_validator.py`](../backend/app/sessions/turn_validator.py)
owns "what makes a valid turn at state X". It is a pure function: it
inspects the post-dispatch
[`DispatchOutcome.slots`](../backend/app/llm/dispatch.py) (computed
from the tool-name-to-slot map in
[`slots.py`](../backend/app/sessions/slots.py)) against a
state-aware `TurnContract`, and emits zero-or-more
`RecoveryDirective`s for each missing requirement. The driver loop
runs each directive as a narrowed follow-up LLM call (tools
allowlisted, `tool_choice` pinned, prior attempt's tool-loop spliced
in for context) until the contract is satisfied or the shared
recovery budget is exhausted.

Two ad-hoc paths the validator replaced:

- the strict-retry loop (no yield) — now expressed as
  `strict_yield_directive()`,
- the briefing-broadcast recovery (yield without a brief, BRIEFING
  only) — now expressed as `drive_recovery_directive()` and applied
  on **every** yielding play turn, not just BRIEFING.

### Slot taxonomy

| Slot | Tools | What it represents |
|---|---|---|
| `DRIVE` | `broadcast`, `address_role` | A player-facing question / addressable narrative beat |
| `YIELD` | `set_active_roles` | Advances the turn |
| `NARRATE` | `inject_event` | Stage-direction system note |
| `PIN` | `mark_timeline_point` | Sidebar timeline pin (no chat bubble) |
| `ESCALATE` | `inject_critical_event` | Headline-grade banner — must chain to DRIVE+YIELD |
| `TERMINATE` | ~~`end_session`~~ | Removed from the AI palette in 2026-05-02 (issue #104). Slot retained as defensive dead code; only the creator can end the exercise (REST + WS). |
| `BOOKKEEPING` | `track_role_followup` / `resolve_role_followup` / `request_artifact` / `lookup_resource` / `use_extension_tool` / extension tools | Side effects that neither drive nor yield |

### Contracts (play tier)

| State / mode | Required | Forbidden | Soft drive carve-out |
|---|---|---|---|
| BRIEFING | `DRIVE`, `YIELD` | — | No (no "mid-discussion" on first turn) |
| AWAITING / AI_PROCESSING (normal) | `DRIVE`, `YIELD` | — | Yes (`?`-terminated open question + no new beat → warning, not violation) |
| Interject path | `DRIVE` | `YIELD`, `TERMINATE` | No |

### Recovery budget

`LLM_STRICT_RETRY_MAX` is now the **per-turn shared recovery budget**
(default 2). A turn missing both `DRIVE` and `YIELD` runs **two
sequential** recovery LLM calls — `broadcast` first (drive), then
`set_active_roles` (yield) — each consuming one budget slot. Setting
`=0` disables recovery entirely; setting higher accommodates flakier
models.

### Retry-feedback loop

Each recovery LLM call splices the prior attempt's `tool_use` blocks
+ the dispatcher's `tool_result` blocks into the messages array as a
proper Anthropic tool-loop pair, then appends the directive's
user-nudge:

```
…earlier transcript…
assistant: [tool_use(name="broadcast", input={...})]
user:      [tool_result(tool_use_id=..., is_error=False, content="broadcast queued"),
            text("[system] You skipped the player-facing question…")]
```

If a prior tool call failed dispatcher validation (e.g.
`unknown role_ids`), the `is_error=True` content reads back as
"unknown role_ids: ['IR Lead'] — pass the opaque role_id (column 1
of the roster), not the label." The model self-corrects.

### Kill-switches

Two operator settings revert the new behaviour for emergency
rollouts:

- `LLM_RECOVERY_DRIVE_REQUIRED=False` — drops `DRIVE` from the
  required set, restoring "yield-only" semantics.
- `LLM_RECOVERY_DRIVE_SOFT_ON_OPEN_QUESTION=False` — turns the
  carve-out off so missing-DRIVE always recovers.

## phase_policy vs turn_validator — different concerns

[`phase_policy.py`](../backend/app/sessions/phase_policy.py)
(authorization: "is this LLM call permitted?") and
[`turn_validator.py`](../backend/app/sessions/turn_validator.py)
(completeness: "did the turn produce a valid output?") are
deliberately separate modules. They never import each other.

| | `phase_policy.py` | `turn_validator.py` |
|---|---|---|
| Question | "Is this LLM call permitted?" | "Did the turn produce a complete output?" |
| When | BEFORE the request leaves the process | AFTER dispatch applied tool calls |
| Inputs | tier + state + tool list (static) | DispatchOutcome + session context |
| Output | drop forbidden tools; pin tool_choice; raise `PhaseViolation` | `RecoveryDirective`s + warnings |
| Catches | "play tier called `ask_setup_question`" | "play tier yielded without driving" |

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

(`end_session` was removed in 2026-05-02 / issue #104; only the creator
can wrap the exercise, via `POST /api/sessions/{id}/end` or the WS
`request_end_session` event.)

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
