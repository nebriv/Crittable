"""Wave 1 (issue #134) — per-submission intent + ready-quorum gate.

Direct tests against ``SessionManager`` for the wire change. The
existing scenario suite in ``tests/scenarios/`` covers the e2e replay
path; this file pins the unit-level invariants so a regression in
``submit_response`` / ``proxy_submit_as`` / ``proxy_submit_pending``
trips loudly without needing a mock-LLM round-trip.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import reset_settings_cache
from app.main import create_app
from app.sessions.models import MessageKind, SessionState, Turn
from app.sessions.turn_engine import all_ready, all_submitted
from tests.conftest import default_settings_body


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_MODEL_PLAY", "mock-play")
    monkeypatch.setenv("ANTHROPIC_MODEL_SETUP", "mock-setup")
    monkeypatch.setenv("ANTHROPIC_MODEL_AAR", "mock-aar")
    monkeypatch.setenv("ANTHROPIC_MODEL_GUARDRAIL", "mock-guardrail")
    monkeypatch.setenv("SESSION_SECRET", "x" * 32)
    monkeypatch.setenv("INPUT_GUARDRAIL_ENABLED", "false")
    monkeypatch.setenv("DUPLICATE_SUBMISSION_WINDOW_SECONDS", "0")
    reset_settings_cache()


@pytest.fixture
def client() -> Iterator[TestClient]:
    """``with`` trips the lifespan so ``app.state.manager`` is bound."""

    app = create_app()
    with TestClient(app) as c:
        yield c


def _seat_session(client: TestClient, *, role_count: int) -> dict[str, Any]:
    """Spin up a session, seat ``role_count`` roles, skip setup, drop into
    AWAITING_PLAYERS with all roles active. Mirrors the pattern used in
    ``test_e2e_session.py`` so this file doesn't depend on private
    helpers there."""

    resp = client.post(
        "/api/sessions",
        json={
            "scenario_prompt": "Ready-quorum drill",
            "creator_label": "CISO",
            "creator_display_name": "Alex",
            **default_settings_body(),
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    session_id = body["session_id"]
    creator_token = body["creator_token"]
    creator_role_id = body["creator_role_id"]
    role_ids = [creator_role_id]
    for i in range(role_count - 1):
        r = client.post(
            f"/api/sessions/{session_id}/roles?token={creator_token}",
            json={"label": f"Player_{i + 1}", "display_name": f"P{i + 1}"},
        )
        assert r.status_code == 200, r.text
        role_ids.append(r.json()["role_id"])
    client.post(f"/api/sessions/{session_id}/setup/skip?token={creator_token}")

    async def _open_awaiting() -> None:
        manager = client.app.state.manager
        session = await manager.get_session(session_id)
        session.turns.append(
            Turn(index=0, active_role_ids=role_ids, status="awaiting")
        )
        session.state = SessionState.AWAITING_PLAYERS
        await manager._repo.save(session)

    asyncio.run(_open_awaiting())
    return {
        "session_id": session_id,
        "creator_token": creator_token,
        "role_ids": role_ids,
    }


def test_discuss_intent_does_not_advance(client: TestClient) -> None:
    """A ``discuss`` submission lands in the transcript and counts toward
    ``submitted_role_ids`` but does NOT add the role to
    ``ready_role_ids`` — so the turn stays awaiting even when every
    active role has spoken."""

    seats = _seat_session(client, role_count=2)
    sid = seats["session_id"]
    a, b = seats["role_ids"]
    manager = client.app.state.manager

    async def _go() -> tuple[bool, bool]:
        x = await manager.submit_response(
            session_id=sid, role_id=a, content="thinking…", intent="discuss"
        )
        y = await manager.submit_response(
            session_id=sid, role_id=b, content="me too", intent="discuss"
        )
        return x, y

    advanced_a, advanced_b = asyncio.run(_go())
    assert advanced_a is False
    assert advanced_b is False
    session = asyncio.run(manager.get_session(sid))
    turn = session.current_turn
    assert turn is not None
    assert set(turn.submitted_role_ids) == {a, b}
    assert set(turn.ready_role_ids) == set()
    assert session.state == SessionState.AWAITING_PLAYERS
    assert all_submitted(turn) is True
    assert all_ready(turn) is False


def test_ready_quorum_advances_only_when_everyone_ready(
    client: TestClient,
) -> None:
    """One ``ready`` flips the role into ``ready_role_ids`` but the
    turn does NOT advance until every other active role does the
    same."""

    seats = _seat_session(client, role_count=3)
    sid = seats["session_id"]
    a, b, c = seats["role_ids"]
    manager = client.app.state.manager

    async def _go() -> None:
        # A signals ready alone — no advance.
        first = await manager.submit_response(
            session_id=sid, role_id=a, content="A is ready.", intent="ready"
        )
        assert first is False
        s = await manager.get_session(sid)
        assert s.state == SessionState.AWAITING_PLAYERS
        assert set(s.current_turn.ready_role_ids) == {a}

        # B chimes in as discussion only — still no advance.
        second = await manager.submit_response(
            session_id=sid, role_id=b, content="B muses.", intent="discuss"
        )
        assert second is False
        s = await manager.get_session(sid)
        assert set(s.current_turn.ready_role_ids) == {a}

        # B then signals ready.
        third = await manager.submit_response(
            session_id=sid, role_id=b, content="B ready.", intent="ready"
        )
        assert third is False
        s = await manager.get_session(sid)
        assert set(s.current_turn.ready_role_ids) == {a, b}

        # C closes the quorum.
        fourth = await manager.submit_response(
            session_id=sid, role_id=c, content="C ready.", intent="ready"
        )
        assert fourth is True
        s = await manager.get_session(sid)
        assert s.state == SessionState.AI_PROCESSING

    asyncio.run(_go())


def test_walk_back_ready_with_discuss(client: TestClient) -> None:
    """A subsequent ``discuss`` submission removes the role from
    ``ready_role_ids`` so the turn re-opens for further discussion."""

    seats = _seat_session(client, role_count=2)
    sid = seats["session_id"]
    a, b = seats["role_ids"]
    manager = client.app.state.manager

    async def _go() -> None:
        await manager.submit_response(
            session_id=sid, role_id=a, content="A ready.", intent="ready"
        )
        # A walks back ready.
        await manager.submit_response(
            session_id=sid, role_id=a, content="Hold on.", intent="discuss"
        )
        s = await manager.get_session(sid)
        assert set(s.current_turn.ready_role_ids) == set()
        # B readies — but A is no longer ready, so the turn stays.
        advanced = await manager.submit_response(
            session_id=sid, role_id=b, content="B ready.", intent="ready"
        )
        assert advanced is False
        s = await manager.get_session(sid)
        assert s.state == SessionState.AWAITING_PLAYERS
        assert set(s.current_turn.ready_role_ids) == {b}

    asyncio.run(_go())


def test_force_advance_bypasses_ready_quorum(client: TestClient) -> None:
    """Force-advance still advances even when nobody has signaled
    ready. The escape hatch must keep working."""

    seats = _seat_session(client, role_count=3)
    sid = seats["session_id"]
    a, _b, _c = seats["role_ids"]
    manager = client.app.state.manager

    async def _go() -> None:
        await manager.submit_response(
            session_id=sid, role_id=a, content="thinking", intent="discuss"
        )
        s = await manager.get_session(sid)
        assert s.state == SessionState.AWAITING_PLAYERS
        await manager.force_advance(session_id=sid, by_role_id=a)
        s = await manager.get_session(sid)
        assert s.state == SessionState.AI_PROCESSING

    asyncio.run(_go())


def test_proxy_submit_pending_marks_filled_seats_ready(
    client: TestClient,
) -> None:
    """``proxy_submit_pending`` (the creator's "fill in everyone else"
    helper) must mark every auto-filled seat as ready so the
    ready-quorum gate flips and the turn actually advances."""

    seats = _seat_session(client, role_count=3)
    sid = seats["session_id"]
    a, b, c = seats["role_ids"]
    manager = client.app.state.manager

    async def _go() -> None:
        await manager.submit_response(
            session_id=sid, role_id=a, content="A ready.", intent="ready"
        )
        filled = await manager.proxy_submit_pending(
            session_id=sid, by_role_id=a, content="(skipped — solo)"
        )
        assert filled == 2
        s = await manager.get_session(sid)
        assert s.state == SessionState.AI_PROCESSING
        assert set(s.current_turn.ready_role_ids) == {a, b, c}

    asyncio.run(_go())


def test_intent_recorded_on_player_message(client: TestClient) -> None:
    """Each player message stores its intent so the recorder round-trips
    per-submission intent into deterministic-replay scenarios."""

    seats = _seat_session(client, role_count=2)
    sid = seats["session_id"]
    a, _b = seats["role_ids"]
    manager = client.app.state.manager

    async def _go() -> list[Any]:
        await manager.submit_response(
            session_id=sid, role_id=a, content="discussing", intent="discuss"
        )
        await manager.submit_response(
            session_id=sid, role_id=a, content="ready now", intent="ready"
        )
        s = await manager.get_session(sid)
        return [
            m.intent
            for m in s.messages
            if m.kind == MessageKind.PLAYER and m.role_id == a
        ]

    intents = asyncio.run(_go())
    assert intents == ["discuss", "ready"]


def test_interjection_intent_is_none(client: TestClient) -> None:
    """Out-of-turn interjections (issue #78) don't participate in the
    ready quorum, so their intent is recorded as ``None`` regardless of
    what the caller passed. Setup: spin up a 3-role session but seat
    the turn with only A active — B is a non-active interjector."""

    # Three roles seated; only the first is in the active set so the
    # second's submission is an out-of-turn interjection.
    resp = client.post(
        "/api/sessions",
        json={
            "scenario_prompt": "Interjection drill",
            "creator_label": "CISO",
            "creator_display_name": "Alex",
            **default_settings_body(),
        },
    )
    body = resp.json()
    sid = body["session_id"]
    creator_token = body["creator_token"]
    a = body["creator_role_id"]
    r2 = client.post(
        f"/api/sessions/{sid}/roles?token={creator_token}",
        json={"label": "Player_1", "display_name": "P1"},
    )
    b = r2.json()["role_id"]
    client.post(f"/api/sessions/{sid}/setup/skip?token={creator_token}")
    manager = client.app.state.manager

    async def _open_with_only_a_active() -> None:
        s = await manager.get_session(sid)
        s.turns.append(
            Turn(index=0, active_role_ids=[a], status="awaiting")
        )
        s.state = SessionState.AWAITING_PLAYERS
        await manager._repo.save(s)

    asyncio.run(_open_with_only_a_active())

    async def _go() -> list[Any]:
        # B is NOT in active_role_ids — message lands as interjection
        # regardless of intent the caller passes.
        await manager.submit_response(
            session_id=sid, role_id=b, content="sidebar", intent="ready"
        )
        s = await manager.get_session(sid)
        return [
            m
            for m in s.messages
            if m.kind == MessageKind.PLAYER and m.role_id == b
        ]

    msgs = asyncio.run(_go())
    assert len(msgs) == 1
    assert msgs[0].is_interjection is True
    assert msgs[0].intent is None


def test_active_role_can_submit_multiple_messages(client: TestClient) -> None:
    """Wave 1 changes ``can_submit``: an active role on an awaiting
    turn can post multiple turn-submissions before signaling ready.
    Each one updates ``ready_role_ids`` based on its intent (latest
    intent wins for that role)."""

    seats = _seat_session(client, role_count=2)
    sid = seats["session_id"]
    a, _b = seats["role_ids"]
    manager = client.app.state.manager

    async def _go() -> list[Any]:
        await manager.submit_response(
            session_id=sid, role_id=a, content="thought 1", intent="discuss"
        )
        await manager.submit_response(
            session_id=sid, role_id=a, content="thought 2", intent="discuss"
        )
        await manager.submit_response(
            session_id=sid, role_id=a, content="ready now", intent="ready"
        )
        s = await manager.get_session(sid)
        return [m for m in s.messages if m.kind == MessageKind.PLAYER and m.role_id == a]

    msgs = asyncio.run(_go())
    # All three count as turn submissions (none flagged as interjections).
    assert all(m.is_interjection is False for m in msgs)
    assert [m.intent for m in msgs] == ["discuss", "discuss", "ready"]
    session = asyncio.run(manager.get_session(sid))
    assert a in session.current_turn.ready_role_ids  # type: ignore[union-attr]


def test_per_role_submission_cap_blocks_flood(client: TestClient) -> None:
    """Wave 1 (issue #134) security review H2: ``can_submit`` was
    relaxed for discussion follow-ups; the per-role per-turn cap is
    the new ceiling against a flood / griefing loop. Default cap is
    20; we override to 3 here for a tractable test."""

    # Override the cap via the manager's settings reference. The
    # autouse env fixture ran before this test; we mutate the live
    # Settings instance so we don't have to recreate the manager.
    manager = client.app.state.manager
    manager._settings.max_submissions_per_role_per_turn = 3
    seats = _seat_session(client, role_count=2)
    sid = seats["session_id"]
    a, _b = seats["role_ids"]

    async def _go() -> None:
        # 3 discuss submissions land (each different content).
        for i in range(3):
            await manager.submit_response(
                session_id=sid,
                role_id=a,
                content=f"discussion {i}",
                intent="discuss",
            )
        # 4th must fail.
        try:
            await manager.submit_response(
                session_id=sid,
                role_id=a,
                content="discussion 4",
                intent="discuss",
            )
        except Exception as exc:
            assert "too many submissions" in str(exc).lower()
            return
        raise AssertionError(
            "expected per-role cap to reject the 4th submission"
        )

    asyncio.run(_go())


def test_walk_back_emits_dedicated_audit(client: TestClient) -> None:
    """Wave 1 (issue #134) security review H3: a ``ready → discuss``
    transition emits ``ready_walk_back`` so the creator's activity
    panel can spot a griefer re-flipping ready after every peer
    signals. The audit fires only on actual transitions — a fresh
    discuss without prior ready does not trip it."""

    seats = _seat_session(client, role_count=2)
    sid = seats["session_id"]
    a, _b = seats["role_ids"]
    manager = client.app.state.manager

    async def _go() -> None:
        # Fresh discuss without prior ready — must NOT emit walk-back.
        await manager.submit_response(
            session_id=sid, role_id=a, content="thinking", intent="discuss"
        )
        # Ready, then walk back — emits walk-back exactly once.
        await manager.submit_response(
            session_id=sid, role_id=a, content="ready now", intent="ready"
        )
        await manager.submit_response(
            session_id=sid, role_id=a, content="actually wait", intent="discuss"
        )

    asyncio.run(_go())
    events = manager.audit().dump(sid)
    walk_back_events = [e for e in events if e.kind == "ready_walk_back"]
    assert len(walk_back_events) == 1, (
        f"expected exactly one ready_walk_back; got "
        f"{[e.kind for e in events]}"
    )
    assert walk_back_events[0].payload["role_id"] == a


def test_snapshot_exposes_ready_role_ids(client: TestClient) -> None:
    """The REST snapshot surfaces ``current_turn.ready_role_ids`` so the
    frontend HUD can render the readiness count without an extra
    round-trip."""

    seats = _seat_session(client, role_count=2)
    sid = seats["session_id"]
    a, _b = seats["role_ids"]
    creator_token = seats["creator_token"]
    manager = client.app.state.manager

    async def _go() -> None:
        await manager.submit_response(
            session_id=sid, role_id=a, content="A ready.", intent="ready"
        )

    asyncio.run(_go())
    snap = client.get(f"/api/sessions/{sid}?token={creator_token}").json()
    assert snap["current_turn"]["ready_role_ids"] == [a]
