# AI Cybersecurity Tabletop Facilitator

Multi-user, browser-based chat app that runs cybersecurity tabletop exercises facilitated by Claude. A creator starts a session, provides a scenario prompt, defines roles, and shares a join link per role. Claude drives a turn-based exercise and produces a downloadable markdown after-action report with per-role and overall scores.

> **Status: Phase 1 — Architecture & Bootstrap.** No session UI yet. See [`docs/PLAN.md`](docs/PLAN.md) for the full architecture and roadmap, and [`CLAUDE.md`](CLAUDE.md) for how this repo is built.

## Quickstart

### GitHub Codespaces

Open the repo in Codespaces. The devcontainer installs both the Python backend and the React frontend. Add `ANTHROPIC_API_KEY` to your Codespaces secrets and the env var is forwarded into the container.

### Local Docker (single container)

```bash
docker compose up --build
# visit http://localhost:8000/healthz
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

## Documentation

- [`docs/PLAN.md`](docs/PLAN.md) — architecture and phase plan (source of truth).
- [`docs/architecture.md`](docs/architecture.md) — diagrams and request flows.
- [`docs/configuration.md`](docs/configuration.md) — every env var.
- [`docs/extensions.md`](docs/extensions.md) — Skills-style custom tools / resources / prompts.
- [`docs/prompts.md`](docs/prompts.md) — system prompt and guardrails.
- [`CLAUDE.md`](CLAUDE.md) — guidance for Claude Code sessions on this repo.

## License

MIT — see [`LICENSE`](LICENSE).
