<p align="center">
  <!-- Transparent GIF variants so the mark adapts to GitHub's dark/light
       README themes. Same <picture> + prefers-color-scheme pattern as the
       lockup below. The previous opaque GIF baked in a #0A0D13 plate that
       read as a dark panel on the light theme. -->
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/brand/mark-animated-dark-transparent.gif" />
    <source media="(prefers-color-scheme: light)" srcset="./assets/brand/mark-animated-light-transparent.gif" />
    <img src="./assets/brand/mark-animated-dark-transparent.gif" alt="Crittable mark — die rolling through six encounter states" width="180" />
  </picture>
</p>
<p align="center">
  <!-- Transparent SVG variants so the lockup looks correct on both
       GitHub's dark and light README themes — the opaque PNG had
       its own #0A0D13 background baked in and read as a black panel
       on the light theme. The <picture> element + prefers-color-scheme
       is rendered by GitHub's markdown pipeline. -->
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/brand/lockup-crittable-dark-transparent.svg" />
    <source media="(prefers-color-scheme: light)" srcset="./assets/brand/lockup-crittable-light-transparent.svg" />
    <img src="./assets/brand/lockup-crittable-dark-transparent.svg" alt="CRITTABLE — ROLL · RESPOND · REVIEW" width="320" />
  </picture>
</p>

# Crittable

*Tabletop exercises for security teams. Roll the inject. Ship the AAR.*

**`ROLL · RESPOND · REVIEW`**

A multi-user, browser-based tabletop platform for incident response.
Open a session, brief the AI, share per-role join links, and Claude
runs the room while your team responds. The after-action report drafts
itself while the room is still warm.

> **Status.** Phase 1 + Phase 2 shipped. Multi-provider LLM support
> shipped — every call routes through LiteLLM, so set `LLM_MODEL_<TIER>`
> to any of ~100 providers (Anthropic, Azure OpenAI, AWS Bedrock,
> Vertex AI, OpenRouter, vLLM, …). Phase 3 in design (Redis pub/sub
> for multi-process WS fan-out). Authoritative architecture:
> [`docs/PLAN.md`](docs/PLAN.md).

## What it does

- **Set the brief.** Scenario / team / environment / constraints in four
  short sections. Claude proposes a plan. You approve or skip.
- **Per-role join links.** HMAC-signed tokens. Kick-and-reissue on demand.
- **Turn-based exercise.** Claude narrates beats, throws injects, yields
  to specific roles via tool calls. Typical session: 30–60 min.
- **Critical-event banners.** Per-role typing indicators. AI auto-interject
  on direct questions.
- **Right-rail HUD.** MGMT Pressure / Containment / Burn Rate gauges
  (placeholders today; real telemetry on the Phase-3 roadmap).
- **Force-advance / abort-turn / proxy-respond escape hatches.**
- **AAR pipeline.** Async, with markdown export, retry, and inline viewer.
- **Operator-tunable everything.** Per-tier model / max_tokens / temperature
  / top_p / timeout, strict-retry count, setup-turn cap, submission cap,
  poll cadences. See [`docs/configuration.md`](docs/configuration.md).
- **Provider swap.** `LLM_API_BASE` → Bedrock / Vertex / OpenRouter
  / local Ollama via litellm. See [`docs/llm_providers.md`](docs/llm_providers.md).

## Quickstart

