"""Regression tests for the test-mode branch of ``configure_logging``.

The branch (added with the scenario-replay system) disables structlog's
``cache_logger_on_first_use`` flag and stops pinning ``PrintLoggerFactory``
to a captured ``sys.stdout`` reference, so ``capsys``-using unit tests
don't cross-pollute when one test boots a TestClient and a later test
swaps stdout.

Without this branch the failure mode is:

  1. Test A creates a TestClient → ``configure_logging`` runs → structlog
     caches the bound logger pinned to test A's capsys buffer.
  2. Test B uses ``capsys`` to capture log output. The cached logger
     writes to test A's (now-closed) buffer; test B's capsys sees ``''``;
     the test fails with ``ValueError: I/O operation on closed file``
     bubbling out of structlog's ``_output.py``.

These tests lock the contract in.
"""

from __future__ import annotations

import io
import sys

import pytest
import structlog

from app.config import Settings
from app.logging_setup import configure_logging, get_logger


def _settings_with(test_mode: bool) -> Settings:
    return Settings(
        TEST_MODE=test_mode,  # type: ignore[call-arg]
        SESSION_SECRET="x" * 32,  # type: ignore[call-arg]
    )


def test_test_mode_disables_logger_caching() -> None:
    """``configure_logging(test_mode=True)`` must NOT cache loggers
    on first use. The structlog config exposes the flag via
    ``structlog.get_config()``.
    """

    structlog.reset_defaults()
    configure_logging(_settings_with(test_mode=True))
    cfg = structlog.get_config()
    assert cfg["cache_logger_on_first_use"] is False, (
        "test_mode must disable structlog's cache so capsys-using tests "
        "see a fresh logger bound to the current sys.stdout"
    )


def test_production_mode_enables_logger_caching() -> None:
    """The non-test branch keeps the production-friendly cache enabled."""

    structlog.reset_defaults()
    configure_logging(_settings_with(test_mode=False))
    cfg = structlog.get_config()
    assert cfg["cache_logger_on_first_use"] is True


def test_test_mode_logger_writes_to_current_stdout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Beyond the flag, ``PrintLoggerFactory`` must look up
    ``sys.stdout`` per call (not at config time) so a stdout swap
    between log calls is observed. Without this, even with caching
    off, the factory's frozen ``file=`` argument would still write to
    the original buffer.
    """

    structlog.reset_defaults()
    configure_logging(_settings_with(test_mode=True))
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
