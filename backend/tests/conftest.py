"""Shared pytest fixtures.

We inject a dummy ``ANTHROPIC_API_KEY`` so ``Settings.require_anthropic_key()``
boots without a real key, and turn on ``AAR_INLINE_ON_END`` so end-to-end
tests that drive a session through ``/end`` get a ready AAR back from the
follow-up ``GET /export.md`` poll (Starlette's sync ``TestClient`` does
not reliably progress cross-request ``asyncio.create_task`` work).

``DUMMY_ANTHROPIC_API_KEY`` is the load-bearing tripwire string: the
live-test fixtures pop it on collection and assert it's never the
resolved key when calling Anthropic. Importing it from this module
keeps the three callsites (this conftest, ``tests/live/conftest.py``,
``tests/live/test_aar_quality_judge.py``) in lockstep — drift would
silently disarm the assertions.
"""

from __future__ import annotations

import os

import pytest

DUMMY_ANTHROPIC_API_KEY = "dummy-key-for-tests"

os.environ.setdefault("ANTHROPIC_API_KEY", DUMMY_ANTHROPIC_API_KEY)
os.environ.setdefault("SESSION_SECRET", "x" * 32)
os.environ.setdefault("AAR_INLINE_ON_END", "true")


@pytest.fixture(autouse=True)
def _reset_settings_singleton() -> None:
    from app.config import reset_settings_cache

    reset_settings_cache()


def default_settings_body() -> dict[str, object]:
    """Wire-shape ``settings`` block matching ``SessionSettings`` defaults.

    Every test that POSTs ``/api/sessions`` must include a populated
    ``settings`` key — the field is required on the wire (CLAUDE.md
    forbids optional-with-default wire shims). Tests that don't care
    about specific tuning values spread this helper into the body
    instead of hand-rolling the default dict at every call site.
    """

    return {
        "settings": {
            "difficulty": "standard",
            "duration_minutes": 60,
            "features": {
                "active_adversary": True,
                "time_pressure": True,
                "executive_escalation": True,
                "media_pressure": False,
            },
        },
    }
