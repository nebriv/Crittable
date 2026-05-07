"""Issue #127 regression net — session-management invalidation tests.

Pre-fix the creator could click "Kick" in the RolesPanel, the server
would bump ``role.token_version`` (so REST polls 401'd), but the
kicked player's already-open WebSocket stayed live and they kept
posting messages. The fix has three layers:

1. ``ConnectionManager.disconnect_role`` force-closes every open
   socket for ``(session_id, role_id)``.
2. ``SessionManager.reissue_role_token(revoke_previous=True)`` and
   ``SessionManager.remove_role`` call ``disconnect_role`` after
   committing the state change.
3. ``SessionManager.submit_response`` and similar mutating entry
   points reject if the role no longer exists in
   ``session.roles`` (defense-in-depth for the in-flight race).

Session-management correctness is load-bearing for security: a
permissive bug here lets a kicked attacker keep talking. This file
covers the variants — multi-tab, multi-session isolation, every
mutating WS event, reissue-vs-revoke contract, reconnect-after-kick,
side-effects on other roles, and the audit trail.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.auth.authz import AuthorizationError
from app.config import reset_settings_cache
from app.main import create_app
from app.sessions.turn_engine import IllegalTransitionError
from tests.mock_anthropic import MockAnthropic, setup_then_play_script


@pytest.fixture(autouse=True)
def _e2e_env(monkeypatch) -> None:
    monkeypatch.setenv("ANTHROPIC_MODEL_PLAY", "mock-play")
    monkeypatch.setenv("ANTHROPIC_MODEL_SETUP", "mock-setup")
    monkeypatch.setenv("ANTHROPIC_MODEL_AAR", "mock-aar")
    monkeypatch.setenv("ANTHROPIC_MODEL_GUARDRAIL", "mock-guardrail")
    monkeypatch.setenv("SESSION_SECRET", "x" * 32)
    monkeypatch.setenv("INPUT_GUARDRAIL_ENABLED", "false")
    monkeypatch.setenv("DUPLICATE_SUBMISSION_WINDOW_SECONDS", "0")
    reset_settings_cache()


@pytest.fixture
def client() -> TestClient:
    reset_settings_cache()
    app = create_app()
    with TestClient(app) as c:
        c.app.state.llm.set_transport(MockAnthropic({}).messages)
        yield c


def _install_play_mock(client: TestClient, role_ids: list[str]) -> None:
    """Install a script-driven mock that handles setup + play tiers,
    so ``/start`` doesn't immediately end the session via the
    minimal ``end_session``-everywhere fallback."""

    scripts = setup_then_play_script(role_ids=role_ids, extension_tool=None)
    client.app.state.llm.set_transport(MockAnthropic(scripts).messages)


def _create_and_seat(client: TestClient, *, role_count: int) -> dict[str, Any]:
    resp = client.post(
        "/api/sessions",
        json={
            "scenario_prompt": "Ransomware via vendor portal",
            "creator_label": "CISO",
            "creator_display_name": "Alex",
        },
    )
    assert resp.status_code == 200, resp.text
    created = resp.json()
    sid = created["session_id"]
    cr = created["creator_token"]
    creator_role_id = created["creator_role_id"]
    role_ids: list[str] = [creator_role_id]
    role_tokens: dict[str, str] = {creator_role_id: cr}
    for i in range(role_count - 1):
        r = client.post(
            f"/api/sessions/{sid}/roles?token={cr}",
            json={"label": f"Player_{i + 1}", "display_name": f"P{i + 1}"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        role_ids.append(body["role_id"])
        role_tokens[body["role_id"]] = body["token"]
    return {
        "session_id": sid,
        "creator_token": cr,
        "creator_role_id": creator_role_id,
        "role_ids": role_ids,
        "role_tokens": role_tokens,
    }


def _drain_until(ws, predicate, *, max_frames: int = 64) -> dict[str, Any] | None:
    """Pull WS frames until ``predicate(frame)`` returns True, or until
    the WebSocket closes / the budget runs out. Returns the matching
    frame, or None if we hit the end without a match."""

    for _ in range(max_frames):
        try:
            evt = ws.receive_json()
        except WebSocketDisconnect:
            return None
        if predicate(evt):
            return evt
    return None


# ---------------------------------------------------------------------------
# Layer 1: ConnectionManager.disconnect_role primitive — multi-tab + isolation
# ---------------------------------------------------------------------------


def test_revoke_disconnects_every_tab_for_kicked_role(client: TestClient) -> None:
    """A kicked role with two open tabs gets BOTH tabs closed. A
    one-tab close would leave a live channel the player could still
    post through — same effective bug as before the fix."""

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    rid = seats["role_ids"][1]
    old = seats["role_tokens"][rid]

    with client.websocket_connect(f"/ws/sessions/{sid}?token={old}") as tab1:
        with client.websocket_connect(f"/ws/sessions/{sid}?token={old}") as tab2:
            # Drain initial presence frames so the recv buffer is clean
            # for the post-revoke disconnect signal.
            tab1.receive_json()
            tab2.receive_json()

            r = client.post(f"/api/sessions/{sid}/roles/{rid}/revoke?token={cr}")
            assert r.status_code == 200, r.text

            with pytest.raises(WebSocketDisconnect):
                for _ in range(64):
                    tab1.receive_json()
            with pytest.raises(WebSocketDisconnect):
                for _ in range(64):
                    tab2.receive_json()


def test_revoke_does_not_disconnect_other_roles_in_session(
    client: TestClient,
) -> None:
    """The kick is surgical — the creator and any other player still
    have a live channel. Pre-fix this WAS surgical (revoke didn't
    close ANY socket); post-fix we must keep it surgical, not regress
    to a session-wide reset."""

    seats = _create_and_seat(client, role_count=3)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    kicked_rid = seats["role_ids"][1]
    bystander_rid = seats["role_ids"][2]
    kicked_tok = seats["role_tokens"][kicked_rid]
    bystander_tok = seats["role_tokens"][bystander_rid]

    with client.websocket_connect(f"/ws/sessions/{sid}?token={cr}") as creator_ws:
        with client.websocket_connect(
            f"/ws/sessions/{sid}?token={bystander_tok}"
        ) as bystander_ws:
            with client.websocket_connect(
                f"/ws/sessions/{sid}?token={kicked_tok}"
            ) as kicked_ws:
                # Initial presence frame on each.
                creator_ws.receive_json()
                bystander_ws.receive_json()
                kicked_ws.receive_json()

                r = client.post(
                    f"/api/sessions/{sid}/roles/{kicked_rid}/revoke?token={cr}"
                )
                assert r.status_code == 200, r.text

                # Kicked tab must close…
                with pytest.raises(WebSocketDisconnect):
                    for _ in range(64):
                        kicked_ws.receive_json()

                # …but the bystander's channel must still deliver. Use
                # heartbeat as a cheap "is the socket alive" probe.
                bystander_ws.send_json({"type": "heartbeat"})
                creator_ws.send_json({"type": "heartbeat"})


def test_revoke_does_not_disconnect_same_role_in_other_session(
    client: TestClient,
) -> None:
    """Each session is its own subscription scope. A kick on session A
    must not leak into session B even if (impossibly, but as a
    boundary check) the same role_id exists on both. The
    ConnectionManager keys on session_id; this test pins that
    contract."""

    seats_a = _create_and_seat(client, role_count=2)
    seats_b = _create_and_seat(client, role_count=2)

    other_a = seats_a["role_tokens"][seats_a["role_ids"][1]]
    other_b = seats_b["role_tokens"][seats_b["role_ids"][1]]

    with client.websocket_connect(
        f"/ws/sessions/{seats_a['session_id']}?token={other_a}"
    ) as ws_a:
        with client.websocket_connect(
            f"/ws/sessions/{seats_b['session_id']}?token={other_b}"
        ) as ws_b:
            ws_a.receive_json()
            ws_b.receive_json()

            r = client.post(
                f"/api/sessions/{seats_a['session_id']}"
                f"/roles/{seats_a['role_ids'][1]}/revoke?token={seats_a['creator_token']}"
            )
            assert r.status_code == 200

            with pytest.raises(WebSocketDisconnect):
                for _ in range(64):
                    ws_a.receive_json()

            ws_b.send_json({"type": "heartbeat"})  # session B still alive


# ---------------------------------------------------------------------------
# Layer 2: reissue ≠ revoke — non-destructive reissue must NOT close sockets
# ---------------------------------------------------------------------------


def test_reissue_without_revoke_keeps_existing_websocket_alive(
    client: TestClient,
) -> None:
    """Reissue is "show me the link again." It must NOT close the
    holder's open socket — that would defeat the documented use case
    (creator lost the URL but the player is still on the call)."""

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    rid = seats["role_ids"][1]
    tok = seats["role_tokens"][rid]

    with client.websocket_connect(f"/ws/sessions/{sid}?token={tok}") as ws:
        ws.receive_json()  # initial presence
        r = client.post(f"/api/sessions/{sid}/roles/{rid}/reissue?token={cr}")
        assert r.status_code == 200, r.text

        # Socket must still be alive after the no-revoke reissue.
        ws.send_json({"type": "heartbeat"})


# ---------------------------------------------------------------------------
# Layer 3: every mutating WS event must be blocked for a removed role
# ---------------------------------------------------------------------------


def test_kicked_role_cannot_reconnect_with_old_token(client: TestClient) -> None:
    """Even if the kicked tab's reconnect logic ignored 4401 codes, a
    fresh ``websocket_connect`` with the old token must be rejected."""

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    rid = seats["role_ids"][1]
    old = seats["role_tokens"][rid]

    r = client.post(f"/api/sessions/{sid}/roles/{rid}/revoke?token={cr}")
    assert r.status_code == 200, r.text

    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect(f"/ws/sessions/{sid}?token={old}"):
            pass
    assert exc_info.value.code == 4401


def test_new_token_after_kick_can_reconnect_cleanly(client: TestClient) -> None:
    """The whole point of revoke-then-reissue is that the *new* token
    works. Confirms the kick path doesn't accidentally lock the seat
    permanently."""

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    rid = seats["role_ids"][1]

    r = client.post(f"/api/sessions/{sid}/roles/{rid}/revoke?token={cr}")
    new = r.json()["token"]

    with client.websocket_connect(f"/ws/sessions/{sid}?token={new}") as ws:
        ws.receive_json()  # presence frame proves the WS upgraded


def test_removed_role_cannot_reconnect(client: TestClient) -> None:
    """``DELETE /roles/{rid}`` removes the role entirely; the old
    token must 4401 on reconnect with "role no longer exists" rather
    than treating the missing role as "fresh-version-0"."""

    seats = _create_and_seat(client, role_count=3)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    rid = seats["role_ids"][1]
    old = seats["role_tokens"][rid]

    r = client.delete(f"/api/sessions/{sid}/roles/{rid}?token={cr}")
    assert r.status_code == 200, r.text

    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect(f"/ws/sessions/{sid}?token={old}"):
            pass
    assert exc_info.value.code == 4401


# ---------------------------------------------------------------------------
# Layer 4: defense-in-depth at the session-manager layer
# ---------------------------------------------------------------------------


def test_submit_response_after_remove_raises_illegal_transition(
    client: TestClient,
) -> None:
    """Even if a racing in-flight submit_response slipped past the
    WS-close, the manager must refuse to land a message from a role
    that's no longer in ``session.roles``. Same gate covers any
    future caller (proxy, scenario runner, dev API)."""

    from app.sessions.models import SessionState

    seats = _create_and_seat(client, role_count=3)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    rid = seats["role_ids"][1]

    # Drive into AWAITING_PLAYERS via the dev-skip path so the
    # submit_response state guard is satisfied. The dev skip drops a
    # minimal plan and transitions straight to READY; ``start`` opens
    # the first turn — but the AI play turn must yield to a player,
    # not immediately ``end_session`` (which is what the auto-mock
    # in the fixture does for every tier).
    _install_play_mock(client, seats["role_ids"])
    client.post(f"/api/sessions/{sid}/setup/skip?token={cr}")
    client.post(f"/api/sessions/{sid}/start?token={cr}")

    manager = client.app.state.manager

    async def _check() -> None:
        await manager.remove_role(
            session_id=sid, role_id=rid, by_role_id=seats["creator_role_id"]
        )
        with pytest.raises(IllegalTransitionError) as exc_info:
            await manager.submit_response(
                session_id=sid, role_id=rid, content="ghost message"
            )
        assert "no longer exists" in str(exc_info.value)
        # Session is still alive for the remaining roles.
        snapshot = await manager.get_session(sid)
        assert snapshot.state == SessionState.AWAITING_PLAYERS

    asyncio.run(_check())


def test_submit_response_for_unknown_role_id_rejected_at_manager(
    client: TestClient,
) -> None:
    """The unknown-role guard is generic — covers a forged role_id
    that was never in the session, not just one that *was* removed.
    Useful seam for any future proxy / dev surface that constructs
    a manager call from less-trusted input."""

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]

    _install_play_mock(client, seats["role_ids"])
    client.post(f"/api/sessions/{sid}/setup/skip?token={cr}")
    client.post(f"/api/sessions/{sid}/start?token={cr}")

    manager = client.app.state.manager

    async def _check() -> None:
        with pytest.raises(IllegalTransitionError):
            await manager.submit_response(
                session_id=sid,
                role_id="ghost-role-that-was-never-real",
                content="hello",
            )

    asyncio.run(_check())


# ---------------------------------------------------------------------------
# Layer 5: audit trail + side-effects on peer roles
# ---------------------------------------------------------------------------


def test_revoke_emits_role_token_revoked_audit_event(client: TestClient) -> None:
    """Operators investigating a stuck-session report rely on the
    audit log to reconstruct who kicked whom. The emit must fire
    regardless of whether anyone was connected at the time."""

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    rid = seats["role_ids"][1]

    r = client.post(f"/api/sessions/{sid}/roles/{rid}/revoke?token={cr}")
    assert r.status_code == 200, r.text

    audit = client.app.state.manager.audit().dump(sid)
    kinds = [evt.kind for evt in audit]
    assert "role_token_revoked" in kinds, kinds


def test_remove_role_broadcasts_participant_left_to_peers(
    client: TestClient,
) -> None:
    """Peer clients learn about the removal via the
    ``participant_left`` event so their roster panel updates
    without a polling round-trip. Was working before this change;
    pinning it here so a future "force-disconnect early-return"
    refactor can't accidentally drop the broadcast."""

    seats = _create_and_seat(client, role_count=3)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    bystander_rid = seats["role_ids"][1]
    target_rid = seats["role_ids"][2]
    bystander_tok = seats["role_tokens"][bystander_rid]

    with client.websocket_connect(
        f"/ws/sessions/{sid}?token={bystander_tok}"
    ) as ws:
        ws.receive_json()  # initial presence

        r = client.delete(f"/api/sessions/{sid}/roles/{target_rid}?token={cr}")
        assert r.status_code == 200, r.text

        evt = _drain_until(
            ws,
            lambda e: e.get("type") == "participant_left"
            and e.get("role_id") == target_rid,
        )
        assert evt is not None, "expected participant_left for the removed role"


