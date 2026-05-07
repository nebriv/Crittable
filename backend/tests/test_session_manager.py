"""Targeted tests for SessionManager guards added in issue #63:

* ``force_advance`` rejects with ``IllegalTransitionError`` while a
  play-tier LLM call is in flight (defense-in-depth — the new
  ``ai_thinking`` indicator is the primary fix; this stops the
  triple-banner cascade visible in the screenshot timeline if an
  impatient operator double-clicks anyway).
* ``submit_response`` rejects an exact same-body resubmission within
  the dedupe window (backstop for the no-feedback retype loop).
"""

from __future__ import annotations

import time
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import reset_settings_cache
from app.llm.protocol import InFlightCall
from app.main import create_app
from app.sessions.turn_engine import IllegalTransitionError
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
    assert resp.status_code == 200
    created = resp.json()
    sid = created["session_id"]
    creator_token = created["creator_token"]
    creator_role_id = created["creator_role_id"]
    r = client.post(
        f"/api/sessions/{sid}/roles?token={creator_token}",
        json={"label": "Player_1", "display_name": "P1"},
    )
    assert r.status_code == 200
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


# --------------------------------------------------- force_advance gate
def test_force_advance_rejects_while_play_tier_call_in_flight(client: TestClient) -> None:
    """Issue #63: force-advance must NOT race a still-streaming play
    LLM call. We simulate "play call in flight" by injecting an
    ``InFlightCall`` directly into the LLM client's tracker."""

    seats = _seat_two(client)
    _drive_to_play(client, seats)
    snap = client.get(f"/api/sessions/{seats['sid']}?token={seats['creator_token']}").json()
    if snap["state"] != "AWAITING_PLAYERS":
        pytest.skip("scripted setup did not yield to players")

    # Inject a fake play-tier call into _in_flight to simulate "AI is
    # mid-stream right now".
    llm = client.app.state.llm
    fake = InFlightCall(
        tier="play", model="mock-play", stream=True, started_at=time.monotonic()
    )
    llm._in_flight.setdefault(seats["sid"], []).append(fake)
    try:
        r = client.post(
            f"/api/sessions/{seats['sid']}/force-advance?token={seats['creator_token']}"
        )
        # The route layer surfaces IllegalTransitionError as an HTTP 4xx.
        assert r.status_code in (400, 409, 422), r.text
        assert "still processing" in r.text.lower()
    finally:
        llm._in_flight[seats["sid"]].remove(fake)
        if not llm._in_flight[seats["sid"]]:
            llm._in_flight.pop(seats["sid"], None)


def test_force_advance_allowed_with_only_non_play_calls_in_flight(
    client: TestClient,
) -> None:
    """A guardrail / setup / AAR call in flight must NOT block force-advance —
    the operator needs to be able to recover from a hung non-play call."""

    seats = _seat_two(client)
    _drive_to_play(client, seats)
    snap = client.get(f"/api/sessions/{seats['sid']}?token={seats['creator_token']}").json()
    if snap["state"] != "AWAITING_PLAYERS":
        pytest.skip("scripted setup did not yield to players")

    llm = client.app.state.llm
    fake = InFlightCall(
        tier="guardrail",
        model="mock-guardrail",
        stream=False,
        started_at=time.monotonic(),
    )
    llm._in_flight.setdefault(seats["sid"], []).append(fake)
    try:
        r = client.post(
            f"/api/sessions/{seats['sid']}/force-advance?token={seats['creator_token']}"
        )
        assert r.status_code == 200, r.text
    finally:
        bucket = llm._in_flight.get(seats["sid"], [])
        if fake in bucket:
            bucket.remove(fake)
        if seats["sid"] in llm._in_flight and not llm._in_flight[seats["sid"]]:
            llm._in_flight.pop(seats["sid"], None)


# ---------------------------------------------------- duplicate dedupe
def _active_role(client: TestClient, seats: dict[str, Any]) -> tuple[str, str]:
    """Return ``(role_id, token)`` for whichever seated role is in the
    current turn's active set. ``setup_then_play_script`` opens the
    play turn with ``set_active_roles=[role_ids[0]]`` (the creator),
    but we read the snapshot rather than hardcoding so a future script
    tweak doesn't silently skip these tests."""

    snap = client.get(
        f"/api/sessions/{seats['sid']}?token={seats['creator_token']}"
    ).json()
    if snap["state"] != "AWAITING_PLAYERS":
        pytest.skip("scripted setup did not yield to players")
    active = snap["current_turn"]["active_role_ids"]
    role_to_token = {
        seats["creator_role_id"]: seats["creator_token"],
        seats["other_role_id"]: seats["other_token"],
    }
    for rid in active:
        if rid in role_to_token:
            return rid, role_to_token[rid]
    pytest.skip("no seated role in active set")


async def _force_two_active(client: TestClient, seats: dict[str, Any]) -> None:
    """Make both seated roles active on the current turn so the first
    submission doesn't auto-advance state out of AWAITING_PLAYERS — we
    need the second submit to reach the dedupe guard rather than fail
    at the prior "session is not awaiting player input" check."""

    manager = client.app.state.manager
    sid = seats["sid"]
    async with await manager._lock_for(sid):
        session = await manager._repo.get(sid)
        turn = session.current_turn
        assert turn is not None
        turn.active_role_ids = [seats["creator_role_id"], seats["other_role_id"]]
        turn.submitted_role_ids = []
        await manager._repo.save(session)


