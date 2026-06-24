"""``ConnectionManager.broadcast_to_creator`` — creator-only fan-out.

Added for cost/abuse H2: the LLM concurrency governor's degraded
``backend_status`` notice goes to the creator's tab(s) only, targeted by
the connection's ``is_creator`` flag (so the caller needs no role_id).
Non-creator connections must never receive it, and it must NOT enter the
replay buffer (it's an ephemeral live-load signal).
"""

from __future__ import annotations

import asyncio

import pytest

from app.ws.connection_manager import ConnectionManager


def _drain(conn) -> list[dict]:
    out: list[dict] = []
    while True:
        try:
            out.append(conn.queue.get_nowait())
        except asyncio.QueueEmpty:
            return out


@pytest.mark.asyncio
async def test_broadcast_to_creator_only_creator_connections_receive() -> None:
    cm = ConnectionManager()
    creator = await cm.register(session_id="s1", role_id="r-creator", is_creator=True)
    player = await cm.register(session_id="s1", role_id="r-player", is_creator=False)

    event = {"type": "backend_status", "status": "degraded", "message": "Heavy load"}
    await cm.broadcast_to_creator("s1", event)

    assert _drain(creator) == [event]
    assert _drain(player) == [], "non-creator must not receive creator-only event"

    await cm.unregister(creator)
    await cm.unregister(player)


@pytest.mark.asyncio
async def test_broadcast_to_creator_reaches_all_creator_tabs() -> None:
    """A creator with two open tabs gets the notice on both."""

    cm = ConnectionManager()
    tab_a = await cm.register(session_id="s1", role_id="r-creator", is_creator=True)
    tab_b = await cm.register(session_id="s1", role_id="r-creator", is_creator=True)

    event = {"type": "backend_status", "status": "degraded"}
    await cm.broadcast_to_creator("s1", event)

    assert _drain(tab_a) == [event]
    assert _drain(tab_b) == [event]


@pytest.mark.asyncio
async def test_broadcast_to_creator_noop_when_no_creator_tab() -> None:
    """No open creator tab → silent no-op (player queue stays empty)."""

    cm = ConnectionManager()
    player = await cm.register(session_id="s1", role_id="r-player", is_creator=False)
    await cm.broadcast_to_creator("s1", {"type": "backend_status"})
    assert _drain(player) == []


@pytest.mark.asyncio
async def test_broadcast_to_creator_is_not_recorded_in_replay() -> None:
    """The notice is ephemeral: a creator tab that connects AFTER the
    burst must not be handed a stale degraded notice from the replay
    buffer."""

    cm = ConnectionManager()
    early = await cm.register(session_id="s1", role_id="r-creator", is_creator=True)
    await cm.broadcast_to_creator("s1", {"type": "backend_status", "status": "degraded"})
    # The early tab saw it live.
    assert _drain(early)

    # A late-joining creator tab replays the buffer on register; the
    # ephemeral notice must NOT be there.
    late = await cm.register(session_id="s1", role_id="r-creator", is_creator=True)
    assert _drain(late) == [], "creator-only notice must not be replayed"
