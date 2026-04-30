"""Tests for the labelled ``ai_status`` breadcrumbs emitted by the
turn driver (issue #63 — without these, the operator could not tell
"AI is on recovery pass 2/3" from "AI is stuck", and the entire
``run_interject`` path was invisible to clients because state stays
``AWAITING_PLAYERS`` throughout)."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import reset_settings_cache
from app.main import create_app
from tests.mock_anthropic import MockAnthropic, setup_then_play_script


@pytest.fixture(autouse=True)
def _env(monkeypatch) -> None:
    monkeypatch.setenv("ANTHROPIC_MODEL_PLAY", "mock-play")
    monkeypatch.setenv("ANTHROPIC_MODEL_SETUP", "mock-setup")
    monkeypatch.setenv("ANTHROPIC_MODEL_AAR", "mock-aar")
    monkeypatch.setenv("ANTHROPIC_MODEL_GUARDRAIL", "mock-guardrail")
    monkeypatch.setenv("TEST_MODE", "true")
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
    # The manager and LLM client cache references to the original; rewire.
    client.app.state.manager._connections = rec
    client.app.state.llm.set_connections(rec)
    return rec


def _ai_statuses(rec: _RecordingConnections) -> list[dict[str, Any]]:
    return [e for e in rec.events if e.get("type") == "ai_status"]


def test_run_play_turn_emits_ai_status_with_phase_play(client: TestClient) -> None:
    """The play-tier turn driver must light the labelled status during
    its LLM call so the operator sees something more specific than
    just "thinking"."""

    rec = _wrap_connections(client)
    seats = _seat_two(client)
    _drive_to_play(client, seats)

    statuses = _ai_statuses(rec)
    # We expect at least: phase=briefing or phase=play (start) and a
    # final phase=null (cleanup). The exact count depends on the
    # scripted recovery path — we just assert the structure.
    phases = [e["phase"] for e in statuses]
    assert any(p in ("play", "briefing") for p in phases), phases
    # Cleanup emits a null phase before returning.
    assert phases[-1] is None, phases


@pytest.mark.asyncio
async def test_run_interject_emits_phase_interject(client: TestClient) -> None:
    """The interject path was the primary screenshot bug: a participant
    asks a question, the AI is busy, but state stays AWAITING_PLAYERS
    so the indicator was dark. Now ``run_interject`` must emit
    ``phase=interject`` before the LLM call and ``phase=None`` on exit.
    """

    from app.sessions.turn_driver import TurnDriver

    rec = _wrap_connections(client)
    seats = _seat_two(client)
    _drive_to_play(client, seats)

    sid = seats["sid"]
    snap = client.get(f"/api/sessions/{sid}?token={seats['creator_token']}").json()
    if snap["state"] != "AWAITING_PLAYERS":
        pytest.skip("scripted setup did not yield to players")

    manager = client.app.state.manager
    rec.events.clear()
    session = await manager.get_session(sid)
    turn = session.current_turn
    assert turn is not None
    await TurnDriver(manager=manager).run_interject(
        session=session, turn=turn, for_role_id=seats["other_role_id"]
    )

    statuses = _ai_statuses(rec)
    phases = [(e["phase"], e.get("for_role_id")) for e in statuses]
    assert any(p == "interject" for p, _ in phases), phases
    interject_emit = next(e for e in statuses if e["phase"] == "interject")
    assert interject_emit["for_role_id"] == seats["other_role_id"]
    assert phases[-1][0] is None, phases


def test_ai_status_events_are_not_recorded_in_replay_buffer(client: TestClient) -> None:
    """``ai_status`` and ``ai_thinking`` are stale on reconnect and
    must NOT clog the bounded replay buffer. Verify the
    ``_record`` flag is False on every emit."""

    rec = _wrap_connections(client)
    seats = _seat_two(client)
    _drive_to_play(client, seats)

    statuses = _ai_statuses(rec)
    assert statuses, "expected at least one ai_status event during play turn"
    for evt in statuses:
        assert evt["_record"] is False, evt
    thinkings = [e for e in rec.events if e.get("type") == "ai_thinking"]
    for evt in thinkings:
        assert evt["_record"] is False, evt
