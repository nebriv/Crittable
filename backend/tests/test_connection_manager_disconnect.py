"""``ConnectionManager.disconnect_role`` — force-close primitive used
by ``SessionManager`` when a creator kicks (revokes) or removes a
role. Token-version bump alone leaves the kicked tab with a live
WebSocket; ``disconnect_role`` is what severs the channel (issue
#127).
"""

from __future__ import annotations

import pytest

from app.ws.connection_manager import ConnectionManager


class _FakeWebSocket:
    """Minimal stand-in for a Starlette ``WebSocket``.

    Records ``close()`` calls so the test can assert on the code /
    reason that landed. Nothing else from the real WS surface is
    exercised here — the recv / send pumps that read the queue live
    in the live WS routes test.
    """

    def __init__(self) -> None:
        self.closed_with: list[tuple[int, str]] = []

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed_with.append((code, reason))


@pytest.mark.asyncio
async def test_disconnect_role_closes_every_open_socket_for_role() -> None:
    cm = ConnectionManager()
    ws_a = _FakeWebSocket()
    ws_b = _FakeWebSocket()
    other_ws = _FakeWebSocket()

    # Two tabs for the same role + an unrelated role on the same session.
    await cm.register(
        session_id="s1", role_id="kicked", is_creator=False, websocket=ws_a  # type: ignore[arg-type]
    )
    await cm.register(
        session_id="s1", role_id="kicked", is_creator=False, websocket=ws_b  # type: ignore[arg-type]
    )
    other = await cm.register(
        session_id="s1",
        role_id="bystander",
        is_creator=False,
        websocket=other_ws,  # type: ignore[arg-type]
    )

    closed = await cm.disconnect_role("s1", "kicked", code=4401, reason="kicked")

    assert closed == 2
    assert ws_a.closed_with == [(4401, "kicked")]
    assert ws_b.closed_with == [(4401, "kicked")]
    # The bystander's socket must be untouched — disconnect_role is
    # surgical, not a session-wide reset.
    assert other_ws.closed_with == []

    # Per-connection recv pumps would normally call ``unregister`` on
    # the WebSocketDisconnect they observe; ``disconnect_role`` does
    # NOT remove the connection itself when there's a live socket so
    # the pump can run its normal teardown.
    assert other in cm._connections["s1"]


@pytest.mark.asyncio
async def test_disconnect_role_no_open_connections_returns_zero() -> None:
    cm = ConnectionManager()
    closed = await cm.disconnect_role("s1", "phantom")
    assert closed == 0


@pytest.mark.asyncio
async def test_disconnect_role_isolates_per_session() -> None:
    """Same role_id in two sessions must not be mass-disconnected."""

    cm = ConnectionManager()
    ws_a = _FakeWebSocket()
    ws_b = _FakeWebSocket()
    await cm.register(
        session_id="A", role_id="r1", is_creator=False, websocket=ws_a  # type: ignore[arg-type]
    )
    await cm.register(
        session_id="B", role_id="r1", is_creator=False, websocket=ws_b  # type: ignore[arg-type]
    )

    closed = await cm.disconnect_role("A", "r1")

    assert closed == 1
    assert ws_a.closed_with and ws_a.closed_with[0][0] == 4401
    assert ws_b.closed_with == []


@pytest.mark.asyncio
async def test_disconnect_role_handles_close_failure_per_socket() -> None:
    """A flaky / already-closed socket on tab #1 must not block tab #2
    from being closed. The primitive is best-effort per socket; a
    single failing close cannot leave a live channel behind."""

    class _ExplodingWebSocket:
        def __init__(self) -> None:
            self.attempted = False

        async def close(self, code: int = 1000, reason: str = "") -> None:
            self.attempted = True
            raise RuntimeError("transport already torn down")

    cm = ConnectionManager()
    boom = _ExplodingWebSocket()
    fine = _FakeWebSocket()
    await cm.register(
        session_id="s1", role_id="r1", is_creator=False, websocket=boom  # type: ignore[arg-type]
    )
    await cm.register(
        session_id="s1", role_id="r1", is_creator=False, websocket=fine  # type: ignore[arg-type]
    )

    closed = await cm.disconnect_role("s1", "r1")

    assert boom.attempted is True
    assert fine.closed_with and fine.closed_with[0][0] == 4401
    # Only the successful close counts — the failure path logs and
    # moves on rather than aborting the loop.
    assert closed == 1


@pytest.mark.asyncio
async def test_disconnect_role_drops_ghost_connection_with_no_socket() -> None:
    """Test fixtures (``test_connection_manager_focus.py``) call
    ``register`` without a websocket. ``disconnect_role`` still has to
    clean those out so subsequent broadcasts don't fan out to a dead
    subscriber whose role was kicked."""

    cm = ConnectionManager()
    ghost = await cm.register(session_id="s1", role_id="r1", is_creator=False)

    closed = await cm.disconnect_role("s1", "r1")

    assert closed == 1
    assert ghost not in cm._connections.get("s1", [])
