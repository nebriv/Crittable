"""Cost/abuse M3 — per-session setup-call budget.

``Session.setup_call_count`` increments once per setup-tier model call.
Once it reaches ``MAX_SETUP_CALLS_PER_SESSION`` ``run_setup_turn`` stops
calling the model entirely, and ``POST /setup/reply`` returns
``setup_budget_exhausted: true``. This stops a creator token from
hammering ``/setup/reply`` to burn the setup tier's large output budget.

The initial setup turn fires synchronously inside ``POST /api/sessions``
(unless skipped), so creating a non-skipped session already burns one
setup call.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import reset_settings_cache
from app.main import create_app
from app.sessions.models import Session, SessionState
from app.sessions.turn_driver import TurnDriver
from tests.conftest import default_settings_body
from tests.mock_chat_client import (
    install_mock_chat_client,
    llm_result,
    text_block,
    tool_block,
)


def _setup_script(n: int) -> list[Any]:
    """``n`` setup-tier responses, each an ``ask_setup_question`` (a
    yielding setup tool, so ``run_setup_turn`` returns after one call)."""

    return [
        llm_result(
            text_block("Tell me more."),
            tool_block(
                "ask_setup_question",
                {"topic": "scope", "question": f"Q{i}?"},
            ),
            stop_reason="tool_use",
        )
        for i in range(n)
    ]


def _make_client(monkeypatch, *, budget: int) -> TestClient:
    monkeypatch.setenv("LLM_MODEL_SETUP", "mock-setup")
    monkeypatch.setenv("LLM_MODEL_PLAY", "mock-play")
    monkeypatch.setenv("LLM_MODEL_AAR", "mock-aar")
    monkeypatch.setenv("LLM_MODEL_GUARDRAIL", "mock-guardrail")
    monkeypatch.setenv("SESSION_SECRET", "x" * 32)
    monkeypatch.setenv("INPUT_GUARDRAIL_ENABLED", "false")
    monkeypatch.setenv("MAX_SETUP_CALLS_PER_SESSION", str(budget))
    reset_settings_cache()
    app = create_app()
    c = TestClient(app)
    c.__enter__()
    install_mock_chat_client(c, scripts={"setup": _setup_script(10)})
    return c


def _create_session(client: TestClient) -> dict[str, Any]:
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
    return {"sid": created["session_id"], "token": created["creator_token"]}


@pytest.mark.asyncio
async def test_setup_call_count_increments_per_setup_call(monkeypatch) -> None:
    """Each setup-tier model call bumps ``setup_call_count`` by exactly
    one. With a generous budget, create (1 call) + one ``/setup/reply``
    (1 call) leaves the count at 2. The sync TestClient calls complete
    fully before each await, so reading the manager afterwards is safe
    (same pattern as ``test_turn_driver`` interject test)."""

    client = _make_client(monkeypatch, budget=12)
    try:
        ses = _create_session(client)
        sid, token = ses["sid"], ses["token"]
        manager = client.app.state.manager
        mock = client.app.state.llm

        # The synchronous initial setup turn burned exactly one call.
        snap = client.get(f"/api/sessions/{sid}?token={token}").json()
        assert snap["state"] == "SETUP"
        s1 = await manager.get_session(sid)
        assert s1.setup_call_count == 1
        assert sum(1 for c in mock.calls if c["tier"] == "setup") == 1

        client.post(
            f"/api/sessions/{sid}/setup/reply?token={token}",
            json={"content": "We're a hospital network."},
        )
        s2 = await manager.get_session(sid)
        assert s2.setup_call_count == 2
        assert sum(1 for c in mock.calls if c["tier"] == "setup") == 2
    finally:
        client.__exit__(None, None, None)


@pytest.mark.asyncio
async def test_run_setup_turn_makes_no_call_once_budget_spent(monkeypatch) -> None:
    """Once ``setup_call_count`` reaches the budget, ``run_setup_turn``
    short-circuits and makes NO further setup-tier model call."""

    client = _make_client(monkeypatch, budget=1)
    try:
        ses = _create_session(client)
        sid = ses["sid"]
        manager = client.app.state.manager
        mock = client.app.state.llm

        # Budget is 1; the create-time setup turn already spent it.
        session = await manager.get_session(sid)
        assert session.setup_call_count == 1
        assert session.state == SessionState.SETUP

        calls_before = sum(1 for c in mock.calls if c["tier"] == "setup")
        await TurnDriver(manager=manager).run_setup_turn(session=session)
        calls_after = sum(1 for c in mock.calls if c["tier"] == "setup")

        assert calls_after == calls_before, "no setup call once budget spent"
        # Count is unchanged (not incremented past the budget).
        refreshed = await manager.get_session(sid)
        assert refreshed.setup_call_count == 1
    finally:
        client.__exit__(None, None, None)


def test_setup_reply_response_flags_budget_exhausted(monkeypatch) -> None:
    """``POST /setup/reply`` carries ``setup_budget_exhausted: true`` the
    moment the count reaches the budget, so the creator UI can prompt
    "finalize or skip". With budget=2: create burns 1, the first reply
    burns the 2nd → exhausted=true on that reply."""

    client = _make_client(monkeypatch, budget=2)
    try:
        ses = _create_session(client)
        sid, token = ses["sid"], ses["token"]

        body = client.post(
            f"/api/sessions/{sid}/setup/reply?token={token}",
            json={"content": "Hospital network, EU patients."},
        ).json()

        assert body["ok"] is True
        assert body["setup_budget_exhausted"] is True

        # A subsequent reply still reports exhausted and makes no new call.
        mock = client.app.state.llm
        calls_before = sum(1 for c in mock.calls if c["tier"] == "setup")
        body2 = client.post(
            f"/api/sessions/{sid}/setup/reply?token={token}",
            json={"content": "Anything else?"},
        ).json()
        calls_after = sum(1 for c in mock.calls if c["tier"] == "setup")
        assert body2["setup_budget_exhausted"] is True
        assert calls_after == calls_before
    finally:
        client.__exit__(None, None, None)


def test_setup_reply_not_exhausted_with_headroom(monkeypatch) -> None:
    """With ample budget the flag stays false on an early reply."""

    client = _make_client(monkeypatch, budget=12)
    try:
        ses = _create_session(client)
        sid, token = ses["sid"], ses["token"]
        body = client.post(
            f"/api/sessions/{sid}/setup/reply?token={token}",
            json={"content": "Manufacturing, OT-heavy."},
        ).json()
        assert body["setup_budget_exhausted"] is False
    finally:
        client.__exit__(None, None, None)
