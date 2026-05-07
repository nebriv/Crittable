"""Pure state machine for the session lifecycle. No I/O, no side effects.

The :class:`~.manager.SessionManager` is the only thing that mutates a
:class:`~.models.Session`. It calls into this module for "is this transition
legal?" decisions, then performs the mutation itself.
"""

from __future__ import annotations

from typing import Literal

from .models import (
    PLAN_EDITABLE_FIELDS,
    Session,
    SessionState,
    Turn,
)

# Wave 1 (issue #134): per-submission intent. A "ready" submission
# adds the role to ``Turn.ready_role_ids`` and may flip the state to
# ``AI_PROCESSING`` once the quorum is met; a "discuss" submission
# leaves space for further team discussion (and removes the role from
# the quorum if they had previously signaled ready).
SubmissionIntent = Literal["ready", "discuss"]


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
    """A role may submit only if it's named active on an awaiting turn.

    Wave 1 (issue #134): we no longer cap submissions at one per role
    per turn. The ready-quorum gate replaces "submitted once" as the
    advance signal — a role can post multiple discussion messages
    before signaling ``intent="ready"``, and all of them count as
    turn submissions (each updates ``ready_role_ids`` based on the
    submission's intent). Non-active roles (or active roles on a
    non-awaiting turn) still land as out-of-turn interjections.
    """

    if turn.status != "awaiting":
        return False
    return role_id in turn.active_role_ids


def all_submitted(turn: Turn) -> bool:
    """Have *all* active roles submitted (or equivalent forced-advance state)?"""

    return turn.status == "awaiting" and set(turn.submitted_role_ids) >= set(
        turn.active_role_ids
    )


def all_ready(turn: Turn) -> bool:
    """Have *all* active roles signaled ``intent="ready"`` on their most
    recent submission this turn?

    This is the Wave-1 (issue #134) replacement for ``all_submitted`` as
    the gate that flips ``AWAITING_PLAYERS → AI_PROCESSING``.
    Force-advance still bypasses this check via the existing
    ``force_advance`` path. Discussion-only submissions accumulate in
    ``submitted_role_ids`` (so the AI sees them on its next turn and the
    UI shows "X spoke") without triggering an advance.
    """

    return turn.status == "awaiting" and set(turn.ready_role_ids) >= set(
        turn.active_role_ids
    )


def assert_plan_edit_field(field: str) -> None:
    """Raise if ``field`` is not in the editable allow-list."""

    if field not in PLAN_EDITABLE_FIELDS:
        raise IllegalTransitionError(
            f"plan field '{field}' is immutable post-finalize_setup"
        )


def critical_inject_allowed(session: Session, *, max_per_5_turns: int) -> bool:
    """Enforce the critical-event rate limit (default 1 per 5 turns).

    Side effect: when the rolling window is at cap, write
    ``session.critical_inject_rate_limit_until`` to the turn index at
    which the budget refreshes. The play-tier system prompt
    (``build_play_system_blocks``) surfaces this as a "you are
    rate-limited until turn N" mini-block so the AI doesn't keep
    retrying the same critical-event call across turns. When the
    budget has refreshed, clear the field.
    """

    if max_per_5_turns <= 0:
        session.critical_inject_rate_limit_until = None
        return False
    if not session.turns:
        session.critical_inject_rate_limit_until = None
        return True
    current_index = session.turns[-1].index
    window = [i for i in session.critical_injects_window if current_index - i < 5]
    allowed = len(window) < max_per_5_turns
    if not allowed and window:
        # Earliest in-window index expires when (idx + 5) is reached.
        session.critical_inject_rate_limit_until = min(window) + 5
    else:
        session.critical_inject_rate_limit_until = None
    return allowed


def record_critical_inject(session: Session) -> None:
    """Append the current turn index and trim the rolling window."""

    if not session.turns:
        return
    idx = session.turns[-1].index
    session.critical_injects_window.append(idx)
    session.critical_injects_window = [
        i for i in session.critical_injects_window if idx - i < 5
    ]
