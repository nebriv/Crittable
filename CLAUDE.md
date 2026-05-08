# CLAUDE.md

Long-term memory for Claude Code sessions on this repo. Read this first.

> # ⚠️ NO BACKWARDS COMPATIBILITY
>
> **This app is not deployed and has zero users in the wild.** Do not write
> backwards-compat shims, optional fields "for old clients", graceful
> fallbacks for older backends, deprecation warnings, version-flag branches,
> or rollout-safe migrations. Just change the schema/contract on both sides
> and delete the old code.
>
> **No `field?: T` "for older deploys" anywhere.** If you add a wire field,
> make it required. If you rename a field, rename it everywhere — don't
> alias. If you remove a tool / event / endpoint, delete it; don't leave a
> stub that returns 410. Tests should assert the *new* contract; do not
> add a "fallback when X is undefined" test branch.
>
> The cost of carrying compat code is paid forever; the benefit (smooth
> upgrade for absent users) is exactly zero. If you find yourself writing
> "this is optional in case the backend hasn't shipped yet" — stop, ship
> the backend change in the same PR, and make the field required.
>
> Sub-agents reviewing PRs should flag any back-compat shim as **HIGH** —
> it's debt with no upside.

## Project overview

A multi-user, browser-based chat application that runs cybersecurity tabletop exercises facilitated by Claude. A creator opens "New session," provides a scenario prompt, defines participant roles (CISO / IR Lead / Legal / Comms / etc.), and shares a unique join link per role. The creator also plays a role. Claude drives a turn-based loop and produces a downloadable markdown after-action report at the end.

Authoritative design doc: [`docs/PLAN.md`](docs/PLAN.md). Architecture details (diagrams + flow): [`docs/architecture.md`](docs/architecture.md).

## Branching

- `main` — protected; PRs only.
- `claude/<task-name>-<session-id>` — Claude Code work happens on a session-specific branch the harness designates (e.g. `claude/redesign-english-interface-DKWnN`). The assistant pushes to that branch and opens a draft PR into `main`. Don't push directly to `main` and don't reuse another session's branch.

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

All config is via environment variables. The full reference lives in [`docs/configuration.md`](docs/configuration.md). Required at minimum: `LLM_API_KEY`. Hardening checklist before any non-toy deployment is also there (set `CORS_ORIGINS`, enable rate limit, set `SESSION_SECRET`, etc.).

## LLM backend selection (read before touching any LLM call site)

Two concrete `ChatClient` implementations sit behind a common ABC at [`backend/app/llm/protocol.py`](backend/app/llm/protocol.py):

- `app.llm.client.LLMClient` — Anthropic-direct via `anthropic.AsyncAnthropic` (default; selected by `LLM_BACKEND=anthropic`).
- `app.llm.clients.litellm_client.LiteLLMChatClient` — LiteLLM-routed; supports ~100 providers (Azure OpenAI, AWS Bedrock, Vertex AI, OpenRouter, OpenAI direct, vLLM/Ollama, …). Selected by `LLM_BACKEND=litellm`.

Both share the `ChatClient` ABC. Internal vocabulary stays Anthropic-shaped (content blocks, `tool_use`/`tool_result`, `cache_control: ephemeral`, `stop_reason`); provider-specific clients adapt at the wire boundary. Downstream callers (turn driver, dispatch, AAR generator, guardrail) never see provider-shaped data. See [`docs/llm_providers.md`](docs/llm_providers.md) for the full configuration story and [`docs/testing-llm.md`](docs/testing-llm.md) for how to write tests against the seam.

**When adding a new feature that talks to the LLM**: depend on `ChatClient`, not on a specific implementation. The two backends are functionally equivalent (validated by 50/50 live tests passing under both); any drift is a bug. The translator surface lives in `_build_call_kwargs` / `_to_openai_messages` / `_from_litellm_response` in `litellm_client.py` — anything that wouldn't translate cleanly through both backends belongs at the wire boundary, not in `dispatch.py` or `turn_driver.py`.