def test_creator_cannot_revoke_own_token(client: TestClient) -> None:
    """Self-revoke is a footgun (it locks the creator out of their
    own session) — guard rail belongs at the manager. Pinning the
    refusal so a future "let creators rotate their token" feature
    has to think about what to do about live sockets."""

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    creator_role_id = seats["creator_role_id"]

    r = client.post(
        f"/api/sessions/{sid}/roles/{creator_role_id}/revoke?token={cr}"
    )
    assert r.status_code == 409, r.text


def test_non_creator_cannot_revoke_other_role(client: TestClient) -> None:
    """Authorisation regression net: only the creator can kick. A
    misbehaving player must not be able to kick a peer using their
    own token."""

    seats = _create_and_seat(client, role_count=3)
    sid = seats["session_id"]
    attacker_tok = seats["role_tokens"][seats["role_ids"][1]]
    target_rid = seats["role_ids"][2]

    r = client.post(
        f"/api/sessions/{sid}/roles/{target_rid}/revoke?token={attacker_tok}"
    )
    assert r.status_code == 403, r.text


def test_revoke_clears_role_from_active_set_on_remove(
    client: TestClient,
) -> None:
    """``remove_role`` must also drop the role from
    ``current_turn.active_role_ids`` so the turn isn't stuck waiting
    on a player that no longer exists. Pre-existing behavior; pinned
    here in the regression net so a future kick-cleanup refactor
    can't drop it."""

    from app.sessions.models import SessionState

    seats = _create_and_seat(client, role_count=3)
    sid = seats["session_id"]
    cr = seats["creator_token"]

    _install_play_mock(client, seats["role_ids"])
    client.post(f"/api/sessions/{sid}/setup/skip?token={cr}")
    client.post(f"/api/sessions/{sid}/start?token={cr}")

    manager = client.app.state.manager

    async def _check() -> None:
        snapshot = await manager.get_session(sid)
        assert snapshot.state == SessionState.AWAITING_PLAYERS
        # Pick a target that's actually in the AI-chosen active set so
        # the post-remove "no longer in active_role_ids" assertion is
        # exercising the cleanup path, not a vacuous "wasn't there to
        # begin with" pass. Skip the test if the AI's first turn only
        # asked one role and removing it would unblock the turn.
        active = list(snapshot.current_turn.active_role_ids or [])
        target_rid = next(
            (rid for rid in active if rid != seats["creator_role_id"]),
            None,
        )
        if target_rid is None:
            pytest.skip("AI didn't seat any non-creator role for turn 1")

        await manager.remove_role(
            session_id=sid, role_id=target_rid, by_role_id=seats["creator_role_id"]
        )

        snapshot = await manager.get_session(sid)
        assert target_rid not in (snapshot.current_turn.active_role_ids or [])

    asyncio.run(_check())


