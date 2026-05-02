"""Per-connection focus / visibility tracking — feeds the tri-state
status dot on the creator's RolesPanel.

A *role* is "focused" if at least one of its open connections has
``focused=True``. A multi-tab user with one foreground and one
background tab counts as focused. Disconnecting a focused tab while a
backgrounded tab survives drops the role to joined-but-idle.
"""

from __future__ import annotations

import asyncio

import pytest

from app.ws.connection_manager import ConnectionManager


@pytest.mark.asyncio
async def test_set_focus_returns_true_on_change_false_on_no_op() -> None:
    cm = ConnectionManager()
    conn = await cm.register(session_id="s1", role_id="r1", is_creator=False)

    # Default focused=True on register; setting True again is a no-op.
    assert await cm.set_focus(conn, True) is False
    # Flipping to False is a real change.
    assert await cm.set_focus(conn, False) is True
    # Setting back to False is a no-op.
    assert await cm.set_focus(conn, False) is False
    # And flipping back True is real.
    assert await cm.set_focus(conn, True) is True

    await cm.unregister(conn)


@pytest.mark.asyncio
async def test_role_has_focused_connection_aggregates_across_tabs() -> None:
    """Two tabs, one foreground + one background. Role stays focused
    until the foreground tab itself goes background / disconnects.
    """

    cm = ConnectionManager()
    fg = await cm.register(session_id="s1", role_id="r1", is_creator=False)
    bg = await cm.register(session_id="s1", role_id="r1", is_creator=False)
    await cm.set_focus(bg, False)

    assert await cm.role_has_focused_connection("s1", "r1") is True

    # Background-tab-only state.
    await cm.set_focus(fg, False)
    assert await cm.role_has_focused_connection("s1", "r1") is False

    # Foreground returns.
    await cm.set_focus(fg, True)
    assert await cm.role_has_focused_connection("s1", "r1") is True

    # Excluding the foreground tab simulates the disconnect path —
    # the answer should drop to False even though it's still in the
    # connection list, because the caller is asking "what would be
    # true *after* this conn unregisters?".
    assert (
        await cm.role_has_focused_connection("s1", "r1", exclude=fg) is False
    )

    await cm.unregister(fg)
    await cm.unregister(bg)


@pytest.mark.asyncio
async def test_focused_role_ids_subset_of_connected_role_ids() -> None:
    cm = ConnectionManager()
    a = await cm.register(session_id="s1", role_id="role-a", is_creator=False)
    b = await cm.register(session_id="s1", role_id="role-b", is_creator=False)
    c = await cm.register(session_id="s1", role_id="role-c", is_creator=False)

    # role-a foreground, role-b background, role-c foreground.
    await cm.set_focus(b, False)

    connected = sorted(await cm.connected_role_ids("s1"))
    focused = sorted(await cm.focused_role_ids("s1"))

    assert connected == ["role-a", "role-b", "role-c"]
    assert focused == ["role-a", "role-c"]

    await cm.unregister(a)
    await cm.unregister(b)
    await cm.unregister(c)


@pytest.mark.asyncio
async def test_focused_role_ids_isolates_per_session() -> None:
    """A focused tab on session A must not appear as focused on B."""

    cm = ConnectionManager()
    on_a = await cm.register(session_id="A", role_id="role-x", is_creator=False)
    on_b = await cm.register(session_id="B", role_id="role-x", is_creator=False)
    await cm.set_focus(on_b, False)

    assert await cm.focused_role_ids("A") == ["role-x"]
    assert await cm.focused_role_ids("B") == []
    assert await cm.role_has_focused_connection("A", "role-x") is True
    assert await cm.role_has_focused_connection("B", "role-x") is False

    await cm.unregister(on_a)
    await cm.unregister(on_b)


@pytest.mark.asyncio
async def test_default_register_marks_connection_focused() -> None:
    """Fresh connect → focused=True. Server-side default; the client
    immediately refines via ``tab_focus`` if the tab is actually
    backgrounded."""

    cm = ConnectionManager()
    conn = await cm.register(session_id="s1", role_id="r1", is_creator=False)
    assert conn.focused is True
    assert await cm.focused_role_ids("s1") == ["r1"]
    await cm.unregister(conn)


def test_async_helper_runs_under_asyncio_run() -> None:
    """Sanity check: the async helpers are usable from a sync test
    runner via ``asyncio.run`` too — matches the existing pattern in
    ``test_e2e_session.py`` for connection-manager assertions."""

    async def _check() -> None:
        cm = ConnectionManager()
        conn = await cm.register(session_id="s", role_id="r", is_creator=False)
        await cm.set_focus(conn, False)
        assert await cm.role_has_focused_connection("s", "r") is False
        await cm.unregister(conn)

    asyncio.run(_check())
