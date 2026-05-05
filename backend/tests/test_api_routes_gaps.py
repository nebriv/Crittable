"""Targeted tests for the routes whose error / no-op branches are not
exercised by the e2e suite.

Coverage gap addressed: ``app/api/routes.py`` was at 78% — most of the
missing 128 lines live in the error-conversion shells around manager
calls (admin endpoints, notepad pin/snapshot, AAR poll lifecycle,
display-name self-rename). These are the exact branches a 500 in
production lands on; covering them here is "fight the next outage in
test, not in the post-mortem".

These tests run against the in-process FastAPI app with a benign
default mock so no LLM call escapes to the network.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import reset_settings_cache
from app.main import create_app
from app.sessions.models import SessionState
from tests.mock_anthropic import MockAnthropic


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_MODEL_PLAY", "mock-play")
    monkeypatch.setenv("ANTHROPIC_MODEL_SETUP", "mock-setup")
    monkeypatch.setenv("ANTHROPIC_MODEL_AAR", "mock-aar")
    monkeypatch.setenv("ANTHROPIC_MODEL_GUARDRAIL", "mock-guardrail")
    monkeypatch.setenv("TEST_MODE", "true")
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


def _seat(client: TestClient) -> dict[str, str]:
    """Create a session and add one player; return ids + tokens."""

    r = client.post(
        "/api/sessions",
        json={
            "scenario_prompt": "Ransomware",
            "creator_label": "CISO",
            "creator_display_name": "Alex",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    sid = body["session_id"]
    ctok = body["creator_token"]
    cid = body["creator_role_id"]
    r2 = client.post(
        f"/api/sessions/{sid}/roles?token={ctok}",
        json={"label": "SOC", "display_name": "Bo"},
    )
    assert r2.status_code == 200, r2.text
    other = r2.json()
    return {
        "sid": sid,
        "ctok": ctok,
        "cid": cid,
        "ptok": other["token"],
        "pid": other["role_id"],
    }


# ---------------------------------------------------------------- admin/retry-aar


def test_retry_aar_rejects_non_ended_session(client: TestClient) -> None:
    """Session not yet ENDED — the operator can't retry an AAR that
    never started. 409 is the contract."""

    seats = _seat(client)
    r = client.post(
        f"/api/sessions/{seats['sid']}/admin/retry-aar?token={seats['ctok']}"
    )
    assert r.status_code == 409
    assert "not ENDED" in r.text


def test_retry_aar_rejects_non_creator(client: TestClient) -> None:
    """Player tokens cannot retry the AAR — creator-only operation."""

    seats = _seat(client)
    r = client.post(
        f"/api/sessions/{seats['sid']}/admin/retry-aar?token={seats['ptok']}"
    )
    assert r.status_code == 403


def test_retry_aar_rejects_unknown_session(client: TestClient) -> None:
    seats = _seat(client)
    # Forge a token bound to a session id that doesn't exist.
    r = client.post(
        f"/api/sessions/does-not-exist/admin/retry-aar?token={seats['ctok']}"
    )
    # The token-binding step rejects mismatched session_id with 403
    # (token is bound to a different session). That's the existing
    # behaviour we lock in here.
    assert r.status_code in (403, 404)


def test_retry_aar_noops_when_already_pending(client: TestClient) -> None:
    """If the AAR is currently pending or generating, retry must be
    a noop — kicking another background task would race the existing one."""

    seats = _seat(client)
    sid = seats["sid"]
    manager = client.app.state.manager

    import asyncio

    async def _force_ended_pending() -> None:
        async with await manager._lock_for(sid):
            sess = await manager._repo.get(sid)
            sess.state = SessionState.ENDED
            sess.aar_status = "pending"
            await manager._repo.save(sess)

    asyncio.run(_force_ended_pending())
    r = client.post(
        f"/api/sessions/{sid}/admin/retry-aar?token={seats['ctok']}"
    )
    assert r.status_code == 200
    body = r.json()
    assert body["noop"] is True
    assert body["status"] == "pending"


# ---------------------------------------------------------------- admin/abort-turn


def test_abort_turn_rejected_for_non_creator(client: TestClient) -> None:
    seats = _seat(client)
    r = client.post(
        f"/api/sessions/{seats['sid']}/admin/abort-turn?token={seats['ptok']}"
    )
    assert r.status_code == 403


def test_abort_turn_409_when_no_active_turn(client: TestClient) -> None:
    """Session is in SETUP — there's no current turn to abort, so the
    manager raises IllegalTransitionError → 409."""

    seats = _seat(client)
    r = client.post(
        f"/api/sessions/{seats['sid']}/admin/abort-turn?token={seats['ctok']}"
    )
    assert r.status_code == 409


# ---------------------------------------------------------------- export.md (AAR poll)


def test_export_md_returns_425_when_session_not_ended(client: TestClient) -> None:
    """The polling client expects 425 with Retry-After when the session
    is still in flight — this is the contract the AAR-poll loop keys off."""

    seats = _seat(client)
    r = client.get(
        f"/api/sessions/{seats['sid']}/export.md?token={seats['ctok']}"
    )
    assert r.status_code == 425


def test_export_md_returns_500_when_aar_failed(client: TestClient) -> None:
    """Force aar_status=failed and confirm the polling client gets a
    500 with the X-AAR-Status header so it can stop retrying."""

    seats = _seat(client)
    sid = seats["sid"]
    manager = client.app.state.manager

    import asyncio

    async def _force_ended_failed() -> None:
        async with await manager._lock_for(sid):
            sess = await manager._repo.get(sid)
            sess.state = SessionState.ENDED
            sess.aar_status = "failed"
            sess.aar_error = "anthropic timeout"
            sess.aar_markdown = None
            await manager._repo.save(sess)

    asyncio.run(_force_ended_failed())
    r = client.get(f"/api/sessions/{sid}/export.md?token={seats['ctok']}")
    assert r.status_code == 500
    assert r.headers.get("X-AAR-Status") == "failed"
    assert "anthropic timeout" in r.text


def test_export_md_returns_410_for_evicted_session(client: TestClient) -> None:
    """Once the GC reaper has tombstoned a session_id, the polling
    client should get a definitive 410 Gone instead of 404."""

    seats = _seat(client)
    sid = seats["sid"]
    gc = client.app.state.session_gc
    # Force-tombstone the session id by reaching into the GC's bounded
    # tombstone list. The is_evicted() boundary reads off this set.
    gc._tombstones.append(sid)
    gc._tombstone_set.add(sid)

    r = client.get(f"/api/sessions/{sid}/export.md?token={seats['ctok']}")
    assert r.status_code == 410
    assert r.headers.get("X-AAR-Status") == "evicted"


# ---------------------------------------------------------------- notepad pin


def test_notepad_pin_rejects_empty_after_sanitization(client: TestClient) -> None:
    """``sanitize_pin_text`` strips markup; if the snippet was nothing
    but markup, the route 400s rather than pinning an empty string."""

    seats = _seat(client)
    r = client.post(
        f"/api/sessions/{seats['sid']}/notepad/pin?token={seats['ctok']}",
        json={"text": "[click me](http://evil.com)", "action": "pin"},
    )
    # The link text "click me" survives — that's not empty.
    assert r.status_code == 204

    # Now a snippet that's pure markup → empty after strip.
    r2 = client.post(
        f"/api/sessions/{seats['sid']}/notepad/pin?token={seats['ctok']}",
        json={"text": "<div></div>```\n```", "action": "pin"},
    )
    assert r2.status_code == 400
    assert "empty after sanitization" in r2.text


def test_notepad_pin_idempotent_on_source_message_id(client: TestClient) -> None:
    """Double-clicking the highlight popover hits the route twice with
    the same (action, source_message_id); second call must noop with 204."""

    seats = _seat(client)
    sid = seats["sid"]
    payload = {"text": "important", "source_message_id": "msg-99", "action": "pin"}
    r1 = client.post(
        f"/api/sessions/{sid}/notepad/pin?token={seats['ctok']}",
        json=payload,
    )
    assert r1.status_code == 204
    r2 = client.post(
        f"/api/sessions/{sid}/notepad/pin?token={seats['ctok']}",
        json=payload,
    )
    assert r2.status_code == 204


def test_notepad_pin_403_for_non_seated_token(client: TestClient) -> None:
    """An invalid / unseated token can't pin."""

    seats = _seat(client)
    r = client.post(
        f"/api/sessions/{seats['sid']}/notepad/pin?token=garbage-token",
        json={"text": "x", "action": "pin"},
    )
    assert r.status_code in (401, 403)


