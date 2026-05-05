# Backend scripts

Utility scripts for the play-tier engine. Most hit the live Anthropic
API and require `ANTHROPIC_API_KEY` in the environment. They auto-skip
or print a clear "set the key" message when it's missing.

| Script | When to run it | Cost (per run) |
|---|---|---|
| `run-live-tests.sh` | Whenever you want to run `backend/tests/live/` from inside the Claude Code agent harness (or any environment where setting `ANTHROPIC_API_KEY` directly would collide with the host process's SDK auth). Bridges `LIVE_TEST_ANTHROPIC_API_KEY` -> pytest. | ~$0.10 (full suite) |
| `live_recovery_check.py` | Before every push that touches `_DRIVE_RECOVERY_NOTE`, `_STRICT_YIELD_NOTE`, `_format_drive_user_nudge`, `Block 6` of the system prompt, or any `drive_recovery_directive` plumbing. | ~$0.03 |
| `issue_151_before_after.py` | Issue #151 regression demo. Run when changing the dispatcher's inject-pairing scan, the validator's `pending_critical_inject_args` plumbing, or Block 6's "Critical-inject chain" rule. Three probes: (1) live solo-inject baseline rate, (2) dispatcher-level fix-A pre/post comparison (no API), (3) live recovery-grounding fix-B pre/post comparison. Emits a JSON report with `--json`. | ~$0.15 |
| `diagnostic_full_response.py` | When you suspect a tool is being mis-picked and want to see the full model response (text + all tool_use blocks) across three palette variants. | ~$0.05 |

Both scripts use the production message-build path (`_play_messages`)
so what you observe matches what production sends to the model.

## live_recovery_check.py

Runs three live API calls that exercise the recovery cascade:

1. **Normal play turn** (full palette, no `tool_choice`): does the
   model attempt-1 the full shape (drive + yield in one response)?
   Informational; failure here is not a hard fail because the
   cascade is the load-bearing fix — but a high failure rate on this
   check means the prompt copy or tool descriptions need tightening.
2. **Drive recovery** (tools narrowed to `broadcast`, pinned via
   `tool_choice`, prior `record_decision_rationale` tool-loop spliced
   in, recovery user nudge with the verbatim player `?`): the
   broadcast must reference the source the player asked about.
3. **Yield recovery** (tools narrowed to `set_active_roles`, pinned):
   `set_active_roles` returns valid role IDs.

Exit code 0 if checks 2+3 pass (regardless of check 1). Use as a
pre-push smoke test.

```bash
cd backend && ANTHROPIC_API_KEY=sk-ant-... python scripts/live_recovery_check.py
```

Add `--verbose` to dump the full request/response for each call.

## issue_151_before_after.py

Reproduces issue #151's "AI silently yields after `inject_critical_event`" failure mode and demonstrates the post-fix engine + recovery behaviour. Three probes:

1. **Solo-inject baseline rate** (`--runs N`, default 5). On a fixture seeded to provoke `inject_critical_event` (a critical-typed inject in the plan, transcript past the inject's trigger), counts how often the live model emits the inject without a same-response DRIVE-slot tool. The fix doesn't change this rate — it changes how the engine *responds* when the rate is non-zero. Last measured at ~50–80% on `claude-sonnet-4-6`.
2. **Dispatch-layer rejection (fix A)**. Replays a synthetic solo-inject response through the dispatcher in two configurations: pre-fix (pairing scan bypassed → inject lands; `is_error=False`; banner fires) and post-fix (live code → inject rejected with structured chain-shape hint; `is_error=True`; banner does NOT fire). No live API call.
3. **Recovery grounding (fix B)** (`--recovery-samples N`, default 3). Constructs the post-Fix-A recovery state (model fired inject, dispatcher rejected, validator now firing missing-DRIVE recovery) and runs the same recovery prompt twice — once with the OLD generic addendum, once with the NEW inject-grounded addendum. Two metrics:
   - **Lenient grounded rate**: at least one inject keyword appears anywhere in the broadcast (uniformly high — the model's own prior tool_use carries the inject context).
   - **Strict leading-with-inject rate**: the broadcast OPENS with an inject frame ("CRITICAL INJECT", "BREAKING", "MEDIA LEAK", "🚨"). Last measured 40% pre-fix → 100% post-fix.

```bash
cd backend && ANTHROPIC_API_KEY=sk-ant-... python scripts/issue_151_before_after.py
# tighter / cheaper:
python scripts/issue_151_before_after.py --runs 3 --recovery-samples 2
# JSON report (clean stdout, audit chatter goes to stderr):
python scripts/issue_151_before_after.py --json > report.json
```

Inside the harness, prefix the call with `ANTHROPIC_API_KEY="$LIVE_TEST_ANTHROPIC_API_KEY"` to scope the bridged var to the subprocess only (per the same harness-shadowing rule that motivated `run-live-tests.sh`).

## diagnostic_full_response.py

Runs the same scenario across three palette variants:

* Variant 1: full play palette.
* Variant 2: with `record_decision_rationale` removed (was a "think
  first and stop" attractor before the tool was killed).
* Variant 3: with rationale + `inject_event` + `mark_timeline_point`
  removed.

Compares which tools the model picks under each. Useful for
diagnosing "why does the model pick X instead of Y?" — by removing
candidate tools you can see whether the issue is X being too
attractive or Y being too unattractive.

```bash
cd backend && ANTHROPIC_API_KEY=sk-ant-... python scripts/diagnostic_full_response.py
```

## Tool-routing pytest suite

The live tool-routing tests in `backend/tests/live/test_tool_routing.py`
are the **authoritative regression net** for tool-routing behavior.
Run them after any change to:
* `PLAY_TOOLS` in `app/llm/tools.py`,
* Block 6 in `app/llm/prompts.py`,
* the recovery directives in `app/sessions/turn_validator.py`,
* the per-turn reminder in `app/sessions/turn_driver.py`.

```bash
cd backend && ANTHROPIC_API_KEY=sk-ant-... pytest tests/live/ -v
```

Auto-skipped without the key. Cost ~$0.10 per tool-routing run; the
full live suite (incl. AAR / consistency / edge-fixture / long-context)
is ~$1.40.

Inside the Claude Code agent harness, **don't** set `ANTHROPIC_API_KEY`
as a session-wide secret — it shadows the harness's own SDK auth and
breaks the session. Store the key as `LIVE_TEST_ANTHROPIC_API_KEY`
instead and use the wrapper, which scopes the bridged var to the
pytest subprocess only:

```bash
backend/scripts/run-live-tests.sh                # full suite
backend/scripts/run-live-tests.sh -k test_aar    # pytest filter
```

See [`docs/tool-design.md`](../../docs/tool-design.md) for the
authoring guidelines this suite enforces.

### CI: gated live-tests workflow

[`.github/workflows/live-tests.yml`](../../.github/workflows/live-tests.yml)
runs the live suite automatically on:

* **PRs to `main` that touch routing- or prompt-relevant paths** —
  `backend/app/llm/**`, `backend/app/sessions/**`,
  `backend/app/extensions/**`, `backend/tests/live/**`, the diagnostic
  scripts in this directory, or the workflow file itself.
* **The `live-tests` label** on a PR with a relevant path change.
  (For PRs where the label is the only trigger and no relevant
  paths changed, use `workflow_dispatch`.)
* **`workflow_dispatch`** — Actions-UI button. Optional inputs:
  `pytest_args` (narrow filter), `cost_cap_usd` (override the per-run
  dollar cap), `anthropic_model_play` (validate Sonnet N → N+1
  migration).

There is no scheduled cron — see [`docs/tool-design.md`](../../docs/tool-design.md)
"CI: when the live suite runs automatically" for the rationale and
the cheap "weekly Monday cron" / "routing-only nightly" options if
you ever want periodic drift checks.

Fork PRs run with `pull_request` (NOT `pull_request_target`), so
secrets are not injected; the live conftest's auto-skip cleanly
marks every test SKIP. A maintainer can `workflow_dispatch` against
the fork's head ref after code-review.

### Per-run dollar cap

The live conftest installs a session-scoped wrapper around
`AsyncAnthropic.messages.create` that records `response.usage` and
multiplies by the per-million-token rate from `app/llm/cost.py`. When
the cumulative spend crosses `LIVE_TEST_COST_CAP_USD` (default
**$2.00**; standing suite ~$1.40, ~40% headroom), the in-flight test
finishes and the next teardown sets `session.shouldstop` to halt cleanly.

* Override per-run: `LIVE_TEST_COST_CAP_USD=2.50 pytest tests/live/`.
* Disable (intentional stress run): `LIVE_TEST_COST_CAP_USD=0 ...`.
* Typos / negatives fall back to the default — a typo should NEVER
  silently uncork the budget.
* Pass it inline (`VAR=value command ...`) rather than exporting it
  in a shell rc or in `.env` — keep the override scoped to one run
  so a forgotten `export` doesn't quietly raise the ceiling for the
  whole machine.

The terminal summary always prints `live-API spend: $X.XXXX across
N call(s)` regardless of whether the cap fired.
