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


def groups_from_flat(role_ids: list[str]) -> list[list[str]]:
    """Convert a flat list of role ids to one-role-per-group form.

    The legacy "every role must respond" semantic. Used by call sites
    that don't know the AI's grouping intent (force-advance recovery,
    replay-mode runner, briefing turn opener) and want the safest
    default — every named role becomes its own required group.
    """

    return [[rid] for rid in role_ids]


def can_submit(turn: Turn, role_id: str) -> bool:
    """A role may submit only if it's named active on an awaiting turn.

    Submissions never advance the turn — the ready-quorum gate
    (``set_role_ready`` + ``groups_quorum_met``) does. A role can post
    any number of discussion messages before marking themselves ready.
    Non-active roles (or active roles on a non-awaiting turn) land as
    out-of-turn interjections instead.

    Issue #168 (role-groups): "named active" means "appears in any of
    the turn's ``active_role_groups``" — equivalent to membership in
    the flat ``active_role_ids`` derived view.
    """

    if turn.status != "awaiting":
        return False
    return role_id in turn.active_role_ids


def all_submitted(turn: Turn) -> bool:
    """Have *all* active roles submitted (or equivalent forced-advance state)?

    Kept as a diagnostic helper (used by the ``response_submitted`` audit
    line and by the activity panel's "every voice spoke" indicator). The
    advance gate is ``groups_quorum_met`` — roles are not all required
    to submit for the turn to advance under the role-groups model.
    """

    return turn.status == "awaiting" and set(turn.submitted_role_ids) >= set(
        turn.active_role_ids
    )


def groups_quorum_met(turn: Turn) -> bool:
    """Has every active group received at least one ready signal?

    The role-groups model (issue #168) replaces the all-roles-must-ready
    gate with a per-group quorum. Each group in ``active_role_groups``
    closes when ANY of its members fires ``set_ready{ready: True}``;
    the turn advances when *every* group is closed. A single-role group
    reduces to "that role must ready" (the previous default for a
    single-id yield); a multi-role group is the "either of you can
    answer" case.

    Examples:

    * ``groups=[[ben]]`` and ``ready=[]`` → ``False`` (Ben hasn't readied)
    * ``groups=[[ben]]`` and ``ready=[ben]`` → ``True``
    * ``groups=[[paul, lawrence]]`` and ``ready=[paul]`` → ``True``
      (the screenshot case from #168)
    * ``groups=[[ben], [paul, lawrence]]`` and ``ready=[paul]`` →
      ``False`` (Ben's group still open)
    * ``groups=[[ben], [paul, lawrence]]`` and ``ready=[ben, paul]`` →
      ``True``

    Edge: an empty ``active_role_groups`` returns ``False``. A turn
    that opens with no groups is malformed; the gate doesn't fire.
    Force-advance still bypasses this check via the existing
    ``force_advance`` path.
    """

    if turn.status != "awaiting":
        return False
    if not turn.active_role_groups:
        return False
    ready = set(turn.ready_role_ids)
    return all(any(rid in ready for rid in group) for group in turn.active_role_groups)




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
