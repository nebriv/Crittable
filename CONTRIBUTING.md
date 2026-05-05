# Contributing to Crittable

*Tabletop exercises for security teams. Roll the inject. Ship the AAR.*

This guide gets you from a clean clone to a green PR. Read it once, then
keep [`docs/`](docs/) and [`CLAUDE.md`](CLAUDE.md) within reach — the
authoritative rules live there, not here.

## What the app does

A multi-user, browser-based chat room that runs a cybersecurity tabletop
exercise. The creator opens a session, defines roles (CISO / IR Lead /
Legal / Comms / etc.), and shares a per-role join link. Claude drives a
turn-based loop — narrates beats, throws injects, yields to specific
roles via tool calls — and produces a markdown after-action report at
session end. Typical exercise: 30–60 minutes.

The session walks a phase machine:

```
CREATED → SETUP → READY → BRIEFING → AWAITING_PLAYERS ↔ AI_PROCESSING → ENDED
```

Each phase restricts which LLM tier may run, which tools the model may
call, and which tool-choice posture is forced. The single source of
truth is [`backend/app/sessions/phase_policy.py`](backend/app/sessions/phase_policy.py);
every call site (turn driver entry, LLM client, dispatcher) consults it.
The engine does not trust the LLM to honor the prompt — phase boundaries
are enforced in code.

## Repo layout

```
backend/        FastAPI + Anthropic SDK; all turn / state / LLM logic
  app/api/      REST endpoints
  app/ws/       WebSocket + connection manager (chat-style fan-out)
  app/sessions/ Phase machine, turn driver, validator, slots, repository
  app/llm/      Client, prompts, tools, dispatch, export (AAR)
  app/extensions/ Skills-style custom tools / resources / prompts
  tests/        pytest; live/ runs against a real ANTHROPIC_API_KEY
frontend/       React + Vite + TS + Tailwind; serves SPA from same origin
  src/pages/    Facilitator (creator) and Play (participant) pages
  src/components/brand/ Brand-system primitives (use these, don't re-derive)
  src/lib/      WS client, hooks, typed helpers
  src/api/      Generated/typed REST client (every fetch logs `[api]`)
docs/           Authoritative design + ops docs (see map below)
design/handoff/ Brand reference: BRAND.md, HANDOFF.md, tokens.css, JSX source
docker/         Single-image build (one container serves API + SPA)
.github/        CI workflows + path-scoped review instructions
```

## docs/ map — what to read, when

Read these before editing the corresponding surface. They are the
load-bearing references; CONTRIBUTING.md is just the index.

| File | Read before… |
|---|---|
| [`docs/PLAN.md`](docs/PLAN.md) | Anything architectural. Source of truth for decisions, phase plan, milestones. |
| [`docs/architecture.md`](docs/architecture.md) | Touching the request/turn flow. Diagrams, retry-feedback loop, phase-policy contract. |
| [`docs/configuration.md`](docs/configuration.md) | Adding any env var or operator-tunable knob. Hardening checklist for non-toy deploys. |
| [`docs/llm_providers.md`](docs/llm_providers.md) | Wiring Bedrock / Vertex / OpenRouter / Ollama via `ANTHROPIC_BASE_URL`. |
| [`docs/prompts.md`](docs/prompts.md) | Editing system prompts, guardrails, tool-use protocol, AAR rubric. JSON tool-use only — no XML function-call shapes. |
| [`docs/tool-design.md`](docs/tool-design.md) | **Adding, renaming, or rewording any play-tier tool.** Five trap patterns documented. |
| [`docs/turn-lifecycle.md`](docs/turn-lifecycle.md) | **Touching `turn_driver.py`, `turn_validator.py`, `slots.py`, or `dispatch.py`.** Every gate, contract, recovery path, and the 2026-04-30 silent-yield post-mortem. |
| [`docs/extensions.md`](docs/extensions.md) | Adding a custom tool / resource / prompt. Declarative handlers only (`templated_text`, `static_text`); content flows as `tool_result`, never system content. |
| [`CLAUDE.md`](CLAUDE.md) | Anything. Coding conventions, logging rules, dependency intake, sub-agent review protocol, model-output trust boundary, communication transport choices, the no-backwards-compat policy. |

Brand work also reads:

- [`design/handoff/BRAND.md`](design/handoff/BRAND.md) — voice, tokens, type, "Don't" lists.
- [`design/handoff/HANDOFF.md`](design/handoff/HANDOFF.md) — drop-in patterns (`.card`, `.pill`, `.btn`).
- [`design/handoff/source/app-screens.jsx`](design/handoff/source/app-screens.jsx) — canonical product UI patterns to lift, not re-derive.

## Local setup

See [`README.md`](README.md) for the run-the-app side. For development:

```bash
# Backend
cd backend && pip install -e ".[dev]"
uvicorn app.main:app --reload --app-dir .

# Frontend (separate terminal)
cd frontend && npm ci && npm run dev
```

The Vite dev server proxies `/api` and `/ws` to `localhost:8000`. You
need `ANTHROPIC_API_KEY` exported; everything else has a default.

GitHub Codespaces also works — the devcontainer installs both stacks
and forwards `ANTHROPIC_API_KEY` from your Codespaces secrets.

## Before you push

| Goal | Command |
|---|---|
| Backend tests | `cd backend && pytest -q` |
| Backend lint / type | `cd backend && ruff check . && mypy app` |
| Frontend tests | `cd frontend && npm test -- --run` |
| Frontend lint / type / build | `cd frontend && npm run lint && npm run typecheck && npm run build` |
| Live LLM tests (touched `tools.py` / Block 6 / a recovery directive) | `cd backend && pytest tests/live/ -v` against a real `ANTHROPIC_API_KEY` |

For UI changes, start the dev server and exercise the feature in a
browser. Type-checks verify code correctness, not feature correctness.

### Live tests on fork PRs

The `live-tests` workflow (`.github/workflows/live-tests.yml`) does
NOT auto-run on fork PRs — secrets aren't injected for forks, so the
suite would all-skip anyway. If your change touches
`backend/app/llm/**`, `backend/app/sessions/**`, or
`backend/app/extensions/**`, **mention "please run live tests" in the
PR description** so a maintainer can dispatch the workflow against
your head ref after a code-review pass. See
[`docs/tool-design.md`](docs/tool-design.md) §"CI: when the live
suite runs automatically" for the full trigger matrix and
fork-safety rationale.

## Conventions

- **Python:** `ruff` + `mypy --strict`. No `print` or stdlib `logging` in
  business code — use `from app.logging_setup import get_logger`.
- **TypeScript:** ESLint flat config; `tsc -b --noEmit` clean.
- **Async-first:** every I/O path is `async`; locks are per-session, never global.
- **Config:** all knobs through `pydantic-settings` env vars; never hard-code.
- **Logging:** every external boundary gets a `*_start` and `*_complete` /
  `*_failed` line. Frontend `console.*` calls carry a `[module]` prefix.
  Full rules in [`CLAUDE.md`](CLAUDE.md#logging-rules-read-before-adding-any-new-code-path).
- **No backwards compatibility.** Zero users in the wild. Change the
  schema/contract on both sides in the same PR; delete the old code.
  See the banner at the top of [`CLAUDE.md`](CLAUDE.md).
- **Brand voice in user-facing copy.** Operator voice, not marketer
  voice. LLM system prompts are *not* user-facing — leave them descriptive.

## Branching and PRs

- `main` is protected. PRs only.
- Work on a topic branch (`claude/<task>-<id>` for Claude Code sessions,
  `<your-handle>/<topic>` otherwise). Don't reuse another session's branch.
- Commit style: `<area>: <imperative subject>` (e.g. `backend: add session
  repository`). Body explains *why*.
- **Closing keywords:** repeat per issue (`Closes #52` / `Closes #53`).
  A comma-list (`Closes #52, #53, #54`) only closes the first. Never put
  a closing keyword next to an issue number you don't want closed —
  GitHub's parser ignores surrounding negations.
- Open a **draft PR** when you push the first commit. Mark ready for
  review only when CI is green and the sub-agent reviews are clean.

## Sub-agent reviews (Phase-2+ application code)

Every commit that touches application code runs through six parallel
sub-agent reviews before push: QA, Security, UI/UX, Product, User
(creator persona), and Prompt Expert. CRITICAL / BLOCK / HIGH findings
must be fixed in the same commit; logging-and-debuggability findings are
treated as HIGH regardless of nominal severity. Phase-1 docs / CI /
scaffolding work is exempt.

Full protocol — including which agent guards which class of bug — is in
[`CLAUDE.md`](CLAUDE.md#sub-agent-review-protocol).

## Dependencies

Before adding any third-party dep (npm / pip / GitHub Action / container
image), spend two minutes on the smell test and write the answers in the
PR body: last release date, maintenance signals, known CVEs,
replaceability (≤200 LoC of straightforward logic should be inlined),
license compatibility. Full checklist in
[`CLAUDE.md`](CLAUDE.md#dependency-intake-new-deps-must-pass-these-checks).

## Asking questions / reporting issues

- **Bugs / feature requests:** open an issue on
  [`nebriv/Crittable`](https://github.com/nebriv/Crittable/issues).
- **Phase scope:** milestones, not labels. List current scope with
  `mcp__github__search_issues` filtered by milestone (Phase 2 / Phase 3).
- **Architecture questions:** start with [`docs/PLAN.md`](docs/PLAN.md);
  if it doesn't answer, open an issue with the `question` label.

Welcome aboard. Roll the inject. Ship the AAR.
