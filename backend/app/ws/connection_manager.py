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

    async def broadcast(self, session_id: str, event: dict[str, Any]) -> None:
        """Fan out to every connection on the session.

        Cost events are gated to creators only inside :meth:`send_to_role`
        upstream — this method assumes everything passed in is broadcast-safe.
        """

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