# ---------------------------------------------------------------------------
# Layer 6: REST surface for the kicked token (REST + WS share the same
# token-version gate; if one path regresses while the other doesn't, the
# attacker just switches transport).
# ---------------------------------------------------------------------------


def test_kicked_token_cannot_post_setup_reply(client: TestClient) -> None:
    """The kicked token must 401 on every authenticated REST surface,
    not just GET /sessions/{id}. We pick a representative MUTATING
    POST endpoint (setup reply) — the full path goes through the same
    ``_bind_token`` so once the version-mismatch returns 401 the
    handler never runs."""

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    rid = seats["role_ids"][1]
    old = seats["role_tokens"][rid]

    r = client.post(f"/api/sessions/{sid}/roles/{rid}/revoke?token={cr}")
    assert r.status_code == 200, r.text

    # Setup reply is creator-only, so 403 is the success signal —
    # what we DON'T want is a 200. Pre-fix the kicked token would
    # have at least passed _bind_token; now it 401s upstream of any
    # creator/participant gate.
    resp = client.post(
        f"/api/sessions/{sid}/setup/reply?token={old}",
        json={"content": "ignored"},
    )
    assert resp.status_code == 401, resp.text


def test_kicked_token_cannot_force_advance_via_websocket(
    client: TestClient,
) -> None:
    """Issue #127 / Security review CRITICAL #2:
    ``request_force_advance`` must be rejected for a kicked player
    whose old WebSocket is still mid-recv. The per-event
    ``_role_still_authorized`` gate in the WS pump catches this even
    if the recv buffer holds frames from before the disconnect lands.
    """

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    rid = seats["role_ids"][1]
    old = seats["role_tokens"][rid]

    _install_play_mock(client, seats["role_ids"])
    client.post(f"/api/sessions/{sid}/setup/skip?token={cr}")
    client.post(f"/api/sessions/{sid}/start?token={cr}")

    with client.websocket_connect(f"/ws/sessions/{sid}?token={old}") as ws:
        # Drain initial presence so the race window is narrow.
        _drain_until(ws, lambda e: e.get("type") == "presence_snapshot")

        # Bump token_version OUT-OF-BAND directly on the manager so
        # the bump lands BEFORE we send the ``request_force_advance``
        # — this simulates the race: the WS's token_version is now
        # stale relative to ``role.token_version``, but the socket
        # is still open because we sidestepped the route's
        # ``disconnect_role`` call.
        async def _bump() -> None:
            session = await client.app.state.manager.get_session(sid)
            role = session.role_by_id(rid)
            assert role is not None
            role.token_version += 1
            await client.app.state.manager._repo.save(session)

        asyncio.run(_bump())

        ws.send_json({"type": "request_force_advance"})

        # Either an error frame or a disconnect — both are acceptable
        # outcomes. The CRITICAL bug pre-fix was that force_advance
        # would land and mutate session state.
        outcome: dict[str, Any] | None = None
        with pytest.raises(WebSocketDisconnect):
            for _ in range(64):
                evt = ws.receive_json()
                if evt.get("type") == "error" and evt.get("scope") == "auth":
                    outcome = evt

        # Confirm post-condition: turn was NOT advanced. With the
        # mock's first turn typically still ``awaiting``, status
        # must remain ``awaiting`` (or the turn AI was driving
        # already), but it must NOT contain a "Force-advanced"
        # SYSTEM message attributed to the kicked role.
        snapshot = client.get(f"/api/sessions/{sid}?token={cr}").json()
        force_advance_messages = [
            m
            for m in snapshot["messages"]
            if m["kind"] == "system" and "Force-advanced" in (m["body"] or "")
        ]
        assert force_advance_messages == [], (
            "force_advance must not have landed for a kicked role; "
            f"found: {force_advance_messages}"
        )

        # Either the auth error frame fired, or the WS disconnected
        # before any error frame — both are fail-closed outcomes.
        if outcome is not None:
            assert outcome["scope"] == "auth"


