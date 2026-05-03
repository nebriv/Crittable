"""Edge-path tests for ``app.devtools.runner.ScenarioRunner``.

Coverage gap addressed: the runner is at 79% line coverage. The
existing ``test_scenario_runner.py`` covers the happy path well, but
the failure-recovery paths flagged in CLAUDE.md as "load-bearing
seams" (lines 204–228, 692–712) were not exercised. A regression
here could result in a runner that swallows exceptions and reports
``finished=True, error=None`` while the spawned session is in a
broken state — a debugging nightmare during dev play.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.devtools.runner import ScenarioRunner
from app.devtools.scenario import (
    PlayStep,
    PlayTurn,
    RecordedCost,
    RecordedDecisionEntry,
    RecordedMessage,
    RoleSpec,
    Scenario,
    ScenarioMeta,
)
from app.sessions.models import MessageKind, SessionState


def _scenario_with_side_channels() -> Scenario:
    """Minimal scenario whose only payload is end-of-play side-channel
    state: notepad snapshot, decision log, cost. Drives the
    ``_apply_session_side_channels`` branch end-to-end."""

    return Scenario(
        meta=ScenarioMeta(name="side-channels", description="", tags=[]),
        scenario_prompt="Ransomware",
        creator_label="CISO",
        creator_display_name="Alex",
        skip_setup=True,
        roster=[RoleSpec(label="SOC", display_name="Bo", kind="player")],
        play_turns=[
            PlayTurn(
                submissions=[
                    PlayStep(role_label="creator", content="Isolate."),
                    PlayStep(role_label="SOC", content="Acknowledged."),
                ]
            )
        ],
        notepad_snapshot="# Containment\n- isolated finance subnet\n",
        notepad_pinned_message_ids=["msg-1", "msg-1", "msg-2"],  # dupe filter
        notepad_contributor_role_labels=["SOC", "ghost-role"],  # ghost skipped
        decision_log=[
            RecordedDecisionEntry(turn_index=1, rationale="Triage first."),
        ],
        cost=RecordedCost(
            input_tokens=10_000,
            output_tokens=2_000,
            cache_read_tokens=5_000,
            cache_creation_tokens=1_000,
            estimated_usd=0.0345,
        ),
    )


# ---------------------------------------------------------------- pre-conditions


def test_must_session_id_raises_before_create() -> None:
    """Calling any phase before ``create_session`` should raise loudly,
    not silently no-op. The ``_must_session_id`` guard is the canary."""

    sc = _scenario_with_side_channels()
    runner = ScenarioRunner(manager=None, scenario=sc)  # type: ignore[arg-type]
    with pytest.raises(RuntimeError, match="not created a session"):
        runner._must_session_id()


@pytest.mark.asyncio
async def test_resolve_role_unknown_label_raises(
    client: TestClient, install_mock_for_roles
) -> None:
    """Scenarios that reference a role label not in the roster should
    surface a clear error rather than a confusing KeyError."""

    sc = _scenario_with_side_channels()
    manager = client.app.state.manager
    runner = ScenarioRunner(manager, sc)
    await runner.create_session()
    with pytest.raises(RuntimeError, match="not in roster"):
        runner._resolve_role("Marketing")


# ---------------------------------------------------------------- skip-setup transitions


@pytest.mark.asyncio
async def test_skip_setup_is_idempotent_when_already_ready(
    client: TestClient, install_mock_for_roles
) -> None:
    """``_skip_setup`` may be called multiple times — the second call
    should no-op (because ``finalize_setup`` rejects with
    IllegalTransitionError otherwise) so callers can safely retry."""

    sc = _scenario_with_side_channels()
    manager = client.app.state.manager
    runner = ScenarioRunner(manager, sc)
    await runner.create_session()
    await runner._skip_setup()
    sid = runner.progress.session_id
    sess = await manager.get_session(sid)
    assert sess.state == SessionState.READY
    # Second call must not raise.
    await runner._skip_setup()
    sess2 = await manager.get_session(sid)
    assert sess2.state == SessionState.READY


# ---------------------------------------------------------------- side-channel application


@pytest.mark.asyncio
async def test_side_channels_dedupe_and_skip_unknown_labels(
    client: TestClient, install_mock_for_roles
) -> None:
    """Verify the four documented quirks of ``_apply_session_side_channels``:

    * Notepad markdown lands on ``session.notepad.markdown_snapshot``.
    * Pinned message ids are deduped (the scenario lists ``msg-1`` twice).
    * Contributor labels are resolved; unknown labels are silently skipped.
    * Cost numbers round-trip exactly.
    """

    sc = _scenario_with_side_channels()
    manager = client.app.state.manager
    runner = ScenarioRunner(manager, sc)
    await runner.create_session()
    role_ids = list(runner.role_label_to_id.values())
    install_mock_for_roles(client, role_ids[:2])
    await runner._skip_setup()
    await runner.start_phase()
    await runner.play_phase()
    sid = runner.progress.session_id
    sess = await manager.get_session(sid)

    # notepad snapshot landed
    assert sess.notepad.markdown_snapshot.startswith("# Containment")
    # dedupe: ["msg-1", "msg-1", "msg-2"] → ["msg-1", "msg-2"]
    assert sess.notepad.pinned_message_ids == ["msg-1", "msg-2"]
    # SOC resolved, ghost-role dropped
    soc_id = runner.role_label_to_id["SOC"]
    assert soc_id in sess.notepad.contributor_role_ids
    assert all(rid != "ghost-role" for rid in sess.notepad.contributor_role_ids)
    # decision log appended
    assert len(sess.decision_log) >= 1
    assert sess.decision_log[-1].rationale == "Triage first."
    # cost round-trip
    assert sess.cost.input_tokens == 10_000
    assert sess.cost.estimated_usd == pytest.approx(0.0345)


# ---------------------------------------------------------------- end-phase short-circuit


@pytest.mark.asyncio
async def test_end_phase_no_ops_when_already_ended(
    client: TestClient, install_mock_for_roles
) -> None:
    """Test the explicit short-circuit branch that logs
    ``session already ENDED — skipping explicit end``."""

    sc = _scenario_with_side_channels()
    manager = client.app.state.manager
    runner = ScenarioRunner(manager, sc)
    await runner.create_session()
    role_ids = list(runner.role_label_to_id.values())
    install_mock_for_roles(client, role_ids[:2])
    await runner._skip_setup()
    sid = runner.progress.session_id
    creator_id = runner.role_label_to_id["creator"]
    # End the session out-of-band, BEFORE end_phase runs.
    await manager.end_session(
        session_id=sid, by_role_id=creator_id, reason="manual"
    )
    # end_phase should now log "already ENDED" and return without raising.
    await runner.end_phase()
    assert runner.progress.error is None
    assert any("already ENDED" in line for line in runner.progress.log)


# ---------------------------------------------------------------- run() error capture


@pytest.mark.asyncio
async def test_run_captures_exception_into_progress_error(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If any phase raises, ``run()`` must set ``progress.error`` and
    still set ``progress.finished=True`` so the polling UI can move on
    instead of spinning forever."""

    sc = _scenario_with_side_channels()
    manager = client.app.state.manager
    runner = ScenarioRunner(manager, sc)

    async def boom() -> None:
        raise RuntimeError("kaboom")

    monkeypatch.setattr(runner, "create_session", boom)
    progress = await runner.run()
    assert progress.finished
    assert progress.error is not None
    assert "RuntimeError" in progress.error
    assert "kaboom" in progress.error


