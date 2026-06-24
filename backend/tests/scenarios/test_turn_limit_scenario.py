"""Scenario coverage for the cost/abuse C2 turn-limit PARK (lifecycle
rule: a new turn-pump path MUST add/update a scenario in
``backend/scenarios/``).

The shipped ``turn_limit_stop_2role.json`` documents a long-running
2-role exercise that should hit ``MAX_TURNS_PER_SESSION`` and PARK. This
test loads + validates that file, then drives it to the cap and asserts
the engine-side park: no further play call, no new turn, the flag, the
SYSTEM line, and the ``turn_limit_reached`` WS event.

Why we drive turns directly through the manager / TurnDriver rather than
``ScenarioRunner.run()``: the park is an *engine-side* behavior that only
fires inside ``run_play_turn`` / ``_apply_play_outcome`` (the guarded
paths). Deterministic replay can't express it (the deterministic runner
injects recorded AI messages and opens turns directly, bypassing those
guards — CLAUDE.md "Known fragility seams #1"). Engine-mode
``ScenarioRunner`` *does* call ``run_play_turn``, but the repo's
mock-LLM play scripts don't reliably keep both roles active across many
turns (documented at ``test_discussion_then_ready_scenario_runs``), so
we open each turn explicitly with both roles — the same pragmatic shape
that test uses — and let the real guards trip.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import reset_settings_cache
from app.devtools.runner import ScenarioRunner
from app.devtools.scenario import Scenario
from app.sessions.models import MessageKind, SessionState, Turn
from app.sessions.turn_driver import TurnDriver
from tests.mock_chat_client import (
    install_mock_chat_client,
    llm_result,
    text_block,
    tool_block,
)

_SCENARIO_PATH = (
    Path(__file__).resolve().parents[2] / "scenarios" / "turn_limit_stop_2role.json"
)


def test_turn_limit_scenario_file_is_valid_and_engine_mode() -> None:
    """The shipped JSON must be valid Pydantic and declare engine mode
    (deterministic mode can't exercise the engine-side park)."""

    scenario = Scenario.model_validate(json.loads(_SCENARIO_PATH.read_text()))
    assert scenario.replay_mode == "engine"
    assert scenario.skip_setup is True
    # More scripted play turns than the cap the test imposes, so the
    # park is reached before the script is exhausted.
    assert len(scenario.play_turns) >= 3
    # Every turn the runner would OPEN must carry role-groups.
    for turn in scenario.play_turns:
        assert turn.active_role_label_groups, "each turn needs role-groups"


def _always_yield_play_script(*role_ids: str, n: int = 12) -> list:
    """``n`` play responses that each broadcast + re-yield (never end),
    so the play loop would run forever absent the turn cap."""

    out = []
    for i in range(n):
        active = role_ids[i % len(role_ids)]
        out.append(
            llm_result(
                text_block(f"Beat {i}: continue the exercise."),
                tool_block("broadcast", {"message": f"Update {i}"}),
                tool_block("set_active_roles", {"role_groups": [[active]]}),
                stop_reason="tool_use",
            )
        )
    return out


@pytest.mark.asyncio
async def test_turn_limit_scenario_parks_at_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Low cap so the scripted 3-turn exercise trips the park before
    # exhausting its turns. Cap=2 → turns 0,1 run; opening turn 2 parks.
    # IMPORTANT: the env override must land BEFORE the app (and its
    # SessionManager, which captures ``Settings`` at construction) is
    # built — so we build a fresh app here rather than using the shared
    # ``client`` fixture, whose manager already snapshotted the default
    # cap of 40.
    from app.main import create_app

    monkeypatch.setenv("MAX_TURNS_PER_SESSION", "2")
    monkeypatch.setenv("LLM_MODEL_PLAY", "mock-play")
    monkeypatch.setenv("LLM_MODEL_SETUP", "mock-setup")
    monkeypatch.setenv("LLM_MODEL_AAR", "mock-aar")
    monkeypatch.setenv("LLM_MODEL_GUARDRAIL", "mock-guardrail")
    monkeypatch.setenv("SESSION_SECRET", "x" * 32)
    monkeypatch.setenv("INPUT_GUARDRAIL_ENABLED", "false")
    reset_settings_cache()

    scenario = Scenario.model_validate(json.loads(_SCENARIO_PATH.read_text()))
    app = create_app()
    with TestClient(app) as client:
        install_mock_chat_client(client)
        assert client.app.state.manager.settings().max_turns_per_session == 2
        await _drive_scenario_to_cap(client, scenario)


async def _drive_scenario_to_cap(client: TestClient, scenario: Scenario) -> None:
    manager = client.app.state.manager
    runner = ScenarioRunner(manager, scenario)
    await runner.create_session()
    sid = runner.progress.session_id
    assert sid is not None
    creator_id = runner.role_label_to_id["creator"]
    soc_id = runner.role_label_to_id["SOC Analyst"]

    # Install a play script that always re-yields, then walk turns.
    mock = install_mock_chat_client(
        client, scripts={"play": _always_yield_play_script(creator_id, soc_id)}
    )
    await runner._skip_setup()
    await manager.start_session(session_id=sid)

    async def _open_turn(index: int) -> Turn:
        session = await manager.get_session(sid)
        turn = Turn(
            index=index,
            active_role_groups=[[creator_id], [soc_id]],
            status="awaiting",
        )
        session.turns.append(turn)
        session.state = SessionState.AWAITING_PLAYERS
        await manager._repo.save(session)
        return turn

    # Drive turn 0 (under the cap) through the real engine path so the
    # play call fires and the outcome applies normally.
    turn0 = await _open_turn(0)
    session = await manager.get_session(sid)
    session.state = SessionState.AI_PROCESSING
    await TurnDriver(manager=manager).run_play_turn(session=session, turn=turn0)

    play_calls_before_cap = sum(1 for c in mock.calls if c["tier"] == "play")
    assert play_calls_before_cap >= 1, "turn under the cap should call the model"

    # Now drive a turn AT the cap (index == MAX_TURNS_PER_SESSION). The
    # entry guard must park without a play call.
    over_cap = await _open_turn(2)
    session = await manager.get_session(sid)
    session.state = SessionState.AI_PROCESSING
    result = await TurnDriver(manager=manager).run_play_turn(
        session=session, turn=over_cap
    )

    play_calls_after_cap = sum(1 for c in mock.calls if c["tier"] == "play")

    # No additional play-tier LLM call for the at-cap turn.
    assert play_calls_after_cap == play_calls_before_cap
    # Parked, not ended.
    assert result.turn_limit_reached is True
    assert result.state == SessionState.AWAITING_PLAYERS
    # SYSTEM "turn limit reached" line present (the cap is 2).
    sys_msgs = [m for m in result.messages if m.kind == MessageKind.SYSTEM]
    assert any("Turn limit reached (2 turns)" in m.body for m in sys_msgs)
    # No new turn was opened past the at-cap turn.
    assert result.turns[-1] is over_cap
