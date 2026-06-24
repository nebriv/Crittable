"""Cost/abuse C2 — ``MAX_TURNS_PER_SESSION`` enforcement.

When a play turn at/over the cap would be DRIVEN or OPENED:
  * NO play-tier LLM call is made,
  * no new turn opens,
  * ``session.turn_limit_reached`` flips True,
  * a ``turn_limit_reached`` WS event + a SYSTEM message are emitted,
  * state lands in AWAITING_PLAYERS (no auto-end).
Repeat ``_park_turn_limit_reached`` calls are idempotent — they
re-broadcast the nudge but append no duplicate SYSTEM line.

The entry guard lives in ``run_play_turn`` (turn.index >= cap) and the
advance-point guard in ``_apply_play_outcome`` (would-open index >= cap);
both funnel through ``_park_turn_limit_reached``.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import reset_settings_cache
from app.main import create_app
from app.sessions.models import MessageKind, Session, SessionState, Turn
from app.sessions.turn_driver import TurnDriver
from tests.conftest import default_settings_body
from tests.mock_chat_client import (
    install_mock_chat_client,
    llm_result,
    setup_then_play_script,
    tool_block,
)


@pytest.fixture(autouse=True)
def _env(monkeypatch) -> None:
    monkeypatch.setenv("LLM_MODEL_PLAY", "mock-play")
    monkeypatch.setenv("LLM_MODEL_SETUP", "mock-setup")
    monkeypatch.setenv("LLM_MODEL_AAR", "mock-aar")
    monkeypatch.setenv("LLM_MODEL_GUARDRAIL", "mock-guardrail")
    monkeypatch.setenv("SESSION_SECRET", "x" * 32)
    monkeypatch.setenv("INPUT_GUARDRAIL_ENABLED", "false")
    # Low cap so the entry/advance guards trip in a short scripted run.
    monkeypatch.setenv("MAX_TURNS_PER_SESSION", "2")
    reset_settings_cache()


@pytest.fixture
def client() -> TestClient:
    reset_settings_cache()
    app = create_app()
    with TestClient(app) as c:
        install_mock_chat_client(c)
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


def _drive_to_play(client: TestClient, seats: dict[str, Any]) -> Any:
    role_ids = [seats["creator_role_id"], seats["other_role_id"]]
    scripts = setup_then_play_script(role_ids=role_ids, extension_tool="")
    mock = install_mock_chat_client(client, scripts)
    client.post(f"/api/sessions/{seats['sid']}/setup/skip?token={seats['creator_token']}")
    client.post(f"/api/sessions/{seats['sid']}/start?token={seats['creator_token']}")
    return mock


# --------------------------------------------------------------------------
# Direct unit tests for ``_park_turn_limit_reached`` against a stub manager.
# --------------------------------------------------------------------------


class _Settings:
    def __init__(self, max_turns: int) -> None:
        self.max_turns_per_session = max_turns


class _RecConnections:
    """Captures broadcasts so the test can assert the ``turn_limit_reached``
    WS event fired."""

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    async def broadcast(
        self, session_id: str, event: dict[str, Any], *, record: bool = True
    ) -> None:
        self.events.append(event)


class _Repo:
    def __init__(self) -> None:
        self.saves = 0

    async def save(self, session: Session) -> None:
        self.saves += 1


class _ParkStubManager:
    """Minimal manager exposing only what ``_park_turn_limit_reached`` uses:
    ``settings()``, ``connections()``, ``_repo``."""

    def __init__(self, max_turns: int) -> None:
        self._settings = _Settings(max_turns)
        self._conns = _RecConnections()
        self._repo = _Repo()

    def settings(self) -> _Settings:
        return self._settings

    def connections(self) -> _RecConnections:
        return self._conns


@pytest.mark.asyncio
async def test_park_sets_flag_emits_event_and_system_message() -> None:
    mgr = _ParkStubManager(max_turns=2)
    driver = TurnDriver(manager=mgr)  # type: ignore[arg-type]
    session = Session(scenario_prompt="x")
    session.state = SessionState.AI_PROCESSING
    turn = Turn(index=2, active_role_groups=[])
    session.turns.append(turn)

    await driver._park_turn_limit_reached(session, turn)

    # Flag set, parked in AWAITING_PLAYERS (no auto-end).
    assert session.turn_limit_reached is True
    assert session.state == SessionState.AWAITING_PLAYERS
    # SYSTEM message appended once with the cap in the body.
    sys_msgs = [m for m in session.messages if m.kind == MessageKind.SYSTEM]
    assert len(sys_msgs) == 1
    assert "Turn limit reached (2 turns)" in sys_msgs[0].body
    # WS event broadcast carrying the cap.
    limit_events = [e for e in mgr._conns.events if e.get("type") == "turn_limit_reached"]
    assert len(limit_events) == 1
    assert limit_events[0]["max_turns"] == 2
    # A state_changed broadcast accompanies the park.
    assert any(e.get("type") == "state_changed" for e in mgr._conns.events)


@pytest.mark.asyncio
async def test_park_is_idempotent_no_duplicate_system_line() -> None:
    mgr = _ParkStubManager(max_turns=2)
    driver = TurnDriver(manager=mgr)  # type: ignore[arg-type]
    session = Session(scenario_prompt="x")
    session.state = SessionState.AI_PROCESSING
    turn = Turn(index=2, active_role_groups=[])
    session.turns.append(turn)

    await driver._park_turn_limit_reached(session, turn)
    await driver._park_turn_limit_reached(session, turn)

    # Exactly one SYSTEM line despite two park calls.
    sys_msgs = [m for m in session.messages if m.kind == MessageKind.SYSTEM]
    assert len(sys_msgs) == 1
    # The nudge re-broadcasts though (so a late client still learns).
    limit_events = [e for e in mgr._conns.events if e.get("type") == "turn_limit_reached"]
    assert len(limit_events) == 2


# --------------------------------------------------------------------------
# Integration: ``run_play_turn`` entry guard makes NO play LLM call when the
# turn is already at/over the cap.
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_play_turn_entry_guard_makes_no_llm_call_at_cap(
    client: TestClient,
) -> None:
    seats = _seat_two(client)
    mock = _drive_to_play(client, seats)
    sid = seats["sid"]

    manager = client.app.state.manager
    session = await manager.get_session(sid)
    # Cap is 2 (MAX_TURNS_PER_SESSION). Inject an over-cap turn directly
    # and drive it — simulates a force-advance/recovery opener that created
    # a turn past the cap. The entry guard must park, not call the model.
    over_cap_turn = Turn(index=2, active_role_groups=[[seats["other_role_id"]]])
    session.turns.append(over_cap_turn)
    session.state = SessionState.AI_PROCESSING

    play_calls_before = sum(1 for c in mock.calls if c["tier"] == "play")
    result = await TurnDriver(manager=manager).run_play_turn(
        session=session, turn=over_cap_turn
    )
    play_calls_after = sum(1 for c in mock.calls if c["tier"] == "play")

    # No new play-tier LLM call.
    assert play_calls_after == play_calls_before
    # Parked: flag set, AWAITING_PLAYERS, SYSTEM line present, no new turn.
    assert result.turn_limit_reached is True
    assert result.state == SessionState.AWAITING_PLAYERS
    assert any(m.kind == MessageKind.SYSTEM for m in result.messages)
    # The over-cap turn was NOT followed by a freshly-opened turn.
    assert result.turns[-1] is over_cap_turn


# --------------------------------------------------------------------------
# Integration: ``run_interject`` honours the park — an ``@facilitator``-ing
# player can't drive unbounded play-tier calls past the cap.
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_interject_makes_no_llm_call_after_park(
    client: TestClient,
) -> None:
    seats = _seat_two(client)
    mock = _drive_to_play(client, seats)
    sid = seats["sid"]

    manager = client.app.state.manager
    session = await manager.get_session(sid)
    # Simulate the session having parked at the cap. The interject path
    # makes a full play-tier ``astream`` call with NO advance-point guard
    # of its own; the only thing standing between a repeat-``@facilitator``
    # griefer and unbounded play spend is the ``turn_limit_reached`` gate.
    session.state = SessionState.AWAITING_PLAYERS
    session.turn_limit_reached = True
    turn = session.current_turn
    assert turn is not None

    play_calls_before = sum(1 for c in mock.calls if c["tier"] == "play")
    result = await TurnDriver(manager=manager).run_interject(
        session=session, turn=turn, for_role_id=seats["other_role_id"]
    )
    play_calls_after = sum(1 for c in mock.calls if c["tier"] == "play")

    # ZERO play-tier LLM calls — the guard returned before any astream.
    assert play_calls_after == play_calls_before
    assert result is session


# --------------------------------------------------------------------------
# Integration: the advance-point guard in ``_apply_play_outcome`` parks when
# the (cap-1)th yielding turn would open a turn at the cap — exercising the
# guard via the real drive path, not just the entry guard.
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_advance_guard_parks_when_opening_turn_at_cap(
    client: TestClient,
) -> None:
    seats = _seat_two(client)
    mock = _drive_to_play(client, seats)
    sid = seats["sid"]

    manager = client.app.state.manager
    session = await manager.get_session(sid)
    # After ``/start`` the session sits at turn index 1 (cap is 2) in
    # AWAITING_PLAYERS. Drive that turn through a YIELDING play script:
    # the AI yields with ``set_active_roles``, so ``_apply_play_outcome``
    # reaches its advance point with ``new_index == 2 == cap`` and must
    # PARK instead of opening turn 2 (the unbounded-cost path).
    turn = session.current_turn
    assert turn is not None
    assert turn.index == 1

    install_mock_chat_client(
        client,
        {
            "play": [
                llm_result(
                    tool_block("broadcast", {"message": "Status check."}),
                    tool_block(
                        "set_active_roles",
                        {"role_groups": [[seats["other_role_id"]]]},
                    ),
                    stop_reason="tool_use",
                )
            ]
        },
    )
    mock = client.app.state.llm
    session.state = SessionState.AI_PROCESSING

    play_calls_before = sum(1 for c in mock.calls if c["tier"] == "play")
    result = await TurnDriver(manager=manager).run_play_turn(
        session=session, turn=turn
    )
    play_calls_after = sum(1 for c in mock.calls if c["tier"] == "play")

    # Exactly one play call (this turn's drive); the parked advance opened
    # NO further turn, so no second call.
    assert play_calls_after == play_calls_before + 1
    # Parked at the advance point: flag set, AWAITING_PLAYERS, no turn at
    # index 2 ever opened.
    assert result.turn_limit_reached is True
    assert result.state == SessionState.AWAITING_PLAYERS
    assert all(t.index < 2 for t in result.turns)


# --------------------------------------------------------------------------
# Soft warning: ``turn_limit_approaching`` fires exactly once when a freshly-
# opened turn first crosses ``AI_TURN_SOFT_WARN_PCT`` of the cap.
# --------------------------------------------------------------------------


class _WarnConnections(_RecConnections):
    """Adds ``send_to_role`` so the full ``_apply_play_outcome`` advance
    path (which broadcasts a creator-only decision log) doesn't blow up."""

    async def send_to_role(
        self, session_id: str, role_id: str, event: dict[str, Any]
    ) -> None:  # pragma: no cover - not asserted on
        pass