def test_kicked_token_cannot_send_notepad_update(client: TestClient) -> None:
    """Notepad mutations through the WS pump go through the same
    require_participant gate as submit / force_advance, so the new
    per-event role check covers them too. A kicked user must not be
    able to corrupt the canonical Yjs doc through their stale tab.
    """

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    rid = seats["role_ids"][1]
    old = seats["role_tokens"][rid]

    _install_play_mock(client, seats["role_ids"])
    client.post(f"/api/sessions/{sid}/setup/skip?token={cr}")
    client.post(f"/api/sessions/{sid}/start?token={cr}")

    with client.websocket_connect(f"/ws/sessions/{sid}?token={old}") as ws:
        _drain_until(ws, lambda e: e.get("type") == "presence_snapshot")

        async def _bump() -> None:
            session = await client.app.state.manager.get_session(sid)
            role = session.role_by_id(rid)
            assert role is not None
            role.token_version += 1
            await client.app.state.manager._repo.save(session)

        asyncio.run(_bump())

        # Send a notepad update from the now-stale-version socket.
        # The base64 payload doesn't matter — the gate fires before
        # any bytes are decoded.
        ws.send_json({"type": "notepad_update", "update": "AAA="})

        with pytest.raises(WebSocketDisconnect):
            for _ in range(64):
                ws.receive_json()


