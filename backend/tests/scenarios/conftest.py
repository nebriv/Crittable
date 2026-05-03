"""Shared fixtures for scenario-replay tests.

These tests drive `app.devtools.runner.ScenarioRunner` against the
deterministic ``MockAnthropic`` transport so the runner — and the
canonical scenario JSON files in ``backend/scenarios/`` — stay in
contract with the engine without burning real tokens.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.config import reset_settings_cache
from app.main import create_app
from tests.mock_anthropic import MockAnthropic, setup_then_play_script


@pytest.fixture(autouse=True)
def _scenario_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_MODEL_PLAY", "mock-play")
    monkeypatch.setenv("ANTHROPIC_MODEL_SETUP", "mock-setup")
    monkeypatch.setenv("ANTHROPIC_MODEL_AAR", "mock-aar")
    monkeypatch.setenv("ANTHROPIC_MODEL_GUARDRAIL", "mock-guardrail")
    monkeypatch.setenv("TEST_MODE", "true")
    monkeypatch.setenv("SESSION_SECRET", "x" * 32)
    monkeypatch.setenv("INPUT_GUARDRAIL_ENABLED", "false")
    # Scenario files repeat content within a single run for some
    # players; mirror the e2e suite's choice and disable the dedupe
    # window so the runner can replay verbatim.
    monkeypatch.setenv("DUPLICATE_SUBMISSION_WINDOW_SECONDS", "0")
    monkeypatch.setenv("DEV_TOOLS_ENABLED", "true")
    reset_settings_cache()


@pytest.fixture
def client() -> Iterator[TestClient]:
    """Boot a fresh app per test with a benign default mock installed."""

    app = create_app()
    with TestClient(app) as c:
        c.app.state.llm.set_transport(MockAnthropic({}).messages)
        yield c


@pytest.fixture
def install_mock_for_roles():
    """Install a richer mock script keyed off a role_id list. Returns a
    callable so the test can re-install after creating roles."""

    def _install(client: TestClient, role_ids: list[str]) -> MockAnthropic:
        scripts = setup_then_play_script(
            role_ids=role_ids, extension_tool=None, fire_critical=False
        )
        mock = MockAnthropic(scripts)
        client.app.state.llm.set_transport(mock.messages)
        return mock

    return _install