**Streaming caveats**: before adding any new `astream` call site (or reading mid-stream events from an existing one), read the [Streaming caveats](docs/llm_providers.md#streaming-caveats-read-before-adding-a-new-astream-call-site) section in `docs/llm_providers.md`. Quick summary: the terminal `complete` event is the durable contract on both backends; mid-stream events (`text_delta`, `tool_use_start`) are useful as **early signals for UX** but **not safe sources of content or state**. The LiteLLM translator deliberately drops `tool_use` deltas mid-stream to sidestep the known-fragile `input_json_delta` accumulation path — tool args / IDs are unavailable until `complete` fires on the LiteLLM path. Frontends already treat streaming as a typing pulse, not a content channel; do not add a code path that reads mid-stream `text_delta` content as ground truth.

**Cost reporting**: `app.llm._shared.compute_cost_usd(model, usage_dict)` is the single authoritative cost calculator. Both backends (Anthropic-direct and LiteLLM-routed) call it; it talks to LiteLLM's pricing JSON (`litellm.cost_per_token`). The hand-maintained local pricing table that used to live at `app/llm/cost.py` is gone — it had drifted (Opus 4.7 listed at $15/M input vs. the actual $5/M, off by 3×) and there's no reason to maintain a parallel source of truth when LiteLLM ships a community-updated `model_prices_and_context_window.json` covering ~100 providers. Unknown models return 0.0 with a `compute_cost_usd_unknown_model` warning. The LiteLLM-routed backend's `_usage_to_normalized_dict` still subtracts cache_read+creation out of OpenAI's `prompt_tokens` to recover the Anthropic-shape input count — `compute_cost_usd` consumes the four-key normalized dict (`{input, output, cache_read, cache_creation}`) and `litellm.cost_per_token` charges each separately. Locked by `tests/test_litellm_translators.py::test_from_response_warm_cache_subtracts_cache_read_from_input` and `tests/test_llm_backend_seam.py::test_compute_cost_usd_*`.

**Per-provider API key discovery**: The engine forwards `LLM_API_KEY` to LiteLLM **only** when the wire model targets the `anthropic/` family. Every other provider relies on LiteLLM's auto-discovery from the provider-native env var (`OPENAI_API_KEY`, `AWS_*`, `AZURE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `OPENROUTER_API_KEY`). The startup gate in `app/main.py` mirrors this: `cfg.require_llm_api_key()` only runs when `LLM_BACKEND=anthropic` or when `_resolves_to_anthropic(cfg)` is true; non-Anthropic LiteLLM deployments boot without `LLM_API_KEY` set at all (logs `llm_api_key_skipped`). Without this, a `LLM_BACKEND=litellm LLM_MODEL=openai/...` deploy would ship an Anthropic key to OpenAI's auth endpoint — credential mis-routed, key value logged in OpenAI's auth-failure response.

**LiteLLM safety hardening**: `app.llm._shared` zeroes every callback registry (`callbacks`, `success_callback`, `failure_callback`, `input_callback`, `service_callback`, `audit_log_callbacks`, plus the lazy `_async_*` variants — 9 lists) and disables phone-home telemetry on import. Both `ChatClient` backends import from `_shared`, so any boot path produces a hardened litellm. Sets `LITELLM_MODE=PRODUCTION` *before* `import litellm` so the library's import-time `dotenv.load_dotenv()` is skipped. Without these, a stray `LANGSMITH_API_KEY` / `HELICONE_API_KEY` / `LANGFUSE_*` in a contributor's `.env` would silently exfiltrate prompts + participant chat to a third-party SaaS.

## Test API-key handling (no `TEST_MODE`)

`backend/tests/conftest.py` injects a dummy `LLM_API_KEY=dummy-key-for-tests` so unit tests can boot `Settings` without a real key. There is **no `TEST_MODE` placeholder** — `Settings.require_llm_api_key()` simply raises `RuntimeError` whenever `LLM_API_KEY` is unset. Don't reintroduce it.

Live-API tests (`backend/tests/live/`) need a real key. The directory's `conftest.py` runs at collection time: pops the dummy, loads the project-root `.env` so a contributor's key actually reaches `os.environ`, and skips the live tests cleanly when no real key is found. The dummy is restored before unit tests run so they still boot. The `anthropic_client` and `judge_client` fixtures defensively assert the resolved key is not the dummy.

`backend/tests/test_live_fixtures.py` source-greps `tests/live/` for `os.environ["LLM_API_KEY"]` reads and `"tests/live" in str(...)` substring matches — both ways the original `TEST_MODE` trap shipped — and fails loud at CI time.

## Live-test API key handling

The engine reads its API key from `LLM_API_KEY` (renamed in #193 from `ANTHROPIC_API_KEY` so the name is provider-agnostic and doesn't collide with the Anthropic SDK's auto-discovery namespace). The live-test workflow uses `LIVE_TEST_LLM_API_KEY` and bridges it into the pytest subprocess at invocation time. The `backend/scripts/run-live-tests.sh` wrapper does this for you:

```bash
backend/scripts/run-live-tests.sh                # full suite
backend/scripts/run-live-tests.sh -k test_aar    # pytest filter
```

If you'd rather invoke pytest directly, the equivalent inline form is:

```bash
LLM_API_KEY="$LIVE_TEST_LLM_API_KEY" pytest backend/tests/live/ -v
```

The `VAR=value command` form scopes the assignment to that one child process. `backend/tests/live/conftest.py` resolves the key via `get_settings().require_llm_api_key()` at collection time (reading `LLM_API_KEY` through pydantic-settings), so the bridged var reaches the auto-skip exactly the same way a shell-exported one would.

**Historical context (resolved):** Before the rename, the engine read `ANTHROPIC_API_KEY` directly. The Anthropic SDK auto-discovers `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` from process env, so setting our config var as a session-wide secret in the Claude Code harness shadowed the harness's own credentials and broke the session. The rename to `LLM_API_KEY` resolves this — set `LLM_API_KEY` freely in any env (Claude Code session, GitHub Actions, Docker, local shell). The provider-specific env vars used by individual SDKs (`ANTHROPIC_*`, `OPENAI_*`, `AWS_*`, etc.) are still off-limits in the harness for the same reason — but we no longer set those ourselves.

## Branding (read before any UI / copy work)

The product is **Crittable** — tabletop exercises for security teams. Slogan `ROLL · RESPOND · REVIEW`. Operator voice, not marketer voice; the audience is incident responders mid-exercise. **Always read these before touching UI, page copy, marketing surfaces, or anything user-facing:**

- [`design/handoff/BRAND.md`](design/handoff/BRAND.md) — the rules: mark, voice, color tokens (ink/paper/signal/crit/warn/info), type (JetBrains Mono + Inter, no third family), geometry (square-ish radii, no gradients), animations, photography policy ("there isn't any"). The "Don't" lists are load-bearing — no recoloring the mark, no marketing fluff, no stock photography, no emoji as decoration.
- [`design/handoff/HANDOFF.md`](design/handoff/HANDOFF.md) — drop-in steps, the voice-rewrite checklist (`"Empower your team to respond"` → `"Run the inject. Ship the AAR."`), and the documented `.card` / `.pill` / `.btn` / divider patterns. Use these patterns verbatim; **don't re-derive**.
- [`design/handoff/source/SOURCE.md`](design/handoff/source/SOURCE.md) — map of the JSX source. Specifically:
  - [`design/handoff/source/app-screens.jsx`](design/handoff/source/app-screens.jsx) — the **canonical reference for product UI patterns** (`AppTacticalHUD`, `AppCreatorSetup`, `AppLobby`, `AppBriefing`, `AppAAR`). Lift component patterns from here, don't re-derive.
  - `mark.jsx` / `artboards.jsx` — the brand-system reference compositions.
- [`design/handoff/tokens.css`](design/handoff/tokens.css) — single source of truth for design tokens. The same content is mirrored into [`frontend/src/index.css`](frontend/src/index.css) so Vite serves it; keep them in sync if you touch tokens.

**Implementation hooks** already wired in this repo:
- Brand utility components: [`frontend/src/components/brand/`](frontend/src/components/brand/) — `<SiteHeader>`, `<StatusChip>`, `<RailHeader>`, `<Eyebrow>`, `<HudGauges>`, `<TurnStateRail>`, `<DieLoader>`, `<BottomActionBar>`. **Use these instead of building new chrome.** They're verbatim lifts from `app-screens.jsx`.
- Brand assets: `frontend/public/logo/` (mark + lockup SVG/GIF), `frontend/public/favicon/` (full set wired into `index.html` per `HEAD-SNIPPET.html`), `frontend/public/og/og-image.gif` (OG / Twitter card), `assets/brand/` (README hero).
- Bundled fonts: [`@fontsource-variable/inter`](https://fontsource.org/fonts/inter) + [`@fontsource-variable/jetbrains-mono`](https://fontsource.org/fonts/jetbrains-mono) imported in `frontend/src/index.css`. **Do not load fonts from Google Fonts CDN** — security-team deployments are often air-gapped / strict-CSP. Same rule for any other external runtime asset (icons, images).

**Voice boundary**: operator-voice applies to **user-facing** copy (UI labels, banners, marketing pages, README, OG description, error messages). LLM system prompts are NOT user-facing — they describe the AI's role internally and use descriptive language ("AI cybersecurity tabletop facilitator") that's clearer for the model than the brand name. Don't rebrand the prompts as a part of a UI sweep — that's a model-behavior change, not a brand change. See [`docs/prompts.md`](docs/prompts.md) and the model-output-trust-boundary section below.

**When the brand and a feature ask conflict**, prefer the brand and surface the conflict — `BRAND.md` explicitly lists "don't autoplay the animated mark on the product side; only on marketing" as one example. The current `<DieLoader>` is a documented exception (the user explicitly asked for the animated d6 as the loading icon — log the carve-out in the commit body when you do similar).

## Milestones

Phase grouping is tracked via GitHub **milestones**, not labels. **Always list the current scope before starting work**:

```
mcp__github__search_issues  query='repo:nebriv/Crittable is:issue is:open milestone:"Phase 1"'
mcp__github__search_issues  query='repo:nebriv/Crittable is:issue is:open milestone:"Phase 2"'
mcp__github__search_issues  query='repo:nebriv/Crittable is:issue is:open milestone:"Phase 3"'
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
> **Adding or rewording a tool:** read [`docs/tool-design.md`](docs/tool-design.md) first. The five trap patterns there are the difference between a tool the model picks correctly and one it ignores or over-applies. Run `backend/scripts/run-live-tests.sh` after any change to `app/llm/tools.py`, Block 6 of `app/llm/prompts.py`, or the recovery directives.

> **Issue #168 — role-groups quorum (NEW).** `set_active_roles` takes `role_groups: list[list[str]]` (NOT a flat `role_ids`). Each inner list is one ASK and closes when ANY of its members signals ready; the turn advances when EVERY group has closed. Worked shapes: `[[ben]]` = "Ben must respond"; `[[paul, lawrence]]` = "either Paul or Lawrence answers"; `[[ben], [paul, lawrence]]` = "Ben + (Paul or Lawrence)". The advance gate is `groups_quorum_met(turn)` (renamed from `all_ready`). The narrower (`narrow_active_role_groups`) recognizes both clause-start addresses ("Ben — …") AND conjoined heads ("Paul and Lawrence — …" / "Paul, Lawrence — …" / "Paul or Lawrence — …"); chained-name heads address every member of the chain. Round-trip in scenarios via `PlayTurn.active_role_label_groups` (legacy fixtures fall back to one-singleton-group-per-submission). Comprehensive tests live in `backend/tests/test_role_groups.py` (gate truth table + dispatcher + narrower + recorder/runner round-trip).

[`backend/app/sessions/phase_policy.py`](backend/app/sessions/phase_policy.py) is the **single source of truth** for "what is the LLM allowed to do in tier X at session state Y?" Do not duplicate these rules elsewhere. Three enforcement points consume it:

1. **`turn_driver.py`** — every `run_*_turn` calls `assert_state(tier, session.state)` at entry. A `PhaseViolation` here means the calling code is wrong, not the LLM.
2. **`llm/client.py` (`acomplete` + `astream`)** — calls `filter_allowed_tools(tier, tools, extension_tool_names=…)` before forwarding to Anthropic and logs `phase_policy_dropped_tools` for any dropped names. Pass extension tool names explicitly when running the play tier so they survive the filter.
3. **`llm/dispatch.py`** — rejects forbidden tool calls at runtime and returns `is_error=True` in the `tool_result`. The strict-retry path in `turn_driver.py` feeds those `tool_result` blocks back to the model so it self-corrects rather than retrying blind. **Never silently drop a tool call** — the model will get stuck repeating it.

Adding a new tier or tool: update `phase_policy.POLICIES`, add `ALLOWED_*_TOOL_NAMES` to the relevant frozenset, and run `pytest backend/tests/test_phase_policy.py`. Adding a new tool to an existing tier: add it to that tier's `_<TIER>_TOOL_NAMES` constant.

## Prompt ↔ tool consistency (don't tell the model about tools that don't exist)

`backend/tests/test_prompt_tool_consistency.py` is a **mandatory regression net** for the class of bug where a model-facing string mentions a tool that isn't in the tier's palette. The 2026-04-30 redesign removed three tools from `PLAY_TOOLS` but missed cleaning up eight separate model-facing references to them in prompt blocks, recovery directives, kickoff messages, and tool descriptions. The model can't *call* a tool that's absent from the API request, but seeing the name in the prompt confuses it, wastes tokens, and misroutes its attention. The test catches this by reconstructing every model-facing string per tier, regex-extracting backticked snake_case names, and asserting each one is either a current tool in the tier's palette or a known non-tool concept.

**Removal protocol** (every tool removal must do all four):

1. Drop the tool from `PLAY_TOOLS` / `SETUP_TOOLS` / `AAR_TOOL` in `app/llm/tools.py`.
2. Add the name to `HISTORICAL_REMOVED_PLAY_TOOLS` (or the tier-equivalent set) in `backend/tests/test_prompt_tool_consistency.py`. **Do not skip this** — it's how future regressions get caught.
3. Search the codebase for the name in backticks: `grep -rn '`<name>`' backend/app frontend/src` — every hit in a model-facing string is a bug. Hits in code comments, removal-explanation docstrings, and `BUILTIN_TOOL_NAMES` (extension shadowing prevention) are intentional.
4. Run `pytest backend/tests/test_prompt_tool_consistency.py` — must pass. Then run `backend/scripts/run-live-tests.sh` to confirm no model-routing regression.

**Addition protocol**:

1. Add the tool to the tier's array.
2. The consistency test pulls names directly from those arrays — no test edit needed for additions.
3. If the tool's input schema introduces a new field name that appears in prompt copy (e.g. `share_data`'s `label` field), add the field name to `_NON_TOOL_ALLOWLIST` in the test file.

## Model-output trust boundary (read before touching any LLM call site)

Treat every LLM response as **untrusted input** with one well-defined
sanitisation point per call site. After that point, the rest of the system
reads the result as ground truth and does **no further coercion or
identity correction**. Two principles drive this:

1. **One boundary per call.** Validation, coercion, and identity resolution
   live in the function that pulls the tool input out of the response —
   `_extract_report` for AAR, dispatcher pre-checks for play tools,
   plan-extraction in setup. Defensive coercion in a downstream route
   handler (or worse, the frontend) is a **monkey patch**, not a fix:
   it diverges the on-disk shape from the rendered shape, multiplies the
   places a future bug can hide, and makes the storage layer untrustworthy.
   When you catch yourself writing `if isinstance(value, str): value = [value]`
   in a route or React component, stop and push it down to the extractor.

2. **Identity is OURS, not the model's.** Role IDs, session IDs, turn
   indices, message IDs — anything that names a row in our own state — must
   come from our state, never from a model field. If the model has to refer
   to an entity (e.g. "score this role"), pass the canonical IDs into the
   prompt and **validate every echoed ID at the extractor**: drop the entry
   if it doesn't match a real row, log the drop count so a prompt
   regression is observable, and never let an invented ID become a "name"
   we render to the user. If the model needs to talk about a thing, we
   pass it the thing's id and we look the thing up. This applies to every
   tier (setup, play, AAR, guardrail) and every tool that takes a
   role/turn/message/session reference.

The 2026-05-01 AAR fixes (PR #110) are the canonical example of getting
this wrong, then right:

- **Wrong (monkey patch).** `_str_list` was added to the JSON-export route
  to coerce string-blob bullets into `[string]`; role-id ↔ label
  resolution was also added in the route. The on-disk `aar_report` stayed
  malformed; only the JSON view looked correct, the markdown view kept
  rendering character-per-bullet.
- **Right (boundary fix).** Both coercions moved to `_extract_report` in
  `app/llm/export.py`. The roster is now passed to the model in the AAR
  system prompt as a `## Roster (canonical IDs)` block; entries with
  unknown role_ids are dropped with a `aar_per_role_scores_dropped` warning
  carrying `dropped_count`, `kept_count`, and the rejected ids. Sub-scores
  are clamped to 0–5 (the rubric's actual range) instead of trusting
  whatever int the model emitted. The route handler reverts to plain dict
  access on `session.aar_report`.

When adding a new LLM-driven feature, the checklist is:

- [ ] Pass identity (role/turn/session ids) into the prompt as a
      canonical-IDs block. Be explicit: "Use only these ids; any other
      value is dropped."
- [ ] Validate echoed identity at the extractor. Drop, don't repair.
- [ ] Coerce schema-shape drift at the extractor (e.g. string → `[string]`
      for `array<string>` fields). Don't trust `tool_use` validation alone.
- [ ] Clamp numeric fields to the documented range. Out-of-band → safe
      default, not "whatever the model said."
- [ ] Log drops + coercions at WARNING with enough context to debug a
      prompt regression from the audit log alone.

**`backend/app/llm/export.py::_extract_report`** is the reference shape.
Read it before adding a new structured-output tool.

## Coding conventions

- Python: `ruff` (config in `backend/pyproject.toml`), `mypy --strict`. No `print` or stdlib `logging` in business code — use `structlog`.
- TypeScript: ESLint flat config; `tsc -b --noEmit` clean.
- Async-first: every I/O path is `async`; locks are per-session (no globals).
- All config through `pydantic-settings` env vars; never hard-code.
- Commit style: `<area>: <imperative subject>` (e.g. `backend: add session repository`). Body explains *why*. Phase-1 bootstrap can use `chore:` / `docs:` / `ci:`.

## React: refs vs state for render-gating

**If render output depends on whether a `useRef` value is set, mirror the ref into `useState`.** `useRef` assignments do NOT trigger a re-render — `someRef.current = value` mutates the ref object in place and React stays unaware. JSX gated on `someRef.current` (e.g. `{wsRef.current ? <Foo/> : null}`) will look stale until something *else* nudges React to re-render. Pages with frequent state churn (the creator path on `Facilitator.tsx`) mask this; quieter paths (the player path on `Play.tsx`) leave the slot null forever.

The bug shipped in PR #115 (issue #98 shared notepad) and only surfaced during manual smoke. `wsRef.current` was set inside the WS-connect effect, but the player view had no follow-up state change to trigger a re-render, so the notepad slot stayed `null` indefinitely. Fix landed in commit `44b0606`: mirror the WS client into a `useState` (`wsClient`) alongside the ref; gate the slot on the state value.

**Rule of thumb when reaching for `useRef`:**
- Reading the ref's value inside an **event handler** or **effect** → `useRef` is correct (e.g. `wsRef.current?.send(...)`).
- Reading the ref's value inside **render** (anywhere in `return ( ... )`) → use `useState`. If you need both — a stable identity for handlers and a render-trigger — keep both: a ref for handlers, a state mirror for render. Update them together at the assignment site.

There is no ESLint rule for this — refs are legitimately read in render for non-JSX-gating purposes (DOM measurements, passing to children). Audit grep when reviewing a React PR: `grep -rEn 'Ref\.current\s*(\?\s*\(|\&\&)' frontend/src --include="*.tsx"`. Any hit gating JSX needs to move to state.

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

A cross-repo close needs the full `owner/repo#N` form (`Closes nebriv/Crittable#52`). Auto-close only fires when the PR merges into the **default branch** (`main`); merging into a feature branch never closes anything via these keywords.

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
  - **LLM calls** — `llm_call_start` / `llm_call_complete` (or `llm_call_failed`) with `tier`, `model`, `duration_ms`, `usage`, `estimated_usd`, `tool_uses`, `stop_reason`. Both backends emit the same shape — see `app/llm/client.py` (Anthropic-direct) and `app/llm/clients/litellm_client.py` (LiteLLM).
  - **State transitions** — every `SessionState` change emits a `session_event` line with `audit_kind`, `state`, `turn_index`. See `SessionManager._emit`.
  - **WebSocket connect/disconnect** — `ws_connected` / `ws_disconnected` with `session_id`, `role_id`, `kind`.
  - **Tool dispatch** — `tool_use` / `tool_use_rejected` (already audit-emitted).
  - **Extension dispatch** — `extension_invoked` / `extension_dispatch_failed`.
- **Every `try/except` that catches a broad exception must log it** before re-raising or swallowing. Silent swallows are bugs.
- **Don't log secrets**. `SESSION_SECRET`, `LLM_API_KEY`, raw join tokens, or full participant message bodies (preview to ≤120 chars).
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

## Scenario replay (solo-dev testing harness)

This repo ships a scenario record/replay system under `backend/app/devtools/`
+ `backend/scenarios/`. A scenario is a JSON file describing a full session
lifecycle (creation → setup → play → end → AAR) plus, for recordings, the
exact AI / system / inject messages that drove the original UI. The
`ScenarioRunner` plays it back through the **live** `SessionManager` so the
same code path runs in pytest, in the dev-tools API, and in God Mode.

Two replay modes:

- **`engine`** — the runner submits player input through `submit_response`
  and lets `run_play_turn` produce the AI side via the live LLM (or whatever
  `MockAnthropic` transport an external test installed). Used for prompt
  experimentation and live-LLM regression tests. Re-records may differ run
  to run.
- **`deterministic`** — the runner submits player input the same way, but
  for each turn it **injects** the recorded AI fallout (every `ai_text`,
  `ai_tool_call`, `critical_inject`, `system` message) directly into
  `session.messages` and opens the next turn with the role-set the
  recording captured. The LLM is never called during play. The transcript,
  highlights, broadcast/share_data icons, role colors, and filtering all
  reproduce byte-for-byte. The recorder defaults to this mode whenever AI
  fallout was captured.

### Commit rule (load-bearing)

**Any commit that adds a new `SessionState` transition, a new turn-pump
path, a new player-input gate, or a new `MessageKind` / tool-name / message
field that the frontend keys off MUST add or update a scenario in
`backend/scenarios/` exercising it.** The scenario file in the diff proves
the dev thought about the replay path; `pytest backend/tests/scenarios/`
then catches drift automatically.

This is a **review-blocking** rule the same way the sub-agent reviews are.
Phrase the carve-out explicitly in the commit body when the change
genuinely doesn't affect lifecycle (e.g. a CSS-only tweak, a static-asset
swap, a docstring fix). Don't carve out for "this prompt change won't
matter" — it almost always matters once a recorded scenario hits it.

### Known fragility seams

The runner's contract is durable for most feature shapes (new tools,
prompt edits, AI-behavior changes), but three seams require the runner
itself to be updated when they move:

1. **Lifecycle order** — `runner.run()` hardcodes
   `create → skip-or-setup → start → play → end`. If a new state
   slots in between (e.g. a "lobby-locked" gate), the runner needs an
   explicit handler.
2. **Active-set contract** — the deterministic driver opens the next turn
   with the role-set inferred from `play_turns[i+1].submissions`. A
   feature that decouples the active-set from the submission roles
   (e.g. AI-driven "watch but don't ask") needs the recorder to capture
   the active-set explicitly.
3. **Visibility per role** — `RecordedMessage.visibility` is widened to
   `"all"` on capture because role_ids change between sessions. A feature
   that depends on per-role visibility round-tripping needs a label-based
   visibility encoding.

Updating the runner for any of these counts as a "load-bearing" change;
flag in the PR description so reviewers know to re-record the existing
scenarios.

### Where to look

- `backend/app/sessions/submission_pipeline.py` — single source of truth
  for player-side input validation / truncation / guardrail. Both the
  WS handler and the scenario runner go through it; **any new input-side
  gate must land here**, not in either call site, or replays won't
  exercise it. See `docs/turn-lifecycle.md` § 1a for the full contract.
- `backend/app/devtools/scenario.py` — schema (Pydantic, JSON-serialisable).
- `backend/app/devtools/runner.py` — driver. Two-mode dispatch.
- `backend/app/devtools/recorder.py` — Session → Scenario.
- `backend/app/devtools/api.py` — gated REST surface
  (`/api/dev/scenarios/...`); requires `DEV_TOOLS_ENABLED=true`.
- `backend/scenarios/*.json` — preset scenarios.
- `backend/tests/scenarios/` — runner + API tests (incl. the
  AI-fidelity round-trip).
- `frontend/src/components/ScenarioPanel.tsx` — God Mode picker /
  recorder.

## Stream Timeout Prevention

This helps guard against the below error:
`API Error: Stream idle timeout - partial response received`

This error wastes tokens and time.

1. Do each numbered task ONE AT A TIME. Complete one task fully, confirm it worked, then move to the next.
2. Never write a file longer than ~150 lines in a single tool call. If a file will be longer, write it in multiple append/edit passes.
3. Start a fresh session if the conversation gets long (20+ tool calls). The error gets worse as the session grows.
4. Keep individual grep/search outputs short. Use flags like `--include` and `-l` (list files only) to limit output size.
5. If you do hit the timeout, retry the same step in a shorter form. Don't repeat the entire task from scratch.

## Always-do checklist (start of any task)

1. `git fetch && git checkout "$(git rev-parse --abbrev-ref HEAD)" && git pull` — confirm you're on the session's `claude/...` branch the harness designated; never `git checkout main`.
2. List current-phase open issues via `mcp__github__list_issues`.
3. Pick or confirm the issue you're working on.
4. Re-read [`docs/PLAN.md`](docs/PLAN.md) for the relevant section before making decisions that contradict it.
5. After meaningful work: run tests + lint locally before pushing.
6. If the diff touches `backend/app/llm/`, `backend/app/sessions/turn_*.py`, `backend/app/sessions/submission_pipeline.py`, or any prompt / tool description / recovery-directive copy, also run `backend/scripts/run-live-tests.sh` before pushing (~$0.10/run; hits the real Anthropic API). The non-live suite catches structural regressions; the live suite catches model-routing ones — the two are complementary, not redundant. Skip only when the diff is provably LLM-blind (CSS, type-only changes, comment fixes, scenarios JSON without engine-mode replay).
7. For Phase-2 issues: launch the three review sub-agents before requesting human review.
