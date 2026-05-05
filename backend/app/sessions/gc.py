"""Session garbage collector.

Background reaper that evicts ``ENDED`` sessions whose retention window
(``EXPORT_RETENTION_MIN``) has expired. Eviction:

* emits a ``session_evicted`` audit event (durable JSONL stdout copy)
* drops the per-session audit ring buffer
* deletes the session from the repository
* records the session id in a bounded tombstone list so a follow-up
  ``GET /api/sessions/{id}/export.md`` can answer **410 Gone** rather
  than the misleading 404 the missing-key path would otherwise produce.

The reaper itself is a single ``asyncio.Task`` owned by the FastAPI
lifespan; cancelling it on shutdown is the only stop signal it needs.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

from ..auth.audit import AuditEvent, AuditLog
from ..config import Settings
from ..logging_setup import get_logger
from .models import SessionState
from .repository import SessionRepository

_logger = get_logger("session.gc")


class SessionGC:
    """Periodically evicts ENDED sessions past ``EXPORT_RETENTION_MIN``."""

    def __init__(
        self,
        *,
        settings: Settings,
        repository: SessionRepository,
        audit: AuditLog,
        sweep_interval_s: float | None = None,
        tombstone_cap: int = 1024,
    ) -> None:
        self._settings = settings
        self._repo = repository
        self._audit = audit
        if sweep_interval_s is None:
            # Once-a-minute in production (well under any retention default).
            # Eviction-timing tests construct ``SessionGC`` directly and
            # pass ``sweep_interval_s`` explicitly when they need a faster
            # sweep.
            sweep_interval_s = 60.0
        self._sweep_interval_s = sweep_interval_s
        self._tombstone_cap = max(tombstone_cap, 1)
        self._tombstones: list[str] = []
        self._tombstone_set: set[str] = set()
        self._task: asyncio.Task[None] | None = None
        self._stop = asyncio.Event()

    # ------------------------------------------------------------ inspection
    @property
    def retention(self) -> timedelta:
        return timedelta(minutes=self._settings.export_retention_min)

    def is_evicted(self, session_id: str) -> bool:
        return session_id in self._tombstone_set

    # --------------------------------------------------------------- runtime
    async def start(self) -> None:
        if self._task is not None:
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="session-gc")
        _logger.info(
            "session_gc_started",
            sweep_interval_s=self._sweep_interval_s,
            retention_min=self._settings.export_retention_min,
        )

    async def stop(self) -> None:
        if self._task is None:
            return
        self._stop.set()
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            # Cancellation is the expected shutdown signal; not an error.
            pass
        except Exception as exc:
            # Real shutdown error — log it so a wedged shutdown shows up in
            # the audit / container logs instead of being silently swallowed.
            _logger.exception("session_gc_stop_failed", error=str(exc))
        self._task = None
        _logger.info("session_gc_stopped")

    async def _run(self) -> None:
        try:
            while not self._stop.is_set():
                try:
                    await self.sweep()
                except Exception as exc:  # never let the reaper die
                    _logger.exception(
                        "session_gc_sweep_failed", error=str(exc)
                    )
                try:
                    await asyncio.wait_for(
                        self._stop.wait(), timeout=self._sweep_interval_s
                    )
                except TimeoutError:
                    pass
        except asyncio.CancelledError:
            return

    # ----------------------------------------------------------- sweep logic
    async def sweep(self, *, now: datetime | None = None) -> list[str]:
        """One pass: evict expired sessions. Returns the evicted ids."""

        moment = now or datetime.now(UTC)
        threshold = moment - self.retention
        try:
            sessions = await self._repo.list()
        except Exception as exc:
            _logger.exception("session_gc_list_failed", error=str(exc))
            return []
        evicted: list[str] = []
        for session in sessions:
            if session.state != SessionState.ENDED:
                continue
            if session.ended_at is None:
                continue
            if session.ended_at > threshold:
                continue
            # Don't evict mid-AAR. ``end_session`` sets ``ended_at`` before
            # kicking off the (possibly long-running) AAR background task; if
            # the operator sets ``EXPORT_RETENTION_MIN`` aggressively the
            # reaper could otherwise delete the session out from under the
            # generator and the polling client would see a 410 for an AAR
            # that never had a chance to finish.
            if session.aar_status in ("pending", "generating"):
                continue
            try:
                await self._evict(session.id)
            except Exception as exc:
                _logger.exception(
                    "session_gc_evict_failed",
                    session_id=session.id,
                    error=str(exc),
                )
                continue
            evicted.append(session.id)
        return evicted

    async def _evict(self, session_id: str) -> None:
        # Audit-emit BEFORE the buffer drop or repository delete: the JSONL
        # stdout line is the durable record either way, but the ring-buffer
        # copy disappears with ``audit.drop``.
        self._audit.emit(
            AuditEvent(
                kind="session_evicted",
                session_id=session_id,
                payload={
                    "retention_min": self._settings.export_retention_min,
                },
            )
        )
        await self._repo.delete(session_id)
        self._audit.drop(session_id)
        self._add_tombstone(session_id)
        _logger.info("session_evicted", session_id=session_id)

    def _add_tombstone(self, session_id: str) -> None:
        if session_id in self._tombstone_set:
            return
        self._tombstones.append(session_id)
        self._tombstone_set.add(session_id)
        while len(self._tombstones) > self._tombstone_cap:
            old = self._tombstones.pop(0)
            self._tombstone_set.discard(old)


__all__ = ["SessionGC"]
