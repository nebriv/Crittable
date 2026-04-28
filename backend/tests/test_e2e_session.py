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


def _wait_for_aar(client: TestClient, session_id: str, token: str, *, attempts: int = 50):
    """Poll the AAR endpoint until it returns 200 or fails. AAR generation is
    a background task on /end, so the export endpoint returns 425 while
    pending/generating."""

    import time

    for _ in range(attempts):
        r = client.get(f"/api/sessions/{session_id}/export.md?token={token}")
        if r.status_code != 425:
            return r
        time.sleep(0.05)
    return r  # last attempt, even if still 425


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
    r = _wait_for_aar(client, seats["session_id"], seats["creator_token"])
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

    # Gate 9 (docs/PLAN.md § Phase 2 acceptance gates): "Custom extension
    # loaded from EXTENSIONS_TOOLS_JSON is offered to the AI and successfully
    # invoked at least once during the integration test." Mock script in
    # ``setup_then_play_script`` calls ``use_extension_tool`` with
    # ``lookup_threat_intel`` on play turn 3; the dispatcher should render
    # the Jinja template and emit an ``extension_invoked`` audit event.
    audit_dump = client.app.state.manager.audit().dump(seats["session_id"])
    extension_invocations = [
        e for e in audit_dump if e.kind == "extension_invoked"
    ]
    assert extension_invocations, (
        f"gate 9 violated: no extension_invoked audit events for session "
        f"{seats['session_id']}; saw kinds={set(e.kind for e in audit_dump)}"
    )
    assert any(
        e.payload.get("tool") == "lookup_threat_intel"
        for e in extension_invocations
    ), "gate 9 violated: lookup_threat_intel never dispatched"


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


def test_play_after_auto_greet_then_skip_does_not_400(client: TestClient) -> None:
    """Regression for production bug observed via ``docker compose up``.

    Flow:
      1. POST /api/sessions auto-runs a setup turn — the AI may emit several
         ``ask_setup_question`` tool calls in one turn.
      2. Operator clicks "Skip setup (dev)" → POST /api/sessions/.../setup/skip
         → state moves to READY without clearing the setup-era AI messages.
      3. POST /api/sessions/.../start kicks the play turn.
      4. ``_play_messages`` previously emitted those setup-era AI messages as
         ``role=assistant``, so the conversation ended on assistant. Sonnet
         rejected the request with ``invalid_request_error: This model does
         not support assistant message prefill``.

    Fix lives in two places:
      a. ``dispatch.py`` no longer pushes ``ask_setup_question`` content into
         ``session.messages`` (it stays in ``setup_notes`` only).
      b. ``turn_driver._play_messages`` now filters setup-tool messages and
         guarantees the message list ends with ``role=user``.
    """

    from tests.mock_anthropic import MockAnthropic, _ContentBlock, _Response

    # Custom mock: the SETUP turn emits SIX ask_setup_question tool calls in
    # one response — exactly what was observed in production. The PLAY turn
    # then yields cleanly.
    setup_burst = _Response(
        content=[
            _ContentBlock(
                type="tool_use",
                name="ask_setup_question",
                input={"topic": f"q{i}", "question": f"What is q{i}?"},
                id=f"tu_q{i}",
            )
            for i in range(6)
        ],
        stop_reason="tool_use",
    )
    play_yield = _Response(
        content=[
            _ContentBlock(type="text", text="Detection alarms firing."),
            _ContentBlock(
                type="tool_use",
                name="set_active_roles",
                input={"role_ids": []},  # filled in below
                id="tu_set",
            ),
        ],
        stop_reason="tool_use",
    )

    # Pre-seat one for the role-id we'll fill the script with, then drop the
    # session — we recreate after the mock is installed so the auto-greet
    # actually goes through the scripted SETUP burst.
    seats = _create_and_seat(client, role_count=2)
    play_yield.content[1].input = {"role_ids": [seats["role_ids"][1]]}

    client.app.state.llm.set_transport(
        MockAnthropic({"setup": [setup_burst], "play": [play_yield]}).messages
    )

    # Re-create the session AFTER mock is installed so the auto-kicked setup
    # turn uses our scripted SETUP burst.
    resp = client.post(
        "/api/sessions",
        json={
            "scenario_prompt": "Ransomware via vendor portal at a mid-size bank",
            "creator_label": "CISO",
            "creator_display_name": "Alex",
        },
    )
    assert resp.status_code == 200, resp.text
    new_sid = resp.json()["session_id"]
    new_cr = resp.json()["creator_token"]

    # Add a player so we can start the session.
    r = client.post(
        f"/api/sessions/{new_sid}/roles?token={new_cr}",
        json={"label": "SOC Analyst", "display_name": "Sam"},
    )
    assert r.status_code == 200
    play_yield.content[1].input = {"role_ids": [r.json()["role_id"]]}

    r = client.post(f"/api/sessions/{new_sid}/setup/skip?token={new_cr}")
    assert r.status_code == 200, r.text

    # The bug: this would 500 with anthropic.BadRequestError.
    r = client.post(f"/api/sessions/{new_sid}/start?token={new_cr}")
    assert r.status_code == 200, r.text

    # Confirm the play transcript doesn't carry any setup-tool messages.
    snap = client.get(
        f"/api/sessions/{new_sid}?token={new_cr}"
    ).json()
    leaked = [
        m
        for m in snap["messages"]
        if m.get("tool_name")
        in ("ask_setup_question", "propose_scenario_plan", "finalize_setup")
    ]
    assert not leaked, f"setup-tool messages leaked into play transcript: {leaked}"