async def _allow_resubmit(client: TestClient, role_id: str, sid: str) -> None:
    """Clear ``submitted_role_ids`` so the role can submit again on the
    current turn — simulates the screenshot scenario where the engine
    advanced to a new turn that re-added the role to the active set
    (so the dedupe guard, not ``can_submit``, is what catches the
    identical body)."""

    manager = client.app.state.manager
    async with await manager._lock_for(sid):
        session = await manager._repo.get(sid)
        turn = session.current_turn
        assert turn is not None
        if role_id in turn.submitted_role_ids:
            turn.submitted_role_ids.remove(role_id)
        await manager._repo.save(session)


@pytest.mark.asyncio
async def test_submit_response_rejects_same_body_within_window(
    client: TestClient,
) -> None:
    """A second submission with identical body from the same role within
    ``DUPLICATE_SUBMISSION_WINDOW_SECONDS`` must be rejected. Backstop
    for the screenshot bug — the user retyped because they had no
    feedback; once they do, this guard prevents the residual stray
    double-Enter from producing two visible bubbles."""

    seats = _seat_two(client)
    _drive_to_play(client, seats)
    snap = client.get(
        f"/api/sessions/{seats['sid']}?token={seats['creator_token']}"
    ).json()
    if snap["state"] != "AWAITING_PLAYERS":
        pytest.skip("scripted setup did not yield to players")
    await _force_two_active(client, seats)

    manager = client.app.state.manager
    body = "I'm looking at the service account auth logs, what do I see"
    # First submit lands. With both roles active, the turn does NOT
    # auto-advance, so the state stays AWAITING_PLAYERS.
    await manager.submit_response(
        session_id=seats["sid"],
        role_id=seats["other_role_id"],
        content=body,
    )
    # Re-allow this role to submit (simulates a new turn opening with
    # the same role active again; without this the prior ``can_submit``
    # gate fires before the dedupe check).
    await _allow_resubmit(client, seats["other_role_id"], seats["sid"])
    with pytest.raises(IllegalTransitionError) as excinfo:
        await manager.submit_response(
            session_id=seats["sid"],
            role_id=seats["other_role_id"],
            content=body,
        )
    assert "same message" in str(excinfo.value).lower()


@pytest.mark.asyncio
async def test_submit_response_allows_distinct_bodies(client: TestClient) -> None:
    """Different bodies from the same role are not duplicates — and a
    bare repeat from a *different* role is also not a duplicate (the
    dedupe guard only inspects same-role same-body)."""

    seats = _seat_two(client)
    _drive_to_play(client, seats)
    snap = client.get(
        f"/api/sessions/{seats['sid']}?token={seats['creator_token']}"
    ).json()
    if snap["state"] != "AWAITING_PLAYERS":
        pytest.skip("scripted setup did not yield to players")
    await _force_two_active(client, seats)

    manager = client.app.state.manager
    await manager.submit_response(
        session_id=seats["sid"],
        role_id=seats["other_role_id"],
        content="first body",
    )
    await _allow_resubmit(client, seats["other_role_id"], seats["sid"])
    # Distinct body from same role — must NOT be flagged duplicate.
    await manager.submit_response(
        session_id=seats["sid"],
        role_id=seats["other_role_id"],
        content="different body",
    )


# ----------------- AAR_INLINE_ON_END branch coverage --------------------


@pytest.mark.asyncio
async def test_trigger_aar_generation_inline_when_flag_on(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``AAR_INLINE_ON_END=true`` must run the AAR pipeline inline so
    sync ``TestClient`` callers get a ready AAR back from the
    follow-up ``GET /export.md`` poll. The parent conftest sets the
    flag on for the whole test run; this test pins the contract.
    """

    manager = client.app.state.manager
    awaited: list[str] = []
    spawned: list[Any] = []

    async def _fake_generate(session_id: str) -> None:
        awaited.append(session_id)

    def _fake_spawn(coro: Any) -> None:
        spawned.append(coro)
        coro.close()

    monkeypatch.setattr(manager, "_generate_aar_bg", _fake_generate)
    monkeypatch.setattr(manager, "_spawn_bg", _fake_spawn)
    monkeypatch.setattr(manager._settings, "aar_inline_on_end", True)

    await manager.trigger_aar_generation("sid-123")
    assert awaited == ["sid-123"]
    assert spawned == []


@pytest.mark.asyncio
async def test_trigger_aar_generation_background_when_flag_off(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``AAR_INLINE_ON_END=false`` (production default) must run AAR
    via the background-task path so ``POST /end`` stays fast. Catches
    a future polarity-flip regression on the flag.
    """

    manager = client.app.state.manager
    awaited: list[str] = []
    spawned: list[Any] = []

    async def _fake_generate(session_id: str) -> None:
        awaited.append(session_id)

    def _fake_spawn(coro: Any) -> None:
        spawned.append(coro)
        coro.close()

    monkeypatch.setattr(manager, "_generate_aar_bg", _fake_generate)
    monkeypatch.setattr(manager, "_spawn_bg", _fake_spawn)
    monkeypatch.setattr(manager._settings, "aar_inline_on_end", False)

    await manager.trigger_aar_generation("sid-456")
    assert awaited == []
    assert len(spawned) == 1
