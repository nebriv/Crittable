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
from tests.mock_chat_client import install_mock_chat_client, setup_then_play_script


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
