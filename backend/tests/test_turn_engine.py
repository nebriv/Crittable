from __future__ import annotations

import pytest

from app.auth.audit import AuditLog
from app.llm.client import LLMResult
from app.sessions.models import Session, SessionState, Turn
from app.sessions.turn_driver import TurnDriver
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
    # Wave 1 (issue #134): an active role can submit again on the same
    # turn (e.g. a discussion follow-up before signalling ready).
    # ``can_submit`` no longer caps at one-per-role.
    assert can_submit(turn, "r1") is True
    turn.submitted_role_ids = ["r1", "r2"]
    assert all_submitted(turn) is True
    # Once status flips off "awaiting", nobody can submit anymore.
    turn.status = "processing"
    assert can_submit(turn, "r1") is False


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


class _StubManager:
    """Minimal SessionManager stand-in for ``TurnDriver._check_truncation``.

    The method only touches ``self._manager.audit()``; constructing a full
    manager (which needs an LLM client, dispatcher, registry, settings,
    repository, …) just to exercise an audit emission would be churn.
    """

    def __init__(self, audit: AuditLog) -> None:
        self._audit = audit

    def audit(self) -> AuditLog:
        return self._audit


def _llm_result(*, stop_reason: str, output: int = 1024) -> LLMResult:
    return LLMResult(
        model="claude-test",
        content=[],
        stop_reason=stop_reason,
        usage={"input": 0, "output": output, "cache_read": 0, "cache_creation": 0},
        estimated_usd=0.0,
    )


def test_check_truncation_records_output_token_count() -> None:
    """Regression for PR #60: the audit payload + log line must read
    ``LLMResult.usage["output"]`` (the normalized key emitted by
    ``_normalize_response``), not ``"output_tokens"`` (the raw
    Anthropic key, which is always absent post-normalization). A
    silent ``None`` would defeat the whole point of surfacing
    ``llm_truncated`` to the operator panel.
    """

    audit = AuditLog(ring_size=10)
    driver = TurnDriver(manager=_StubManager(audit))
    result = _llm_result(stop_reason="max_tokens", output=1024)
    driver._check_truncation(session_id="s1", tier="setup", result=result)

    events = audit.dump("s1")
    assert len(events) == 1
    evt = events[0]
    assert evt.kind == "llm_truncated"
    assert evt.payload["output_tokens"] == 1024
    assert evt.payload["tier"] == "setup"
    assert "LLM_MAX_TOKENS_SETUP" in evt.payload["hint"]


def test_check_truncation_noop_on_other_stop_reasons() -> None:
    audit = AuditLog(ring_size=10)
    driver = TurnDriver(manager=_StubManager(audit))
    driver._check_truncation(
        session_id="s1",
        tier="setup",
        result=_llm_result(stop_reason="end_turn"),
    )
    assert audit.dump("s1") == []