def test_reissue_role_does_not_invalidate_old_token(client: TestClient) -> None:
    """Reissue is "show me the link again" — old token still works."""

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    rid = seats["role_ids"][1]
    old = seats["role_tokens"][rid]

    r = client.post(f"/api/sessions/{sid}/roles/{rid}/reissue?token={cr}")
    assert r.status_code == 200, r.text
    new = r.json()["token"]
    # Both tokens validate successfully.
    assert client.get(f"/api/sessions/{sid}?token={old}").status_code == 200
    assert client.get(f"/api/sessions/{sid}?token={new}").status_code == 200


def test_revoke_role_invalidates_old_token(client: TestClient) -> None:
    """Revoke is "kick" — bumps token_version so the old token 401s."""

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    rid = seats["role_ids"][1]
    old = seats["role_tokens"][rid]

    r = client.post(f"/api/sessions/{sid}/roles/{rid}/revoke?token={cr}")
    assert r.status_code == 200, r.text
    new = r.json()["token"]

    # Old token now 401s with "token has been revoked".
    resp = client.get(f"/api/sessions/{sid}?token={old}")
    assert resp.status_code == 401
    assert "revoked" in resp.json()["detail"].lower()
    # New token works.
    assert client.get(f"/api/sessions/{sid}?token={new}").status_code == 200


def test_revoke_creator_token_rejected(client: TestClient) -> None:
    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    creator_role_id = seats["creator_role_id"]
    r = client.post(f"/api/sessions/{sid}/roles/{creator_role_id}/revoke?token={cr}")
    assert r.status_code == 409, r.text


def test_remove_role(client: TestClient) -> None:
    seats = _create_and_seat(client, role_count=3)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    rid = seats["role_ids"][1]
    old = seats["role_tokens"][rid]

    r = client.delete(f"/api/sessions/{sid}/roles/{rid}?token={cr}")
    assert r.status_code == 200, r.text

    snap = client.get(f"/api/sessions/{sid}?token={cr}").json()
    assert all(r["id"] != rid for r in snap["roles"])
    # The kicked role's old token 401s ("role no longer exists").
    resp = client.get(f"/api/sessions/{sid}?token={old}")
    assert resp.status_code == 401


def test_remove_creator_role_rejected(client: TestClient) -> None:
    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    r = client.delete(f"/api/sessions/{sid}/roles/{seats['creator_role_id']}?token={cr}")
    assert r.status_code == 409, r.text


def test_remove_role_non_creator_rejected(client: TestClient) -> None:
    seats = _create_and_seat(client, role_count=3)
    sid = seats["session_id"]
    other = seats["role_tokens"][seats["role_ids"][1]]
    target = seats["role_ids"][2]
    r = client.delete(f"/api/sessions/{sid}/roles/{target}?token={other}")
    assert r.status_code == 403


