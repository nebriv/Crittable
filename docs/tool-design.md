# Tool design guidelines

> Read this before adding, renaming, or rewording any play-tier tool.
> The 2026-04-30 silent-yield regression and its three follow-on traps
> all came from tool descriptions the model interpreted differently
> than we expected. The patterns below are what we learned the hard
> way.

## Why this doc exists

Anthropic models pick tools based on **two signals** with roughly
comparable weight:
1. The tool's `description` string (sent in every API call alongside
   the system prompt).
2. The system prompt's behavioural rules (Block 6 in this codebase).

When the two are inconsistent — even subtly — the model picks based
on description, not the rule. The system prompt loses. So writing
tool descriptions is the **primary** lever for routing behavior;
the system prompt is reinforcement.

## The five traps we hit, and why

### Trap 1: Suggestive use cases attract the model

`inject_event` originally said *"use for status confirmations, time
advances, technical details."* The model read **"technical details"**
and used `inject_event` to answer "what do we see in Defender?"
even though that's a player-facing answer.

**Lesson**: avoid listing example use cases in a tool's description
unless they are **exhaustive and unambiguous**. Loose enumerations
become attractors.

### Trap 2: Bookkeeping tools become "I'll think first" entry points

`record_decision_rationale` was a creator-only debug note tool. The
model called it first as "let me articulate my reasoning" and then
**stopped** without producing player-facing output.

**Lesson**: never give the model a tool whose effect is purely
internal. If you need creator-side telemetry, derive it from the
model's natural text content blocks (which it emits alongside
tool_use), not from a dedicated tool. The current decision_log
captures rationale via `_harvest_rationale_from_text` in
`turn_driver.py`.

### Trap 3: Sidebar / metadata-only tools become "do something quick and stop"

`mark_timeline_point` produced no chat bubble — pure right-rail
metadata. The model called it after a player decision ("CISO chose
isolate → let me pin this") and stopped, leaving the player with no
chat acknowledgement.

**Lesson**: every tool the model can call on a normal turn should
produce some player-visible effect. Tools whose only effect is
metadata are perpetual silent-yield attractors. Either remove them,
make them implicit side-effects of player-facing tools (e.g. `share_data`
auto-pinning to the timeline), or restrict them to specific contexts
(e.g. only allowed during critical-inject chains).

### Trap 4: "Use sparingly" is read as a soft suggestion

`mark_timeline_point` had *"Use sparingly — only for moments players
will want to scroll back to."* The model interpreted this as
"available, low cost." It picked it on every turn.

**Lesson**: "use sparingly", "default answer is don't call it",
"never substitute for X" — these are read as soft preferences, not
hard rules. If you really mean a tool shouldn't be picked first,
either (a) remove it, or (b) split into two tools where one is
clearly the right answer, or (c) accept the recovery cascade as the
backstop.

### Trap 4b: Phantom-tool references survive a removal

After removing a tool from `PLAY_TOOLS`, **every backticked mention of
its name in a model-facing string is now a bug**. The model can't
call a tool that isn't in the API's `tools=[...]` array, but seeing
the name in the prompt confuses it and wastes tokens. The 2026-04-30
redesign removed three tools and missed eight separate references to
them in prompt blocks / recovery directives / tool descriptions. Each
one slipped past the live tool-routing tests because they don't fail
on "the model was told about X but couldn't pick X" — only on routing
outcomes.

**Mitigation**: `backend/tests/test_prompt_tool_consistency.py`
reconstructs every model-facing string per tier, regex-extracts
backticked snake_case names, and asserts each one is a current
tool in the tier's palette or a known non-tool concept. The
removal protocol in [`CLAUDE.md`](../CLAUDE.md) §"Prompt ↔ tool
consistency" requires adding the removed name to
`HISTORICAL_REMOVED_PLAY_TOOLS` so the test will flag any future
re-introduction.

### Trap 5: Trigger phrases bleed into adjacent contexts

`share_data` triggered on player phrases like *"pulling the logs"*.
A player saying "I'm pulling logs now" tripped the AI to dump
unsolicited telemetry on a tactical decision.

**Lesson**: trigger phrases only work for **questions directed at the
AI**. The description must say "the player asked YOU for X" — not
just "X is in the message." Use phrases like "what do we see?",
"show me", "give me" — second-person address from the player to
the AI.

## Authoring rules

Every play-tier tool description **must** answer these questions in
the first sentence:

| Question | Why it matters |
|---|---|
| What does it produce in the chat? | Player-facing AI bubble vs system pill vs sidebar pin vs invisible. The model uses this to decide if calling it counts as "responding." |
| When is it the right tool? | Specific trigger conditions, in second-person ("the player asked you X"). |
| When is it explicitly the wrong tool? | List 3-5 forbidden contexts inline. The model needs explicit DO-NOT cases to avoid bleed. |
| Does it yield? | Always end with "Does NOT yield — pair with `set_active_roles`" or "Yields the turn." |

## Writing checklist

Before adding or rewording a tool, verify each:

- [ ] **Single rendering channel.** Does the tool produce exactly
      one type of player-visible output (AI message, system note,
      sidebar pin, banner)? Mixed-effect tools confuse the model.
- [ ] **Explicit DO-NOT list.** Have you listed 3-5 contexts where
      this tool is wrong, named alongside the right tool for each?
      If a description has only "use this for X" and no "do not use
      for Y" — it's not done.
- [ ] **Second-person trigger phrases.** When listing trigger
      phrases for tools that respond to player asks, make sure
      every phrase is from the player to the AI, not just any
      mention of the topic.
- [ ] **Routing confirmed against the live model.** Add a case to
      `backend/tests/live/test_tool_routing.py` that asserts the
      model picks this tool for a representative scenario, and a
      negative case asserting it does NOT pick this tool for a
      lookalike scenario.
- [ ] **No "use sparingly".** That phrase is a defeated cause.
      Either it's the right tool for the context (so make the
      context explicit) or it's not (remove it).
