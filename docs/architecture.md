# Architecture

> **Source of truth: [`PLAN.md`](PLAN.md).** This document is the living, diagram-rich version of that plan and is updated as design evolves. If they ever conflict, `PLAN.md` wins until this doc is updated to match.

## High-level shape

Single Docker container. Python 3.12 + FastAPI backend serves both the REST/WebSocket API and the built React+Vite SPA from the same origin. State is held in process memory; the durable artifact is a markdown export at session end.

```
┌──────────── browser (creator + N participants) ─────────────┐
│  React + Vite SPA (Tailwind, dark mode default)             │
│   ├ Facilitator page  (/)                                    │
│   └ Participant page  (/play/{token})                        │
│           │                                                  │
│           │  HTTPS (REST)        WSS (streaming + control)   │
└───────────┼───────────────────────────────────────┼──────────┘
            ▼                                       ▼
┌──────────────────── FastAPI app (single process) ────────────┐
│  api/   REST                ws/   WebSocket + ConnectionMgr  │
│  auth/  (HMAC tokens, role-AuthZ, audit ring buffer)         │
│  sessions/   models · repository(InMemory) · turn_engine     │
│              · manager (per-session asyncio.Lock)            │
│  llm/    AsyncAnthropic · prompts · tools · export           │
│  extensions/   ToolRegistry · ResourceRegistry ·             │
│                PromptRegistry · loaders/env                  │
│  audit/  JSONL stdout + ring buffer                          │
└────────────────────────────┬─────────────────────────────────┘
                             │
                             ▼
                    Anthropic API (HTTPS)
```

## Session state machine

```
CREATED ──▶ SETUP ◀──┐ creator ↔ AI dialogue
                     │ (ask_setup_question / propose_scenario_plan loop)
                     ▼
                  READY (frozen scenario plan committed via finalize_setup)
                     │
                     ▼
                 BRIEFING (AI initial situation broadcast)
                     │
                     ▼
   AWAITING_PLAYERS(active_role_ids) ◀──┐
                     │                  │ wait for ALL active roles
                     ▼                  │ (manual "submit & advance now"
                AI_PROCESSING            │  available to anyone)
                     │                  │
                     └──────────────────┘
                     │
                     ▼
                  ENDED  ─▶  AAR + scores → markdown export
```

`SessionManager` owns a per-session `asyncio.Lock`; transitions on one session never block another. `TurnEngine` is a pure state machine with no I/O.

## WebSocket fan-out

`ConnectionManager` keeps one `asyncio.Queue` per connection. Producer code calls only `broadcast(session_id, event)` and `send_to_role(session_id, role_id, event)` — a slow client never blocks fan-out, and Phase 3 can swap the in-process queues for Redis pub-sub without touching the call sites.

## LLM boundary

Single `AsyncAnthropic` instance, instantiated at app startup, reused for HTTP keep-alive. Streaming is the default; deltas relay to the WebSocket as `message_chunk` events. The system prompt is composed each turn from a stable cached block (identity + mission + boundaries + frozen scenario plan + active extension prompts) plus the live transcript. Parallel `tool_use` blocks are dispatched concurrently with `asyncio.gather`.

Tiered models (env-overridable):

- `ANTHROPIC_MODEL_PLAY` — facilitation (default `claude-sonnet-4-6`).
- `ANTHROPIC_MODEL_SETUP` — setup dialogue (default `claude-haiku-4-5`).
- `ANTHROPIC_MODEL_AAR` — final report (default `claude-opus-4-7`).
- `ANTHROPIC_MODEL_GUARDRAIL` — input classifier (default `claude-haiku-4-5`).

## Tools surfaced to Claude

Built-ins: `address_role`, `broadcast`, `inject_event`, `set_active_roles`, `request_artifact`, `use_extension_tool`, `lookup_resource`, `end_session`. Setup-only: `ask_setup_question`, `propose_scenario_plan`, `finalize_setup`. Interrupt: `inject_critical_event`. Full schema and rules in [`PLAN.md`](PLAN.md) § Built-in tools.

## Extensions (Skills-style)

Three registries (`ToolRegistry`, `ResourceRegistry`, `PromptRegistry`), populated at startup by pluggable `ExtensionLoader`s. MVP ships a single `EnvLoader` reading JSON from env vars or files; Phase 3 adds DB / UI / MCP loaders behind the same Protocol. Extension content always reaches Claude as `tool_result` role — never as system content. See [`extensions.md`](extensions.md).

## Phase scope

- **Phase 1 (now)** — devcontainer, Dockerfile, CI, Docker workflow, scaffolding, docs. No application logic. Tracked under issues labelled `phase-1`.
- **Phase 2** — full MVP per `PLAN.md` § Phase 2. Tracked under epics labelled `phase-2` (#11–#19), each split into per-component issues at kickoff.
- **Phase 3** — value-add (persistence, OAuth/SSO, scenario library, voice, observability, scale-out, etc.). Tracked under epics labelled `phase-3` (#20–#25).
