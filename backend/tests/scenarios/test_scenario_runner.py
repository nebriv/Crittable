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
    that drove the original UI (highlights, colors, tool icons,
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


@pytest.mark.asyncio
async def test_discussion_then_ready_scenario_runs(
    client: TestClient,
) -> None:
    """Wave 1 (issue #134) QA review H1+H2: the
    ``discussion_then_ready.json`` scenario file in
    ``backend/scenarios/`` must (a) be valid Pydantic, (b) preserve
    its multi-role discussion structure as documentation, and (c) drive
    every recorded submission through the live submission pipeline
    end-to-end so per-submission ``intent`` survives.

    Why we bypass ``ScenarioRunner.play_phase`` here: the runner
    trusts the AI's ``set_active_roles`` for each turn, and the
    mock-LLM scripts in this repo (and the active-roles narrower)
    don't reliably keep both roles active across multiple turns. For
    the canonical scenario file we want the multi-role discussion to
    *actually fire*, so we pre-open each turn with both roles active
    via the manager and drive the submissions directly through the
    same ``prepare_and_submit_player_response`` boundary the WS
    handler and the runner both use. That keeps the scenario file
    multi-role (correct documentation of Wave 1's purpose) without
    coupling the test to the runner's mock-script fragility.
    """

    import asyncio
    import json
    from pathlib import Path

    from app.devtools.scenario import Scenario
    from app.sessions.models import MessageKind, SessionState, Turn
    from app.sessions.submission_pipeline import (
        prepare_and_submit_player_response,
    )

    scenarios_dir = Path(__file__).resolve().parents[2] / "scenarios"
    raw = json.loads(
        (scenarios_dir / "discussion_then_ready.json").read_text()
    )
    scenario = Scenario.model_validate(raw)

    # (a) Sanity: the scenario file actually exercises discuss +
    # ready across multiple roles. Catches a future scenario edit
    # that accidentally simplifies away the multi-role discussion.
    intents = [
        step.intent
        for turn in scenario.play_turns
        for step in turn.submissions
    ]
    assert "discuss" in intents, (
        "scenario should include at least one discuss-intent submission"
    )
    assert "ready" in intents, (
        "scenario should include at least one ready-intent submission"
    )
    role_labels = {
        step.role_label
        for turn in scenario.play_turns
        for step in turn.submissions
    }
    assert len(role_labels) >= 2, (
        "scenario should exercise multi-role discussion, not solo"
    )

    # (b) Spin up a session through the runner's create + skip-setup
    # path so the role roster matches the scenario's role labels.
    manager = client.app.state.manager
    runner = ScenarioRunner(manager, scenario)
    await runner.create_session()
    await runner._skip_setup()
    sid = runner.progress.session_id
    assert sid is not None
    creator_id = runner.role_label_to_id["creator"]
    soc_id = runner.role_label_to_id["SOC Analyst"]

    # (c) Drive each scripted submission through the live pipeline.
    # Pre-open each turn with both roles active so every submission
    # lands as a turn-submission (not an interjection). The test
    # exercises the ``intent`` field at every layer:
    #   - the WS payload (skipped — pipeline boundary is the
    #     equivalent contract);
    #   - submission_pipeline (forwards intent);
    #   - manager.submit_response (writes Message.intent + updates
    #     ready_role_ids).
    for turn in scenario.play_turns:

        async def _open() -> None:
            session = await manager.get_session(sid)
            new_turn = Turn(
                index=len(session.turns),
                active_role_groups=[[creator_id], [soc_id]],
                status="awaiting",
            )
            session.turns.append(new_turn)
            session.state = SessionState.AWAITING_PLAYERS
            await manager._repo.save(session)

        # If we're past the first turn, AI_PROCESSING gets flipped by
        # the previous turn's last ready submission; transition back
        # to AWAITING_PLAYERS by opening the next turn.
        session = await manager.get_session(sid)
        if (
            session.current_turn is None
            or session.current_turn.status != "awaiting"
        ):
            await _open()

        for step in turn.submissions:
            role_id = (
                creator_id if step.role_label == "creator"
                or step.role_label == scenario.creator_label
                else soc_id
            )
            await prepare_and_submit_player_response(
                manager=manager,
                session_id=sid,
                role_id=role_id,
                content=step.content,
                intent=step.intent,
            )

    # (d) Verify intent survived end-to-end on every submission, both
    # roles. Pre-Wave-1 ``Message.intent`` was always ``None``; this
    # asserts the field landed on each turn-submission.
    session = await manager.get_session(sid)
    by_role: dict[str, list[str | None]] = {creator_id: [], soc_id: []}
    for m in session.messages:
        if (
            m.kind == MessageKind.PLAYER
            and not m.is_interjection
            and m.role_id in by_role
        ):
            by_role[m.role_id].append(m.intent)
    creator_intents = by_role[creator_id]
    soc_intents = by_role[soc_id]
    assert "ready" in creator_intents, (
        f"creator should have at least one ready submission; got {creator_intents}"
    )
    assert "discuss" in soc_intents, (
        f"SOC should have at least one discuss-intent submission; got {soc_intents}"
    )
    assert "ready" in soc_intents, (
        f"SOC should close turn 1 with a ready submission; got {soc_intents}"
    )
    # Belt-and-braces: every recorded submission's intent matches a
    # message in the transcript with the same intent — the scenario
    # round-trips faithfully.
    expected_intents = sorted(
        step.intent
        for turn in scenario.play_turns
        for step in turn.submissions
    )
    actual_intents = sorted(creator_intents + soc_intents)
    # Drop any None / interjection entries that slipped through —
    # asserting expected as a multiset against actual non-None.
    actual_non_none = sorted(i for i in actual_intents if i is not None)
    assert actual_non_none == expected_intents, (
        f"every scripted intent should appear in the transcript "
        f"(expected={expected_intents}, got={actual_non_none})"
    )

    # Silence the asyncio-import lint — kept for the closure in
    # ``_open`` if the surrounding code grows.
    _ = asyncio


@pytest.mark.asyncio
async def test_runner_routes_player_submissions_through_pipeline(
    install_mock_for_roles, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A scripted submission whose content exceeds
    ``max_participant_submission_chars`` MUST be truncated by the
    runner's pipeline call — proving runner submissions go through
    the same gates the WS handler does.

    Boots its own app instance because ``Settings`` is captured at
    ``SessionManager`` construction time; the shared ``client``
    fixture's manager has the default 4000-char cap baked in and
    can't be retro-monkey-patched.
    """

    from app.config import reset_settings_cache
    from app.main import create_app
    from tests.mock_anthropic import MockAnthropic

    monkeypatch.setenv("MAX_PARTICIPANT_SUBMISSION_CHARS", "50")
    reset_settings_cache()
    app = create_app()
    with TestClient(app) as test_client:
        test_client.app.state.llm.set_transport(MockAnthropic({}).messages)
        scenario = _basic_scenario()
        # Replace the first scripted submission with a too-long body.
        scenario.play_turns[0].submissions[0] = PlayStep(
            role_label="creator",
            content="X" * 200,
        )
        manager = test_client.app.state.manager
        runner = ScenarioRunner(manager, scenario)
        await runner.create_session()
        role_ids = list(runner.role_label_to_id.values())
        install_mock_for_roles(test_client, role_ids[:2])
        await runner._skip_setup()
        await runner.start_phase()
        await runner.play_phase()
        sid = runner.progress.session_id
        assert sid is not None
        session = await manager.get_session(sid)
        # The scripted oversize body must have been truncated by the
        # pipeline before it landed in the transcript.
        creator_id = runner.role_label_to_id["creator"]
        creator_messages = [
            m for m in session.messages if m.role_id == creator_id
        ]
        assert creator_messages, "expected at least one creator message"
        first = creator_messages[0]
        assert "[message truncated by server]" in (first.body or ""), (
            "runner must route submissions through the truncation gate "
            "the WS handler enforces"
        )
        assert len(first.body or "") < 200


@pytest.mark.asyncio
async def test_deterministic_replay_preserves_workstream_and_mentions(
    client: TestClient,
) -> None:
    """Chat-declutter polish: the deterministic-replay path round-trips
    ``workstream_id`` + ``mentions`` from the scenario JSON to the
    persisted ``Message``. Without this the replay UI would render
    every recorded AI message in #main with no ``@-highlight``,
    defeating the whole point of the polish PR.

    Deterministic-mode contract: ``play_turns[0]`` is the briefing —
    submissions=[] and ai_messages = the briefing's AI fallout.
    Subsequent turns carry the player responses + the next AI fallout.
    """

    from app.devtools.scenario import RecordedMessage

    scenario = Scenario(
        meta=ScenarioMeta(
            name="ws round-trip",
            description="workstream + mentions deterministic round-trip",
            tags=["test", "chat-declutter"],
        ),
        scenario_prompt="Ransomware via vendor portal",
        creator_label="CISO",
        creator_display_name="Alex",
        skip_setup=True,
        roster=[
            RoleSpec(label="IR Lead", display_name="Jordan", kind="player"),
            RoleSpec(label="SOC Analyst", display_name="Bo", kind="player"),
        ],
        play_turns=[
            # Turn 0: briefing only — no submissions per the
            # deterministic-mode contract.
            PlayTurn(
                submissions=[],
                ai_messages=[
                    RecordedMessage(
                        kind="ai_text",
                        body="Briefing — Jordan and Bo, take point.",
                        tool_name="broadcast",
                        role_label=None,
                        workstream_id=None,
                        mentions=["IR Lead", "SOC Analyst"],
                    ),
                ],
            ),
            # Turn 1: responses to the briefing + tagged AI fallout.
            PlayTurn(
                submissions=[
                    PlayStep(role_label="IR Lead", content="On it.", intent="ready"),
                    PlayStep(role_label="SOC Analyst", content="Logs pulled.", intent="ready"),
                ],
                ai_messages=[
                    RecordedMessage(
                        kind="ai_text",
                        body="Jordan, contain laptops 4-9.",
                        tool_name="address_role",
                        tool_args={"message": "contain"},
                        role_label=None,
                        is_interjection=False,
                        visibility="all",
                        workstream_id="containment",
                        mentions=["IR Lead"],
                    ),
                    RecordedMessage(
                        kind="ai_text",
                        body="Cross-cutting beat broadcast.",
                        tool_name="broadcast",
                        role_label=None,
                        is_interjection=False,
                        visibility="all",
                        workstream_id=None,
                        mentions=[],
                    ),
                ],
            ),
        ],
        replay_mode="deterministic",
    )

    manager = client.app.state.manager
    runner = ScenarioRunner(manager, scenario)
    progress = await runner.run()
    assert progress.error is None, progress.error
    assert progress.session_id is not None

    session = await manager.get_session(progress.session_id)
    ai_messages = [m for m in session.messages if m.kind.value.startswith("ai")]
    # Turn-0 briefing + turn-1 (address_role + broadcast) = 3 AI messages.
    assert len(ai_messages) == 3
    briefing, addressed, broadcast = ai_messages
    # Briefing is unscoped + mentions IR Lead + SOC Analyst.
    assert briefing.workstream_id is None
    ir_lead_id = runner.role_label_to_id["IR Lead"]
    soc_id = runner.role_label_to_id["SOC Analyst"]
    assert set(briefing.mentions) == {ir_lead_id, soc_id}
    # address_role: tagged containment, mentions IR Lead → translated to
    # the fresh role_id the runner minted.
    assert addressed.workstream_id == "containment"
    assert addressed.mentions == [ir_lead_id]
    # Broadcast: unscoped (#main), no mentions — empty list survives
    # the round-trip without being coerced.
    assert broadcast.workstream_id is None
    assert broadcast.mentions == []


@pytest.mark.asyncio
async def test_deterministic_replay_drops_undeclared_workstream(
    client: TestClient,
) -> None:
    """A scenario that names a workstream the spawned session's plan
    doesn't declare gets coerced to ``None`` (the #main bucket) at the
    ``append_recorded_message`` boundary. This protects against a
    scenario file written against a different default plan from
    polluting the replay with ghost workstreams."""

    from app.devtools.scenario import RecordedMessage

    scenario = Scenario(
        meta=ScenarioMeta(name="ghost ws", description="", tags=["test"]),
        scenario_prompt="Ransomware",
        creator_label="CISO",
        creator_display_name="Alex",
        skip_setup=True,
        roster=[
            RoleSpec(label="IR Lead", display_name="Jordan", kind="player"),
            RoleSpec(label="SOC Analyst", display_name="Bo", kind="player"),
        ],
        play_turns=[
            PlayTurn(
                submissions=[],
                ai_messages=[
                    RecordedMessage(
                        kind="ai_text",
                        body="cross-cutting",
                        tool_name="broadcast",
                        role_label=None,
                        workstream_id="vendor_management",  # not declared
                    ),
                ],
            ),
        ],
        replay_mode="deterministic",
    )
    manager = client.app.state.manager
    runner = ScenarioRunner(manager, scenario)
    progress = await runner.run()
    assert progress.error is None, progress.error
    session = await manager.get_session(progress.session_id)  # type: ignore[arg-type]
    ai = [m for m in session.messages if m.kind.value == "ai_text"]
    assert ai, "expected the recorded ai_text to be persisted"
    # Undeclared id was dropped to None — the message renders in #main,
    # NOT against an invented workstream slot.
    assert ai[0].workstream_id is None