def test_submit_response_with_stale_token_version_rejected(
    client: TestClient,
) -> None:
    """Defense-in-depth at the manager: even if the WS pre-check
    passed (race), ``submit_response(expected_token_version=...)``
    must reject the submission inside the lock when the server's
    role.token_version has moved on. This covers the kick/revoke
    race that the previous ``role_by_id is None`` check missed."""

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    rid = seats["role_ids"][1]

    _install_play_mock(client, seats["role_ids"])
    client.post(f"/api/sessions/{sid}/setup/skip?token={cr}")
    client.post(f"/api/sessions/{sid}/start?token={cr}")

    manager = client.app.state.manager

    async def _check() -> None:
        # Bump the version (simulates a kick that already landed).
        await manager.reissue_role_token(
            session_id=sid,
            role_id=rid,
            revoke_previous=True,
            by_role_id=seats["creator_role_id"],
        )
        # Submitting with the OLD (now-stale) version must raise.
        with pytest.raises(IllegalTransitionError) as exc_info:
            await manager.submit_response(
                session_id=sid,
                role_id=rid,
                content="ghost",
                expected_token_version=0,  # stale — actual is 1 post-revoke
            )
        assert "revoked" in str(exc_info.value).lower()

        # And submitting with the CURRENT version still works (the
        # role wasn't removed, just its token rotated). Sanity check
        # so the new gate doesn't accidentally lock the seat.
        # Note: requires the turn to still allow this role.
        snapshot = await manager.get_session(sid)
        if rid in (snapshot.current_turn.active_role_ids or []):
            await manager.submit_response(
                session_id=sid,
                role_id=rid,
                content="legitimate post-rotation submission",
                expected_token_version=1,
            )

    asyncio.run(_check())


