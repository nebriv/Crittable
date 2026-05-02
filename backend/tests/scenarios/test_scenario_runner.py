"""Unit-ish tests for the ScenarioRunner — drive a small Scenario through
the live SessionManager + a MockAnthropic transport, assert state.

Runs the runner against an in-process app rather than the full HTTP
TestClient — that's the runner's intended call surface (see
``app.devtools.api.play_scenario``). The HTTP path is covered by
``test_scenario_api.py`` separately.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.devtools.recorder import SessionRecorder
from app.devtools.runner import ScenarioRunner
from app.devtools.scenario import (
    PlayStep,
    PlayTurn,
    RoleSpec,
    Scenario,
    ScenarioMeta,
)
from app.sessions.models import SessionState


def _basic_scenario() -> Scenario:
    return Scenario(
        meta=ScenarioMeta(
            name="basic 2-role",
            description="test fixture",
            tags=["test"],
        ),
        scenario_prompt="Ransomware via vendor portal",
        creator_label="CISO",
        creator_display_name="Alex",
        skip_setup=True,
        roster=[RoleSpec(label="SOC", display_name="Bo", kind="player")],
        play_turns=[
            PlayTurn(
                submissions=[
                    PlayStep(role_label="creator", content="Isolate now."),
                    PlayStep(role_label="SOC", content="Acknowledged."),
                ]
            ),
            PlayTurn(
                submissions=[
                    PlayStep(role_label="creator", content="Stage comms."),
                    PlayStep(role_label="SOC", content="Recovery plan ready."),
                ]
            ),
        ],
    )


@pytest.mark.asyncio
async def test_runner_drives_full_lifecycle(
    client: TestClient, install_mock_for_roles
) -> None:
    """The runner should walk a scenario from create → end without errors,
    leaving the session in ENDED state."""

    scenario = _basic_scenario()
    manager = client.app.state.manager
    runner = ScenarioRunner(manager, scenario)
    # Step-mode: create the session first so we know the actual role_ids,
    # then install a richer mock that scripts play turns referencing those
    # ids. Without this the default mock returns end_session which trips
    # ``submit_response`` (state isn't AWAITING_PLAYERS once the session
    # has ended).
    await runner.create_session()
    role_ids = list(runner.role_label_to_id.values())
    install_mock_for_roles(client, role_ids[:2])
    # Reuse the same runner instance so progress tracks correctly.
    await runner._skip_setup()
    await runner.start_phase()
    await runner.play_phase()
    await runner.end_phase()
    assert runner.progress.error is None, runner.progress.error
    sid = runner.progress.session_id
    assert sid is not None
    session = await manager.get_session(sid)
    assert session.state == SessionState.ENDED
    assert runner.progress.play_turns_completed == 2


@pytest.mark.asyncio
async def test_runner_resolves_creator_label_alias(
    client: TestClient, install_mock_for_roles
) -> None:
    """``role_label="creator"`` and ``role_label=<creator_label>`` should
    both resolve to the same role_id."""

    scenario = _basic_scenario()
    manager = client.app.state.manager
    runner = ScenarioRunner(manager, scenario)
    await runner.create_session()
    assert (
        runner.role_label_to_id["creator"]
        == runner.role_label_to_id["CISO"]
    )


@pytest.mark.asyncio
async def test_runner_unknown_role_label_raises(
    client: TestClient, install_mock_for_roles
) -> None:
    """A scenario referencing a role label that isn't in the roster
    should fail loudly during play_phase, not silently skip.

    Uses step-mode (``create_session`` then install richer mock then
    drive) so the runner reaches ``play_phase`` before the default
    end-session mock terminates the session — the test wants to
    validate the role-resolution failure, not the early-end path.
    """

    scenario = _basic_scenario()
    scenario.play_turns[0].submissions[0] = PlayStep(
        role_label="Imaginary", content="Nope."
    )
    manager = client.app.state.manager
    runner = ScenarioRunner(manager, scenario)
    await runner.create_session()
    role_ids = list(runner.role_label_to_id.values())
    install_mock_for_roles(client, role_ids[:2])
    await runner._skip_setup()
    await runner.start_phase()
    try:
        await runner.play_phase()
    except RuntimeError as exc:
        assert "Imaginary" in str(exc)
        return
    raise AssertionError("expected play_phase to raise on unknown role label")


@pytest.mark.asyncio
async def test_recorder_captures_ai_messages_for_deterministic_replay(
    client: TestClient, install_mock_for_roles
) -> None:
    """Recording must capture every AI / system / critical_inject
    message so a deterministic replay can reproduce the exact transcript
    that drove the original UI (highlights, colours, tool icons,
    filtering all key off ``Message.kind`` + ``Message.tool_name``).

    Drive a scenario through the engine, record it, replay it
    deterministically, and assert the second session ends up with the
    same kind+tool_name+body sequence on AI messages.
    """

    from app.sessions.models import MessageKind

    scenario = _basic_scenario()
    manager = client.app.state.manager
    runner = ScenarioRunner(manager, scenario)
    await runner.create_session()
    role_ids = list(runner.role_label_to_id.values())
    install_mock_for_roles(client, role_ids[:2])
    await runner._skip_setup()
    await runner.start_phase()
    await runner.play_phase()
    await runner.end_phase()
    sid = runner.progress.session_id
    assert sid is not None
    original = await manager.get_session(sid)
    original_ai = [
        (m.kind, m.tool_name, m.body)
        for m in original.messages
        if m.kind != MessageKind.PLAYER and m.turn_id is not None
    ]
    assert original_ai, "expected the engine to emit some AI messages"

    recorded = SessionRecorder.to_scenario(
        original, name="captured", description="ai-fidelity check"
    )
    assert recorded.replay_mode == "deterministic", (
        "recording with AI fallout should default to deterministic replay"
    )
    captured_ai_count = sum(len(turn.ai_messages) for turn in recorded.play_turns)
    assert captured_ai_count > 0, (
        "recorder should capture AI messages, not just player submissions"
    )

    # Replay deterministically — no MockAnthropic install, the runner
    # injects recorded AI messages directly. If it tried to call the
    # LLM, the un-installed transport would crash.
    replay_runner = ScenarioRunner(manager, recorded)
    progress = await replay_runner.run()
    assert progress.error is None, progress.error
    assert progress.session_id is not None
    replayed = await manager.get_session(progress.session_id)
    replayed_ai = [
        (m.kind, m.tool_name, m.body)
        for m in replayed.messages
        if m.kind != MessageKind.PLAYER and m.turn_id is not None
    ]
    assert replayed_ai == original_ai, (
        "deterministic replay must reproduce the AI side of the transcript"
    )


@pytest.mark.asyncio
async def test_recorder_round_trip(
    client: TestClient, install_mock_for_roles
) -> None:
    """A session driven by the runner should round-trip through the recorder
    into a Scenario whose roster + play_turn shape matches the source."""

    scenario = _basic_scenario()
    manager = client.app.state.manager
    runner = ScenarioRunner(manager, scenario)
    await runner.create_session()
    role_ids = list(runner.role_label_to_id.values())
    install_mock_for_roles(client, role_ids[:2])
    await runner._skip_setup()
    await runner.start_phase()
    await runner.play_phase()
    await runner.end_phase()
    assert runner.progress.session_id is not None
    session = await manager.get_session(runner.progress.session_id)
    recorded = SessionRecorder.to_scenario(
        session, name="recorded", description="round-trip check"
    )
    assert recorded.creator_label == scenario.creator_label
    assert {r.label for r in recorded.roster} == {r.label for r in scenario.roster}
    # Recorded play turns should at least match the count we drove
    # (the recorder may add an extra turn for the final AI broadcast,
    # depending on how the mock script ends; assert >= not ==).
    assert len(recorded.play_turns) >= len(scenario.play_turns)
