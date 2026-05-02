"""HTTP-layer tests for the dev-tools scenario API.

Verifies the gating, list shape, and the end-to-end ``play`` flow over
HTTP. The runner internals are exercised by ``test_scenario_runner.py``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import reset_settings_cache
from tests.mock_anthropic import MockAnthropic

_FIXTURE_DIR = Path(__file__).parent / "_fixture_scenarios"


def _write_fixture_scenario() -> None:
    """Drop a tiny scenario into a fixture directory the test will point
    ``DEV_SCENARIOS_PATH`` at — keeps the repo's real ``backend/scenarios/``
    isolated from test-side mutations.
    """

    _FIXTURE_DIR.mkdir(exist_ok=True)
    payload = {
        "meta": {
            "name": "fixture",
            "description": "tiny",
            "tags": ["fixture"],
        },
        "scenario_prompt": "Ransomware via vendor portal",
        "creator_label": "CISO",
        "creator_display_name": "Alex",
        "skip_setup": True,
        "roster": [{"label": "SOC", "display_name": "Bo", "kind": "player"}],
        "setup_replies": [],
        "play_turns": [
            {
                "submissions": [
                    {"role_label": "creator", "content": "Isolate."},
                    {"role_label": "SOC", "content": "Acknowledged."},
                ]
            }
        ],
        "end_reason": "fixture done",
        "mock_llm_script": None,
    }
    (_FIXTURE_DIR / "fixture.json").write_text(json.dumps(payload))


@pytest.fixture(autouse=True)
def _point_at_fixture_dir(monkeypatch: pytest.MonkeyPatch) -> None:
    _write_fixture_scenario()
    monkeypatch.setenv("DEV_SCENARIOS_PATH", str(_FIXTURE_DIR))
    reset_settings_cache()


def _bootstrap_token(client: TestClient) -> str:
    """The play endpoint now requires a valid signed token — anyone with
    a token, but a real one. Spin up a throwaway session to mint one.

    This mirrors the dev workflow: a creator already has a session open
    (their own God Mode panel) and uses that token to fire the dev-tools
    /play endpoint.
    """

    resp = client.post(
        "/api/sessions",
        json={
            "scenario_prompt": "bootstrap",
            "creator_label": "Bootstrap",
            "creator_display_name": "Bootstrap",
            "skip_setup": True,
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["creator_token"]


def test_list_scenarios_gated_off_404(monkeypatch: pytest.MonkeyPatch) -> None:
    """The list endpoint should 404 (not 403, not 200) when dev tools are
    disabled — the gate is opaque so probing clients can't tell the
    route exists."""

    monkeypatch.setenv("DEV_TOOLS_ENABLED", "false")
    monkeypatch.setenv("TEST_MODE", "false")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    reset_settings_cache()
    from app.main import create_app

    app = create_app()
    with TestClient(app) as client:
        resp = client.get("/api/dev/scenarios")
        assert resp.status_code == 404


def test_list_scenarios_returns_fixture(client: TestClient) -> None:
    """Test mode is on (via the autouse fixture); the fixture scenario
    should appear in the list with the correct metadata."""

    resp = client.get("/api/dev/scenarios")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    ids = {s["id"] for s in body["scenarios"]}
    assert "fixture" in ids
    fix = next(s for s in body["scenarios"] if s["id"] == "fixture")
    assert fix["roster_size"] == 2  # creator + SOC
    assert fix["play_turns"] == 1
    assert fix["skip_setup"] is True


def test_play_requires_token(client: TestClient) -> None:
    """Auth gate on /play: even with DEV_TOOLS_ENABLED, an unauth'd
    caller cannot mint sessions / harvest tokens. Closes Security H1."""

    resp = client.post("/api/dev/scenarios/fixture/play")
    assert resp.status_code == 401


def test_play_unknown_scenario_404(client: TestClient) -> None:
    token = _bootstrap_token(client)
    resp = client.post(f"/api/dev/scenarios/does-not-exist/play?token={token}")
    assert resp.status_code == 404


def test_play_drives_session_to_end(client: TestClient) -> None:
    """Hitting the play endpoint should walk the fixture scenario to ENDED
    and return the new session_id + role tokens."""

    client.app.state.llm.set_transport(MockAnthropic({}).messages)
    token = _bootstrap_token(client)
    resp = client.post(f"/api/dev/scenarios/fixture/play?token={token}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True, body
    assert body["session_id"]
    assert "creator" in body["role_label_to_id"]
    assert "CISO" in body["role_label_to_id"]
    assert "SOC" in body["role_label_to_id"]
    # The new session should actually be in ENDED state. Without this
    # the runner could silently skip end_phase and the test would still
    # pass on body["ok"] alone (QA review HIGH-3).
    snap = client.get(
        f"/api/sessions/{body['session_id']}?token={body['role_tokens'][body['role_label_to_id']['creator']]}",
    ).json()
    assert snap["state"] == "ENDED"


def test_record_creates_replayable_scenario(client: TestClient) -> None:
    """Drive a fresh session, then call /record. The returned scenario_json
    should be a valid Scenario shape with roster + play_turns extracted
    from the live session state."""

    client.app.state.llm.set_transport(MockAnthropic({}).messages)
    token = _bootstrap_token(client)
    play_resp = client.post(
        f"/api/dev/scenarios/fixture/play?token={token}"
    ).json()
    session_id = play_resp["session_id"]
    creator_id = play_resp["role_label_to_id"]["creator"]
    creator_token = play_resp["role_tokens"][creator_id]

    rec = client.post(
        f"/api/dev/sessions/{session_id}/record?token={creator_token}",
        json={"name": "round-trip", "description": "from test", "tags": ["t"]},
    )
    assert rec.status_code == 200, rec.text
    body = rec.json()
    assert body["ok"]
    sj = body["scenario_json"]
    assert sj["meta"]["name"] == "round-trip"
    assert sj["creator_label"] == "CISO"
    labels = {r["label"] for r in sj["roster"]}
    assert "SOC" in labels


def test_record_requires_creator_token(client: TestClient) -> None:
    """A non-creator (or absent) token must not be able to dump session
    state via /record."""

    token = _bootstrap_token(client)
    play_resp = client.post(
        f"/api/dev/scenarios/fixture/play?token={token}"
    ).json()
    session_id = play_resp["session_id"]
    # Absent token → 401
    rec = client.post(
        f"/api/dev/sessions/{session_id}/record", json={"name": "nope"}
    )
    assert rec.status_code == 401
    # Wrong-session creator token → 403 (token / session mismatch)
    other_creator_token = _bootstrap_token(client)
    rec2 = client.post(
        f"/api/dev/sessions/{session_id}/record?token={other_creator_token}",
        json={"name": "nope"},
    )
    assert rec2.status_code == 403
