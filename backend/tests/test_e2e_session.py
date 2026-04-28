"""End-to-end integration test driving the full session against a mock LLM."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import reset_settings_cache
from app.main import create_app
from tests.mock_anthropic import MockAnthropic, setup_then_play_script

_TOOLS_JSON = """[{
    "name": "lookup_threat_intel",
    "description": "Look up simulated threat intel.",
    "input_schema": {
        "type": "object",
        "properties": {"ioc": {"type": "string"}},
        "required": ["ioc"]
    },
    "handler_kind": "templated_text",
    "handler_config": "TLP:AMBER for {{ args.ioc }} (roster={{ session.roster_size }})"
}]"""


@pytest.fixture(autouse=True)
def _e2e_env(monkeypatch) -> None:
    monkeypatch.setenv("ANTHROPIC_MODEL_PLAY", "mock-play")
    monkeypatch.setenv("ANTHROPIC_MODEL_SETUP", "mock-setup")
    monkeypatch.setenv("ANTHROPIC_MODEL_AAR", "mock-aar")
    monkeypatch.setenv("ANTHROPIC_MODEL_GUARDRAIL", "mock-guardrail")
    monkeypatch.setenv("TEST_MODE", "true")
    monkeypatch.setenv("SESSION_SECRET", "x" * 32)
    monkeypatch.setenv("INPUT_GUARDRAIL_ENABLED", "false")
    monkeypatch.setenv("EXTENSIONS_TOOLS_JSON", _TOOLS_JSON)
    reset_settings_cache()


def _install_mock_and_drive(client: TestClient, *, role_ids: list[str], extension: str) -> str:
    """Wire the deterministic mock onto the running app and return the markdown."""

    scripts = setup_then_play_script(role_ids=role_ids, extension_tool=extension)
    mock = MockAnthropic(scripts)
    client.app.state.llm.set_transport(mock.messages)
    return ""  # callers fetch the export themselves


def _install_minimal_mock(client: TestClient) -> None:
    """A no-op-ish mock for tests that don't drive a full play flow.

    Returns a benign ``end_session`` call for any tier so the auto-kicked
    setup turn on session creation doesn't reach the real Anthropic API.
    """

    client.app.state.llm.set_transport(MockAnthropic({}).messages)


@pytest.fixture
def client() -> TestClient:
    reset_settings_cache()
    app = create_app()
    with TestClient(app) as c:
        # Install a default mock so session creation's auto-AI-kick doesn't hit
        # the network. Individual tests can re-install a richer script later.
        _install_minimal_mock(c)
        yield c


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
    session_id = created["session_id"]
    creator_token = created["creator_token"]
    creator_role_id = created["creator_role_id"]

    role_ids: list[str] = [creator_role_id]
    role_tokens: dict[str, str] = {creator_role_id: creator_token}
    for i in range(role_count - 1):
        r = client.post(
            f"/api/sessions/{session_id}/roles?token={creator_token}",
            json={"label": f"Player_{i + 1}", "display_name": f"P{i + 1}"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        role_ids.append(body["role_id"])
        role_tokens[body["role_id"]] = body["token"]

    return {
        "session_id": session_id,
        "creator_token": creator_token,
        "creator_role_id": creator_role_id,
        "role_ids": role_ids,
        "role_tokens": role_tokens,
    }


def _drive(
    client: TestClient,
    *,
    session_id: str,
    creator_token: str,
    role_tokens: dict[str, str],
    role_ids: list[str],
) -> None:
    # ------ setup: drive the AI dialogue
    # Step 1: creator answers the AI's first question — triggers proposal
    r = client.post(
        f"/api/sessions/{session_id}/setup/reply?token={creator_token}",
        json={"content": "We're a regional bank, mid-size, PCI + SOX."},
    )
    assert r.status_code == 200, r.text

    # Step 2: creator pushes the AI to propose a plan
    r = client.post(
        f"/api/sessions/{session_id}/setup/reply?token={creator_token}",
        json={"content": "Looks like enough context — please draft a plan."},
    )
    assert r.status_code == 200, r.text

    # Step 3: creator approves the proposal — triggers finalize
    r = client.post(
        f"/api/sessions/{session_id}/setup/reply?token={creator_token}",
        json={"content": "Plan looks good — please finalize."},
    )
    assert r.status_code == 200, r.text

    # ------ start the play phase
    r = client.post(f"/api/sessions/{session_id}/start?token={creator_token}")
    assert r.status_code == 200, r.text

    # The first play turn ran during /start; now the engine should be awaiting
    # a player response. Connect each role and submit until the session ends.
    safety_cap = 30
    turns_played = 0
    while turns_played < safety_cap:
        snap = client.get(
            f"/api/sessions/{session_id}?token={creator_token}"
        ).json()
        if snap["state"] == "ENDED":
            break
        active = (snap.get("current_turn") or {}).get("active_role_ids") or []
        if not active:
            # No active turn — force-advance to keep the loop moving
            client.post(
                f"/api/sessions/{session_id}/force-advance?token={creator_token}"
            )
            turns_played += 1
            continue
        # Submit for each active role via WS
        for rid in active:
            tok = role_tokens[rid]
            with client.websocket_connect(
                f"/ws/sessions/{session_id}?token={tok}"
            ) as ws:
                ws.send_json(
                    {"type": "submit_response", "content": "Acknowledged, taking action."}
                )
                # Drain a bounded number of events; close on first message_complete
                # for our role (server-driven; never blocks indefinitely).
                for _ in range(64):
                    try:
                        evt = ws.receive_json(mode="text", timeout=2)
                    except Exception:
                        break
                    if evt.get("type") in ("state_changed", "turn_changed"):
                        break
        turns_played += 1


def test_e2e_2_role(client: TestClient) -> None:
    seats = _create_and_seat(client, role_count=2)
    _install_mock_and_drive(
        client, role_ids=seats["role_ids"], extension="lookup_threat_intel"
    )
    _drive(
        client,
        session_id=seats["session_id"],
        creator_token=seats["creator_token"],
        role_tokens=seats["role_tokens"],
        role_ids=seats["role_ids"],
    )

    # ------ export
    r = client.get(
        f"/api/sessions/{seats['session_id']}/export.md?token={seats['creator_token']}"
    )
    assert r.status_code == 200, r.text
    md = r.text
    for section in (
        "After-Action Report",
        "Header",
        "Executive summary",
        "Full transcript",
        "Per-role scores",
        "Overall session score",
        "Appendix A — Setup conversation",
        "Appendix B — Frozen scenario plan",
        "Appendix C — Audit log",
    ):
        assert section in md, f"missing section: {section}"

    # Roster-size adaptation: small strategy
    snap = client.get(
        f"/api/sessions/{seats['session_id']}?token={seats['creator_token']}"
    ).json()
    assert snap["state"] == "ENDED"


def test_e2e_12_role(client: TestClient) -> None:
    seats = _create_and_seat(client, role_count=12)
    _install_mock_and_drive(
        client, role_ids=seats["role_ids"], extension="lookup_threat_intel"
    )
    _drive(
        client,
        session_id=seats["session_id"],
        creator_token=seats["creator_token"],
        role_tokens=seats["role_tokens"],
        role_ids=seats["role_ids"],
    )
    r = client.get(
        f"/api/sessions/{seats['session_id']}/export.md?token={seats['creator_token']}"
    )
    assert r.status_code == 200
    assert "After-Action Report" in r.text


def test_role_gating_blocks_non_active(client: TestClient) -> None:
    seats = _create_and_seat(client, role_count=3)
    _install_mock_and_drive(
        client, role_ids=seats["role_ids"], extension="lookup_threat_intel"
    )

    # Drive setup + start
    cr = seats["creator_token"]
    sid = seats["session_id"]
    client.post(f"/api/sessions/{sid}/setup/reply?token={cr}", json={"content": "ok"})
    client.post(f"/api/sessions/{sid}/setup/reply?token={cr}", json={"content": "approve"})
    client.post(f"/api/sessions/{sid}/start?token={cr}")

    snap = client.get(f"/api/sessions/{sid}?token={cr}").json()
    active = (snap.get("current_turn") or {}).get("active_role_ids") or []
    if not active:
        pytest.skip("no active role on first turn after start (mock variance)")

    # Find a non-active role and try to submit — should bounce
    non_active = [r for r in seats["role_ids"] if r not in active]
    if not non_active:
        pytest.skip("all roles active on first turn (mock variance)")
    rid = non_active[0]
    tok = seats["role_tokens"][rid]
    with client.websocket_connect(f"/ws/sessions/{sid}?token={tok}") as ws:
        ws.send_json({"type": "submit_response", "content": "I sneak in."})
        # Expect an error event from the server within a few frames
        saw_error = False
        for _ in range(8):
            try:
                evt = ws.receive_json(timeout=2)
            except Exception:
                break
            if evt.get("type") == "error":
                saw_error = True
                break
        assert saw_error, "non-active role should be rejected"


def test_extensions_endpoint(client: TestClient) -> None:
    r = client.get("/api/extensions")
    assert r.status_code == 200
    body = r.json()
    names = [t["name"] for t in body["tools"]]
    assert "lookup_threat_intel" in names


def test_creator_can_finalize_draft_plan_without_ai(client: TestClient) -> None:
    """The 'Approve plan' UI shortcut: AI proposes, creator hits finalize
    directly with no body — server uses the existing draft plan."""

    seats = _create_and_seat(client, role_count=2)
    _install_mock_and_drive(
        client, role_ids=seats["role_ids"], extension="lookup_threat_intel"
    )
    sid = seats["session_id"]
    cr = seats["creator_token"]

    # First reply triggers the AI to ask. Second reply triggers propose.
    client.post(f"/api/sessions/{sid}/setup/reply?token={cr}", json={"content": "ok"})
    client.post(
        f"/api/sessions/{sid}/setup/reply?token={cr}",
        json={"content": "draft plan please"},
    )

    snap = client.get(f"/api/sessions/{sid}?token={cr}").json()
    assert snap["plan"] is not None, "AI should have stored a draft plan"
    assert snap["state"] == "SETUP", "session must still be in SETUP after propose"

    # Direct finalize without resending the plan body — server uses the draft.
    r = client.post(f"/api/sessions/{sid}/setup/finalize?token={cr}", json={})
    assert r.status_code == 200, r.text

    snap = client.get(f"/api/sessions/{sid}?token={cr}").json()
    assert snap["state"] == "READY"


def test_setup_skip_endpoint_lands_session_in_ready(client: TestClient) -> None:
    """The 'Skip setup (dev)' UI button: drops a default plan, jumps to READY."""

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]

    r = client.post(f"/api/sessions/{sid}/setup/skip?token={cr}")
    assert r.status_code == 200, r.text

    snap = client.get(f"/api/sessions/{sid}?token={cr}").json()
    assert snap["state"] == "READY"
    assert snap["plan"] is not None
    assert snap["plan"]["title"]


def test_dev_fast_setup_env(monkeypatch) -> None:
    """``DEV_FAST_SETUP=true`` lands new sessions straight in READY."""

    monkeypatch.setenv("DEV_FAST_SETUP", "true")
    reset_settings_cache()
    app = create_app()
    with TestClient(app) as c:
        _install_minimal_mock(c)
        resp = c.post(
            "/api/sessions",
            json={
                "scenario_prompt": "Phishing-led credential theft.",
                "creator_label": "CISO",
                "creator_display_name": "Alex",
            },
        )
        body = resp.json()
        assert body["fast_setup"] is True
        snap = c.get(
            f"/api/sessions/{body['session_id']}?token={body['creator_token']}"
        ).json()
        assert snap["state"] == "READY"
        assert snap["plan"] is not None


def test_plan_not_revealed_to_non_creator(client: TestClient) -> None:
    """Acceptance gate: the frozen scenario plan never reaches non-creator roles."""

    seats = _create_and_seat(client, role_count=3)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    other = seats["role_tokens"][seats["role_ids"][1]]

    # Use the dev-skip path so we get a deterministic plan committed.
    r = client.post(f"/api/sessions/{sid}/setup/skip?token={cr}")
    assert r.status_code == 200

    creator_view = client.get(f"/api/sessions/{sid}?token={cr}").json()
    other_view = client.get(f"/api/sessions/{sid}?token={other}").json()

    assert creator_view["plan"] is not None
    assert other_view["plan"] is None, "non-creator must not see the plan in snapshot"
    assert other_view["cost"] is None, "non-creator must not see the cost meter"


def test_force_advance_from_any_participant(client: TestClient) -> None:
    """Acceptance gate: any seated participant can force-advance a stalled turn."""

    seats = _create_and_seat(client, role_count=3)
    _install_mock_and_drive(
        client, role_ids=seats["role_ids"], extension="lookup_threat_intel"
    )
    sid = seats["session_id"]
    cr = seats["creator_token"]
    non_creator = seats["role_tokens"][seats["role_ids"][1]]

    # Drive setup to READY.
    client.post(f"/api/sessions/{sid}/setup/skip?token={cr}")
    client.post(f"/api/sessions/{sid}/start?token={cr}")

    snap = client.get(f"/api/sessions/{sid}?token={cr}").json()
    if snap["state"] != "AWAITING_PLAYERS":
        pytest.skip("first AI turn did not yield to players (mock variance)")

    # Non-creator force-advances — should be allowed.
    r = client.post(
        f"/api/sessions/{sid}/force-advance?token={non_creator}"
    )
    assert r.status_code == 200, r.text


def test_end_session_from_any_participant(client: TestClient) -> None:
    """Acceptance gate: any seated participant can end the session."""

    seats = _create_and_seat(client, role_count=2)
    _install_mock_and_drive(
        client, role_ids=seats["role_ids"], extension="lookup_threat_intel"
    )
    sid = seats["session_id"]
    cr = seats["creator_token"]
    other = seats["role_tokens"][seats["role_ids"][1]]

    client.post(f"/api/sessions/{sid}/setup/skip?token={cr}")
    client.post(f"/api/sessions/{sid}/start?token={cr}")

    r = client.post(f"/api/sessions/{sid}/end?token={other}", json={})
    assert r.status_code == 200, r.text
    snap = client.get(f"/api/sessions/{sid}?token={cr}").json()
    assert snap["state"] == "ENDED"


def test_ws_replay_buffer_rehydrates_on_reconnect(client: TestClient) -> None:
    """Acceptance gate: closing and reopening a tab restores the transcript.

    Tests the ConnectionManager replay buffer directly — that's the layer
    that guarantees a fresh WS gets the prior events. The TestClient's WS
    surface doesn't expose non-blocking receive, so going through it would
    deadlock.
    """

    import asyncio

    seats = _create_and_seat(client, role_count=2)
    _install_mock_and_drive(
        client, role_ids=seats["role_ids"], extension="lookup_threat_intel"
    )
    sid = seats["session_id"]
    cr = seats["creator_token"]

    # Drive setup → start so the manager broadcasts a few events into the
    # connection-manager replay buffer.
    client.post(f"/api/sessions/{sid}/setup/skip?token={cr}")
    client.post(f"/api/sessions/{sid}/start?token={cr}")

    connections = client.app.state.connections

    async def _check() -> None:
        # Register a fresh connection — replay buffer should pre-fill the queue.
        conn = await connections.register(
            session_id=sid, role_id=seats["role_ids"][1], is_creator=False
        )
        try:
            collected: list[dict[str, Any]] = []
            for _ in range(20):
                try:
                    evt = conn.queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
                collected.append(evt)
            assert collected, "replay buffer should have events for a fresh connect"
            # We expect at least one state_changed or turn_changed event.
            kinds = {evt.get("type") for evt in collected}
            assert kinds & {
                "state_changed",
                "turn_changed",
                "plan_finalized",
            }, f"expected lifecycle events in replay; got {kinds}"
        finally:
            await connections.unregister(conn)

    asyncio.run(_check())


def test_plan_content_not_in_ws_replay_buffer(client: TestClient) -> None:
    """Regression for the security review CRITICAL.

    Previously, ``plan_proposed`` and ``plan_finalized`` events were
    ``broadcast()``-ed with full plan content; the replay buffer then handed
    that content to any future-connecting non-creator. The fix routes plan
    content via ``send_to_role(creator)`` and broadcasts a content-free
    announcement instead.
    """

    import asyncio

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]

    # Drive setup → READY (uses /setup/skip which goes through finalize_setup
    # via the manager). manager.finalize_setup itself only broadcasts
    # state_changed; the leaky path was turn_driver._apply_setup_outcome.
    client.post(f"/api/sessions/{sid}/setup/skip?token={cr}")

    connections = client.app.state.connections

    async def _check() -> None:
        # Attach a non-creator connection — replay buffer should have no event
        # whose payload contains plan content.
        non_creator_id = seats["role_ids"][1]
        conn = await connections.register(
            session_id=sid, role_id=non_creator_id, is_creator=False
        )
        try:
            collected: list[dict[str, Any]] = []
            for _ in range(50):
                try:
                    collected.append(conn.queue.get_nowait())
                except asyncio.QueueEmpty:
                    break
            for evt in collected:
                # The plan content key is "plan"; any event still carrying it
                # has leaked.
                assert "plan" not in evt, (
                    f"replay buffer leaked plan content via {evt.get('type')!r}: "
                    f"{evt}"
                )
        finally:
            await connections.unregister(conn)

    asyncio.run(_check())


def test_ws_rejects_spectator_for_mutating_events(client: TestClient) -> None:
    """Regression for security review HIGH: WS handler must run
    ``require_participant`` before routing submit/force-advance/end."""

    import os

    # Create a session and seat a player. We then mint a *spectator* token for
    # that role and confirm it's blocked from submitting.
    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    client.post(f"/api/sessions/{sid}/setup/skip?token={cr}")
    client.post(f"/api/sessions/{sid}/start?token={cr}")

    # Mint a spectator-kind token by calling the authn module directly — the
    # public role-add path doesn't currently mint spectator tokens.
    authn = client.app.state.authn
    spectator_token = authn.mint(
        session_id=sid, role_id=seats["role_ids"][1], kind="spectator"
    )

    with client.websocket_connect(
        f"/ws/sessions/{sid}?token={spectator_token}"
    ) as ws:
        ws.send_json({"type": "submit_response", "content": "hello"})
        # Drain until we see the rejection or the connection closes.
        saw_rejection = False
        for _ in range(8):
            try:
                evt = ws.receive_json()
            except Exception:
                break
            if evt.get("type") == "error" and evt.get("scope") == "submit_response":
                saw_rejection = True
                break
            if evt.get("type") == "state_changed":
                continue
        assert saw_rejection, "spectator token must be rejected on submit_response"
    # Touch unused import sentinel for ruff
    _ = os


def test_plan_edit_endpoint_creator_only_and_field_allowlist(client: TestClient) -> None:
    """Plan-edit endpoint had no e2e coverage."""

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    other = seats["role_tokens"][seats["role_ids"][1]]

    client.post(f"/api/sessions/{sid}/setup/skip?token={cr}")

    # Allowed field — edits the plan in place.
    r = client.post(
        f"/api/sessions/{sid}/plan?token={cr}",
        json={"field": "guardrails", "value": ["new", "rules"]},
    )
    assert r.status_code == 200, r.text
    snap = client.get(f"/api/sessions/{sid}?token={cr}").json()
    assert snap["plan"]["guardrails"] == ["new", "rules"]

    # Immutable field — rejected.
    r = client.post(
        f"/api/sessions/{sid}/plan?token={cr}",
        json={"field": "title", "value": "New title"},
    )
    assert r.status_code == 409, r.text

    # Non-creator — rejected.
    r = client.post(
        f"/api/sessions/{sid}/plan?token={other}",
        json={"field": "guardrails", "value": ["x"]},
    )
    assert r.status_code == 403, r.text


def test_ws_rejects_bad_token_with_4401(client: TestClient) -> None:
    """Acceptance gate 13: AAA exercised on every request.

    The WS handler closes a bad-token connection with code 4401 before
    accept. Starlette's TestClient surfaces that as a ``WebSocketDisconnect``
    raised from ``websocket_connect``'s context manager.
    """

    from starlette.websockets import WebSocketDisconnect

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    bad = seats["creator_token"][:-1] + "X"

    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect(f"/ws/sessions/{sid}?token={bad}"):
            pass
    assert exc_info.value.code == 4401, f"expected 4401, got {exc_info.value.code}"


def test_ws_rejects_session_mismatch(client: TestClient) -> None:
    from starlette.websockets import WebSocketDisconnect

    seats_a = _create_and_seat(client, role_count=2)
    seats_b = _create_and_seat(client, role_count=2)

    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect(
            f"/ws/sessions/{seats_b['session_id']}?token={seats_a['creator_token']}"
        ):
            pass
    assert exc_info.value.code == 4401


def test_setup_notes_visible_only_to_creator(client: TestClient) -> None:
    seats = _create_and_seat(client, role_count=2)
    _install_mock_and_drive(
        client, role_ids=seats["role_ids"], extension="lookup_threat_intel"
    )
    sid = seats["session_id"]
    cr = seats["creator_token"]
    other_token = seats["role_tokens"][seats["role_ids"][1]]

    # Push the AI to ask one question.
    client.post(f"/api/sessions/{sid}/setup/reply?token={cr}", json={"content": "context"})

    creator_view = client.get(f"/api/sessions/{sid}?token={cr}").json()
    other_view = client.get(f"/api/sessions/{sid}?token={other_token}").json()

    assert creator_view["setup_notes"], "creator should see setup notes"
    assert other_view["setup_notes"] is None, "non-creator must not see setup notes"


def test_health(client: TestClient) -> None:
    assert client.get("/healthz").json() == {"status": "ok"}
    assert client.get("/readyz").json() == {"status": "ready"}