# ---------------------------------------------------------------- deterministic ai-message inject


def _scenario_with_recorded_ai() -> Scenario:
    """Scenario with a single recorded AI broadcast in ``play_turns[0].
    ai_messages`` so the deterministic inject branch fires."""

    return Scenario(
        meta=ScenarioMeta(name="recorded-ai", description="", tags=[]),
        scenario_prompt="Ransomware",
        creator_label="CISO",
        creator_display_name="Alex",
        skip_setup=True,
        roster=[RoleSpec(label="SOC", display_name="Bo", kind="player")],
        replay_mode="deterministic",
        play_turns=[
            PlayTurn(
                submissions=[],
                ai_messages=[
                    RecordedMessage(
                        kind="ai_text",
                        body="Detection at 03:14",
                        tool_name="broadcast",
                    ),
                ],
            ),
        ],
    )


@pytest.mark.asyncio
async def test_deterministic_inject_appends_recorded_ai_text(
    client: TestClient,
) -> None:
    """The deterministic mode should append the recorded AI message
    via ``append_recorded_message`` rather than calling the LLM."""

    sc = _scenario_with_recorded_ai()
    manager = client.app.state.manager
    runner = ScenarioRunner(manager, sc)
    await runner.create_session()
    await runner._skip_setup()
    await runner.start_phase()
    await runner.play_phase()
    sid = runner.progress.session_id
    sess = await manager.get_session(sid)
    bodies = [m.body for m in sess.messages if m.kind == MessageKind.AI_TEXT]
    assert any("Detection at 03:14" in b for b in bodies)


# ---------------------------------------------------------------- pacing edge cases


@pytest.mark.asyncio
async def test_pace_from_ts_handles_invalid_iso_strings(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Malformed ``ts`` strings should fall through to the fallback
    sleep instead of crashing the replay. Capture sleep so the
    fallback path is asserted, not just inferred."""

    import asyncio as _asyncio

    sc = _scenario_with_recorded_ai()
    manager = client.app.state.manager
    runner = ScenarioRunner(manager, sc)

    captured: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        captured.append(seconds)

    monkeypatch.setattr(_asyncio, "sleep", fake_sleep)
    await runner._pace_from_ts("not-an-iso-date", "also-bogus")
    # ValueError → fallback path fires asyncio.sleep(_PACE_FALLBACK_S).
    assert captured == [ScenarioRunner._PACE_FALLBACK_S]


@pytest.mark.asyncio
async def test_pace_from_ts_clamps_long_idle_gaps(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A 5-minute recorded gap must be clamped to ``_PACE_CEILING_S``
    so the replay isn't unwatchable."""

    import asyncio as _asyncio

    sc = _scenario_with_recorded_ai()
    manager = client.app.state.manager
    runner = ScenarioRunner(manager, sc)

    captured: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        captured.append(seconds)

    monkeypatch.setattr(_asyncio, "sleep", fake_sleep)
    await runner._pace_from_ts(
        "2026-04-30T10:05:00", "2026-04-30T10:00:00"  # 5min delta
    )
    assert captured  # _pace_from_ts called sleep
    assert captured[0] == ScenarioRunner._PACE_CEILING_S