- [ ] **No legacy enumerations.** Don't list "use for: X, Y, Z"
      style examples — they become attractors. Use scenario rules
      instead ("when a player says ...").

## The current play-tier palette (post-2026-04-30 redesign)

| Tool | Slot | Renders as | Description summary |
|---|---|---|---|
| `broadcast` | DRIVE | AI text bubble (everyone) | The default speaking tool. Answer questions, brief beats, react to calls. |
| `address_role` | DRIVE | AI text bubble (still everyone, but visually directed) | Same content as broadcast, focussed on one role. |
| `share_data` | DRIVE | AI text bubble with bold label + markdown body | Synthetic data dump (logs, IOCs, telemetry) **only when explicitly asked**. |
| `pose_choice` | DRIVE | AI text bubble with question + lettered options | Multi-choice tactical decision prompt for one role. |
| `set_active_roles` | YIELD | (no chat — engine state change) | Yield the turn. Mandatory pair with one of the player-facing tools above. |
| `end_session` | TERMINATE | (no chat — kicks AAR) | Terminate the exercise. |
| `inject_critical_event` | ESCALATE | Red banner (everyone) | Headline-grade escalation. MUST be followed in same turn by broadcast + set_active_roles. |
| `request_artifact` | BOOKKEEPING | (no chat — engine state) | Ask a role for a structured deliverable. Pair with broadcast for the framing. |
| `track_role_followup` | BOOKKEEPING | (no chat) | Open a per-role follow-up todo. |
| `resolve_role_followup` | BOOKKEEPING | (no chat) | Close a tracked follow-up. |
| `lookup_resource` | BOOKKEEPING | (no chat) | Fetch a registered extension resource. |
| `use_extension_tool` | BOOKKEEPING | (varies — extension-defined) | Invoke any registered extension tool. |

### Removed in the 2026-04-30 redesign

- `record_decision_rationale` — creator-only debug note. Model used it
  as a "I'll think first" entry point and stopped. Replaced by
  text-content harvesting from the model's natural prose.
