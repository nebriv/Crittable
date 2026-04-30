# CLAUDE.md

Long-term memory for Claude Code sessions on this repo. Read this first.

## Project overview

A multi-user, browser-based chat application that runs cybersecurity tabletop exercises facilitated by Claude. A creator opens "New session," provides a scenario prompt, defines participant roles (CISO / IR Lead / Legal / Comms / etc.), and shares a unique join link per role. The creator also plays a role. Claude drives a turn-based loop and produces a downloadable markdown after-action report at the end.

Authoritative design doc: [`docs/PLAN.md`](docs/PLAN.md). Architecture details (diagrams + flow): [`docs/architecture.md`](docs/architecture.md).

## Branching

- `main` — protected; PRs only.
- `claude/ai-cybersecurity-chat-app-fEYFi` — primary development branch. **All Claude Code work happens here**, then opens a draft PR into `main`.

## Run / dev commands

| Goal | Command |
|---|---|
| Codespaces | Open in GitHub UI; the devcontainer auto-installs both stacks. |
| Local Docker (single container) | `docker compose up --build` then visit http://localhost:8000 |
| Backend only (dev reload) | `uvicorn app.main:app --reload --app-dir backend` |
| Frontend only (Vite dev) | `cd frontend && npm run dev` (proxies `/api` and `/ws` to :8000) |
| Backend tests | `cd backend && pytest -q` |
| Frontend tests | `cd frontend && npm test -- --run` |
| Backend lint/type | `cd backend && ruff check . && mypy app` |
| Frontend lint/type | `cd frontend && npm run lint && npm run typecheck` |

## Configuration

All config is via environment variables. The full reference lives in [`docs/configuration.md`](docs/configuration.md). Required at minimum: `ANTHROPIC_API_KEY`. Hardening checklist before any non-toy deployment is also there (set `CORS_ORIGINS`, enable rate limit, set `SESSION_SECRET`, etc.).

## Milestones

Phase grouping is tracked via GitHub **milestones**, not labels. **Always list the current scope before starting work**:

```
mcp__github__search_issues  query='repo:nebriv/ai-tabletop-facilitator is:issue is:open milestone:"Phase 1"'
mcp__github__search_issues  query='repo:nebriv/ai-tabletop-facilitator is:issue is:open milestone:"Phase 2"'
mcp__github__search_issues  query='repo:nebriv/ai-tabletop-facilitator is:issue is:open milestone:"Phase 3"'
```

