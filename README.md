# AI Cybersecurity Tabletop Facilitator

Multi-user, browser-based chat app that runs cybersecurity tabletop
exercises facilitated by Claude. The creator opens a session, fills in
the scenario brief / team / environment / constraints, shares a per-role
join link, and Claude drives a turn-based exercise. At the end, the
engine generates a downloadable markdown after-action report with
per-role and overall scores.

> **Status:** Phase 1 + Phase 2 complete (see milestones #1 + #2). The
> app is shippable for internal teams. Phase 3 is in design (Redis
> pub/sub for multi-process WS fan-out, native non-Anthropic LLM
> adapters). Authoritative architecture: [`docs/PLAN.md`](docs/PLAN.md).

## What it does

- Multi-section setup intro (scenario / team / environment / constraints)
  → Claude proposes a structured plan → operator approves or skips.
- Per-role join links (HMAC-signed tokens, kick-and-reissue).
- Turn-based exercise: Claude narrates beats, throws injects, yields to
  specific roles via tool calls.
- Critical-event banners, per-role typing indicators, AI auto-interject
  on direct questions.
- Right-sidebar timeline (only key beats + AI-pinned moments).
- Force-advance / abort-turn / proxy-respond escape hatches.
- Async after-action-report pipeline with markdown export, retry, and
  inline viewer.
- Operator-tunable everything: per-tier model / max_tokens / temperature
  / top_p / timeout, strict-retry count, setup-turn cap, submission cap,
  poll cadences. See [`docs/configuration.md`](docs/configuration.md).
- LLM-provider swap via `ANTHROPIC_BASE_URL` (Bedrock / Vertex /
  OpenRouter / local Ollama via litellm). See
  [`docs/llm_providers.md`](docs/llm_providers.md).

## Quickstart

### GitHub Codespaces

Open the repo in Codespaces. The devcontainer installs both the Python
backend and the React frontend. Add `ANTHROPIC_API_KEY` to your
Codespaces secrets and the env var is forwarded into the container.

### Local Docker (single container)

```bash
docker compose up --build
# visit http://localhost:8000
```

Or directly:

```bash
docker run --rm -p 8000:8000 \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  ghcr.io/nebriv/ai-tabletop-facilitator:latest
```

### Local development (no Docker)

```bash
# Backend
cd backend && pip install -e ".[dev]"
uvicorn app.main:app --reload --app-dir .

# Frontend (separate terminal)
cd frontend && npm ci && npm run dev
```

The frontend dev server proxies `/api` and `/ws` to `localhost:8000` so
the two halves co-develop without CORS friction.

## Session lifecycle (the phase machine)

```
CREATED → SETUP → READY → BRIEFING → AWAITING_PLAYERS ↔ AI_PROCESSING → ENDED
```

Each state has hard rules about which LLM tier may run, which tools may
be called, and what tool-choice posture is forced. The rules live in
[`backend/app/sessions/phase_policy.py`](backend/app/sessions/phase_policy.py)
— a single Python module that the engine assertions, the LLM client's
tool filter, and the dispatcher's runtime checks all consult. See
[`docs/architecture.md`](docs/architecture.md#phase-policy) for the
full table.

The engine does **not** trust the LLM to honour the prompt. Phase
boundaries are enforced in code:

1. Every turn driver entry point asserts the session state matches the
   tier's `allowed_states`.
2. The LLM client filters the `tools` list against the tier's
   `allowed_tool_names` before forwarding to Anthropic.
3. The dispatcher rejects tool calls that aren't permitted in the
   current state and returns the rejection to the model on the next
   strict-retry attempt as a proper Anthropic `tool_result` block — so
   the model can self-correct rather than retry blind.

## Documentation

- [`docs/PLAN.md`](docs/PLAN.md) — architecture and phase plan (source
  of truth).
- [`docs/architecture.md`](docs/architecture.md) — diagrams, request
  flows, phase policy, retry-feedback loop.
- [`docs/configuration.md`](docs/configuration.md) — every env var,
  defaults, and "before going public" hardening checklist.
- [`docs/llm_providers.md`](docs/llm_providers.md) — swap to Bedrock /
  Vertex / OpenRouter / local Ollama via `ANTHROPIC_BASE_URL`.
- [`docs/extensions.md`](docs/extensions.md) — Skills-style custom
  tools / resources / prompts (operator-trusted, sandboxed Jinja).
- [`docs/prompts.md`](docs/prompts.md) — system-prompt blocks,
  guardrails, tool-use protocol, AAR rubric.
- [`docs/turn-lifecycle.md`](docs/turn-lifecycle.md) — **load-bearing
  reference for the play-turn engine.** Full decision tree of slots,
  contracts, validator, recovery cascade, and the 2026-04-30 silent-
  yield regression. Read before touching `app/sessions/turn_*` or
  `app/llm/dispatch.py`.
- [`docs/tool-design.md`](docs/tool-design.md) — **tool authoring
  guidelines.** Five trap patterns we hit, an authoring checklist, the
  current play-tier palette, and the live tool-routing pytest suite
  used as the regression net. Read before adding, renaming, or
  rewording any tool in `app/llm/tools.py`.
- [`CLAUDE.md`](CLAUDE.md) — guidance for Claude Code sessions on this
  repo (six-agent review protocol, logging rules, dependency intake).

## Development

| Goal | Command |
|---|---|
| Backend tests | `cd backend && pytest -q` |
| Backend lint / type | `cd backend && ruff check . && mypy app` |
| Frontend tests | `cd frontend && npm test -- --run` |
| Frontend lint / type / build | `cd frontend && npm run lint && npm run typecheck && npm run build` |

Phase-2 acceptance gates are exercised by `backend/tests/test_e2e_session.py`
(2-role + 12-role + many edge cases).

## License

MIT — see [`LICENSE`](LICENSE).
