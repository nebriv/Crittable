"""Per-turn progress percentage for the TURN STATE rail (issue #111).

Single source of truth for "what fraction of the active step is done?"
Three call sites consume this:

1. The snapshot serializer in ``app/api/routes.py`` — surfaces
   ``current_turn.progress_pct`` so a reconnecting tab gets the value
   at fetch time.
2. The ``state_changed`` / ``turn_changed`` WS broadcasts in
   ``app/sessions/manager.py`` and ``app/sessions/turn_driver.py`` —
   pushes interim updates without forcing a snapshot poll.
3. The play-turn driver itself, which writes ``Turn.ai_progress_pct``
   at sub-step boundaries (planning → tool dispatch → emit / yield)
   and re-broadcasts state so the bar advances as the AI works.

Coarse buckets are by design — the issue explicitly asks for "anything
better than the constant sweep." A precise estimator is a follow-up.
"""

from __future__ import annotations

from ..logging_setup import get_logger
from .models import Session, SessionState

_logger = get_logger("session.progress")


def compute_progress_pct(session: Session) -> float | None:
    """Return the active step's progress fraction in [0.0, 1.0], or
    ``None`` to keep the sweep (indeterminate) bar.

    Per-state policy:

    - ``ENDED`` — terminal state, bar fills (1.0).
    - ``AWAITING_PLAYERS`` — submitted / active. ``None`` when the
      turn has no active roles (e.g. the very first frame after a
      yield, before the engine has populated the next active set).
    - ``AI_PROCESSING`` / ``BRIEFING`` — driver-written
      ``Turn.ai_progress_pct``. May be ``None`` early in the turn
      before the LLM call returns; callers fall back to the sweep.
    - ``CREATED`` / ``SETUP`` / ``READY`` — sweep (None). The setup
      tier has no natural sub-step pulse and a stuck-at-zero bar
      would read as broken.

    Each ``None`` return logs a debug breadcrumb so an operator
    debugging "why is the bar stuck in sweep" can grep for the
    reason without reproducing the live session (logging-and-
    debuggability rule, CLAUDE.md).
    """

    state = session.state
    if state == SessionState.ENDED:
        return 1.0
    if state == SessionState.AWAITING_PLAYERS:
        turn = session.current_turn
        if turn is None:
            _logger.debug(
                "progress_pct_indeterminate",
                session_id=session.id,
                state=state.value,
                reason="no_current_turn",
            )
            return None
        active_count = len(turn.active_role_ids)
        if active_count == 0:
            _logger.debug(
                "progress_pct_indeterminate",
                session_id=session.id,
                state=state.value,
                reason="empty_active_role_ids",
                turn_index=turn.index,
            )
            return None
        submitted_count = len(turn.submitted_role_ids)
        return min(1.0, submitted_count / active_count)
    if state in (SessionState.AI_PROCESSING, SessionState.BRIEFING):
        turn = session.current_turn
        if turn is None:
            _logger.debug(
                "progress_pct_indeterminate",
                session_id=session.id,
                state=state.value,
                reason="no_current_turn",
            )
            return None
        if turn.ai_progress_pct is None:
            _logger.debug(
                "progress_pct_indeterminate",
                session_id=session.id,
                state=state.value,
                reason="ai_progress_pct_unset",
                turn_index=turn.index,
            )
        return turn.ai_progress_pct
    # CREATED / SETUP / READY: deliberate sweep — no log line because
    # the volume would be high (every snapshot fetch during setup) and
    # the cause is not a bug, it's policy.
    return None


__all__ = ["compute_progress_pct"]