- **Phase 1 — Architecture & Bootstrap** (milestone #1): devcontainer, Docker, CI, docs, scaffolding. **Complete** — all 10 issues closed.
- **Phase 2 — MVP** (milestone #2): 9 epics (#11–#19) — split into per-component issues at Phase 2 kickoff.
- **Phase 3 — Value-add** (milestone #3): 6 epics (#20–#25) — define their own success criteria when picked up.

## Sub-agent review protocol

**Every commit that touches application code must pass all six sub-agent reviews before pushing.** The implementing agent launches each in parallel via the Agent tool, triages findings (CRITICAL / BLOCK / HIGH must be fixed; MEDIUM/LOW/MINOR may be deferred with a tracked follow-up), and only commits + pushes once the reviews come back without blockers. Phase-1 docs / CI / scaffolding work is exempt; everything else is in scope.

1. **QA Agent** — verifies tests cover the golden path + edge cases; checks regression risk; validates the issue's acceptance criteria; flags missing or skipped tests.
2. **Security Engineer Agent** — reviews input validation, secret handling, AuthN/AuthZ correctness, WebSocket origin/token checks, rate limits, **prompt-injection surface (extra attention to the extensions pipeline)**, and dependency CVEs.
3. **UI/UX Agent** — reviews layout, responsive behavior, keyboard navigation, ARIA/accessibility, role clarity, and error / empty / loading / streaming states. **Interaction-blocking issues are always BLOCK-level**, including but not limited to: (a) content that can't be scrolled to or interacted with on a 1080p / 1440p / mobile viewport — *trace every phase view through the layout containers and check that the primary CTA in each phase is reachable*, (b) primary affordances (buttons, inputs, links) hidden behind clipped overflow or under fixed elements, (c) layout regressions where a previously-reachable control becomes unreachable. Mentally walk through SETUP → READY → PLAY → ENDED at common viewport sizes and report unreachable controls as BLOCK.
4. **Product / App-Owner Agent** — reviews the change vs. **what was actually asked** and **what the app is supposed to do**. Reads `docs/PLAN.md`, the open GitHub issues for the current milestone (`mcp__github__search_issues` with the milestone filter), the recent conversation asks, and the diff. Flags scope drift, missed requests, half-done items, and design-doc divergence. The other agents check the *how*; this agent checks the *what*.
5. **User Agent (creator persona)** — adopts the perspective of a real creator running a tabletop exercise for the first time. Walks through the diff as a UX-focused user trial: "If I'm a CISO opening this app on Monday morning, where do I get stuck? What's confusing? What would I want that's missing? What surprises me?" Surfaces *usability* friction the other agents miss because they're looking at the code, not the experience — examples include "the plan view spoils every inject for me", "I'd want to invite a role mid-exercise but there's no obvious button", "I can't tell whether the AI is thinking or stuck". Output is a prioritized list of usability gaps (not bugs); CRITICAL = "would abandon the app", HIGH = "would file an angry support ticket", MEDIUM/LOW = "would mention in feedback".
6. **Prompt Expert Agent** — reads every prompt under `backend/app/llm/prompts.py` (system blocks, tool-use protocol, roster scaling, strict-retry note, interject note, AAR pipeline, guardrail classifier) plus the tool descriptions in `backend/app/llm/tools.py`. Looks for: (a) **conflicting instructions** between blocks, (b) **ambiguity** in tool-use directives ("must yield" vs "yield when ready"), (c) **token-budget waste** (redundant restatements, verbose preambles, examples that don't pay for themselves), (d) **missing guardrails** (jailbreak-resistant phrasing, refusal-style hard boundaries, plan-disclosure prevention), (e) **roster-scaling correctness** (small/medium/large strategy blocks adapt to actual roster), (f) **best-practice patterns** (Anthropic prompt-eng guidance: XML tags for blocks, examples-then-task, explicit success criteria). Output: a triaged list of prompt issues with the exact line/block, the failure mode, and a concrete rephrase. CRITICAL = "model behaves wrong because of this"; HIGH = "model burns tokens / occasionally drifts"; MEDIUM/LOW = "could be tightened".

Run them with `Agent({ subagent_type: "general-purpose", run_in_background: true, ... })` so they execute in parallel; wait for all six to complete; address every BLOCK / CRITICAL / HIGH; document any deferred findings in the commit body. **Skipping the reviews is a process bug** — earlier rounds shipped CRITICAL plan-disclosure leaks, token-logging bugs, stuck-setup states, an unscrollable READY view that hid the Approve button, a force-advance loop, and an over-aggressive guardrail dropping casual replies — all caught (or missed) by the review pipeline. The Prompt Expert specifically guards against the "AI does the wrong thing because the prompt told it to" class of bug.

**Logging-and-debuggability findings are always in scope, regardless of severity.** Any review finding (LOW or otherwise) that calls out a swallowed exception, a missing log line at a meaningful boundary, an unprefixed `console.*`, a silent fallback path, or anything else that would hinder debugging in production must be addressed in the same commit — *not deferred to a follow-up*. Once a session is stuck in production, the only useful asset is the log; a "minor" missing log line is what turns a 5-minute diagnose into a 5-hour one. Triage these as if they were HIGH for the purpose of "must-fix-before-push".

## Extension authoring

Custom tools, resources, and prompts (Skills-style) are loaded at startup via env-var JSON. See [`docs/extensions.md`](docs/extensions.md) for the schema and the **prompt-injection guardrails** — extension content always flows through Claude as `tool_result`, never as system content; declarative handlers only (`templated_text`, `static_text`).

## Engine-side phase policy (read before touching any LLM call site)

> **Pair this section with [`docs/turn-lifecycle.md`](docs/turn-lifecycle.md)** — the load-bearing reference for the play-turn engine. Flowcharts of every gate, slot, contract, validator branch, and recovery directive, plus a full write-up of the 2026-04-30 silent-yield regression. Read both before touching `app/sessions/turn_validator.py`, `app/sessions/turn_driver.py`, `app/sessions/slots.py`, or `app/llm/dispatch.py`.
>
> **Adding or rewording a tool:** read [`docs/tool-design.md`](docs/tool-design.md) first. The five trap patterns there are the difference between a tool the model picks correctly and one it ignores or over-applies. Run `pytest backend/tests/live/ -v` against `ANTHROPIC_API_KEY` after any change to `app/llm/tools.py`, Block 6 of `app/llm/prompts.py`, or the recovery directives.

[`backend/app/sessions/phase_policy.py`](backend/app/sessions/phase_policy.py) is the **single source of truth** for "what is the LLM allowed to do in tier X at session state Y?" Do not duplicate these rules elsewhere. Three enforcement points consume it:

1. **`turn_driver.py`** — every `run_*_turn` calls `assert_state(tier, session.state)` at entry. A `PhaseViolation` here means the calling code is wrong, not the LLM.
2. **`llm/client.py` (`acomplete` + `astream`)** — calls `filter_allowed_tools(tier, tools, extension_tool_names=…)` before forwarding to Anthropic and logs `phase_policy_dropped_tools` for any dropped names. Pass extension tool names explicitly when running the play tier so they survive the filter.
3. **`llm/dispatch.py`** — rejects forbidden tool calls at runtime and returns `is_error=True` in the `tool_result`. The strict-retry path in `turn_driver.py` feeds those `tool_result` blocks back to the model so it self-corrects rather than retrying blind. **Never silently drop a tool call** — the model will get stuck repeating it.

Adding a new tier or tool: update `phase_policy.POLICIES`, add `ALLOWED_*_TOOL_NAMES` to the relevant frozenset, and run `pytest backend/tests/test_phase_policy.py`. Adding a new tool to an existing tier: add it to that tier's `_<TIER>_TOOL_NAMES` constant.

## Coding conventions

- Python: `ruff` (config in `backend/pyproject.toml`), `mypy --strict`. No `print` or stdlib `logging` in business code — use `structlog`.
- TypeScript: ESLint flat config; `tsc -b --noEmit` clean.
- Async-first: every I/O path is `async`; locks are per-session (no globals).
- All config through `pydantic-settings` env vars; never hard-code.
- Commit style: `<area>: <imperative subject>` (e.g. `backend: add session repository`). Body explains *why*. Phase-1 bootstrap can use `chore:` / `docs:` / `ci:`.

## Closing GitHub issues via PRs

GitHub auto-closes issues on merge **only when each issue number is preceded by its own closing keyword**. The keyword applies to one reference at a time — listing several issues after a single keyword silently leaves all but the first open. This has bitten this repo twice: PR #29 (Phase 2 epics #11–#19, none auto-closed because the body just listed bare `#11 #12 …` with no keyword) and PR #57 (`Closes #52, #53, #54, #55, #56` — only #52 closed; the rest had to be closed manually).

Use one of these forms — and `Closes` / `Fixes` / `Resolves` are interchangeable:

```
Closes #52
Closes #53
Closes #54
```

or inline with the keyword repeated each time:

```
Closes #52, closes #53, closes #54, closes #55, closes #56.
```

What does **not** work:

```
Closes #52, #53, #54   ← only #52 auto-closes
Lands #11 #12 #13      ← bare references, none auto-close
Closes #63? — No, …    ← still matches; the `?` and the negation don't unparse the keyword
Does not close #63     ← still matches; "close #63" is enough
```

**Never write a closing keyword adjacent to an issue number you don't actually want to close, including in negations or rhetorical questions.** PR #64 closed #63 because the body said "Closes #63? — No, …" — GitHub's parser saw the keyword and the issue number and acted on it; the surrounding "? — No" was invisible to it. If you need to *reference* an issue without closing it, never put a closing keyword anywhere near the number. Phrase it: `tracked separately as #63 (closing keywords intentionally omitted)`, or just `see issue #63`.

A cross-repo close needs the full `owner/repo#N` form (`Closes nebriv/ai-tabletop-facilitator#52`). Auto-close only fires when the PR merges into the **default branch** (`main`); merging into a feature branch never closes anything via these keywords.

If you forget and the PR is already merged, the cleanest recovery is to comment "Delivered in #PR — auto-close didn't fire because of comma-list keyword" on each issue and close it manually via `mcp__github__issue_write` with `state="closed"` and `state_reason="completed"`.

## Dependency intake (NEW deps must pass these checks)

Before adding ANY new third-party dependency (npm, pip, action, container image), spend ~2 minutes on the smell test and write the answers in the PR description:

1. **Last release date.** > 12 months stale = yellow flag; > 24 months = red flag — needs justification.
2. **Maintenance signals.** Open-issue/PR ratio, recent commit cadence, named maintainers (not anonymous bus factor of 1).
3. **Known CVEs.** Cross-check `npm audit` / `pip-audit` and the GitHub Advisory DB. A clean record at the *current* version is the bar; transitive CVEs in lockfile must be triaged too.
4. **Replaceability.** If the package is ≤ 200 LoC of straightforward logic, prefer inlining over depending on it.
5. **License compatibility.** MIT / BSD / Apache-2 / ISC are fine; copyleft (GPL, AGPL) is not for this project.

When adding a yellow-flag dep anyway (e.g. `remark-gfm` for GFM tables in chat / AAR), open a follow-up issue tagged `dep-review` so we revisit if upstream stays quiet. Don't silently absorb the maintenance debt.

## Communication patterns: WebSocket vs AJAX/polling

Pick the right transport for each interaction. Mixing them is fine; using the wrong one for a specific job is the bug.

### WebSocket — chat-style fan-out

Use the `/ws/sessions/{id}` channel for **anything that reads as a real-time conversation** between the server and many clients:

- streaming AI text deltas (`message_chunk`)
- final messages (`message_complete`)
- state / turn / participant transitions (`state_changed`, `turn_changed`, `participant_joined`, `participant_left`)
- critical-event banners (`critical_event`)
- typing indicators (`typing`)
- creator-only signals like `cost_updated` (sent via `send_to_role`)

The contract: events are small, frequent, and one-shot. The connection manager's per-connection queue + replay buffer is sized for this.

### AJAX / polling — long-running operations and large payloads

Use plain HTTP for **anything that involves a slow upstream call** (Anthropic API > 2 s) or **anything where the client may legitimately reconnect / refresh and need to fetch state on demand**:

- `POST /api/sessions/{id}/end` returns immediately; the AAR generates in a background task. The download endpoint (`GET /export.md`) returns **425 Too Early** with a `Retry-After` header while `aar_status` is `pending`/`generating`, **200** when ready, **500** on failure. Frontend polls every ~2.5 s.
- `GET /api/sessions/{id}/activity` and `/debug` are **polled** by the creator UI (~3 s) — they don't push because their content is heavy and not all clients want it.
- `POST /api/sessions/{id}/setup/reply` and `POST /start` are still synchronous in this codebase; they're flagged as Phase-3 candidates for the same async-then-poll treatment because they currently block on a 5–30 s LLM call.

Long synchronous POSTs that wrap an LLM call **without a polling fallback** are flagged in code review. The reverse — pushing a 30 KB plan dump via WebSocket — is also flagged: that's what `GET /api/sessions/{id}/debug` is for.

### Pattern for new long-running endpoints

```text
POST /api/.../foo            → 200 immediately, sets foo_status="pending"
                                kicks asyncio.create_task(_foo_bg(...))
GET  /api/.../foo            → 425 (Retry-After: 3) while pending/generating
                                200 when ready
                                500 when failed (X-Foo-Status reveals the state)
WS event "foo_status_changed" optional, nudges the polling client to re-fetch
```

This keeps the request handlers fast, lets the operator's reverse proxy keep its 30 s read timeout, and gives the client a cheap recovery path when its tab refreshes.

## Logging rules (read before adding any new code path)

We have repeatedly hit "is the app stuck or working?" mysteries during manual testing. The cure is **observable boundaries**: every meaningful action should produce one log line at the start and one at the end on both backend and browser.

### Backend (Python / `structlog`)

- **Always use** `from app.logging_setup import get_logger`. Never `print`. Never `import logging` in business code.
- **Bind context**, don't repeat fields. `RequestContextMiddleware` binds `request_id` per HTTP/WS request; the manager / WS layer binds `session_id`, `turn_id`, `role_id`. Once bound, every subsequent log line in that request inherits them — don't re-pass.
- **`event` is reserved** by structlog (the message key). Don't pass an `event=` kwarg — use `audit_kind`, `tool_name`, etc.
- **Log every external boundary**:
  - **LLM calls** — `llm_call_start` / `llm_call_complete` (or `llm_call_failed`) with `tier`, `model`, `duration_ms`, `usage`, `estimated_usd`, `tool_uses`, `stop_reason`. See `app/llm/client.py`.
  - **State transitions** — every `SessionState` change emits a `session_event` line with `audit_kind`, `state`, `turn_index`. See `SessionManager._emit`.
  - **WebSocket connect/disconnect** — `ws_connected` / `ws_disconnected` with `session_id`, `role_id`, `kind`.
  - **Tool dispatch** — `tool_use` / `tool_use_rejected` (already audit-emitted).
  - **Extension dispatch** — `extension_invoked` / `extension_dispatch_failed`.
- **Every `try/except` that catches a broad exception must log it** before re-raising or swallowing. Silent swallows are bugs.
- **Don't log secrets**. `SESSION_SECRET`, `ANTHROPIC_API_KEY`, raw join tokens, or full participant message bodies (preview to ≤120 chars).
- **Don't log oversized payloads**. The `_is_oversized` helper in `sessions/manager.py` caps individual fields; reuse it for any wide payload.

### Browser (TypeScript / `console.*`)

- **Use the right level**: `console.debug` for routine boundary tracing, `console.info` for state transitions and key user actions, `console.warn` for recoverable errors / surfaces shown to the user, `console.error` only for unrecoverable bugs.
- **Always log API calls** — `lib/api/client.ts` already wraps every fetch with `[api] METHOD path → status (Nms)`. New endpoints inherit this for free; don't bypass the wrapper.
- **Always log WS events** — `lib/ws.ts` logs `[ws] open`, `[ws] event`, `[ws] close`, `[ws] error`. Don't add direct `new WebSocket(...)` outside that module.
- **Log state transitions** in pages — phase changes, route changes, modal open/close. See `pages/Facilitator.tsx`'s `useEffect` that logs `[facilitator] phase`.
- **Log surfaced errors** — every `setError(...)` call should also `console.warn` with the same context. Users will paste the console into bug reports; make sure it tells the story.
- **Prefix log lines** with the module: `[ws]`, `[api]`, `[facilitator]`, `[play]`. Greppable.
- **Don't log tokens** to the console. The token is in the URL on `/play/:id/:token`; do not re-log it from any other handler.

### Test rule

When a manual-test issue requires more telemetry than the current logs provide, **add the log line first** (so the next operator finds it), then fix the bug. Don't fix-and-forget — the log is the regression detector.

## Always-do checklist (start of any task)

1. `git fetch && git checkout claude/ai-cybersecurity-chat-app-fEYFi && git pull`
2. List current-phase open issues via `mcp__github__list_issues`.
3. Pick or confirm the issue you're working on.
4. Re-read [`docs/PLAN.md`](docs/PLAN.md) for the relevant section before making decisions that contradict it.
5. After meaningful work: run tests + lint locally before pushing.
6. For Phase-2 issues: launch the three review sub-agents before requesting human review.