def test_role_token_revoked_audit_includes_by_role_id(
    client: TestClient,
) -> None:
    """Product review HIGH: ``role_removed`` records ``by`` (the
    creator who performed the action); ``role_token_revoked`` was
    missing that field, so post-incident audit couldn't tell who
    kicked whom. Now both events carry it."""

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    rid = seats["role_ids"][1]

    r = client.post(f"/api/sessions/{sid}/roles/{rid}/revoke?token={cr}")
    assert r.status_code == 200, r.text

    audit = client.app.state.manager.audit().dump(sid)
    revoke_events = [e for e in audit if e.kind == "role_token_revoked"]
    assert revoke_events, "expected at least one role_token_revoked event"
    last = revoke_events[-1]
    assert last.payload.get("by") == seats["creator_role_id"], (
        f"role_token_revoked must record the actor; got payload={last.payload}"
    )
    assert last.payload.get("role_id") == rid


def test_reissue_without_revoke_audit_records_actor_too(
    client: TestClient,
) -> None:
    """Symmetric coverage for the non-revoke reissue path — same
    audit field plumbing, both events must populate ``by``."""

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    rid = seats["role_ids"][1]

    r = client.post(f"/api/sessions/{sid}/roles/{rid}/reissue?token={cr}")
    assert r.status_code == 200, r.text

    audit = client.app.state.manager.audit().dump(sid)
    reissue_events = [e for e in audit if e.kind == "role_token_reissued"]
    assert reissue_events
    assert reissue_events[-1].payload.get("by") == seats["creator_role_id"]


