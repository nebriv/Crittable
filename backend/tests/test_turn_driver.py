"""Tests for the labeled ``ai_status`` breadcrumbs emitted by the
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
from tests.conftest import default_settings_body
from tests.mock_anthropic import MockAnthropic, setup_then_play_script


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
    # The manager and LLM client cache references to the original; rewire.
    client.app.state.manager._connections = rec
    client.app.state.llm.set_connections(rec)
    return rec


def _ai_statuses(rec: _RecordingConnections) -> list[dict[str, Any]]:
    return [e for e in rec.events if e.get("type") == "ai_status"]


def test_run_play_turn_emits_ai_status_with_phase_play(client: TestClient) -> None:
    """The play-tier turn driver must light the labeled status during
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


def test_run_play_turn_emits_turn_validation_audit_event(
    client: TestClient,
) -> None:
    """Issue #70: every validator pass MUST land in the audit ring
    buffer (not just stdout) so the creator's ``/debug`` and
    ``/activity`` endpoints can render a per-turn slot/recovery
    summary without log access. A clean play turn produces at least
    one ``turn_validation`` row with ``ok=True``.
    """

    seats = _seat_two(client)
    _drive_to_play(client, seats)

    audit_events = client.app.state.manager.audit().dump(seats["sid"])
    validations = [evt for evt in audit_events if evt.kind == "turn_validation"]
    assert validations, (
        "expected at least one turn_validation audit row during play turn"
    )
    # Each row carries enough info to drive the panel: attempt, slots,
    # violations, warnings, ok. The first attempt of a clean turn is ok.
    first = validations[0]
    assert first.turn_id is not None
    payload = first.payload
    assert "attempt" in payload
    assert "slots" in payload
    assert "violations" in payload
    assert "warnings" in payload
    assert "ok" in payload


def test_debug_endpoint_includes_turn_diagnostics(client: TestClient) -> None:
    """Issue #70: the rolled-up per-turn diagnostics MUST be on the
    ``/debug`` payload. Without this the creator panel has no way to
    render `Turn 6: drive ✓ yield ✓` without scraping audit events
    client-side. Also verifies ``ai_paused`` and ``engine_flags``
    surface so a misconfigured deploy is visible at a glance.
    """

    seats = _seat_two(client)
    _drive_to_play(client, seats)

    sid = seats["sid"]
    cr = seats["creator_token"]
    body = client.get(f"/api/sessions/{sid}/debug?token={cr}").json()

    assert "turn_diagnostics" in body
    assert isinstance(body["turn_diagnostics"], list)
    # ai_paused on the session block lets a debug consumer see the
    # pause state without a separate snapshot fetch.
    assert "ai_paused" in body["session"]
    # engine_flags expose the kill-switches an operator may have
    # flipped on for emergency rollback. Both keys must be present
    # so a missing key isn't silently treated as "off" by the UI.
    flags = body["engine_flags"]
    assert "legacy_carve_out_enabled" in flags
    assert "drive_required" in flags


def test_activity_endpoint_includes_recent_turn_diagnostics(
    client: TestClient,
) -> None:
    """Issue #70: ``/activity`` is the polled (3 s) creator panel so
    its rollup is bounded — at most the most-recent 3 turns —
    keeping the response cheap on long sessions. ``ai_paused`` and
    ``legacy_carve_out_enabled`` must also surface here so the
    BottomActionBar's LLM chip + the panel's red banner have the
    data they need without a second fetch.
    """

    seats = _seat_two(client)
    _drive_to_play(client, seats)

    sid = seats["sid"]
    cr = seats["creator_token"]
    body = client.get(f"/api/sessions/{sid}/activity?token={cr}").json()

    assert "recent_turn_diagnostics" in body
    assert isinstance(body["recent_turn_diagnostics"], list)
    assert len(body["recent_turn_diagnostics"]) <= 3
    assert "ai_paused" in body
    assert "legacy_carve_out_enabled" in body


def _setup_drafting_events(rec: _RecordingConnections) -> list[dict[str, Any]]:
    return [e for e in rec.events if e.get("type") == "setup_drafting_plan"]


def test_setup_drafting_plan_fires_when_propose_tool_starts(
    client: TestClient,
) -> None:
    """The setup-tier driver must broadcast ``setup_drafting_plan
    active=true`` the moment the streaming model commits to
    ``propose_scenario_plan``, and ``active=false`` once the turn
    completes. Pre-fix, an AI-initiated plan draft (i.e. the model
    decides on its own that it has enough background and calls
    ``propose_scenario_plan`` after a regular reply, not via the
    operator's LOOKS-READY click) showed only the small "AI is typing"
    dots for the full 10-30 s wait — read as "the app is stuck."
    """

    rec = _wrap_connections(client)
    seats = _seat_two(client)

    # Script a setup turn whose first iteration goes straight to
    # ``propose_scenario_plan``. We don't need the real prompt-driven
    # ask-then-propose flow here; the test is about the broadcast
    # contract, not the LLM's decision logic.
    plan_args = {
        "title": "Ransomware via vendor portal",
        "executive_summary": "Vendor portal compromise leading to ransomware.",
        "key_objectives": ["containment", "comms"],
        "narrative_arc": [
            {
                "beat": 1,
                "label": "Detection",
                "expected_actors": [seats["creator_role_id"]],
            }
        ],
        "injects": [
            {"trigger": "after beat 1", "type": "info", "summary": "ping"}
        ],
        "guardrails": [],
        "success_criteria": [],
        "out_of_scope": [],
    }
    from tests.mock_anthropic import response, tool_block

    scripts = {
        "setup": [
            response(tool_block("propose_scenario_plan", plan_args)),
        ]
    }
    client.app.state.llm.set_transport(MockAnthropic(scripts).messages)

    # Trigger one setup turn via the same path the creator UI uses.
    sid = seats["sid"]
    cr = seats["creator_token"]
    r = client.post(
        f"/api/sessions/{sid}/setup/reply?token={cr}",
        json={"content": "Financial services, ~1k employees, SOX/PCI."},
    )
    assert r.status_code == 200, r.text

    drafting = _setup_drafting_events(rec)
    actives = [e["active"] for e in drafting]
    assert actives == [True, False], (
        f"expected exactly one True followed by one False, got {actives!r}"
    )
    # Stale on reconnect — must NOT be in the replay buffer.
    assert all(e["_record"] is False for e in drafting), drafting


def test_setup_drafting_plan_does_not_fire_on_ask_question(
    client: TestClient,
) -> None:
    """A regular back-and-forth ``ask_setup_question`` MUST NOT trigger
    the prominent banner. The creator's small "AI is typing" dots are
    the only indicator for routine setup Q&A; firing the heavy banner
    here was the false-positive from the prior 1.5 s-debounce attempt.
    """

    rec = _wrap_connections(client)
    seats = _seat_two(client)

    from tests.mock_anthropic import response, tool_block

    scripts = {
        "setup": [
            response(
                tool_block(
                    "ask_setup_question",
                    {"topic": "industry", "question": "What industry?"},
                )
            ),
        ]
    }
    client.app.state.llm.set_transport(MockAnthropic(scripts).messages)

    sid = seats["sid"]
    cr = seats["creator_token"]
    r = client.post(
        f"/api/sessions/{sid}/setup/reply?token={cr}",
        json={"content": "Financial services."},
    )
    assert r.status_code == 200, r.text

    drafting = _setup_drafting_events(rec)
    assert drafting == [], (
        f"setup_drafting_plan must not fire for ask_setup_question; got {drafting!r}"
    )