> **Minimum viable config:** export `LLM_API_KEY` and run one of
> the recipes below. Everything else has a sensible default.
> See [Environment variables](#environment-variables) for the
> shortlist that actually matters and
> [`docs/configuration.md`](docs/configuration.md) for the full
> reference.

### GitHub Codespaces (zero-install)

Open the repo in Codespaces. The devcontainer installs both halves.
Add `LLM_API_KEY` to your Codespaces secrets — it's forwarded
into the container automatically. Then run `docker compose up --build`
in the terminal and click the forwarded port.

### Local Docker (single container)

```bash
export LLM_API_KEY=sk-ant-…
docker compose up --build
# visit http://localhost:8000
```

Or pull the published image directly (no clone needed):

```bash
docker run --rm -p 8000:8000 \
  -e LLM_API_KEY="$LLM_API_KEY" \
  ghcr.io/nebriv/crittable:latest
```

### Local development (no Docker)

Two terminals — backend reload + Vite HMR:

```bash
# Terminal 1 — backend (auto-reload on save)
export LLM_API_KEY=sk-ant-…
cd backend && pip install -e ".[dev]"
uvicorn app.main:app --reload --app-dir .

# Terminal 2 — frontend (Vite dev server)
cd frontend && npm ci && npm run dev
```

The Vite dev server proxies `/api` and `/ws` to `localhost:8000`, so
the two halves co-develop without CORS friction.

## Drafting a brief with your work's LLM

Crittable's setup wizard takes four short text sections — **SCENARIO
BRIEF**, **ABOUT YOUR TEAM**, **ABOUT YOUR ENVIRONMENT**, **CONSTRAINTS
/ AVOID** — plus a tuning panel (difficulty, target duration, feature
toggles) and a roster on later steps. You can write the four sections
yourself, or paste the template below into your work's LLM (ChatGPT,
Claude, Gemini, an enterprise assistant with memory / connectors), fill
in the bracketed fields once with your real environment, and let it draft
a scenario tuned to *your* shop.

The output is structured to match the wizard's four textareas one-for-one
— copy each section into the matching field, then click through Step 2
(difficulty / features) and Step 3 (roles) as you would for any session.
Re-run the prompt to get a different scenario against the same
environment; the bracketed setup is meant to be filled in once and
re-used.

> Tip: name systems by product (Splunk, Defender, Okta, IRIS, PagerDuty),
> not generic categories. The more concrete the environment, the more it
> shows up in the AI's injects during play.

````text
We're going to run a simulated cybersecurity tabletop exercise on a
tool called Crittable. Draft the brief — I'll paste your output
straight into the tool's setup form.

Pull what you know about our environment, team, and tooling from
memory / connectors / prior chats. Where you don't have detail, use
the values below.

OUR SHOP (fill in once; re-use this prompt for new scenarios):