def test_removed_token_cannot_post_setup_reply(client: TestClient) -> None:
    """Mirror of the kicked-token test for the remove path. The role
    no longer exists in ``session.roles`` so ``_bind_token`` raises
    "role no longer exists" → 401."""

    seats = _create_and_seat(client, role_count=3)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    rid = seats["role_ids"][1]
    old = seats["role_tokens"][rid]

    r = client.delete(f"/api/sessions/{sid}/roles/{rid}?token={cr}")
    assert r.status_code == 200, r.text

    resp = client.post(
        f"/api/sessions/{sid}/setup/reply?token={old}",
        json={"content": "ignored"},
    )
    assert resp.status_code == 401, resp.text


# ---------------------------------------------------------------------------
# Lock-time auth re-check on add_role (B2 in PR #192)
# ---------------------------------------------------------------------------
#
# The route does ``require_creator(token)`` BEFORE ``manager.add_role`` takes
# the per-session lock. Without the in-lock recheck a concurrent revoke
# landing between bind and lock would let a now-revoked creator land a role.
# The fix threads ``acting_role_id`` + ``acting_token_version`` into
# ``add_role`` and re-validates against the live session under the lock.


def test_add_role_rejects_stale_acting_token_version(client: TestClient) -> None:
    """A creator whose token_version was bumped between bind and lock
    must be rejected at the lock-time recheck inside add_role."""

    seats = _create_and_seat(client, role_count=1)
    sid = seats["session_id"]
    creator_role_id = seats["creator_role_id"]
    manager = client.app.state.manager

    async def _attempt() -> None:
        with pytest.raises(AuthorizationError):
            await manager.add_role(
                session_id=sid,
                label="Late",
                kind="player",
                acting_role_id=creator_role_id,
                # Live version is 0 (freshly minted creator); 99 simulates a
                # stale token from before a concurrent revoke landed.
                acting_token_version=99,
            )

    asyncio.run(_attempt())


def test_add_role_rejects_non_creator_acting_role(client: TestClient) -> None:
    """A token from a non-creator role with an otherwise-current
    token_version must still be denied — only the seat marked as the
    session's creator can add roles."""

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    non_creator_role_id = seats["role_ids"][1]
    manager = client.app.state.manager

    async def _attempt() -> None:
        with pytest.raises(AuthorizationError):
            await manager.add_role(
                session_id=sid,
                label="ShouldNotLand",
                kind="player",
                acting_role_id=non_creator_role_id,
                acting_token_version=0,
            )

    asyncio.run(_attempt())
