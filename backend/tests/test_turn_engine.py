from __future__ import annotations

import pytest

from app.sessions.models import Session, SessionState, Turn
from app.sessions.turn_engine import (
    IllegalTransitionError,
    all_submitted,
    assert_plan_edit_field,
    assert_transition,
    can_submit,
    critical_inject_allowed,
    record_critical_inject,
)


def _session() -> Session:
    return Session(scenario_prompt="x")


def test_legal_transitions() -> None:
    assert_transition(SessionState.CREATED, SessionState.SETUP)
    assert_transition(SessionState.SETUP, SessionState.READY)
    assert_transition(SessionState.READY, SessionState.BRIEFING)
    assert_transition(SessionState.BRIEFING, SessionState.AWAITING_PLAYERS)
    assert_transition(SessionState.AWAITING_PLAYERS, SessionState.AI_PROCESSING)
    assert_transition(SessionState.AI_PROCESSING, SessionState.AWAITING_PLAYERS)
    assert_transition(SessionState.AWAITING_PLAYERS, SessionState.ENDED)


def test_illegal_transitions() -> None:
    with pytest.raises(IllegalTransitionError):
        assert_transition(SessionState.CREATED, SessionState.READY)
    with pytest.raises(IllegalTransitionError):
        assert_transition(SessionState.ENDED, SessionState.SETUP)
    with pytest.raises(IllegalTransitionError):
        assert_transition(SessionState.SETUP, SessionState.AI_PROCESSING)


def test_can_submit_and_all_submitted() -> None:
    turn = Turn(index=0, active_role_ids=["r1", "r2"])
    assert can_submit(turn, "r1") is True
    assert can_submit(turn, "rX") is False
    turn.submitted_role_ids = ["r1"]
    assert all_submitted(turn) is False
    assert can_submit(turn, "r1") is False  # already submitted
    turn.submitted_role_ids = ["r1", "r2"]
    assert all_submitted(turn) is True


def test_plan_edit_allow_list() -> None:
    assert_plan_edit_field("guardrails")
    with pytest.raises(IllegalTransitionError):
        assert_plan_edit_field("title")


def test_critical_inject_rate_limit() -> None:
    s = _session()
    s.turns.append(Turn(index=0, active_role_ids=[]))
    assert critical_inject_allowed(s, max_per_5_turns=1) is True
    record_critical_inject(s)
    assert critical_inject_allowed(s, max_per_5_turns=1) is False
    # Advance the turn index by 6 — window slides
    s.turns.append(Turn(index=6, active_role_ids=[]))
    assert critical_inject_allowed(s, max_per_5_turns=1) is True
