"""Tests for the per-turn validator/recovery rollup surfaced to the
creator UI (issue #70).

The rollup turns ``turn_validation`` and ``turn_recovery_directive``
audit rows into a per-turn summary structure rendered by
``SessionActivityPanel`` + the ``/debug`` God Mode panel. Pre-fix
these events were stdout-only structlog lines and a 5-hour log dive
was required to diagnose the 2026-04-30 silent-yield regression.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.api.routes import _compute_turn_diagnostics
from app.auth.audit import AuditEvent


def _evt(
    kind: str,
    *,
    turn_id: str,
    payload: dict,
    offset_s: int = 0,
) -> AuditEvent:
    """Build an ``AuditEvent`` with a deterministic timestamp."""

    ts = datetime(2026, 5, 5, tzinfo=UTC) + timedelta(seconds=offset_s)
    return AuditEvent(
        ts=ts,
        kind=kind,
        session_id="sess-1",
        turn_id=turn_id,
        payload=payload,
    )


def test_compute_turn_diagnostics_groups_by_turn() -> None:
    events = [
        _evt(
            "turn_validation",
            turn_id="t-aaa",
            payload={
                "attempt": 1,
                "slots": ["yield"],
                "violations": ["missing_drive"],
                "warnings": [],
                "ok": False,
            },
        ),
        _evt(
            "turn_recovery_directive",
            turn_id="t-aaa",
            payload={
                "attempt": 1,
                # Stored as ``directive_kind`` to avoid colliding with
                # ``SessionManager._emit``'s positional ``kind`` param;
                # the rollup re-publishes it as ``kind`` for the UI.
                "directive_kind": "missing_drive",
                "tools": ["broadcast"],
            },
            offset_s=1,
        ),
        _evt(
            "turn_validation",
            turn_id="t-aaa",
            payload={
                "attempt": 2,
                "slots": ["drive", "yield"],
                "violations": [],
                "warnings": [],
                "ok": True,
            },
            offset_s=2,
        ),
        _evt(
            "turn_validation",
            turn_id="t-bbb",
            payload={
                "attempt": 1,
                "slots": ["drive", "yield"],
                "violations": [],
                "warnings": [],
                "ok": True,
            },
            offset_s=10,
        ),
    ]
    diag = _compute_turn_diagnostics(
        events,
        {"t-aaa": 0, "t-bbb": 1},
    )
    # Two turns, sorted by turn_index ascending.
    assert [t["turn_index"] for t in diag] == [0, 1]

    # Turn 0 had two validation passes and one recovery between.
    t0 = diag[0]
    assert len(t0["validations"]) == 2
    assert len(t0["recoveries"]) == 1
    assert t0["validations"][0]["attempt"] == 1
    assert t0["validations"][0]["ok"] is False
    assert t0["validations"][1]["attempt"] == 2
    assert t0["validations"][1]["ok"] is True
    assert t0["recoveries"][0]["kind"] == "missing_drive"
    assert t0["recoveries"][0]["tools"] == ["broadcast"]

    # Turn 1 had a single clean pass.
    t1 = diag[1]
    assert len(t1["validations"]) == 1
    assert t1["recoveries"] == []
    assert t1["validations"][0]["ok"] is True


def test_compute_turn_diagnostics_drops_unknown_turn_id() -> None:
    events = [
        _evt(
            "turn_validation",
            turn_id="t-orphan",
            payload={
                "attempt": 1,
                "slots": [],
                "violations": [],
                "warnings": [],
                "ok": True,
            },
        ),
    ]
    # Turn id is not in the index map (e.g. ring buffer rotated).
    diag = _compute_turn_diagnostics(events, {})
    assert diag == []


def test_compute_turn_diagnostics_ignores_unrelated_events() -> None:
    events = [
        _evt(
            "session_created",
            turn_id="t-x",
            payload={"scenario_prompt": "x"},
        ),
        _evt(
            "tool_use",
            turn_id="t-x",
            payload={"name": "broadcast"},
        ),
        _evt(
            "turn_validation",
            turn_id="t-x",
            payload={
                "attempt": 1,
                "slots": ["drive", "yield"],
                "violations": [],
                "warnings": [],
                "ok": True,
            },
        ),
    ]
    diag = _compute_turn_diagnostics(events, {"t-x": 0})
    assert len(diag) == 1
    # Only the validator pass survived — session_created / tool_use are
    # not part of the validator rollup.
    assert len(diag[0]["validations"]) == 1
    assert diag[0]["recoveries"] == []


def test_compute_turn_diagnostics_caps_to_max_turns() -> None:
    events = []
    turn_index = {}
    for i in range(5):
        tid = f"t-{i}"
        turn_index[tid] = i
        events.append(
            _evt(
                "turn_validation",
                turn_id=tid,
                payload={
                    "attempt": 1,
                    "slots": ["drive", "yield"],
                    "violations": [],
                    "warnings": [],
                    "ok": True,
                },
                offset_s=i * 10,
            ),
        )
    diag = _compute_turn_diagnostics(events, turn_index, max_turns=3)
    # Newest 3 by turn_index, ascending.
    assert [t["turn_index"] for t in diag] == [2, 3, 4]


def test_compute_turn_diagnostics_carries_warnings() -> None:
    events = [
        _evt(
            "turn_validation",
            turn_id="t-w",
            payload={
                "attempt": 1,
                "slots": ["yield"],
                "violations": [],
                "warnings": [
                    "drive missing but downgraded — legacy carve-out fired"
                ],
                "ok": True,
            },
        ),
    ]
    diag = _compute_turn_diagnostics(events, {"t-w": 0})
    [warning] = diag[0]["validations"][0]["warnings"]
    assert "legacy carve-out" in warning


def test_compute_turn_diagnostics_sorts_attempts_within_turn() -> None:
    """Attempts arrive in chronological order, but the helper must be
    robust against an out-of-order audit buffer (e.g. a future
    persistent backend that re-fetches by turn_id)."""

    events = [
        _evt(
            "turn_validation",
            turn_id="t-x",
            payload={
                "attempt": 3,
                "slots": ["drive", "yield"],
                "violations": [],
                "warnings": [],
                "ok": True,
            },
            offset_s=10,
        ),
        _evt(
            "turn_validation",
            turn_id="t-x",
            payload={
                "attempt": 1,
                "slots": [],
                "violations": ["missing_drive", "missing_yield"],
                "warnings": [],
                "ok": False,
            },
            offset_s=0,
        ),
        _evt(
            "turn_validation",
            turn_id="t-x",
            payload={
                "attempt": 2,
                "slots": ["drive"],
                "violations": ["missing_yield"],
                "warnings": [],
                "ok": False,
            },
            offset_s=5,
        ),
    ]
    diag = _compute_turn_diagnostics(events, {"t-x": 0})
    attempts = [v["attempt"] for v in diag[0]["validations"]]
    assert attempts == [1, 2, 3]


def test_compute_turn_diagnostics_survives_missing_attempt_field() -> None:
    """QA review LOW: a corrupt audit row missing the ``attempt`` key
    must not crash the rollup. The sort key falls back to ``0`` so
    the entry lands first in the list rather than raising
    ``TypeError`` on ``None`` ordering."""

    events = [
        _evt(
            "turn_validation",
            turn_id="t-x",
            payload={
                # No ``attempt`` field at all.
                "slots": ["drive", "yield"],
                "violations": [],
                "warnings": [],
                "ok": True,
            },
        ),
        _evt(
            "turn_validation",
            turn_id="t-x",
            payload={
                "attempt": 2,
                "slots": ["drive", "yield"],
                "violations": [],
                "warnings": [],
                "ok": True,
            },
            offset_s=5,
        ),
    ]
    # Must not raise; missing-attempt entry sorts first (None → 0).
    diag = _compute_turn_diagnostics(events, {"t-x": 0})
    attempts = [v["attempt"] for v in diag[0]["validations"]]
    assert attempts == [None, 2]
