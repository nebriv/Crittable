"""Regression tests for ``SessionManager._emit``'s payload filter.

The ``_emit`` helper logs a structlog ``session_event`` line carrying
``audit_kind`` / ``session_id`` / ``state`` / ``turn_index`` from the
session itself. Callers (notably ``open_turn``) also pass payload
kwargs that historically *re-included* one of these names — silently
overwriting the manager-derived value.

Once ``cache_logger_on_first_use`` is disabled (the test_mode path
landed in PR #122 / scenario-replay system), the duplicate kwarg
raises ``TypeError`` from inside structlog's bound logger. This file
locks in the filter that strips reserved keys from ``payload`` before
forwarding to the logger, so a future regression that re-introduces
the duplicate trips here loudly.
"""

from __future__ import annotations

import pytest

from app.auth.audit import AuditLog
from app.config import get_settings, reset_settings_cache
from app.sessions.manager import SessionManager
from app.sessions.models import Session, SessionState
from app.sessions.repository import InMemoryRepository


@pytest.fixture
def manager() -> SessionManager:
    reset_settings_cache()
    settings = get_settings()
    return SessionManager(
        settings=settings,
        repository=InMemoryRepository(),
        connections=_NoopConnections(),  # type: ignore[arg-type]
        audit=AuditLog(ring_size=settings.audit_ring_size),
        llm=_NoopLLM(),  # type: ignore[arg-type]
        guardrail=_NoopGuardrail(),  # type: ignore[arg-type]
        tool_dispatcher=_NoopDispatcher(),  # type: ignore[arg-type]
        extension_registry=_NoopRegistry(),  # type: ignore[arg-type]
        authn=_NoopAuthn(),  # type: ignore[arg-type]
    )


class _NoopConnections:
    async def broadcast(self, *_args, **_kwargs) -> None:  # pragma: no cover
        return None

    async def send_to_role(self, *_args, **_kwargs) -> None:  # pragma: no cover
        return None


class _NoopLLM:
    pass


class _NoopGuardrail:
    async def classify(self, *, message: str) -> str:
        return "ok"


class _NoopDispatcher:
    pass


class _NoopRegistry:
    pass


class _NoopAuthn:
    pass


def _session() -> Session:
    return Session(
        id="s-test",
        scenario_prompt="x",
        state=SessionState.CREATED,
    )


def test_emit_drops_reserved_keys_from_payload(
    manager: SessionManager, capsys: pytest.CaptureFixture[str]
) -> None:
    """``_emit`` must NOT forward ``audit_kind`` / ``session_id`` /
    ``state`` / ``turn_index`` from payload to the logger — those
    names are set explicitly above the kwargs splat and a duplicate
    is a structlog ``TypeError`` once caching is off.

    The reserved-key filter also drops them from the audit-event
    payload? No — the audit event keeps them (it's a record of what
    the caller said). Only the *log line* dedupes.
    """

    sess = _session()
    # Should not raise — even though we pass turn_index= explicitly,
    # the filter strips it before forwarding to the logger.
    manager._emit(
        "test_kind",
        sess,
        turn_index=999,
        session_id="ignored-by-filter",
        state="ignored-by-filter",
        audit_kind="ignored-by-filter",
        custom_field="kept",
    )
    log_blob = capsys.readouterr().out
    assert "session_event" in log_blob
    # The session-derived turn_index (None for a session with no
    # current_turn) wins over the explicit 999. Asserting on the
    # presence of the custom field proves the kwargs splat fired.
    assert "custom_field" in log_blob
    assert "kept" in log_blob


def test_emit_does_not_raise_on_duplicate_turn_index(
    manager: SessionManager,
) -> None:
    """The smoking-gun case: ``open_turn`` passes ``turn_index=`` in
    payload. Without the filter the logger raises ``TypeError: got
    multiple values for keyword argument 'turn_index'``."""

    sess = _session()
    # Multiple reserved-key collisions in one call — none should bubble.
    manager._emit("test_kind", sess, turn_index=42, session_id="x", state="y")
