"""Pure state machine for the session lifecycle. No I/O, no side effects.

The :class:`~.manager.SessionManager` is the only thing that mutates a
:class:`~.models.Session`. It calls into this module for "is this transition
legal?" decisions, then performs the mutation itself.
"""

from __future__ import annotations

from .models import (
    PLAN_EDITABLE_FIELDS,
    Session,
    SessionState,
    Turn,
)


class IllegalTransitionError(RuntimeError):
    """Raised when an action is rejected by the state machine."""


_ALLOWED: dict[SessionState, set[SessionState]] = {
    SessionState.CREATED: {SessionState.SETUP},
    SessionState.SETUP: {SessionState.READY, SessionState.ENDED},
    SessionState.READY: {SessionState.BRIEFING, SessionState.ENDED},
    SessionState.BRIEFING: {SessionState.AWAITING_PLAYERS, SessionState.ENDED},
    SessionState.AWAITING_PLAYERS: {
        SessionState.AI_PROCESSING,
        SessionState.AWAITING_PLAYERS,
        SessionState.ENDED,
    },
    SessionState.AI_PROCESSING: {
        SessionState.AWAITING_PLAYERS,
        SessionState.ENDED,
    },
    SessionState.ENDED: set(),
}


def assert_transition(current: SessionState, target: SessionState) -> None:
    """Raise :class:`IllegalTransitionError` if ``current → target`` is not allowed."""

    if target not in _ALLOWED[current]:
        raise IllegalTransitionError(f"illegal transition {current} -> {target}")


def can_submit(turn: Turn, role_id: str) -> bool:
    """A role may submit only if it's named active and hasn't already submitted."""

    if turn.status != "awaiting":
        return False
    return role_id in turn.active_role_ids and role_id not in turn.submitted_role_ids


def all_submitted(turn: Turn) -> bool:
    """Have *all* active roles submitted (or equivalent forced-advance state)?"""

    return turn.status == "awaiting" and set(turn.submitted_role_ids) >= set(
        turn.active_role_ids
    )


def assert_plan_edit_field(field: str) -> None:
    """Raise if ``field`` is not in the editable allow-list."""

    if field not in PLAN_EDITABLE_FIELDS:
        raise IllegalTransitionError(
            f"plan field '{field}' is immutable post-finalize_setup"
        )


def critical_inject_allowed(session: Session, *, max_per_5_turns: int) -> bool:
    """Enforce the critical-event rate limit (default 1 per 5 turns)."""

    if max_per_5_turns <= 0:
        return False
    if not session.turns:
        return True
    current_index = session.turns[-1].index
    window = [i for i in session.critical_injects_window if current_index - i < 5]
    return len(window) < max_per_5_turns


def record_critical_inject(session: Session) -> None:
    """Append the current turn index and trim the rolling window."""

    if not session.turns:
        return
    idx = session.turns[-1].index
    session.critical_injects_window.append(idx)
    session.critical_injects_window = [
        i for i in session.critical_injects_window if idx - i < 5
    ]
