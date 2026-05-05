"""Regression tests for ``configure_logging``'s capsys-friendly config.

Without the per-call ``sys.stdout`` lookup + disabled logger cache,
the failure mode is:

  1. Test A creates a TestClient → ``configure_logging`` runs →
     structlog caches a bound logger pinned to test A's capsys buffer.
  2. Test B uses ``capsys`` to capture log output. The cached logger
     writes to test A's (now-closed) buffer; test B's capsys sees
     ``''``; the test fails with ``ValueError: I/O operation on
     closed file`` bubbling out of structlog's ``_output.py``.

These tests lock the contract in. There used to be a ``test_mode``
toggle on ``configure_logging`` (driven by ``Settings.test_mode``);
the unified config we ship today applies the test-friendly behaviour
unconditionally so tests don't need a flag to opt in.
"""

from __future__ import annotations

import io
import sys

import pytest
import structlog

from app.config import Settings
from app.logging_setup import configure_logging, get_logger


def _settings() -> Settings:
    return Settings(SESSION_SECRET="x" * 32)  # type: ignore[call-arg]


def test_logger_caching_is_disabled() -> None:
    """``configure_logging`` must NOT cache loggers on first use, so
    capsys-using tests see a fresh logger bound to the current
    ``sys.stdout``.
    """

    structlog.reset_defaults()
    configure_logging(_settings())
    cfg = structlog.get_config()
    assert cfg["cache_logger_on_first_use"] is False


def test_logger_writes_to_current_stdout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``PrintLoggerFactory`` must look up ``sys.stdout`` per call (not
    at config time) so a stdout swap between log calls is observed.
    Without this, even with caching off, a frozen ``file=`` argument
    would still write to the original buffer.
    """

    structlog.reset_defaults()
    configure_logging(_settings())
    logger = get_logger("test")

    buffer1 = io.StringIO()
    monkeypatch.setattr(sys, "stdout", buffer1)
    logger.info("first_message")
    assert "first_message" in buffer1.getvalue()

    buffer2 = io.StringIO()
    monkeypatch.setattr(sys, "stdout", buffer2)
    logger.info("second_message")
    assert "second_message" in buffer2.getvalue(), (
        "second log call must write to the *new* stdout, not the captured "
        "one — confirms PrintLoggerFactory looks up sys.stdout per call"
    )
    # And the first buffer should NOT have grown — frozen-stream regression
    # would have appended to buffer1 instead.
    assert "second_message" not in buffer1.getvalue()
