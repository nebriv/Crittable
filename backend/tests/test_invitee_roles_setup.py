"""Cover the wizard's step-3 → setup-prompt path.

Two assertions, one per fix:

1. ``POST /api/sessions`` with an ``invitee_roles`` payload registers
   each role server-side BEFORE the setup turn fires. Previously the
   frontend looped ``api.addRole`` after session creation, which
   meant ``run_setup_turn`` (called synchronously inside the create
   handler) saw only the creator. The AI's first setup question then
   asked "who's seated at the table" even though the wizard had just
   answered.

2. ``build_setup_system_blocks`` renders a ``## Seated roster``
   block listing every seated role. Without this, the model has no
   signal that the roster is fixed and the team-composition intake
   loop fires again.

Both regressions are user-visible (one prompt) so the live suite
covers them too, but unit-level checks here catch a structural
break in the same commit instead of waiting for the live run.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.config import reset_settings_cache
from app.llm.prompts import build_setup_system_blocks
from app.main import create_app
from app.sessions.models import Role, Session, SessionState
from tests.conftest import default_settings_body
from tests.mock_anthropic import MockAnthropic


@pytest.fixture()
def client(monkeypatch) -> TestClient:
    monkeypatch.setenv("LLM_MODEL_SETUP", "mock-setup")
    monkeypatch.setenv("SESSION_SECRET", "x" * 32)
    reset_settings_cache()
    app = create_app()
    with TestClient(app) as c:
        # Wire a benign mock transport so the auto-fired setup turn
        # (when not patched) doesn't hit the real Anthropic API.
        c.app.state.llm.set_transport(MockAnthropic({}).messages)
        yield c


def test_invitee_roles_registered_before_setup_turn(client: TestClient) -> None:
    # Capture the session passed into ``run_setup_turn`` so we can
    # assert the roster was already populated when the AI's first
    # turn fired. The TurnDriver is constructed inside the handler;
    # we patch the bound method on the class.
    captured: dict[str, Any] = {}

    async def fake_run_setup_turn(self, *, session: Session) -> Session:  # type: ignore[no-untyped-def]
        # Snapshot the labels at the moment the setup turn would run.
        # Mutating later doesn't affect this list — it captures the
        # pre-turn state, which is what the AI prompt would see.
        captured["labels"] = [r.label for r in session.roles]
        return session

    with patch(
        "app.sessions.turn_driver.TurnDriver.run_setup_turn",
        new=fake_run_setup_turn,
    ):
        resp = client.post(
            "/api/sessions",
            json={
                "scenario_prompt": "Ransomware via vendor portal",
                "creator_label": "CISO",
                "creator_display_name": "Alex",
                "invitee_roles": [
                    {"label": "Incident Commander"},
                    {"label": "Cybersecurity Engineer"},
                    # Case-insensitive collision with creator → dropped.
                    {"label": "ciso"},
                    # Whitespace-only → dropped.
                    {"label": "   "},
                ],
                **default_settings_body(),
            },
        )
    assert resp.status_code == 200, resp.text
    # Creator + 2 distinct invitees (Incident Commander, Cybersecurity
    # Engineer) — the "ciso" duplicate and the blank entry are skipped
    # by the de-dup / strip pass. Order preserved: creator first, then
    # invitees in input order.
    assert captured["labels"] == [
        "CISO",
        "Incident Commander",
        "Cybersecurity Engineer",
    ]


def test_invitee_roles_omitted_field_defaults_empty(client: TestClient) -> None:
    # Backwards check: the field is optional. Absent ``invitee_roles``
    # MUST behave exactly like the pre-redesign call (creator only).
    captured: dict[str, Any] = {}

    async def fake_run_setup_turn(self, *, session: Session) -> Session:  # type: ignore[no-untyped-def]
        captured["labels"] = [r.label for r in session.roles]
        return session

    with patch(
        "app.sessions.turn_driver.TurnDriver.run_setup_turn",
        new=fake_run_setup_turn,
    ):
        resp = client.post(
            "/api/sessions",
            json={
                "scenario_prompt": "Phishing-led ransomware",
                "creator_label": "IR Lead",
                "creator_display_name": "Sam",
                **default_settings_body(),
            },
        )
    assert resp.status_code == 200, resp.text
    assert captured["labels"] == ["IR Lead"]


def test_setup_system_blocks_include_roster() -> None:
    session = Session(
        scenario_prompt="seed",
        creator_role_id="role_creator",
        roles=[
            Role(
                id="role_creator",
                label="CISO",
                display_name="Alex",
                kind="player",
                is_creator=True,
            ),
            Role(
                id="role_ic",
                label="Incident Commander",
                kind="player",
            ),
            Role(
                id="role_cse",
                label="Cybersecurity Engineer",
                display_name="Mira",
                kind="player",
            ),
        ],
    )
    session.state = SessionState.SETUP

    blocks = build_setup_system_blocks(session)
    text = blocks[0]["text"]

    # Roster section header + every label appear in the prompt so the
    # model has the names to use as ``expected_actors`` instead of
    # re-asking the creator. Labels are wrapped in ``<<<...>>>``
    # fences (prompt-injection sentinel) so the assertion includes
    # the fence to lock that hardening in.
    assert "## Seated roster" in text
    assert "<<<CISO>>>" in text
    assert "<<<Incident Commander>>>" in text
    assert "<<<Cybersecurity Engineer>>>" in text
    # Display name appears too — it shows up alongside the role label
    # so the model can address the player by name in dialogue.
    assert "<<<Mira>>>" in text
    # The new directive against re-asking the team-composition question
    # is in the setup-system block (which appears in the same text).
    assert "Do NOT re-ask which roles exist" in text


def test_setup_system_blocks_empty_roster_keeps_fallback() -> None:
    # Defensive: a session with only the creator (no invitees) still
    # gets the roster header — the model just sees one row. We don't
    # want to silently skip the header when only the creator is seated.
    session = Session(
        scenario_prompt="seed",
        creator_role_id="role_creator",
        roles=[
            Role(
                id="role_creator",
                label="CISO",
                kind="player",
                is_creator=True,
            ),
        ],
    )
    session.state = SessionState.SETUP

    text = build_setup_system_blocks(session)[0]["text"]
    assert "## Seated roster" in text
    assert "CISO" in text


def test_invitee_roles_max_length_cap(client: TestClient) -> None:
    # ``InviteeRoleSpec`` list is ``Field(max_length=32)``; 33 entries
    # should hit Pydantic's validation and 422 the request before any
    # role is registered. (The per-session cap kicks in below this
    # but is exercised by the test below.)
    body: dict[str, Any] = {
        "scenario_prompt": "seed",
        "creator_label": "CISO",
        "creator_display_name": "Alex",
        "invitee_roles": [{"label": f"Role_{i}"} for i in range(33)],
    }
    resp = client.post("/api/sessions", json=body)
    assert resp.status_code == 422, resp.text


def test_invitee_roles_partial_failure_surfaces_in_response(
    client: TestClient, monkeypatch
) -> None:
    # Patch ``manager.add_role`` to raise ``IllegalTransitionError``
    # for one specific label so we can verify the create call still
    # 200s, the OK invitees land in the response context, and the
    # failed one is echoed in ``failed_invitees`` with the
    # exception text.
    from app.sessions.manager import SessionManager
    from app.sessions.turn_engine import IllegalTransitionError

    real_add_role = SessionManager.add_role

    async def patched_add_role(self, *, session_id, label, **kw):  # type: ignore[no-untyped-def]
        if label == "Doomed Role":
            raise IllegalTransitionError("simulated cap hit")
        return await real_add_role(self, session_id=session_id, label=label, **kw)

    monkeypatch.setattr(SessionManager, "add_role", patched_add_role)

    async def fake_run_setup_turn(self, *, session: Session) -> Session:  # type: ignore[no-untyped-def]
        return session

    with patch(
        "app.sessions.turn_driver.TurnDriver.run_setup_turn",
        new=fake_run_setup_turn,
    ):
        resp = client.post(
            "/api/sessions",
            json={
                "scenario_prompt": "seed",
                "creator_label": "CISO",
                "creator_display_name": "Alex",
                "invitee_roles": [
                    {"label": "Incident Commander"},
                    {"label": "Doomed Role"},
                ],
                **default_settings_body(),
                **default_settings_body(),
            },
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    failed = body["failed_invitees"]
    assert len(failed) == 1
    assert failed[0]["label"] == "Doomed Role"
    assert "simulated cap hit" in failed[0]["reason"]


def test_invitee_role_label_strips_control_chars(client: TestClient) -> None:
    # A label containing newlines / ANSI escape bytes / DEL must be
    # sanitised before it lands in the roster (which feeds into the
    # AI's system prompt verbatim). The structlog log-line-split
    # vector is the immediate concern; the prompt-injection vector
    # is a secondary harden.
    captured: dict[str, Any] = {}

    async def fake_run_setup_turn(self, *, session: Session) -> Session:  # type: ignore[no-untyped-def]
        captured["labels"] = [r.label for r in session.roles]
        return session

    with patch(
        "app.sessions.turn_driver.TurnDriver.run_setup_turn",
        new=fake_run_setup_turn,
    ):
        resp = client.post(
            "/api/sessions",
            json={
                "scenario_prompt": "seed",
                "creator_label": "CISO",
                "creator_display_name": "Alex",
                "invitee_roles": [
                    # \n + DEL + C1 byte mix — should all strip out.
                    {"label": "Threat Intel\nFAKE: state\x7fchanged\x9b"},
                ],
                **default_settings_body(),
            },
        )
    assert resp.status_code == 200, resp.text
    # Every control byte stripped; surrounding whitespace .strip()'d.
    assert captured["labels"] == ["CISO", "Threat IntelFAKE: statechanged"]
