# Scenarios

Declarative session-lifecycle definitions for solo-dev testing and e2e
regression. Each `*.json` file in this directory becomes a scenario the
dev-tools API exposes via `GET /api/dev/scenarios` (when
`DEV_TOOLS_ENABLED=true` or `TEST_MODE=true`).

## Running a scenario

**From the UI:** open God Mode (creator-only), Scenarios tab, pick one,
hit Play. The runner spawns a fresh session and walks the entire
lifecycle (setup → play → end → AAR) while the dev watches.

**From pytest:** see `backend/tests/scenarios/test_scenario_replay.py` —
each `*.json` in this directory becomes a parameterised test that drives
the scenario with the deterministic `MockAnthropic` transport. Used as a
regression net so the contract between scenarios and the engine doesn't
silently rot.

**From the CLI:** the `app.devtools.runner.ScenarioRunner` is a plain
async class — drive it from a notebook or a one-off script if you want
to step through phases (`runner.create_session()`, `runner.setup_phase()`,
etc.) instead of `runner.run()`.

## Recording a scenario

Run a session manually through the UI; when it ends, hit "Download
recorded scenario" in God Mode. That hits
`POST /api/dev/sessions/{id}/record`, which dumps the session's
`setup_notes` + `messages` into a Scenario JSON. Save the file as
`backend/scenarios/<slug>.json` and the scenario picker will pick it up
on the next reload.

The recording **does not** include a `mock_llm_script`. Replaying it
re-drives the live LLM — fine for dev experimentation, but the real
regression-net pattern is to copy the recorded scenario into
`backend/tests/scenarios/fixtures/` and pair it with a hand-built mock
script for deterministic playback.

## Scenario format

Authoritative schema: `backend/app/devtools/scenario.py`. Quick reference:

```json
{
  "meta": {
    "name": "human-readable display name",
    "description": "one paragraph; what the scenario exercises",
    "tags": ["smoke", "2role"]
  },
  "scenario_prompt": "the seed text the AI uses to plan the scenario",
  "creator_label": "CISO",
  "creator_display_name": "Alex",
  "skip_setup": false,
  "roster": [
    {"label": "SOC Analyst", "display_name": "Bo", "kind": "player"}
  ],
  "setup_replies": [
    {"content": "creator's first reply to the AI's setup question"}
  ],
  "play_turns": [
    {
      "submissions": [
        {"role_label": "CISO", "content": "isolate now"},
        {"role_label": "SOC Analyst", "content": "acknowledged"}
      ]
    }
  ],
  "end_reason": "scenario complete",
  "mock_llm_script": null
}
```

Notes:

- `skip_setup: true` drops a default plan and jumps straight to READY.
  Use this for scenarios that don't care about the setup dialogue.
- Each `play_turn`'s `submissions` are sent in order. The runner waits
  for each to be acknowledged before sending the next, mirroring the
  real engine's per-turn cadence.
- `role_label` references must match a `roster` entry's `label`, or the
  literal string `"creator"` (which resolves to the creator role at
  runtime regardless of `creator_label`).

## Existing scenarios

- **`smoke_2role.json`** — fastest path: skips setup, 2 roles, 3 play
  turns. ~$0.10 per run against real LLM.
- **`full_5role_phishing.json`** — full lifecycle including setup
  dialogue, 5 roles, 6 play turns. ~$0.20 per run; exercises the
  multi-role active-set narrowing and per-role AAR scoring.

## Security gating

The `/api/dev/scenarios/...` endpoints 404 unless
`DEV_TOOLS_ENABLED=true` or `TEST_MODE=true`. Even with the flag on,
the play and record endpoints require a creator token. **Never enable
this on a deployed instance** — a leaked creator token plus the flag
would let an attacker spin up sessions that consume model tokens.