@pytest.mark.asyncio
async def test_soft_warn_fires_once_when_crossing_threshold() -> None:
    # Cap 10, warn at 80% → threshold turn index 8. Opening turn 8 fires
    # the nudge; opening turn 9 must NOT re-fire (idempotent via the flag).
    mgr = _ParkStubManager(max_turns=10)
    mgr._conns = _WarnConnections()  # type: ignore[assignment]
    mgr._settings.ai_turn_soft_warn_pct = 80  # type: ignore[attr-defined]
    driver = TurnDriver(manager=mgr)  # type: ignore[arg-type]
    session = Session(scenario_prompt="x")

    # Below threshold (index 7): no event.
    await driver._maybe_warn_turn_limit(session, 7)
    assert session.turn_limit_warned is False
    assert not [
        e for e in mgr._conns.events if e.get("type") == "turn_limit_approaching"
    ]

    # First crossing (index 8): one event with turns_remaining = 10 - 8.
    await driver._maybe_warn_turn_limit(session, 8)
    assert session.turn_limit_warned is True
    warn_events = [
        e for e in mgr._conns.events if e.get("type") == "turn_limit_approaching"
    ]
    assert len(warn_events) == 1
    assert warn_events[0]["turns_remaining"] == 2
    assert warn_events[0]["max_turns"] == 10

    # Next opened turn (index 9): flag already set → no second event.
    await driver._maybe_warn_turn_limit(session, 9)
    warn_events = [
        e for e in mgr._conns.events if e.get("type") == "turn_limit_approaching"
    ]
    assert len(warn_events) == 1
