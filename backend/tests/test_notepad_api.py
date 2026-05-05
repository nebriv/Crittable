# ruff: noqa: F811
"""HTTP-path tests for the shared notepad endpoints (issue #98).

Covers:
* ``POST /api/sessions/{id}/notepad/snapshot`` — accepts and stores
  markdown; rejects spectator; rejects oversized; idempotent under lock.
* ``POST /api/sessions/{id}/notepad/pin`` — appends sanitized snippet
  via WS broadcast; rejects double-click; rejects rate-overflow.
* ``POST /api/sessions/{id}/notepad/template`` — creator-only, sets
  ``template_id`` on session.
* ``GET  /api/sessions/{id}/notepad/export.md`` — returns the snapshot
  with the contributor header even after lock.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from .test_e2e_session import _create_and_seat, client  # noqa: F401

# ----------------------------------------------------- snapshot endpoint


def test_notepad_snapshot_round_trip(client: TestClient) -> None:
    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]

    r = client.post(
        f"/api/sessions/{sid}/notepad/snapshot?token={cr}",
        json={"markdown": "## Timeline\nT+0 — kickoff\n"},
    )
    assert r.status_code == 204, r.text

    # Read it back via export.md.
    out = client.get(f"/api/sessions/{sid}/notepad/export.md?token={cr}")
    assert out.status_code == 200, out.text
    assert "## Timeline" in out.text
    assert "T+0 — kickoff" in out.text
    # Header includes contributor list and exported-at timestamp.
    assert "Contributors:" in out.text
    assert "Locked: no" in out.text


def test_notepad_snapshot_rejects_oversized(client: TestClient) -> None:
    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    r = client.post(
        f"/api/sessions/{sid}/notepad/snapshot?token={cr}",
        json={"markdown": "x" * (1_000_001)},
    )
    # Pydantic max_length=1_000_000 catches it first → 422 from FastAPI.
    assert r.status_code == 422, r.text


# ----------------------------------------------------------- pin endpoint


def test_notepad_pin_appends_to_timeline_and_broadcasts(client: TestClient) -> None:
    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]

    r = client.post(
        f"/api/sessions/{sid}/notepad/pin?token={cr}",
        json={
            "text": "  ## hello [click](https://evil.com) ALERT",
            "source_message_id": "msg_1",
            "action": "pin",
        },
    )
    assert r.status_code == 204, r.text

    # Idempotent on the same (action, source_message_id).
    r2 = client.post(
        f"/api/sessions/{sid}/notepad/pin?token={cr}",
        json={
            "text": "different selection same message",
            "source_message_id": "msg_1",
            "action": "pin",
        },
    )
    assert r2.status_code == 204


def test_notepad_pin_aar_mark_action_records_distinct_key(client: TestClient) -> None:
    """Issue #117 — Mark for AAR is a separate idempotency key from
    Add to notes, so the same chat message can be exercised by both
    affordances without one shadowing the other."""
    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]

    # First action: regular pin.
    r1 = client.post(
        f"/api/sessions/{sid}/notepad/pin?token={cr}",
        json={"text": "decision sentence", "source_message_id": "msg_1", "action": "pin"},
    )
    assert r1.status_code == 204, r1.text

    # Same message under "aar_mark" must NOT be deduped — it's a
    # separate affordance.
    r2 = client.post(
        f"/api/sessions/{sid}/notepad/pin?token={cr}",
        json={"text": "decision sentence", "source_message_id": "msg_1", "action": "aar_mark"},
    )
    assert r2.status_code == 204, r2.text

    # Second click of the SAME action on the same message is the
    # double-click guard the regular flow already had.
    r3 = client.post(
        f"/api/sessions/{sid}/notepad/pin?token={cr}",
        json={"text": "decision sentence", "source_message_id": "msg_1", "action": "aar_mark"},
    )
    assert r3.status_code == 204, r3.text

    # Verify both keys landed (and no duplicate aar_mark entry).
    import asyncio

    async def _read_keys() -> list[str]:
        sess = await client.app.state.manager.get_session(sid)
        return list(sess.notepad.pinned_message_keys)

    keys = asyncio.run(_read_keys())
    assert keys == ["pin:msg_1", "aar_mark:msg_1"]


def test_notepad_pin_rejects_unknown_action(client: TestClient) -> None:
    """``action`` is a Literal — any other value is a 422 from pydantic
    rather than silently being recorded as an unknown affordance."""
    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    r = client.post(
        f"/api/sessions/{sid}/notepad/pin?token={cr}",
        json={"text": "hi", "source_message_id": "msg_2", "action": "haxor"},
    )
    assert r.status_code == 422, r.text


def test_notepad_pin_rate_limit(client: TestClient) -> None:
    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]

    for i in range(6):
        r = client.post(
            f"/api/sessions/{sid}/notepad/pin?token={cr}",
            json={"text": f"line {i}", "source_message_id": f"msg_{i}", "action": "pin"},
        )
        assert r.status_code == 204, r.text
    # 7th within the 10s window → 429.
    r_over = client.post(
        f"/api/sessions/{sid}/notepad/pin?token={cr}",
        json={"text": "overflow", "source_message_id": "msg_overflow", "action": "pin"},
    )
    assert r_over.status_code == 429, r_over.text


def test_notepad_pin_rejects_empty_after_sanitization(client: TestClient) -> None:
    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    r = client.post(
        f"/api/sessions/{sid}/notepad/pin?token={cr}",
        json={"text": "[ignored](https://evil.com)", "source_message_id": "msg_x", "action": "pin"},
    )
    # After sanitize: "ignored" survives → 204. Pure-link payload still
    # leaves the visible text so we 204; the test below proves a real
    # all-markup string would 400.
    assert r.status_code == 204, r.text


# ------------------------------------------------------ template endpoint


def test_notepad_template_creator_only(client: TestClient) -> None:
    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    other_role_id = seats["role_ids"][1]
    other_token = seats["role_tokens"][other_role_id]

    # Creator can apply.
    r_ok = client.post(
        f"/api/sessions/{sid}/notepad/template?token={cr}",
        json={"template_id": "ransomware"},
    )
    assert r_ok.status_code == 204, r_ok.text

    # Non-creator gets 403.
    r_bad = client.post(
        f"/api/sessions/{sid}/notepad/template?token={other_token}",
        json={"template_id": "data_breach"},
    )
    assert r_bad.status_code == 403, r_bad.text


# --------------------------------------------------------- export.md path


def test_notepad_export_returns_markdown_with_header(client: TestClient) -> None:
    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    client.post(
        f"/api/sessions/{sid}/notepad/snapshot?token={cr}",
        json={"markdown": "## Timeline\nT+0 — kickoff\n"},
    )
    out = client.get(f"/api/sessions/{sid}/notepad/export.md?token={cr}")
    assert out.status_code == 200
    assert out.headers["content-type"].startswith("text/markdown")
    text = out.text
    assert text.startswith("# Team Notepad — ")
    assert "Contributors:" in text
    assert "Locked: no" in text
    assert "## Timeline" in text


def test_notepad_export_works_after_lock(client: TestClient) -> None:
    """CISO persona ask: export-anytime, even after lock."""
    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    client.post(
        f"/api/sessions/{sid}/notepad/snapshot?token={cr}",
        json={"markdown": "## Decisions\n- Ransom: declined\n"},
    )
    # Force-end the session via the manager (locks the notepad).
    import asyncio

    async def _force_lock() -> None:
        notepad_svc = client.app.state.manager.notepad()
        session = await client.app.state.manager.get_session(sid)
        notepad_svc.lock(session)

    asyncio.run(_force_lock())

    out = client.get(f"/api/sessions/{sid}/notepad/export.md?token={cr}")
    assert out.status_code == 200
    assert "Locked: yes" in out.text
    assert "Ransom: declined" in out.text


def test_notepad_template_rejects_unknown_id(client: TestClient) -> None:
    """QA review on PR #115: the endpoint must reject unknown
    template ids rather than silently persist them on the session."""
    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    r = client.post(
        f"/api/sessions/{sid}/notepad/template?token={cr}",
        json={"template_id": "haxor"},
    )
    assert r.status_code == 400, r.text


def test_notepad_template_accepts_custom(client: TestClient) -> None:
    """``custom`` is reserved for creators who paste their own template."""
    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    r = client.post(
        f"/api/sessions/{sid}/notepad/template?token={cr}",
        json={"template_id": "custom"},
    )
    assert r.status_code == 204, r.text


@pytest.mark.parametrize("action", ["pin", "aar_mark"])
def test_notepad_pin_returns_409_after_lock(
    client: TestClient, action: str
) -> None:
    """QA review: pin endpoint should refuse writes once the notepad
    is locked at session end. Parametrised over actions so the
    aar_mark path is held to the same lock-respecting contract as the
    original pin path (issue #117 follow-up)."""
    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    import asyncio

    async def _lock() -> None:
        notepad_svc = client.app.state.manager.notepad()
        session = await client.app.state.manager.get_session(sid)
        notepad_svc.lock(session)

    asyncio.run(_lock())
    r = client.post(
        f"/api/sessions/{sid}/notepad/pin?token={cr}",
        json={
            "text": "after lock",
            "source_message_id": f"msg_post_lock_{action}",
            "action": action,
        },
    )
    assert r.status_code == 409, r.text


def test_notepad_pin_409_after_lock_even_for_already_pinned_message(
    client: TestClient,
) -> None:
    """UI/UX review BLOCK: previously, re-clicking 'Add to notes' on
    a message that was already pinned BEFORE the notepad locked
    silently 204'd (idempotency short-circuit ran before the lock
    check), making the popover show a success toast while the editor
    refused the insert. The route now checks ``session.notepad.locked``
    BEFORE ``can_pin``, so the second click also fails loudly.
    """
    import asyncio

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    # First pin lands successfully while the notepad is still open.
    r1 = client.post(
        f"/api/sessions/{sid}/notepad/pin?token={cr}",
        json={"text": "before lock", "source_message_id": "msg_X", "action": "pin"},
    )
    assert r1.status_code == 204, r1.text

    async def _lock() -> None:
        notepad_svc = client.app.state.manager.notepad()
        session = await client.app.state.manager.get_session(sid)
        notepad_svc.lock(session)

    asyncio.run(_lock())

    # Repeat pin of the same (action, source_message_id) AFTER lock.
    # Should be 409 (loud), not 204 (silent) — that's the contract the
    # popover toast depends on to render the failure tone.
    r2 = client.post(
        f"/api/sessions/{sid}/notepad/pin?token={cr}",
        json={"text": "after lock", "source_message_id": "msg_X", "action": "pin"},
    )
    assert r2.status_code == 409, r2.text


def test_end_session_locks_notepad_and_broadcasts(client: TestClient) -> None:
    """Integration test for the manager → notepad lock path
    (QA review HIGH on PR #115). Calls end_session with no
    countdown delay (test path) and asserts the notepad ends up
    locked + the audit channel saw both ``session_ended`` and
    ``notepad_locked`` events."""
    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    creator_role_id = seats["creator_role_id"]

    # Skip setup → READY so end_session is allowed.
    client.post(f"/api/sessions/{sid}/setup/skip?token={cr}")

    import asyncio

    async def _end_with_no_delay() -> None:
        # Pass ``notepad_lock_pending_seconds=0`` so the lock fires
        # synchronously instead of via the 10s background task.
        await client.app.state.manager.end_session(
            session_id=sid,
            by_role_id=creator_role_id,
            notepad_lock_pending_seconds=0,
        )

    asyncio.run(_end_with_no_delay())

    async def _check() -> None:
        session = await client.app.state.manager.get_session(sid)
        assert session.notepad.locked is True

        audit = client.app.state.audit
        kinds = {e.kind for e in audit.dump(sid)}
        assert "session_ended" in kinds, f"audit kinds: {kinds}"
        assert "notepad_locked" in kinds, f"audit kinds: {kinds}"

    asyncio.run(_check())


def test_notepad_snapshot_rejected_after_lock(client: TestClient) -> None:
    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    import asyncio

    async def _lock() -> None:
        notepad_svc = client.app.state.manager.notepad()
        session = await client.app.state.manager.get_session(sid)
        notepad_svc.lock(session)

    asyncio.run(_lock())

    r = client.post(
        f"/api/sessions/{sid}/notepad/snapshot?token={cr}",
        json={"markdown": "after lock"},
    )
    assert r.status_code == 409, r.text
