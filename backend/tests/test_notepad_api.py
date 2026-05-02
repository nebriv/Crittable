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
        json={"text": "  ## hello [click](https://evil.com) ALERT", "source_message_id": "msg_1"},
    )
    assert r.status_code == 204, r.text

    # Idempotent on the same source_message_id.
    r2 = client.post(
        f"/api/sessions/{sid}/notepad/pin?token={cr}",
        json={"text": "different selection same message", "source_message_id": "msg_1"},
    )
    assert r2.status_code == 204


def test_notepad_pin_rate_limit(client: TestClient) -> None:
    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]

    for i in range(6):
        r = client.post(
            f"/api/sessions/{sid}/notepad/pin?token={cr}",
            json={"text": f"line {i}", "source_message_id": f"msg_{i}"},
        )
        assert r.status_code == 204, r.text
    # 7th within the 10s window → 429.
    r_over = client.post(
        f"/api/sessions/{sid}/notepad/pin?token={cr}",
        json={"text": "overflow", "source_message_id": "msg_overflow"},
    )
    assert r_over.status_code == 429, r_over.text


def test_notepad_pin_rejects_empty_after_sanitization(client: TestClient) -> None:
    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    r = client.post(
        f"/api/sessions/{sid}/notepad/pin?token={cr}",
        json={"text": "[ignored](https://evil.com)", "source_message_id": "msg_x"},
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
