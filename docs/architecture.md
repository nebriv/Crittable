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
│  llm/    ChatClient ABC + Anthropic/LiteLLM backends         │
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
                     endpoint via LLM_API_BASE)
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
| **Tool-list filter** | `llm/client.py::acomplete + astream` and `llm/clients/litellm_client.py::_build_call_kwargs` | Calls `filter_allowed_tools(tier, tools, extension_tool_names)` before forwarding to the provider. Drops any tool not in the tier's `allowed_tool_names` and logs the dropped names so a regression is visible in the audit trail. Both backends share the same gate. |
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
| `DRIVE` | `broadcast`, `address_role`, `share_data`, `pose_choice` | Player-facing message — answer, brief, data dump, or A/B fork |
| `YIELD` | `set_active_roles` | Advances the turn to the next active roles |
| `ESCALATE` | `inject_critical_event` | Headline-grade banner — must chain to DRIVE + YIELD on the same turn |
| `BOOKKEEPING` | `track_role_followup` / `resolve_role_followup` / `request_artifact` / `lookup_resource` / `use_extension_tool` / extension tools | Side effects that neither drive nor yield |
| ~~`NARRATE`~~ | ~~`inject_event`~~ | Removed from the active play palette in the 2026-04-30 redesign. Slot retained as defensive dead code in [`slots.py`](../backend/app/sessions/slots.py). |
| ~~`PIN`~~ | ~~`mark_timeline_point`~~ | Same — removed in the 2026-04-30 redesign; dead-code slot only. |
| ~~`TERMINATE`~~ | ~~`end_session`~~ | Removed in 2026-05-02 (issue #104). The AI cannot end the exercise; only the creator can, via `POST /api/sessions/{id}/end` or the WS `request_end_session` event. |

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

Two operator settings revert the new behavior for emergency
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

The engine talks to LLMs through a provider-agnostic `ChatClient` ABC
(`backend/app/llm/protocol.py`). Two concrete implementations live
behind the seam:

- `app.llm.client.LLMClient` — talks to Anthropic-direct via
  `anthropic.AsyncAnthropic` (the original path, default).
- `app.llm.clients.litellm_client.LiteLLMChatClient` — routes via
  LiteLLM, supporting ~100 providers (Azure OpenAI, AWS Bedrock,
  Vertex AI, OpenRouter, OpenAI direct, vLLM/Ollama, …). Selected
  via `LLM_BACKEND=litellm`. See [`llm_providers.md`](llm_providers.md).

A single `ChatClient` instance is built at app startup (lifespan) by
`_build_chat_client(settings)` and reused process-wide for HTTP
keep-alive. Streaming is the default for play turns; deltas relay to
the WebSocket as `message_chunk` events (used by the frontends as a
typing-pulse signal — chunk content is ignored, the final message is
rendered from the snapshot refresh after `message_complete`). The
system prompt is composed each turn from a stable cached block
(identity, mission, boundaries, frozen scenario plan, active extension
prompts, roster, open follow-ups) plus the live transcript. Parallel
`tool_use` blocks are dispatched concurrently with `asyncio.gather`.

Internal vocabulary stays Anthropic-shaped (content blocks,
``tool_use``/``tool_result``, ``cache_control: ephemeral``,
``stop_reason: end_turn|tool_use|max_tokens``). Provider-specific
clients adapt at the wire boundary; downstream callers — turn driver,
dispatch, AAR generator, guardrail — never see provider-shaped data.
See `CLAUDE.md` § "Model-output trust boundary" for why this matters.

### Tiered models + per-call sampling

Each tier has independent env knobs (see
[`configuration.md`](configuration.md)):

- `LLM_MODEL_<TIER>` — model id (Sonnet / Haiku / Opus / Haiku
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

`LLM_API_BASE` retargets the SDK to any Anthropic-compatible
endpoint (Bedrock proxy, OpenRouter anthropic-compat, internal LLM
gateway, local Ollama via litellm). A startup warning fires if the
URL uses plain `http://` to a non-loopback host (cleartext prompt
egress). See [`llm_providers.md`](llm_providers.md).

## Tools surfaced to Claude

Built-ins (play tier — every play turn must end with a yield):

- `broadcast` / `address_role` — narrate to all roles or speak
  directly to one (player-facing DRIVE).
- `share_data` — player-facing data dump (logs, IOCs, IR runbook
  excerpts) addressed to one or more roles. Counts as DRIVE.
- `pose_choice` — multi-option decision prompt. Counts as DRIVE.
- `set_active_roles` — yield. The only tool that advances the turn.
  Every play turn must end with a `set_active_roles` call.
- `inject_critical_event` — escalation banner. **Must chain to
  DRIVE + YIELD on the same turn**; standalone calls are rejected
  by the validator and trigger the recovery cascade.
- `request_artifact` — ask a role for a structured deliverable
  (IR plan, comms draft).
- `track_role_followup` / `resolve_role_followup` — per-role todo
  list the AI maintains across turns; surfaced back to the model as
  Block 11 of the system prompt.
- `use_extension_tool` / `lookup_resource` — operator extensions.

Removed from the play palette:

- `end_session` — removed 2026-05-02 (issue #104). Only the creator
  can end the exercise, via `POST /api/sessions/{id}/end` or the WS
  `request_end_session` event.
- `inject_event` / `mark_timeline_point` — removed in the 2026-04-30
  redesign (the four DRIVE tools subsume their use cases). Slot
  enums kept in [`slots.py`](../backend/app/sessions/slots.py) as
  defensive dead code.

Setup-only (state == `SETUP`, `tool_choice = {"type":"any"}` always):

- `ask_setup_question`, `propose_scenario_plan`, `finalize_setup`.
- `declare_workstreams` — added when `WORKSTREAMS_ENABLED=true`
  (default). See [`docs/plans/chat-decluttering.md`](plans/chat-decluttering.md).

AAR-only (state == `ENDED`, `tool_choice = {"type":"tool","name":"finalize_report"}`):

- `finalize_report`.

Tool descriptions in
[`backend/app/llm/tools.py`](../backend/app/llm/tools.py) carry the
detail; the tool-use protocol in
[`prompts.md`](prompts.md) covers the chaining patterns; the
authoring rules live in [`tool-design.md`](tool-design.md).

## Operator runtime controls

Beyond the engine-side guardrails, the creator has a handful of
runtime escape hatches surfaced in the UI ("God Mode" panel) and via
REST. Unless noted otherwise the endpoint is **creator-only**
(`require_creator`); the notepad endpoints accept any seated
participant.

| Action | Endpoint | Purpose |
|---|---|---|
| **Force-advance** | `POST /api/sessions/{id}/force-advance` | Skip a stalled turn (any participant). Bypasses the ready-quorum gate. Also the recovery follow-up after `abort-turn`. |
| **Pause / Resume `@facilitator` interjects** | `POST /api/sessions/{id}/pause` & `/resume` | Wave 3 / issue #69. **Limited scope** — only silences the side-channel `run_interject` reply when a player `@facilitator`'s the AI. Normal play turns still advance on the ready quorum; this is not a full engine pause. |
| **End session** | `POST /api/sessions/{id}/end` | Creator-only as of issue #104. Kicks AAR generation. |
| **Proxy respond** / **Proxy submit pending** | `POST /api/sessions/{id}/admin/proxy-respond` & `/admin/proxy-submit-pending` | Submit on behalf of an absent role (solo testing, missing-player escape). Subject to the same per-role-per-turn cap as a real submission. |
| **Abort turn** | `POST /api/sessions/{id}/admin/abort-turn` | Marks the in-flight AI turn `errored`. Does NOT itself reopen the turn — the operator follows up with `/force-advance` to open a fresh `AWAITING_PLAYERS` turn for the humans. Two-step recovery for stuck retries. |
| **Retry AAR** | `POST /api/sessions/{id}/admin/retry-aar` | Re-run AAR generation if the first attempt failed (the export endpoint returns `500` when this happens). |
| **Edit plan fields** | `POST /api/sessions/{id}/plan` | Inline edit of `key_objectives` / `guardrails` / `injects` / `out_of_scope` / `success_criteria` mid-exercise. Title and `narrative_arc` are immutable post-finalize. |
| **Reissue join token** | `POST /api/sessions/{id}/roles/{role_id}/reissue` | Re-mint the role's join URL **without invalidating the existing token**. Use when the creator lost the link and just needs to recover it; anyone already holding the old URL keeps working. |
| **Revoke join token** | `POST /api/sessions/{id}/roles/{role_id}/revoke` | Bumps `role.token_version` so any old token starts failing with 401 on the next request, then mints a fresh one. Use this — not `reissue` — to actually kick whoever is holding the old link. |
| **Notepad starter templates** | `GET /api/sessions/{id}/notepad/templates` | Participant-readable catalog of empty-state templates the editor can apply locally. Only the creator can record the chosen template id on the session. |
| **Notepad markdown export** | `GET /api/sessions/{id}/notepad/export.md` | Participant-readable snapshot of the current shared notepad with a contributor header. Available before AND after the session ends, for `EXPORT_RETENTION_MIN` minutes after end. |

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
  closed: #11–#19). Layered on top of Phase 2 since:
  - **Phase-policy engine guardrails** (state assertions, tool
    filter, tool-choice posture, dispatcher rejection of forbidden
    calls). PR #29.
  - **Slot-based turn validator + recovery cascade** with the
    retry-feedback loop. The model sees its own prior `tool_use` +
    dispatcher `tool_result` blocks on retry and self-corrects.
    See [`turn-lifecycle.md`](turn-lifecycle.md).
  - **Per-tier sampling + timeout knobs**, `LLM_API_BASE`,
    `LLM_STRICT_RETRY_MAX`, `MAX_SETUP_TURNS`,
    `MAX_PARTICIPANT_SUBMISSION_CHARS`,
    `MAX_SUBMISSIONS_PER_ROLE_PER_TURN`.
  - **Wave 1 — per-submission intent + ready-quorum gate** (issue
    #134, PR #148). `submit_response` carries
    `intent: "ready" | "discuss"`; the AI advances when
    `set(active) ⊆ set(ready_role_ids)`. Force-advance bypasses.
  - **Wave 2 — composer mentions + AI auto-interject on
    `@facilitator`** (PR #152). Replaces the trailing-`?` heuristic.
  - **Wave 3 — pause / resume AI toggle** (issue #69, PR #157).
  - **Chat-declutter** — workstream metadata, transcript filter
    pills, manual override, AAR isolation, creator markdown
    exports (`/exports/timeline.md`, `/exports/full-record.md`).
    PRs #119, #150, #152, #156, #158. Master kill-switch:
    `WORKSTREAMS_ENABLED` (default true).
  - **Mark-for-AAR** via the highlight registry (issue #117, PR #169).
  - **Shared notepad** (issue #98, PR #115).
  - **Live-tests workflow** with per-run dollar cap (issue #74).
  - **Setup-wizard chrome** through SETUP + READY; creator role
    moved to step 3 (PR #167).
  - **Validator state surfaced to creator UI** (issue #70, PR #173).
- **Phase 3** — value-add (persistence, OAuth/SSO, scenario library,
  voice, observability, scale-out, native non-Anthropic LLM
  adapters). Tracked under epics labeled `phase-3` (#20–#25).
