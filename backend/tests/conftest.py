"""Shared pytest fixtures.

We force ``TEST_MODE=true`` on every test run so the API key check is bypassed.
"""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("TEST_MODE", "true")
os.environ.setdefault("SESSION_SECRET", "x" * 32)


@pytest.fixture(autouse=True)
def _reset_settings_singleton() -> None:
    from app.config import reset_settings_cache

    reset_settings_cache()
