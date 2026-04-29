"""Per-connection async-queue fan-out manager.

Public surface = ``register / unregister / broadcast / send_to_role`` only.
Phase 3 can swap the per-connection queues for Redis pub-sub without
changing call sites.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict
from collections.abc import AsyncIterator, Iterable
from dataclasses import dataclass
from typing import Any

from ..logging_setup import get_logger

_logger = get_logger("ws.connection_manager")


@dataclass
class _Connection:
    session_id: str
    role_id: str
    is_creator: bool
    queue: asyncio.Queue[dict[str, Any]]


class ConnectionManager:
    """Track connections per session and fan out events to them."""

    _MAX_QUEUE = 256

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._connections: dict[str, list[_Connection]] = defaultdict(list)
        # Keep a small replay buffer per session so reconnecting clients can
        # rehydrate without bothering the SessionManager.
        self._replay: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self._replay_max = 256

    async def register(
        self,
        *,
        session_id: str,
        role_id: str,
        is_creator: bool,
    ) -> _Connection:
        conn = _Connection(
            session_id=session_id,
            role_id=role_id,
            is_creator=is_creator,
            queue=asyncio.Queue(maxsize=self._MAX_QUEUE),
        )
        async with self._lock:
            self._connections[session_id].append(conn)
        await self._send_replay(conn)
        return conn

    async def unregister(self, conn: _Connection) -> None:
        async with self._lock:
            try:
                self._connections[conn.session_id].remove(conn)
            except ValueError:
                pass

    async def broadcast(
        self,
        session_id: str,
        event: dict[str, Any],
        *,
        record: bool = True,
    ) -> None:
        """Fan out to every connection on the session.

        ``record=False`` skips the replay buffer — use this for **ephemeral**
        signals (typing indicators, presence pings) that are spammed at high
        volume and have no value to a reconnecting client. Without this gate
        a malicious peer can flood typing events and evict legitimate
        ``state_changed`` / ``message_complete`` events from the bounded
        buffer, breaking reconnect rehydration.
        """

        if record:
            await self._record_replay(session_id, event)
        async with self._lock:
            recipients = list(self._connections.get(session_id, ()))
        for conn in recipients:
            await self._enqueue(conn, event)

    async def send_to_role(
        self, session_id: str, role_id: str, event: dict[str, Any]
    ) -> None:
        async with self._lock:
            recipients = [
                c for c in self._connections.get(session_id, ()) if c.role_id == role_id
            ]
        for conn in recipients:
            await self._enqueue(conn, event)

    async def shutdown(self) -> None:
        async with self._lock:
            self._connections.clear()
            self._replay.clear()

    async def connected_role_ids(self, session_id: str) -> list[str]:
        """Snapshot of role_ids that currently have at least one open
        WS connection on this session.
        """

        async with self._lock:
            seen: dict[str, bool] = {}
            for c in self._connections.get(session_id, ()):
                seen[c.role_id] = True
            return list(seen.keys())

    async def role_has_other_connections(
        self, session_id: str, role_id: str, *, exclude: _Connection | None = None
    ) -> bool:
        """Return True if any connection besides ``exclude`` is open for
        the given (session, role). Used by the presence broadcaster to
        avoid emitting a misleading ``offline`` when a player has the
        same role open in two browser tabs.
        """

        async with self._lock:
            for c in self._connections.get(session_id, ()):
                if c is exclude:
                    continue
                if c.role_id == role_id:
                    return True
            return False

    # -------------------------------------------------------- internals
    async def _enqueue(self, conn: _Connection, event: dict[str, Any]) -> None:
        try:
            conn.queue.put_nowait(event)
        except asyncio.QueueFull:
            _logger.warning(
                "ws_queue_full_dropping_event",
                session_id=conn.session_id,
                role_id=conn.role_id,
                event_type=event.get("type"),
            )

    async def _record_replay(self, session_id: str, event: dict[str, Any]) -> None:
        buf = self._replay[session_id]
        buf.append(event)
        if len(buf) > self._replay_max:
            del buf[: len(buf) - self._replay_max]

    async def _send_replay(self, conn: _Connection) -> None:
        for event in self._replay.get(conn.session_id, ()):
            await self._enqueue(conn, event)

    # -------------------------------------------------------- iter helper
    async def stream(self, conn: _Connection) -> AsyncIterator[dict[str, Any]]:
        while True:
            event = await conn.queue.get()
            yield event

    # -------------------------------------------------------- inspection
    def role_ids_for(self, session_id: str) -> Iterable[str]:
        return [c.role_id for c in self._connections.get(session_id, ())]
