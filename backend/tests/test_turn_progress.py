"""Per-turn progress percentage for the TURN STATE rail (issue #111).

Covers the policy in ``app/sessions/progress.py`` plus the integration
points: the snapshot serializer, the ``state_changed`` /
``turn_changed`` WS broadcasts, and the play-turn driver's sub-step
writes.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import reset_settings_cache
from app.main import create_app
from app.sessions.models import Session, SessionState, Turn
from app.sessions.progress import compute_progress_pct
from tests.conftest import default_settings_body
from tests.mock_anthropic import MockAnthropic, setup_then_play_script

# ---------------------------------------------------------------- unit tests


def _session_at(state: SessionState, *, turn: Turn | None = None) -> Session:
    sess = Session(scenario_prompt="ransomware via vendor portal")
    sess.state = state
    if turn is not None:
        sess.turns = [turn]
    return sess


def test_progress_none_for_setup_states() -> None:
    """SETUP / CREATED / READY have no natural sub-step pulse — keep
    the indeterminate sweep so a stuck-at-zero bar doesn't read as
    broken."""

    for state in (SessionState.CREATED, SessionState.SETUP, SessionState.READY):
        assert compute_progress_pct(_session_at(state)) is None


def test_progress_full_for_ended() -> None:
    assert compute_progress_pct(_session_at(SessionState.ENDED)) == 1.0


def test_progress_awaiting_players_submitted_over_active() -> None:
    """``AWAITING_PLAYERS`` → submitted / active. The natural ratio is
    documented in the issue body."""

    turn = Turn(
        index=0,
        active_role_ids=["a", "b", "c", "d"],
        submitted_role_ids=["a", "b"],
        ready_role_ids=["a"],
    )
    sess = _session_at(SessionState.AWAITING_PLAYERS, turn=turn)
    assert compute_progress_pct(sess) == 0.5


def test_progress_awaiting_players_zero_active_returns_none() -> None:
    """A turn with no active roles is degenerate (the engine resets
    the active set on yield) — surface as ``None`` rather than divide
    by zero."""

    turn = Turn(index=0, active_role_ids=[], submitted_role_ids=[])
    sess = _session_at(SessionState.AWAITING_PLAYERS, turn=turn)
    assert compute_progress_pct(sess) is None


def test_progress_awaiting_players_clamped_to_one() -> None:
    """Force-advance can produce ``submitted > active`` if the engine
    later trimmed the active set; clamp so the bar never overflows."""

    turn = Turn(
        index=0,
        active_role_ids=["a"],
        submitted_role_ids=["a", "b"],
    )
    sess = _session_at(SessionState.AWAITING_PLAYERS, turn=turn)
    assert compute_progress_pct(sess) == 1.0


def test_progress_ai_processing_reads_turn_field() -> None:
    """``AI_PROCESSING`` / ``BRIEFING`` mirror the driver-written
    sub-step value. ``None`` early in the turn falls back to the
    sweep."""

    turn_with_progress = Turn(
        index=0, active_role_ids=["a"], ai_progress_pct=0.66
    )
    sess = _session_at(SessionState.AI_PROCESSING, turn=turn_with_progress)
    assert compute_progress_pct(sess) == 0.66

    sess_briefing = _session_at(SessionState.BRIEFING, turn=turn_with_progress)
    assert compute_progress_pct(sess_briefing) == 0.66

    turn_unset = Turn(index=0, active_role_ids=["a"])
    assert compute_progress_pct(_session_at(SessionState.AI_PROCESSING, turn=turn_unset)) is None


# ----------------------------------------------------- integration via REST


@pytest.fixture(autouse=True)
def _env(monkeypatch) -> None:
    monkeypatch.setenv("LLM_MODEL_PLAY", "mock-play")
    monkeypatch.setenv("LLM_MODEL_SETUP", "mock-setup")
    monkeypatch.setenv("LLM_MODEL_AAR", "mock-aar")
    monkeypatch.setenv("LLM_MODEL_GUARDRAIL", "mock-guardrail")
    monkeypatch.setenv("SESSION_SECRET", "x" * 32)
    monkeypatch.setenv("INPUT_GUARDRAIL_ENABLED", "false")
    reset_settings_cache()


@pytest.fixture
def client() -> TestClient:
    reset_settings_cache()
    app = create_app()
    with TestClient(app) as c:
        c.app.state.llm.set_transport(MockAnthropic({}).messages)
        yield c


def _seat_two(client: TestClient) -> dict[str, Any]:
    resp = client.post(
        "/api/sessions",
        json={
            "scenario_prompt": "Ransomware via vendor portal",
            "creator_label": "CISO",
            "creator_display_name": "Alex",
            **default_settings_body(),
        },
    )
    created = resp.json()
    sid = created["session_id"]
    creator_token = created["creator_token"]
    creator_role_id = created["creator_role_id"]
    r = client.post(
        f"/api/sessions/{sid}/roles?token={creator_token}",
        json={"label": "Player_1", "display_name": "P1"},
    )
    other = r.json()
    return {
        "sid": sid,
        "creator_token": creator_token,
        "creator_role_id": creator_role_id,
        "other_token": other["token"],
        "other_role_id": other["role_id"],
    }


def _drive_to_play(client: TestClient, seats: dict[str, Any]) -> None:
    role_ids = [seats["creator_role_id"], seats["other_role_id"]]
    scripts = setup_then_play_script(role_ids=role_ids, extension_tool="")
    client.app.state.llm.set_transport(MockAnthropic(scripts).messages)
    client.post(f"/api/sessions/{seats['sid']}/setup/skip?token={seats['creator_token']}")
    client.post(f"/api/sessions/{seats['sid']}/start?token={seats['creator_token']}")


def test_snapshot_includes_progress_pct(client: TestClient) -> None:
    """The snapshot's ``current_turn`` block surfaces the new
    ``progress_pct`` field after a session reaches AWAITING_PLAYERS."""

    seats = _seat_two(client)
    _drive_to_play(client, seats)

    snap = client.get(
        f"/api/sessions/{seats['sid']}?token={seats['creator_token']}"
    ).json()
    assert snap["state"] == "AWAITING_PLAYERS"
    assert snap["current_turn"] is not None
    assert "progress_pct" in snap["current_turn"]
    # Fresh turn, no submissions yet — 0 / N.
    active_count = len(snap["current_turn"]["active_role_ids"])
    submitted_count = len(snap["current_turn"].get("submitted_role_ids", []))
    expected = submitted_count / active_count if active_count else None
    assert snap["current_turn"]["progress_pct"] == expected


# --------------------------------------- integration via direct manager api


class _RecordingConnections:
    def __init__(self, real: Any) -> None:
        self._real = real
        self.events: list[dict[str, Any]] = []

    async def broadcast(
        self, session_id: str, event: dict[str, Any], *, record: bool = True
    ) -> None:
        self.events.append({**event, "_session_id": session_id, "_record": record})
        await self._real.broadcast(session_id, event, record=record)

    async def send_to_role(self, *args: Any, **kwargs: Any) -> Any:
        return await self._real.send_to_role(*args, **kwargs)

    async def shutdown(self) -> Any:
        return await self._real.shutdown()

    async def connected_role_ids(self, *args: Any, **kwargs: Any) -> Any:
        return await self._real.connected_role_ids(*args, **kwargs)

    async def focused_role_ids(self, *args: Any, **kwargs: Any) -> Any:
        return await self._real.focused_role_ids(*args, **kwargs)

    async def role_has_other_connections(self, *args: Any, **kwargs: Any) -> Any:
        return await self._real.role_has_other_connections(*args, **kwargs)

    async def register(self, *args: Any, **kwargs: Any) -> Any:
        return await self._real.register(*args, **kwargs)

    async def unregister(self, *args: Any, **kwargs: Any) -> Any:
        return await self._real.unregister(*args, **kwargs)

    async def stream(self, *args: Any, **kwargs: Any) -> Any:
        return self._real.stream(*args, **kwargs)


def _wrap_connections(client: TestClient) -> _RecordingConnections:
    real = client.app.state.connections
    rec = _RecordingConnections(real)
    client.app.state.connections = rec
    client.app.state.manager._connections = rec
    client.app.state.llm.set_connections(rec)
    return rec


def test_state_changed_and_turn_changed_carry_progress_pct(
    client: TestClient,
) -> None:
    """Every ``state_changed`` / ``turn_changed`` broadcast must
    include ``progress_pct`` so a connected client can update the bar
    without a snapshot fetch (the field rides as part of the snapshot
    delta — issue #111 'piggy-back' contract)."""

    rec = _wrap_connections(client)
    seats = _seat_two(client)
    _drive_to_play(client, seats)

    relevant = [
        e for e in rec.events if e.get("type") in ("state_changed", "turn_changed")
    ]
    # Must have observed at least one of each kind (start_session →
    # state_changed BRIEFING; the play turn yield → turn_changed +
    # state_changed AWAITING_PLAYERS).
    assert any(e["type"] == "state_changed" for e in relevant), relevant
    assert any(e["type"] == "turn_changed" for e in relevant), relevant
    for evt in relevant:
        assert "progress_pct" in evt, evt


def test_play_turn_writes_ai_progress_pct_at_sub_step_boundaries(
    client: TestClient,
) -> None:
    """The driver pulses the progress fraction at known sub-steps:
    planning → tool dispatch → emit / yield. The series of
    ``state_changed`` broadcasts during AI_PROCESSING / BRIEFING must
    show monotonically advancing fractions for a happy-path turn,
    capped at 1.0 only at the validation-success boundary."""

    rec = _wrap_connections(client)
    seats = _seat_two(client)
    _drive_to_play(client, seats)

    # Filter to state_changed broadcasts emitted during AI_PROCESSING
    # / BRIEFING (the driver's pulses fire there). Use the broadcast's
    # ``state`` field rather than session-state-at-broadcast because
    # the recording isn't time-ordered against session mutation.
    in_play = [
        e
        for e in rec.events
        if e.get("type") == "state_changed"
        and e.get("state") in ("AI_PROCESSING", "BRIEFING")
    ]
    assert in_play, "expected at least one AI_PROCESSING / BRIEFING state_changed"
    fractions = [e.get("progress_pct") for e in in_play if e.get("progress_pct") is not None]
    # At least one pulse must carry a non-null fraction (the driver
    # writes 0.10 → 0.40 → 0.70 → 1.0 for a happy-path attempt).
    assert fractions, [e.get("progress_pct") for e in in_play]
    # Monotonic non-decreasing: the bar never goes backwards within a
    # single turn. Recovery passes that compute lower bucket values
    # are absorbed by the clamp inside ``_set_progress``.
    for i in range(1, len(fractions)):
        assert fractions[i] >= fractions[i - 1], fractions


def test_set_progress_monotonic_clamp() -> None:
    """``_set_progress`` enforces a monotonic-non-decreasing contract
    and a [0, 1] clamp. Tested directly on the helper because the
    recovery-pass code path is hard to script reliably (the validator
    contract evolves) and the contract is critical for the user-
    persona review's "bar must not appear to rewind" requirement."""

    import asyncio

    from app.sessions.turn_driver import TurnDriver

    class _StubBroadcast:
        def __init__(self) -> None:
            self.calls: list[float | None] = []

        async def broadcast(self, *args: Any, **kwargs: Any) -> None:
            event = args[1] if len(args) > 1 else kwargs.get("event")
            self.calls.append(event["progress_pct"] if event else None)

    class _StubManager:
        def __init__(self) -> None:
            self._connections = _StubBroadcast()

        def connections(self) -> Any:
            return self._connections

        async def _broadcast_state(
            self, session: Session, *, record: bool = True
        ) -> None:
            from app.sessions.progress import compute_progress_pct

            await self._connections.broadcast(
                session.id,
                {"type": "state_changed", "progress_pct": compute_progress_pct(session)},
                record=record,
            )

    mgr = _StubManager()
    driver = TurnDriver(manager=mgr)  # type: ignore[arg-type]
    turn = Turn(index=0, active_role_ids=["a"])
    sess = _session_at(SessionState.AI_PROCESSING, turn=turn)

    async def run() -> None:
        # Ascending: each pulse advances the bar.
        await driver._set_progress(sess, turn, 0.10)
        await driver._set_progress(sess, turn, 0.40)
        await driver._set_progress(sess, turn, 0.70)
        # Equal value (dedupe) — no new broadcast.
        await driver._set_progress(sess, turn, 0.70)
        # Lower value (recovery bucket regression) — monotonic clamp
        # rejects the write so the bar doesn't visibly rewind.
        await driver._set_progress(sess, turn, 0.30)
        # Ascending again past the prior high-water mark.
        await driver._set_progress(sess, turn, 0.85)
        # Success snaps to 1.0.
        await driver._set_progress(sess, turn, 1.0)
        # Out-of-range values are clamped to [0, 1].
        await driver._set_progress(sess, turn, 99.0)  # >1 → no change (already at 1.0)
        await driver._set_progress(sess, turn, -1.0)  # <0 → no change

    asyncio.run(run())

    # Expected broadcast sequence: 0.10, 0.40, 0.70, 0.85, 1.0
    assert mgr._connections.calls == [0.10, 0.40, 0.70, 0.85, 1.0]
    # Final state on the turn: 1.0.
    assert turn.ai_progress_pct == 1.0


def test_non_creator_snapshot_carries_progress_pct(client: TestClient) -> None:
    """The ``progress_pct`` field is unconditional on the snapshot —
    a non-creator (player) role sees it too. Confirms no creator-
    only data accidentally rides on the new field (security review
    LOW: positive test for cross-role visibility)."""

    seats = _seat_two(client)
    _drive_to_play(client, seats)

    # Player snapshot via the non-creator token.
    snap = client.get(
        f"/api/sessions/{seats['sid']}?token={seats['other_token']}"
    ).json()
    assert snap["state"] == "AWAITING_PLAYERS"
    assert snap["current_turn"] is not None
    assert "progress_pct" in snap["current_turn"]
    # Non-creator must still get a valid value (or null), not a 403.
    assert snap["current_turn"]["progress_pct"] is None or (
        0.0 <= snap["current_turn"]["progress_pct"] <= 1.0
    )