# ---------------------------------------------------------------- notepad snapshot


def test_notepad_snapshot_rejects_oversized_markdown(client: TestClient) -> None:
    """Force the 1MB cap path — the route should 413 rather than 500."""

    seats = _seat(client)
    huge = "x" * (1024 * 1024 + 1)
    r = client.post(
        f"/api/sessions/{seats['sid']}/notepad/snapshot?token={seats['ctok']}",
        json={"markdown": huge},
    )
    # FastAPI request body cap may pre-empt with 422 — accept either
    # the route's 413 or the framework's 422 / 413.
    assert r.status_code in (413, 422)


def test_notepad_snapshot_403_for_unseated_token(client: TestClient) -> None:
    seats = _seat(client)
    r = client.post(
        f"/api/sessions/{seats['sid']}/notepad/snapshot?token=garbage",
        json={"markdown": "hi"},
    )
    assert r.status_code in (401, 403)


# ---------------------------------------------------------------- self-rename display name


def test_set_self_display_name_works(client: TestClient) -> None:
    seats = _seat(client)
    r = client.post(
        f"/api/sessions/{seats['sid']}/roles/me/display_name?token={seats['ctok']}",
        json={"display_name": "Alex Renamed"},
    )
    assert r.status_code == 200
    assert r.json()["display_name"] == "Alex Renamed"


