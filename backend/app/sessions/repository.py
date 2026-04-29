"""Session repository — Protocol + in-memory MVP implementation."""

from __future__ import annotations

import asyncio
from collections.abc import Iterable
from typing import Protocol

from .models import Session


class SessionNotFoundError(KeyError):
    """Raised when a lookup misses."""


class SessionCapacityError(RuntimeError):
    """Raised when MAX_SESSIONS is exceeded."""


class SessionRepository(Protocol):
    async def create(self, session: Session) -> None: ...
    async def get(self, session_id: str) -> Session: ...
    async def save(self, session: Session) -> None: ...
    async def list(self) -> list[Session]: ...
    async def delete(self, session_id: str) -> None: ...


class InMemoryRepository:
    """Thread-/async-safe in-process store. The MVP storage backend.

    The underlying lock guards only the dict itself; per-session mutation
    locks live on :class:`~.manager.SessionManager`. The repository hands
    back live references; the manager is the only thing that mutates them.
    """

    def __init__(self, *, max_sessions: int = 10) -> None:
        if max_sessions < 1:
            raise ValueError("max_sessions must be >= 1")
        self._max = max_sessions
        self._lock = asyncio.Lock()
        self._sessions: dict[str, Session] = {}

    async def create(self, session: Session) -> None:
        async with self._lock:
            if session.id in self._sessions:
                raise ValueError(f"session already exists: {session.id}")
            if len(self._sessions) >= self._max:
                raise SessionCapacityError(
                    f"session capacity reached ({self._max}); end one before creating another"
                )
            self._sessions[session.id] = session

    async def get(self, session_id: str) -> Session:
        async with self._lock:
            try:
                return self._sessions[session_id]
            except KeyError as exc:
                raise SessionNotFoundError(session_id) from exc

    async def save(self, session: Session) -> None:
        # In-memory: identity-equal already; future backends materialize.
        async with self._lock:
            self._sessions[session.id] = session

    async def list(self) -> list[Session]:
        async with self._lock:
            return list(self._sessions.values())

    async def delete(self, session_id: str) -> None:
        async with self._lock:
            self._sessions.pop(session_id, None)

    # Test/inspection helpers ------------------------------------------------
    def ids(self) -> Iterable[str]:
        return tuple(self._sessions.keys())
