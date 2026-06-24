"""C1(b) — fail-closed front-door boot gate in ``create_app``.

On a real deploy (``CORS_ORIGINS`` narrowed away from ``*``) the
session-create path must have *some* protection — either ``INVITE_CODES``
or a non-zero ``SESSION_CREATE_RATE_PER_MIN``. With neither, an
anonymous caller can loop ``POST /api/sessions`` and burn setup-tier LLM
tokens. The gate raises at import time (mirroring
``require_llm_api_key``) so uvicorn exits non-zero instead of silently
booting an exposed deploy.

Local / toy deploys (``CORS_ORIGINS="*"``) are untouched.
"""

from __future__ import annotations

import pytest

from app.config import reset_settings_cache
from app.main import create_app


@pytest.fixture(autouse=True)
def _base_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_API_KEY", "x")
    monkeypatch.setenv("SESSION_SECRET", "x" * 32)
    # Clear any ambient INVITE_CODES so the no-front-door tests actually
    # exercise the "no door" branch. A leaked code in the runner's env
    # would otherwise satisfy the front-door gate and silently flip
    # ``test_boot_fails_*`` from a real assertion into a no-op (QA review,
    # PR3). The var was renamed from the old singular INVITE_CODE; the
    # stale per-test ``delenv("INVITE_CODE")`` calls were no-ops.
    monkeypatch.delenv("INVITE_CODES", raising=False)


def test_boot_fails_on_real_deploy_with_no_front_door(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CORS_ORIGINS", "https://crit.example.com")
    monkeypatch.setenv("SESSION_CREATE_RATE_PER_MIN", "0")
    reset_settings_cache()
    with pytest.raises(RuntimeError, match="front-door"):
        create_app()


def test_boot_ok_real_deploy_with_create_rate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CORS_ORIGINS", "https://crit.example.com")
    monkeypatch.setenv("SESSION_CREATE_RATE_PER_MIN", "5")
    reset_settings_cache()
    # Should not raise.
    create_app()


def test_boot_ok_real_deploy_with_invite_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CORS_ORIGINS", "https://crit.example.com")
    monkeypatch.setenv("INVITE_CODES", '[{"code": "tabletop-2026"}]')
    monkeypatch.setenv("SESSION_CREATE_RATE_PER_MIN", "0")
    reset_settings_cache()
    create_app()


def test_boot_ok_local_deploy_even_with_no_front_door(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """CORS_ORIGINS='*' is a local/toy deploy — the gate stays out of
    the way so dev is frictionless."""

    monkeypatch.setenv("CORS_ORIGINS", "*")
    monkeypatch.setenv("SESSION_CREATE_RATE_PER_MIN", "0")
    reset_settings_cache()
    create_app()