- Identity & directory: [e.g. "Microsoft 365, hybrid Entra ID + on-prem
  AD forest, ~20 years of GPO sprawl, classic AD controllers"]
- Endpoints: [e.g. "Defender for Endpoint on Windows fleet; Jamf-managed
  Macs for engineering"]
- Cloud / SaaS: [e.g. "AWS prod (us-east-1, us-west-2), Salesforce,
  GitHub Enterprise Cloud, Workday"]
- Network / perimeter: [e.g. "Palo Alto firewalls, Zscaler ZIA for
  egress, Cloudflare in front of marketing"]
- Detection & response: [e.g. "homebrew IRIS workflow for alert
  triage; PagerDuty for paging; Splunk ES as SIEM"]
- Crown jewels: [e.g. "customer billing DB on RDS, prod K8s cluster,
  source repos, HR/payroll instance"]
- Regulatory: [e.g. "SOC 2 Type II, PCI-DSS L2, GDPR; not HIPAA-scope"]
- Maturity note: [e.g. "IT sprawl is heavy and 20+ years old; security
  program is well-resourced and modern"]

OUR TEAM:

- Size & shape: [e.g. "8-person security team inside a 600-person SaaS
  company"]
- Roles in the room for the tabletop: [e.g. "CISO (creator), IR Lead,
  SOC analyst, SRE on-call, Legal counsel, Comms / PR lead"]
- Seniority & posture: [e.g. "IR lead 10y; SOC is junior; legal has
  done one prior breach; follow-the-sun on-call across US + EU"]

CONSTRAINTS:

- Learning objectives: [e.g. "stress-test the AD-compromise containment
  playbook; force comms to draft an external statement under pressure"]
- Hard NOs: [e.g. "no fatalities / physical-safety injects; don't pin
  blame on real named employees; don't simulate regulators we're not
  actually subject to"]
- Time budget: [e.g. "60 minutes"]

Now draft the brief in EXACTLY these four sections, each under a clear
header, no preamble, no closing summary. Pick the scenario yourself —
surprise me — but make it realistic for the environment above
(ransomware, BEC, OAuth phish, supply-chain compromise, leaked cloud
creds, malicious insider, etc.). Include the plausible first signal
that would land in our SIEM.

[1] SCENARIO BRIEF
What happened, when, at what severity. ~3–5 short bullets or a tight
paragraph. Don't worry about prose.

[2] ABOUT YOUR TEAM
Restate the team above in the form Crittable expects: roles,
seniority, on-call posture.

[3] ABOUT YOUR ENVIRONMENT
Restate the stack above in the form Crittable expects: stack, identity
provider, EDR / XDR, crown jewels, regulatory regime.

[4] CONSTRAINTS / AVOID
Restate hard NOs and learning objectives, plus anything you (the LLM)
flag as worth avoiding given the scenario you picked.

Also suggest — outside the four sections, as a postscript — a
difficulty (EASY / STANDARD / HARD), a target duration (15–180 min),
and which of these feature toggles to flip on for this scenario:
active_adversary, time_pressure, executive_escalation, media_pressure.
I'll set those on Crittable's Step 2 tuning panel.
````

## Environment variables

The full reference is [`docs/configuration.md`](docs/configuration.md).
This section is the **shortlist** — the variables that actually
matter day-to-day. Everything else has a working default.

### Required to start

| Var | Why |
|---|---|
| `LLM_API_KEY` | Required when any tier targets the `anthropic/` family (the default). Bring your own provider via `LLM_MODEL_<TIER>=openai/...` / `bedrock/...` / `azure/...` / `vertex_ai/...` / `ollama/...` etc. — every call routes through LiteLLM so the provider-native env var (`OPENAI_API_KEY`, `AWS_*`, `AZURE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`) is what authenticates. Use `LLM_API_BASE` to point at a non-default endpoint (Anthropic-compatible proxy, internal LLM gateway, OpenAI-compatible local server). See [`docs/llm_providers.md`](docs/llm_providers.md). |

### Required before any non-toy deployment

The app boots without these — but **set them before exposing it to
anyone**. The hardening checklist in
[`docs/configuration.md`](docs/configuration.md#before-going-public--hardening-checklist)
is the long form.

| Var | Default | Why |
|---|---|---|
| `SESSION_SECRET` | randomly generated, with a startup warning | HMAC key for join tokens. Not setting this means tokens are invalidated on every restart. Use 32+ random bytes. |
| `CORS_ORIGINS` | `*` | Comma-separated allowlist. Lock to your actual origin(s). |
| `RATE_LIMIT_ENABLED` | `false` | Flip to `true` and tune `RATE_LIMIT_REQ_PER_MIN` (default 60). |

### Useful day-to-day

| Var | Default | Why |
|---|---|---|
| `LLM_API_BASE` | _unset_ | Point at Bedrock / Vertex / OpenRouter / Ollama via litellm. See [`docs/llm_providers.md`](docs/llm_providers.md). |
| `LLM_MODEL_PLAY` / `_SETUP` / `_AAR` / `_GUARDRAIL` | Sonnet 4.6 / Sonnet 4.6 / Opus 4.7 / Haiku 4.5 | Per-tier model overrides. Drop the setup tier to Haiku if you want cheaper setup turns (with a small XML-fallback risk; see configuration.md). |
| `LOG_LEVEL` / `LOG_FORMAT` | `INFO` / `json` | Lower to `DEBUG` for verbose; switch to `console` for human-readable output during local dev. |
| `MAX_TURNS_PER_SESSION` | `40` | Soft warning at 80%, hard stop at limit. |
| `INPUT_GUARDRAIL_ENABLED` | `true` | Cheap Haiku off-topic / prompt-injection pre-classifier. |

### Dev-only — never enable in production

| Var | Default | Why |
|---|---|---|
| `DEV_FAST_SETUP` | `false` | Skip AI setup; land in `READY` with a generic plan. Useful for iterating on play UI. |
| `DEV_TOOLS_ENABLED` | `false` | Exposes `/api/dev/scenarios/*` and the God Mode Scenarios panel. **Allows unauthenticated session creation** — never set in production. The app emits a `dev_tools_enabled_unauth_path_active` warning at boot if it's on. |
| `AAR_INLINE_ON_END` | `false` | Tests-only: blocks the end-session response on AAR generation. |

For everything else — per-tier sampling, retry budgets, session
limits, the chat-declutter kill-switch, extension loaders — see
[`docs/configuration.md`](docs/configuration.md).

## Session lifecycle (the phase machine)

```
CREATED → SETUP → READY → BRIEFING → AWAITING_PLAYERS ↔ AI_PROCESSING → ENDED
```

Each state has hard rules about which LLM tier may run, which tools may
be called, and what tool-choice posture is forced. Rules live in
[`backend/app/sessions/phase_policy.py`](backend/app/sessions/phase_policy.py)
— a single Python module that the engine assertions, the LLM client's
tool filter, and the dispatcher's runtime checks all consult. See
[`docs/architecture.md`](docs/architecture.md#phase-policy) for the full
table.

The engine does **not** trust the LLM to honor the prompt. Phase
boundaries are enforced in code:

1. Every turn driver entry point asserts the session state matches the
   tier's `allowed_states`.
2. The LLM client filters the `tools` list against the tier's
   `allowed_tool_names` before forwarding to Anthropic.
3. The dispatcher rejects forbidden tool calls at runtime and returns a
   proper Anthropic `tool_result` so the model can self-correct rather
   than retry blind.

## Documentation

**Operate / deploy:**
- [`docs/configuration.md`](docs/configuration.md) — every env var,
  defaults, "before going public" hardening checklist.
- [`docs/llm_providers.md`](docs/llm_providers.md) — swap to Bedrock /
  Vertex / OpenRouter / local Ollama via `LLM_API_BASE`.
- [`docs/extensions.md`](docs/extensions.md) — Skills-style custom tools /
  resources / prompts.

**Architecture / engine internals (read before touching the matching code):**
- [`docs/architecture.md`](docs/architecture.md) — live diagrams,
  request flows, phase policy, retry-feedback loop.
- [`docs/turn-lifecycle.md`](docs/turn-lifecycle.md) — **load-bearing
  reference for the play-turn engine.** Read before touching
  `app/sessions/turn_*` or `app/llm/dispatch.py`.
- [`docs/tool-design.md`](docs/tool-design.md) — tool authoring
  guidelines. Read before adding, renaming, or rewording any tool.
- [`docs/prompts.md`](docs/prompts.md) — system-prompt blocks,
  guardrails, tool-use protocol, AAR rubric.
- [`docs/prompt-writing-rules.md`](docs/prompt-writing-rules.md) —
  prompt style guide (shape-not-phrase rule, deflection patterns,
  trust-boundary first). Read before editing any prompt block.
- [`docs/PLAN.md`](docs/PLAN.md) — original architecture & phase plan.
  Historical reference; for the current state, prefer
  `architecture.md` and `configuration.md`.

**Working in the repo:**
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — local setup, conventions,
  the six-agent review protocol.
- [`CLAUDE.md`](CLAUDE.md) — guidance for Claude Code sessions on
  this repo (logging rules, dependency intake, model-output trust
  boundary, communication transport choices).

## Development

| Goal | Command |
|---|---|
| Backend tests | `cd backend && pytest -q` |
| Backend lint / type | `cd backend && ruff check . && mypy app` |
| Frontend tests | `cd frontend && npm test -- --run` |
| Frontend lint / type / build | `cd frontend && npm run lint && npm run typecheck && npm run build` |

## Brand

![Crittable color tokens — INK-900, INK-800, SIGNAL, CRIT, WARN, INFO](./assets/brand/swatches.svg)

Two type families. Operator voice. Square-ish radii. The mark is a d6
whose pips are re-arranged into a 5-on-1 tabletop encounter — five party
tokens, one threat, routes between them. Six encounter states map
optionally to NIST 800-61 IR phases (`CT/01 Detect` … `CT/06 Review`).

Full brand reference: [`design/handoff/BRAND.md`](design/handoff/BRAND.md).
Drop-in tokens + assets: [`design/handoff/`](design/handoff/).

## License

[Functional Source License, Version 1.1, ALv2 Future License](LICENSE)
(FSL-1.1-ALv2). Free for any non-competing use — including self-hosting,
internal use, education, and research. Each release converts to Apache
License 2.0 on the second anniversary of its release date.