- `inject_event` — gray system note for ambient narration. Model used
  it as a stand-in for answering questions. Ambient narration is
  achievable via `broadcast` with a stylized markdown prefix
  (`*[T+5min — Defender auto-isolated FIN-04]*`).
- `mark_timeline_point` — sidebar pin. Model picked it as a "do
  something quick and stop" attractor.

The dispatcher handlers for these tools remain as defensive dead code
so an extension or legacy mock script that emits them still routes
correctly. The phase-policy filter blocks them from reaching the live
API in the first place (they're not in `PLAY_TOOLS`).

## Iteration recipe

When adding a new tool — or when a regression is reported — follow
this loop:

1. **Run the live tool-routing suite** to capture the current state:
   ```bash
   cd backend && ANTHROPIC_API_KEY=sk-ant-... pytest tests/live/ -v
   ```
2. **Add a case** to `tests/live/test_tool_routing.py` that exercises
   the scenario you care about. Both a positive case (the tool is
   picked) and a negative case (the tool is NOT picked for a similar
   but inappropriate scenario).
3. **Run the suite again** — if the negative case fails (the tool was
   picked when it shouldn't have been), the description is too loose.
   Tighten the DO-NOT list, then iterate.
4. **Run `scripts/diagnostic_full_response.py`** if you need to see
   the full model response (text content + all tool_use blocks) for
   one specific scenario.
5. **Document the tightening** in this doc's "traps" section if it
   surfaces a new pattern. Future authors learn from your tightening.

## Cost notes

The live tool-routing suite costs ~$0.10 per full run (9 tests × ~$0.01
each). The full live suite (incl. AAR / consistency / edge-fixture /
long-context cases) is ~$1.40 per run. Auto-skipped unless
`ANTHROPIC_API_KEY` is set. Run it:

- After every prompt edit to Block 6.
- After every tool description change.
- After adding any new tool.
- Before tagging a release.

## CI: when the live suite runs automatically

[`.github/workflows/live-tests.yml`](../.github/workflows/live-tests.yml)
gates the live suite behind explicit triggers — every-PR-runs would
quietly multiply the per-PR spend by N. The triggers are OR-ed:

| Trigger | When it fires | Why |
|---|---|---|
| `pull_request` path filter | PR to `main` touches `backend/app/llm/**`, `backend/app/sessions/**`, `backend/app/extensions/**`, `backend/tests/live/**`, the conftest, the cost-cap test, the diagnostic scripts, or the workflow itself | The change can plausibly regress model routing, so verify before merge. |
| `labeled` event | The `live-tests` label is added to a PR that also touched a relevant path | Re-fire after a label tweak. For label-only PRs (no relevant path change), use `workflow_dispatch` instead. |
| `workflow_dispatch` | A maintainer clicks "Run workflow" in the Actions UI | Manual one-shots, fork PRs after code-review, ad-hoc filters via the `pytest_args` input. |
| `schedule` (nightly 08:00 UTC) | Daily | Catches "Anthropic shipped a model update under us" / "the per-turn reminder regressed at depth" drift the path filter wouldn't see. |

The job uses `pull_request` (NOT `pull_request_target`) so fork-PR
runs do not get the secret — the live conftest's auto-skip then
cleanly marks every test as SKIP. To live-test a fork PR after
code-review, a maintainer dispatches the workflow against the PR's
head ref via the Actions UI.

### Per-run dollar cap

[`backend/tests/live/cost_cap.py`](../backend/tests/live/cost_cap.py)
intercepts every `AsyncAnthropic.messages.create` AND
`messages.stream` call during the live session, multiplies
`usage.input_tokens` / `output_tokens` / cache tokens by the
per-million rate from
[`app/llm/cost.py`](../backend/app/llm/cost.py), and aborts the run
when the cumulative spend crosses the cap. Default cap: **$2.00**
(standing suite is ~$1.40, ~$0.60 / 40% headroom for new tests,
latency variance, and one retried flake). A tighter default would
false-trip on routine variance and push contributors toward
`LIVE_TEST_COST_CAP_USD=0`, which is exactly the failure mode the
cap exists to prevent. Override per-run via the
`LIVE_TEST_COST_CAP_USD` env var or the `workflow_dispatch` input.
Set to `0` to disable for an intentional stress run. Bad values
(typos, negatives) fall back to the default rather than silently
disabling — a misconfigured cap should NEVER quietly torch the
budget.

The terminal summary always prints `live-API spend: $X.XXXX across
N call(s)` so a contributor sees what they spent on every run, not
only when the cap fires.

### Live tests on fork PRs

Fork PRs do NOT auto-run live tests. The workflow uses
`pull_request` (not `pull_request_target`), so secrets aren't
injected for forks; a maintainer dispatches the workflow against
the fork's head ref via the Actions UI after a code-review pass.
Contributors from forks: if your change touches `backend/app/llm/**`,
`backend/app/sessions/**`, or `backend/app/extensions/**`, mention
"please run live tests" in the PR description so a maintainer knows
to dispatch.

## Sequence diagram — adding a new tool

```mermaid
sequenceDiagram
    participant Dev as Developer
    participant Code as Codebase
    participant Live as Live API
    participant Tests as Test Suite

    Dev->>Code: 1. Add tool def to PLAY_TOOLS<br/>(with explicit DO-NOT list)
    Dev->>Code: 2. Map to a Slot in slots.py
    Dev->>Code: 3. Add to BUILTIN_TOOL_NAMES
    Dev->>Code: 4. Implement handler in dispatch.py
    Dev->>Code: 5. Add to interject allowed-set if appropriate
    Dev->>Tests: 6. Add test case(s) in tests/live/
    Dev->>Tests: 7. Run unit tests (must pass)
    Dev->>Live: 8. Run live tool-routing suite
    Live-->>Dev: PASS / FAIL routing
    alt routing fails
        Dev->>Code: Tighten description and iterate
        Dev->>Live: Re-run live suite
    end
    Dev->>Code: 9. Update docs/turn-lifecycle.md
    Dev->>Code: 10. Update docs/prompts.md if Block 6 changed
    Dev->>Code: 11. Update this doc with any new trap pattern
```

## Diagnostic scripts

Two scripts in `backend/scripts/` complement the test suite:

- **`live_recovery_check.py`** — runs the full drive/yield recovery
  cascade against the live model. Three checks: normal turn (full
  palette), drive recovery (broadcast pinned), yield recovery
  (set_active_roles pinned). Use it as the pre-push smoke test for
  the recovery-side of the engine.

- **`diagnostic_full_response.py`** — runs three palette variants
  (full / rationale-removed / data-tools-removed) and dumps the
  complete model response (text + all tool_use blocks) for
  comparison. Use it when you suspect a tool is being overpicked or
  a routing trap and want to see what the model actually produced
  before tightening.

Both scripts use the production `_play_messages` builder so they see
the same context the engine sends. Both auto-skip without an API key.

## Case study: the four traps in 30 minutes

The 2026-04-30 tool-palette redesign landed in roughly four iteration
cycles. Each cycle:
1. Run the live tool-routing suite.
2. Identify which tool the model picked instead of the right one.
3. Either tighten or remove that tool.
4. Repeat.

The cycles in order:

| # | Symptom | Tool the model picked | Fix |
|---|---|---|---|
| 1 | "What do we see?" → no answer | `inject_event` (gray pill) | Tighten + add `share_data` |
| 2 | Player decision → no acknowledgement | `mark_timeline_point` | Tighten, then remove from palette |
| 3 | Player decision (cleaner) → no acknowledgement | `inject_event` again | Remove from palette |
| 4 | Player decision (cleanest) → ambient narrate | `share_data` (over-applied) | Tighten with explicit trigger phrases |

After 4 cycles + a fixture cleanup, all 9 live tests pass and the
model produces the right tool first-attempt. **Total cost of the
iteration: ~$1 in API calls.** The framework paid for itself in the
first regression caught after merge.