def test_set_self_display_name_validates_length(client: TestClient) -> None:
    """Pydantic body validation rejects an oversized display_name with
    422 — we lock that contract in so a future router change doesn't
    silently accept arbitrary-length names."""

    seats = _seat(client)
    over_cap = "A" * 200  # The body validator caps at 64.
    r = client.post(
        f"/api/sessions/{seats['sid']}/roles/me/display_name?token={seats['ctok']}",
        json={"display_name": over_cap},
    )
    assert r.status_code == 422


def test_set_self_display_name_unauthorized_with_garbage_token(
    client: TestClient,
) -> None:
    seats = _seat(client)
    r = client.post(
        f"/api/sessions/{seats['sid']}/roles/me/display_name?token=garbage",
        json={"display_name": "x"},
    )
    assert r.status_code in (401, 403)


# ---------------------------------------------------------------- force-advance error path


def test_force_advance_409_during_setup(client: TestClient) -> None:
    """Force-advance during SETUP must 409 — there's no AI turn to advance."""

    seats = _seat(client)
    r = client.post(
        f"/api/sessions/{seats['sid']}/force-advance?token={seats['ctok']}"
    )
    assert r.status_code == 409


def test_force_advance_403_for_unseated_token(client: TestClient) -> None:
    seats = _seat(client)
    r = client.post(
        f"/api/sessions/{seats['sid']}/force-advance?token=garbage"
    )
    assert r.status_code in (401, 403)


# ---------------------------------------------------------------- end_session error paths


def test_end_session_rejects_non_creator(client: TestClient) -> None:
    seats = _seat(client)
    r = client.post(
        f"/api/sessions/{seats['sid']}/end?token={seats['ptok']}",
        json={"reason": "x"},
    )
    # Only the creator may end. Manager raises IllegalTransitionError → 409.
    assert r.status_code in (403, 409)


# ---------------------------------------------------------------- proxy routes


def test_proxy_submit_pending_403_for_non_creator(client: TestClient) -> None:
    seats = _seat(client)
    r = client.post(
        f"/api/sessions/{seats['sid']}/admin/proxy-submit-pending?token={seats['ptok']}",
        json={"content": "stand-in"},
    )
    assert r.status_code == 403


def test_proxy_submit_pending_409_when_no_open_turn(client: TestClient) -> None:
    """Session is in SETUP — there are no pending player slots to fill."""

    seats = _seat(client)
    r = client.post(
        f"/api/sessions/{seats['sid']}/admin/proxy-submit-pending?token={seats['ctok']}",
        json={"content": "stand-in"},
    )
    assert r.status_code == 409
