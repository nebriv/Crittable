"""In-memory audit ring buffer + JSONL stdout emitter.

Every state transition, tool call, participant message, and creator/control
action emits one :class:`AuditEvent`. The ring buffer makes the audit log
available to the AAR generator without re-parsing stdout; the stdout JSONL
line means a container log scraper sees them too.

The buffer size is bounded per-session (env: ``AUDIT_RING_SIZE``) so a
runaway session can't OOM the process.
"""

from __future__ import annotations

from collections import defaultdict, deque
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from ..logging_setup import get_logger

_logger = get_logger("audit")


class AuditEvent(BaseModel):
    """One auditable event."""

    model_config = ConfigDict(extra="forbid")

    ts: datetime = Field(default_factory=lambda: datetime.now(UTC))
    kind: str
    session_id: str
    turn_id: str | None = None
    role_id: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class AuditLog:
    """Per-session bounded ring buffer + JSONL emitter."""

    def __init__(self, *, ring_size: int = 2000) -> None:
        if ring_size < 10:
            raise ValueError("ring_size must be >= 10")
        self._ring_size = ring_size
        self._buffers: dict[str, deque[AuditEvent]] = defaultdict(self._make_deque)

    def _make_deque(self) -> deque[AuditEvent]:
        return deque(maxlen=self._ring_size)

    def emit(self, event: AuditEvent) -> None:
        """Append to the per-session ring buffer and log as JSONL to stdout.

        Large fields in ``payload`` are truncated for the *log* line so a long
        ``scenario_prompt`` or message body doesn't blow out a JSON log
        record. The ring-buffer copy keeps the original (it goes into the
        AAR appendix).
        """

        self._buffers[event.session_id].append(event)
        _logger.info(
            "audit",
            audit_kind=event.kind,
            audit_session=event.session_id,
            audit_turn=event.turn_id,
            audit_role=event.role_id,
            audit_payload=_truncate(event.payload),
            audit_ts=event.ts.isoformat(),
        )

    def dump(self, session_id: str) -> list[AuditEvent]:
        """Ordered copy of the session's events. Safe to iterate on caller side."""

        return list(self._buffers.get(session_id, ()))

    def drop(self, session_id: str) -> None:
        """Forget a session's audit trail (used after export retention)."""

        self._buffers.pop(session_id, None)


_LOG_FIELD_MAX_CHARS = 200


def _truncate(payload: dict[str, Any]) -> dict[str, Any]:
    """Return a copy with overlong strings / lists trimmed for log emission."""

    out: dict[str, Any] = {}
    for key, value in payload.items():
        if isinstance(value, str) and len(value) > _LOG_FIELD_MAX_CHARS:
            out[key] = value[:_LOG_FIELD_MAX_CHARS] + "…"
        elif isinstance(value, (list, tuple)) and len(value) > 20:
            out[key] = [*list(value[:20]), "…"]
        elif isinstance(value, dict) and len(value) > 20:
            keys = list(value)[:20]
            out[key] = {k: value[k] for k in keys}
            out[key]["…"] = f"+{len(value) - 20} more"
        else:
            out[key] = value
    return out
