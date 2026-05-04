# Backend scripts

Utility scripts for the play-tier engine. Most hit the live Anthropic
API and require `ANTHROPIC_API_KEY` in the environment. They auto-skip
or print a clear "set the key" message when it's missing.

| Script | When to run it | Cost (per run) |
|---|---|---|
| `run-live-tests.sh` | Whenever you want to run `backend/tests/live/` from inside the Claude Code agent harness (or any environment where setting `ANTHROPIC_API_KEY` directly would collide with the host process's SDK auth). Bridges `LIVE_TEST_ANTHROPIC_API_KEY` -> pytest. | ~$0.10 (full suite) |
| `live_recovery_check.py` | Before every push that touches `_DRIVE_RECOVERY_NOTE`, `_STRICT_YIELD_NOTE`, `_format_drive_user_nudge`, `Block 6` of the system prompt, or any `drive_recovery_directive` plumbing. | ~$0.03 |
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

Auto-skipped without the key. Cost ~$0.10 per full run.

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