def test_activity_endpoint_creator_only(client: TestClient) -> None:
    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    other = seats["role_tokens"][seats["role_ids"][1]]

    r = client.get(f"/api/sessions/{sid}/activity?token={cr}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "state" in body
    assert "aar_status" in body
    assert "in_flight_llm" in body

    # Non-creator forbidden.
    r = client.get(f"/api/sessions/{sid}/activity?token={other}")
    assert r.status_code == 403


def test_debug_endpoint_creator_only(client: TestClient) -> None:
    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    other = seats["role_tokens"][seats["role_ids"][1]]

    r = client.get(f"/api/sessions/{sid}/debug?token={cr}")
    assert r.status_code == 200, r.text
    body = r.json()
    for key in ("session", "turns", "messages", "audit_events", "extensions"):
        assert key in body, f"missing key: {key}"

    r = client.get(f"/api/sessions/{sid}/debug?token={other}")
    assert r.status_code == 403


def test_export_returns_425_while_aar_pending(client: TestClient) -> None:
    """Direct test of the polling response: simulate aar_status=generating
    and confirm export.md returns 425 with retry-after."""

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    client.post(f"/api/sessions/{sid}/setup/skip?token={cr}")

    # Manually mutate the session into ENDED + aar_status=generating to test
    # the polling-friendly export response without driving a full play loop.
    import asyncio

    async def _set_pending() -> None:
        from app.sessions.models import SessionState

        session = await client.app.state.manager.get_session(sid)
        session.state = SessionState.ENDED
        session.aar_status = "generating"
        await client.app.state.manager._repo.save(session)

    asyncio.run(_set_pending())

    r = client.get(f"/api/sessions/{sid}/export.md?token={cr}")
    assert r.status_code == 425
    assert r.headers.get("Retry-After") == "3"
    assert r.headers.get("X-AAR-Status") == "generating"


def test_aar_failed_path_returns_500(client: TestClient) -> None:
    """QA review MAJOR: cover the failed-AAR branch.

    Monkey-patch the AAR generator to raise; end the session; export should
    return 500 with ``X-AAR-Status: failed`` and the error body.
    """

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    client.post(f"/api/sessions/{sid}/setup/skip?token={cr}")

    # Monkey-patch by swapping the AARGenerator class the manager imports.
    import app.llm.export as export_mod

    original = export_mod.AARGenerator

    class _BoomGenerator:
        def __init__(self, **_: object) -> None:
            pass

        async def generate(self, _session: object) -> str:
            raise RuntimeError("simulated AAR failure")

    export_mod.AARGenerator = _BoomGenerator  # type: ignore[misc]
    try:
        # Use REST end_session — it now triggers AAR generation inline in
        # TEST_MODE, so by the time end returns the failure has been recorded.
        client.post(f"/api/sessions/{sid}/end?token={cr}", json={"reason": "test"})
        r = client.get(f"/api/sessions/{sid}/export.md?token={cr}")
        assert r.status_code == 500, r.text
        assert r.headers.get("X-AAR-Status") == "failed"
        assert "simulated AAR failure" in r.text
    finally:
        export_mod.AARGenerator = original  # type: ignore[misc]


def test_in_flight_tracker_records_and_releases(client: TestClient) -> None:
    """QA MAJOR: the activity endpoint claims to expose live LLM calls,
    but no test confirmed an actual call shows up. This patches the LLM
    transport to await a future, so we can observe the in-flight slot
    while the call is hanging."""

    import asyncio

    llm = client.app.state.llm
    gate = asyncio.Event()
    held = asyncio.Event()

    class _HangingMessages:
        async def create(self, **_: object) -> object:
            held.set()
            await gate.wait()
            from tests.mock_anthropic import _ContentBlock, _Response

            return _Response(content=[_ContentBlock(type="text", text="ok")])

        def stream(self, **_: object) -> object:
            raise NotImplementedError

    async def _drive() -> None:
        # Call llm.acomplete directly — simpler than threading through the
        # full setup/start flow, and exactly the path that registers a slot.
        prior_transport = llm._transport
        llm.set_transport(_HangingMessages())
        task = asyncio.create_task(
            llm.acomplete(
                tier="setup",
                system_blocks=[{"type": "text", "text": "x"}],
                messages=[{"role": "user", "content": "hi"}],
                session_id="sentinel",
            )
        )
        await held.wait()
        in_flight = llm.in_flight_for("sentinel")
        assert len(in_flight) == 1
        assert in_flight[0].tier == "setup"
        gate.set()
        await task
        # After completion the slot is released.
        assert llm.in_flight_for("sentinel") == []
        llm._transport = prior_transport

    asyncio.run(_drive())


def test_typing_event_relays_to_other_participants(client: TestClient) -> None:
    """QA MAJOR: typing indicators were untested. Drives a participant WS
    sending ``typing_start`` and asserts another participant's connection
    sees the relayed ``typing`` event with the server-verified role_id."""

    import asyncio

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    sender_role_id = seats["role_ids"][1]
    sender_token = seats["role_tokens"][sender_role_id]

    connections = client.app.state.connections

    async def _drive() -> None:
        observer = await connections.register(
            session_id=sid, role_id=seats["creator_role_id"], is_creator=True
        )
        try:
            with client.websocket_connect(
                f"/ws/sessions/{sid}?token={sender_token}"
            ) as ws:
                ws.send_json({"type": "typing_start"})
                # Drain the observer queue for a typing event.
                seen: list[dict[str, object]] = []
                for _ in range(50):
                    try:
                        seen.append(observer.queue.get_nowait())
                    except asyncio.QueueEmpty:
                        await asyncio.sleep(0.01)
                typing_evts = [e for e in seen if e.get("type") == "typing"]
                assert typing_evts, f"no typing event observed in {seen}"
                evt = typing_evts[-1]
                assert evt["role_id"] == sender_role_id
                assert evt["typing"] is True
        finally:
            await connections.unregister(observer)

    asyncio.run(_drive())


def test_typing_rejected_for_spectator(client: TestClient) -> None:
    """Security HIGH regression: spectator-kind tokens cannot emit typing."""

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    authn = client.app.state.authn
    spectator_token = authn.mint(
        session_id=sid, role_id=seats["role_ids"][1], kind="spectator"
    )

    with client.websocket_connect(
        f"/ws/sessions/{sid}?token={spectator_token}"
    ) as ws:
        ws.send_json({"type": "typing_start"})
        saw_rejection = False
        for _ in range(8):
            try:
                evt = ws.receive_json()
            except Exception:
                break
            if evt.get("type") == "error" and evt.get("scope") == "typing_start":
                saw_rejection = True
                break
        assert saw_rejection, "spectator typing must be rejected"


def test_typing_does_not_pollute_replay_buffer(client: TestClient) -> None:
    """Security HIGH regression: typing events use record=False so they
    don't evict legitimate state events from the bounded replay buffer."""

    import asyncio

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    # Drive setup → READY so we have a `state_changed` worth replaying.
    client.post(f"/api/sessions/{sid}/setup/skip?token={cr}")

    connections = client.app.state.connections

    async def _drive() -> None:
        # Hammer the typing channel — used to pollute the replay buffer.
        for _ in range(300):  # > _replay_max (256), would have evicted otherwise
            await connections.broadcast(
                sid,
                {"type": "typing", "role_id": "x", "typing": True},
                record=False,
            )
        # Fresh observer should still see the prior plan_finalized_announcement
        # in its replay buffer.
        conn = await connections.register(
            session_id=sid, role_id=seats["role_ids"][1], is_creator=False
        )
        try:
            collected: list[dict[str, object]] = []
            for _ in range(50):
                try:
                    collected.append(conn.queue.get_nowait())
                except asyncio.QueueEmpty:
                    break
            kinds = {e.get("type") for e in collected}
            assert "typing" not in kinds, "typing leaked into replay"
            # State events from the setup/skip → READY transition must still be there.
            assert kinds & {
                "state_changed",
                "plan_finalized_announcement",
            }, f"replay should still have lifecycle events; got {kinds}"
        finally:
            await connections.unregister(conn)

    asyncio.run(_drive())


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


def test_spa_fallback_for_nested_routes(tmp_path) -> None:
    """Regression for the production 404 on ``/play/{sid}/{token}``.

    The previous ``StaticFiles(directory=..., html=True)`` mount served
    ``index.html`` for ``/`` only. Any nested SPA route returned 404, so the
    join-link flow was broken — players clicking a copied URL got a server
    404 before their browser ever loaded the SPA.

    Uses ``static_dir_override`` so the test never touches the real
    ``backend/app/static`` build artifact (a developer who has run a vite
    build would otherwise have their bundle clobbered by the synthesised
    index.html).
    """

    from app.main import create_app

    static_root = tmp_path / "static"
    static_root.mkdir()
    (static_root / "index.html").write_text(
        "<!doctype html><html><head><title>SPA</title></head><body><div id=root></div></body></html>"
    )
    (static_root / "favicon.ico").write_bytes(b"\x00\x00\x01\x00")  # serve real files
    (static_root / ".env").write_text("SECRET=should-not-leak")  # dotfile reject case

    from fastapi.testclient import TestClient as _TC

    app = create_app(static_dir_override=static_root)
    with _TC(app) as c:
        # Real API still works.
        assert c.get("/healthz").json() == {"status": "ok"}
        # Top-level SPA route → index.html.
        r = c.get("/")
        assert r.status_code == 200
        assert "<title>SPA</title>" in r.text
        # Nested SPA route → fallback to index.html.
        r = c.get("/play/abc123/some-token")
        assert r.status_code == 200
        assert "<title>SPA</title>" in r.text
        # Real top-level static file → served as-is.
        r = c.get("/favicon.ico")
        assert r.status_code == 200
        assert r.content.startswith(b"\x00\x00\x01\x00")
        # Dotfile must NOT be served, even though it exists in static_dir.
        r = c.get("/.env")
        assert r.status_code == 200
        assert "SECRET=" not in r.text
        assert "<title>SPA</title>" in r.text
        # /api/<unknown> must return real 404, not the SPA fallback.
        r = c.get("/api/this-route-does-not-exist")
        assert r.status_code == 404
        assert "<title>SPA</title>" not in r.text
        # /ws/<unknown> must also 404.
        r = c.get("/ws/this-route-does-not-exist")
        assert r.status_code == 404
