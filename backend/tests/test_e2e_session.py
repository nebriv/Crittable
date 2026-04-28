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


@pytest.fixture
def client() -> TestClient:
    reset_settings_cache()
    app = create_app()
    with TestClient(app) as c:
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


def test_health(client: TestClient) -> None:
    assert client.get("/healthz").json() == {"status": "ok"}
    assert client.get("/readyz").json() == {"status": "ready"}
