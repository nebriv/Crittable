"""Direct tests for the WS notepad event handler.

Coverage gap addressed: ``app/ws/routes.py::_handle_notepad_event`` was
~115 untested lines (the handler itself is at 64% file coverage). The
handler converts NotepadService exceptions into structured WS error
frames; a regression here turns into "the notepad silently no-ops"
which is exactly the class of bug PR #115 already shipped.

We drive the handler with an in-memory ``FakeWebSocket`` and a real
``SessionManager`` so the lock + audit + broadcast plumbing all run.
The real ``NotepadService`` is exercised — no mocks below the handler
boundary.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
from typing import Any

import pytest

from app.config import reset_settings_cache
from app.main import create_app
from app.sessions.models import SessionSettings
from app.sessions.notepad import (
    NotepadOversizedError,
    NotepadRateLimitedError,
)
from app.ws.routes import _handle_notepad_event


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_MODEL_PLAY", "mock-play")
    monkeypatch.setenv("ANTHROPIC_MODEL_SETUP", "mock-setup")
    monkeypatch.setenv("ANTHROPIC_MODEL_AAR", "mock-aar")
    monkeypatch.setenv("ANTHROPIC_MODEL_GUARDRAIL", "mock-guardrail")
    monkeypatch.setenv("SESSION_SECRET", "x" * 32)
    reset_settings_cache()


@dataclass
class _FakeWebSocket:
    """Captures send_json calls for assertions."""

    sent: list[dict[str, Any]] = field(default_factory=list)

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


@dataclass
class _BroadcastSpy:
    """Wraps ConnectionManager.broadcast so tests can assert what was relayed."""

    inner: Any
    calls: list[tuple[str, dict[str, Any], bool]] = field(default_factory=list)

    async def broadcast(
        self,
        session_id: str,
        event: dict[str, Any],
        *,
        record: bool = True,
    ) -> None:
        self.calls.append((session_id, event, record))
        await self.inner.broadcast(session_id, event, record=record)

    def __getattr__(self, name: str) -> Any:
        return getattr(self.inner, name)


@pytest.fixture
async def manager_with_session() -> Any:
    """Build a real SessionManager and seat one role."""

    app = create_app()
    # Lifespan hasn't run — manually populate the bits we need.
    async with app.router.lifespan_context(app):
        manager = app.state.manager
        # Wrap connection manager so we can spy on broadcasts.
        spy = _BroadcastSpy(inner=manager.connections())
        manager._connections = spy  # type: ignore[attr-defined]

        session, _ = await manager.create_session(
            scenario_prompt="Ransomware",
            creator_label="CISO",
            creator_display_name="Alex",
            settings=SessionSettings(),
        )
        sid = session.id
        creator_id = session.roles[0].id
        creator_role = session.roles[0]
        # Add a second role.
        soc_role, _ = await manager.add_role(
            session_id=sid,
            label="SOC",
            display_name="Bo",
            acting_role_id=creator_id,
            acting_token_version=creator_role.token_version,
        )
        soc_id = soc_role.id
        yield {
            "manager": manager,
            "spy": spy,
            "session_id": sid,
            "creator_id": creator_id,
            "soc_id": soc_id,
        }


# ---------------------------------------------------------------- awareness


@pytest.mark.asyncio
async def test_notepad_awareness_relays_to_broadcast(
    manager_with_session: dict[str, Any],
) -> None:
    ws = _FakeWebSocket()
    aware_b64 = base64.b64encode(b"caret-frame").decode()
    await _handle_notepad_event(
        websocket=ws,
        manager=manager_with_session["manager"],
        session_id=manager_with_session["session_id"],
        role_id=manager_with_session["soc_id"],
        event_type="notepad_awareness",
        payload={"awareness": aware_b64},
    )
    # No errors back to client.
    assert ws.sent == []
    spy = manager_with_session["spy"]
    relays = [c for c in spy.calls if c[1].get("type") == "notepad_awareness"]
    assert len(relays) == 1
    sid, event, record = relays[0]
    assert sid == manager_with_session["session_id"]
    assert event["awareness"] == aware_b64
    assert event["origin_role_id"] == manager_with_session["soc_id"]
    assert record is False  # awareness frames are never replayed


@pytest.mark.asyncio
async def test_notepad_awareness_rejects_missing_field(
    manager_with_session: dict[str, Any],
) -> None:
    ws = _FakeWebSocket()
    await _handle_notepad_event(
        websocket=ws,
        manager=manager_with_session["manager"],
        session_id=manager_with_session["session_id"],
        role_id=manager_with_session["soc_id"],
        event_type="notepad_awareness",
        payload={},  # no awareness key
    )
    assert len(ws.sent) == 1
    assert ws.sent[0]["type"] == "error"
    assert ws.sent[0]["scope"] == "notepad"
    assert "missing awareness" in ws.sent[0]["message"]


@pytest.mark.asyncio
async def test_notepad_awareness_rejects_oversized_frame(
    manager_with_session: dict[str, Any],
) -> None:
    ws = _FakeWebSocket()
    big = "A" * (16 * 1024 + 1)
    await _handle_notepad_event(
        websocket=ws,
        manager=manager_with_session["manager"],
        session_id=manager_with_session["session_id"],
        role_id=manager_with_session["soc_id"],
        event_type="notepad_awareness",
        payload={"awareness": big},
    )
    assert ws.sent[0]["type"] == "error"
    assert "too large" in ws.sent[0]["message"]


# ---------------------------------------------------------------- sync


@pytest.mark.asyncio
async def test_notepad_sync_request_returns_state(
    manager_with_session: dict[str, Any],
) -> None:
    ws = _FakeWebSocket()
    await _handle_notepad_event(
        websocket=ws,
        manager=manager_with_session["manager"],
        session_id=manager_with_session["session_id"],
        role_id=manager_with_session["soc_id"],
        event_type="notepad_sync_request",
        payload={},
    )
    assert len(ws.sent) == 1
    msg = ws.sent[0]
    assert msg["type"] == "notepad_sync_response"
    # Empty Doc still returns a valid base64 update (Yjs encodes the
    # empty state as ~2 bytes, never an empty string).
    decoded = base64.b64decode(msg["state"])
    assert isinstance(decoded, bytes)
    assert msg["locked"] is False
    assert msg["template_id"] is None or isinstance(msg["template_id"], str)


# ---------------------------------------------------------------- update happy path


@pytest.mark.asyncio
async def test_notepad_update_applies_and_broadcasts(
    manager_with_session: dict[str, Any],
) -> None:
    """A normal update should land on the canonical Doc, increment
    ``edit_count``, and rebroadcast with ``record=False``."""

    from pycrdt import Doc, Text

    # Build a real Yjs update on a side Doc.
    side = Doc()
    text = side.get("text", type=Text)
    text += "hello world"
    update_bytes = side.get_update()
    update_b64 = base64.b64encode(update_bytes).decode()

    ws = _FakeWebSocket()
    await _handle_notepad_event(
        websocket=ws,
        manager=manager_with_session["manager"],
        session_id=manager_with_session["session_id"],
        role_id=manager_with_session["soc_id"],
        event_type="notepad_update",
        payload={"update": update_b64},
    )
    # No error to client.
    assert ws.sent == []
    # Session state mutated.
    sess = await manager_with_session["manager"].get_session(
        manager_with_session["session_id"]
    )
    assert sess.notepad.edit_count >= 1
    assert manager_with_session["soc_id"] in sess.notepad.contributor_role_ids
    # Broadcast fired with record=False.
    relays = [c for c in manager_with_session["spy"].calls if c[1].get("type") == "notepad_update"]
    assert len(relays) == 1
    assert relays[0][2] is False


# ---------------------------------------------------------------- update error paths


@pytest.mark.asyncio
async def test_notepad_update_rejects_missing_payload(
    manager_with_session: dict[str, Any],
) -> None:
    ws = _FakeWebSocket()
    await _handle_notepad_event(
        websocket=ws,
        manager=manager_with_session["manager"],
        session_id=manager_with_session["session_id"],
        role_id=manager_with_session["soc_id"],
        event_type="notepad_update",
        payload={},
    )
    assert ws.sent[0]["type"] == "error"
    assert "missing update" in ws.sent[0]["message"]


@pytest.mark.asyncio
async def test_notepad_update_rejects_invalid_base64(
    manager_with_session: dict[str, Any],
) -> None:
    ws = _FakeWebSocket()
    await _handle_notepad_event(
        websocket=ws,
        manager=manager_with_session["manager"],
        session_id=manager_with_session["session_id"],
        role_id=manager_with_session["soc_id"],
        event_type="notepad_update",
        payload={"update": "@@@not-base64@@@"},
    )
    assert ws.sent[0]["type"] == "error"
    assert "invalid base64" in ws.sent[0]["message"]


@pytest.mark.asyncio
async def test_notepad_update_rejects_locked_notepad(
    manager_with_session: dict[str, Any],
) -> None:
    """Once the notepad is locked (session ended), updates from any role
    should produce a structured error rather than crashing."""

    manager = manager_with_session["manager"]
    sid = manager_with_session["session_id"]

    # Lock by hand — the production path locks on session-end.
    async with await manager.with_lock(sid):
        sess = await manager.get_session(sid)
        manager.notepad().lock(sess)

    ws = _FakeWebSocket()
    update_b64 = base64.b64encode(b"\x00\x00").decode()  # well-formed b64, garbage Yjs
    await _handle_notepad_event(
        websocket=ws,
        manager=manager,
        session_id=sid,
        role_id=manager_with_session["soc_id"],
        event_type="notepad_update",
        payload={"update": update_b64},
    )
    assert ws.sent[0]["type"] == "error"
    assert "locked" in ws.sent[0]["message"]


@pytest.mark.asyncio
async def test_notepad_update_rejects_non_roster_role(
    manager_with_session: dict[str, Any],
) -> None:
    ws = _FakeWebSocket()
    update_b64 = base64.b64encode(b"\x00").decode()
    await _handle_notepad_event(
        websocket=ws,
        manager=manager_with_session["manager"],
        session_id=manager_with_session["session_id"],
        role_id="role-not-seated",
        event_type="notepad_update",
        payload={"update": update_b64},
    )
    assert ws.sent[0]["type"] == "error"
    assert "roster" in ws.sent[0]["message"]


@pytest.mark.asyncio
async def test_notepad_update_rejects_oversized_payload(
    manager_with_session: dict[str, Any],
) -> None:
    """Anything beyond the 64KB cap should produce an oversized error."""

    huge = b"\x00" * (64 * 1024 + 1)
    update_b64 = base64.b64encode(huge).decode()

    ws = _FakeWebSocket()
    await _handle_notepad_event(
        websocket=ws,
        manager=manager_with_session["manager"],
        session_id=manager_with_session["session_id"],
        role_id=manager_with_session["soc_id"],
        event_type="notepad_update",
        payload={"update": update_b64},
    )
    assert ws.sent[0]["type"] == "error"
    assert "too large" in ws.sent[0]["message"]


@pytest.mark.asyncio
async def test_notepad_update_rejects_when_rate_limited(
    manager_with_session: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Force the underlying NotepadService to raise RateLimited and
    confirm the handler converts it to a structured error."""

    manager = manager_with_session["manager"]
    real_apply = manager.notepad().apply_update

    def boom(*args: Any, **kwargs: Any) -> None:
        raise NotepadRateLimitedError("flooded")

    monkeypatch.setattr(manager.notepad(), "apply_update", boom)

    ws = _FakeWebSocket()
    update_b64 = base64.b64encode(b"\x00").decode()
    await _handle_notepad_event(
        websocket=ws,
        manager=manager,
        session_id=manager_with_session["session_id"],
        role_id=manager_with_session["soc_id"],
        event_type="notepad_update",
        payload={"update": update_b64},
    )
    assert ws.sent[0]["type"] == "error"
    assert "rate limited" in ws.sent[0]["message"]
    # restore for fixture teardown safety
    monkeypatch.setattr(manager.notepad(), "apply_update", real_apply)


@pytest.mark.asyncio
async def test_notepad_update_oversized_via_service_error(
    manager_with_session: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Defense-in-depth: the handler also catches NotepadOversizedError
    from the service (in case the cap is checked there before our
    handler-level cap)."""

    manager = manager_with_session["manager"]

    def boom(*args: Any, **kwargs: Any) -> None:
        raise NotepadOversizedError("cap")

    monkeypatch.setattr(manager.notepad(), "apply_update", boom)

    ws = _FakeWebSocket()
    update_b64 = base64.b64encode(b"\x00").decode()
    await _handle_notepad_event(
        websocket=ws,
        manager=manager,
        session_id=manager_with_session["session_id"],
        role_id=manager_with_session["soc_id"],
        event_type="notepad_update",
        payload={"update": update_b64},
    )
    assert ws.sent[0]["type"] == "error"
    assert "too large" in ws.sent[0]["message"]
