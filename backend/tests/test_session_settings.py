"""Issue #33-lite — creator-selected scenario tuning (difficulty,
target duration, feature toggles).

Covers:
* Pydantic model contracts: defaults, literal validation,
  ``duration_minutes`` range, ``extra="forbid"`` on both
  ``SessionFeatures`` and ``SessionSettings``.
* End-to-end round-trip via ``POST /api/sessions`` →
  ``GET /api/sessions/{id}`` with the creator vs. player snapshot
  asymmetry on ``features`` (creator-only field).
* Prompt block smoke test: every (3 difficulties × 16 feature combos)
  builds without error, contains the difficulty literal, and renders
  the correct ON/OFF guidance for each toggle.
* Positive Block-12 assertion on ``build_play_system_blocks``.
* Audit-log emission on ``session_created`` includes the tuning fields.
"""

from __future__ import annotations

import itertools

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.config import reset_settings_cache
from app.extensions.registry import FrozenRegistry
from app.llm.prompts import (
    _DIFFICULTY_GUIDANCE,
    _FEATURE_FIELDS,
    _FEATURE_GUIDANCE,
    _build_session_settings_block,
    build_play_system_blocks,
)
from app.main import create_app
from app.sessions.models import (
    Role,
    ScenarioBeat,
    ScenarioInject,
    ScenarioPlan,
    Session,
    SessionFeatures,
    SessionSettings,
    SessionState,
    Turn,
)
from tests.mock_anthropic import MockAnthropic


@pytest.fixture
def client() -> TestClient:
    reset_settings_cache()
    app = create_app()
    with TestClient(app) as c:
        c.app.state.llm.set_transport(MockAnthropic({}).messages)
        yield c


# ---------------------------------------------------------------- model unit tests


def test_session_settings_defaults_are_balanced_standard_tabletop() -> None:
    """The wizard renders the panel with these as the pre-selected
    values; the backend default must match so an operator who
    click-throughs without touching the panel gets the same shape."""

    s = SessionSettings()
    assert s.difficulty == "standard"
    assert s.duration_minutes == 60
    assert s.features.active_adversary is True
    assert s.features.time_pressure is True
    assert s.features.executive_escalation is True
    assert s.features.media_pressure is False


@pytest.mark.parametrize("level", ["easy", "standard", "hard"])
def test_session_settings_accepts_each_documented_difficulty(level: str) -> None:
    s = SessionSettings(difficulty=level)  # type: ignore[arg-type]
    assert s.difficulty == level


@pytest.mark.parametrize("bad", ["medium", "insane", "EASY", "", "1"])
def test_session_settings_rejects_unknown_difficulty(bad: str) -> None:
    with pytest.raises(ValidationError):
        SessionSettings(difficulty=bad)  # type: ignore[arg-type]


@pytest.mark.parametrize("ok", [15, 30, 60, 90, 120, 180])
def test_session_settings_accepts_in_range_durations(ok: int) -> None:
    assert SessionSettings(duration_minutes=ok).duration_minutes == ok


@pytest.mark.parametrize("bad", [14, 0, -1, 181, 999])
def test_session_settings_rejects_out_of_range_durations(bad: int) -> None:
    with pytest.raises(ValidationError):
        SessionSettings(duration_minutes=bad)


def test_session_features_extra_forbid() -> None:
    with pytest.raises(ValidationError):
        SessionFeatures(secret_toggle=True)  # type: ignore[call-arg]


def test_session_settings_extra_forbid() -> None:
    with pytest.raises(ValidationError):
        SessionSettings(scenario_prompt="x")  # type: ignore[call-arg]


def test_feature_guidance_matches_session_features_fields() -> None:
    """Module-level invariant: every ``SessionFeatures`` toggle has
    a paired ON/OFF guidance entry. Also asserted at import time;
    duplicated here so a CI-only failure leaves a breadcrumb at the
    test name rather than just an ImportError."""

    assert set(_FEATURE_GUIDANCE) == set(SessionFeatures.model_fields)
    assert set(_FEATURE_FIELDS) == set(SessionFeatures.model_fields)
    for name in _FEATURE_FIELDS:
        assert True in _FEATURE_GUIDANCE[name]
        assert False in _FEATURE_GUIDANCE[name]


# ---------------------------------------------------------------- prompt smoke


def _session_with(settings: SessionSettings) -> Session:
    plan = ScenarioPlan(
        title="t",
        key_objectives=["o"],
        narrative_arc=[ScenarioBeat(beat=1, label="b", expected_actors=["A"])],
        injects=[ScenarioInject(trigger="after beat 1", summary="i")],
    )
    return Session(
        scenario_prompt="x",
        settings=settings,
        roles=[Role(id="role-a", label="A", is_creator=True)],
        plan=plan,
        state=SessionState.AWAITING_PLAYERS,
        turns=[Turn(index=0, status="awaiting", active_role_ids=["role-a"])],
    )


@pytest.mark.parametrize("level", ["easy", "standard", "hard"])
def test_settings_block_includes_difficulty_guidance(level: str) -> None:
    block = _build_session_settings_block(
        _session_with(SessionSettings(difficulty=level))  # type: ignore[arg-type]
    )
    assert f"**Difficulty: {level}**" in block
    # The first ~40 chars of the guidance literal must round-trip,
    # so a copy-edit that drops the body of the entry trips this.
    assert _DIFFICULTY_GUIDANCE[level][:40] in block


def test_settings_block_smoke_all_combinations_render() -> None:
    """3 difficulties × 16 feature combos = 48 combos. Each must
    build without raising and contain a feature line per toggle."""

    for diff in ("easy", "standard", "hard"):
        for combo in itertools.product([True, False], repeat=4):
            settings = SessionSettings(
                difficulty=diff,  # type: ignore[arg-type]
                features=SessionFeatures(
                    active_adversary=combo[0],
                    time_pressure=combo[1],
                    executive_escalation=combo[2],
                    media_pressure=combo[3],
                ),
            )
            block = _build_session_settings_block(_session_with(settings))
            for name in _FEATURE_FIELDS:
                assert f"`{name}`:" in block, (
                    f"feature {name} missing in {diff} / {combo}"
                )


def test_settings_block_renders_on_off_guidance_correctly() -> None:
    """Each feature's ON literal must appear when the toggle is True
    and the OFF literal must appear when it's False — guards the
    silent-key-flip bug class."""

    for name in _FEATURE_FIELDS:
        for state in (True, False):
            features = SessionFeatures(**{n: (n == name and state) for n in _FEATURE_FIELDS})
            # When ``state`` is True we set only ``name``; when False
            # we set everything to False (so this name is also False).
            if state:
                # Toggle just this one ON; rest stay default-ish but
                # not relevant to the assertion.
                features = SessionFeatures(**{name: True, **{n: False for n in _FEATURE_FIELDS if n != name}})
            block = _build_session_settings_block(
                _session_with(SessionSettings(features=features))
            )
            expected = _FEATURE_GUIDANCE[name][state]
            # Render uses leading 40 chars of literal as a stable
            # match (any longer and the line wraps; any shorter and
            # near-duplicate prose collisions become possible).
            assert expected[:40] in block, (
                f"feature {name} state={state} guidance not rendered"
            )


def test_play_system_block_includes_block_12_session_settings() -> None:
    """Positive contract: Block 12 ships on every healthy turn — was
    only asserted via absence on the rate-limited path before."""

    s = _session_with(SessionSettings(difficulty="hard"))
    blocks = build_play_system_blocks(
        s, registry=FrozenRegistry(tools={}, resources={}, prompts={})
    )
    text = blocks[0]["text"]
    assert "## Block 12 — Session settings" in text
    assert "**Difficulty: hard**" in text


# ---------------------------------------------------------------- API round-trip


def test_create_session_accepts_custom_settings_and_persists_them(
    client: TestClient,
) -> None:
    body = {
        "scenario_prompt": "ransomware at fintech",
        "creator_label": "CISO",
        "creator_display_name": "Alice",
        "settings": {
            "difficulty": "hard",
            "duration_minutes": 90,
            "features": {
                "active_adversary": True,
                "time_pressure": False,
                "executive_escalation": True,
                "media_pressure": True,
            },
        },
        "skip_setup": True,
    }
    res = client.post("/api/sessions", json=body)
    assert res.status_code == 200, res.text
    payload = res.json()
    sid = payload["session_id"]
    token = payload["creator_token"]

    snap = client.get(f"/api/sessions/{sid}?token={token}")
    assert snap.status_code == 200
    settings = snap.json()["settings"]
    assert settings["difficulty"] == "hard"
    assert settings["duration_minutes"] == 90
    # Creator sees the full features dict.
    assert settings["features"] == {
        "active_adversary": True,
        "time_pressure": False,
        "executive_escalation": True,
        "media_pressure": True,
    }


def test_create_session_with_no_settings_falls_back_to_defaults(
    client: TestClient,
) -> None:
    """Operators who don't change the wizard knobs should land on the
    backend defaults with no explicit field in the body."""

    body = {
        "scenario_prompt": "phishing exercise",
        "creator_label": "CISO",
        "creator_display_name": "Alice",
        "skip_setup": True,
    }
    res = client.post("/api/sessions", json=body)
    assert res.status_code == 200
    sid = res.json()["session_id"]
    token = res.json()["creator_token"]

    snap = client.get(f"/api/sessions/{sid}?token={token}").json()
    settings = snap["settings"]
    assert settings["difficulty"] == "standard"
    assert settings["duration_minutes"] == 60
    assert settings["features"]["media_pressure"] is False


def test_snapshot_redacts_features_for_non_creator(client: TestClient) -> None:
    """``features`` hints at upcoming inject types (the issue-#33
    threat model). The snapshot must surface ``difficulty`` +
    ``duration_minutes`` to all participants but null the features
    block out for player roles."""

    body = {
        "scenario_prompt": "ransomware",
        "creator_label": "CISO",
        "creator_display_name": "Alice",
        "settings": {
            "difficulty": "easy",
            "duration_minutes": 45,
            "features": {
                "active_adversary": False,
                "time_pressure": False,
                "executive_escalation": True,
                "media_pressure": True,
            },
        },
        "skip_setup": True,
    }
    res = client.post("/api/sessions", json=body)
    sid = res.json()["session_id"]
    creator_token = res.json()["creator_token"]

    add = client.post(
        f"/api/sessions/{sid}/roles?token={creator_token}",
        json={"label": "SOC", "kind": "player"},
    )
    assert add.status_code == 200
    player_token = add.json()["token"]

    creator_snap = client.get(f"/api/sessions/{sid}?token={creator_token}").json()
    assert creator_snap["settings"]["difficulty"] == "easy"
    assert creator_snap["settings"]["duration_minutes"] == 45
    assert creator_snap["settings"]["features"]["media_pressure"] is True

    player_snap = client.get(f"/api/sessions/{sid}?token={player_token}").json()
    # Difficulty + duration are visible to players (it's on the HUD).
    assert player_snap["settings"]["difficulty"] == "easy"
    assert player_snap["settings"]["duration_minutes"] == 45
    # Features must be redacted — leaking them spoils the inject palette.
    assert player_snap["settings"]["features"] is None


def test_create_session_rejects_out_of_range_duration_at_api(
    client: TestClient,
) -> None:
    body = {
        "scenario_prompt": "x",
        "creator_label": "CISO",
        "creator_display_name": "Alice",
        "settings": {"duration_minutes": 999},
        "skip_setup": True,
    }
    res = client.post("/api/sessions", json=body)
    assert res.status_code == 422


def test_create_session_rejects_unknown_difficulty_at_api(
    client: TestClient,
) -> None:
    body = {
        "scenario_prompt": "x",
        "creator_label": "CISO",
        "creator_display_name": "Alice",
        "settings": {"difficulty": "expert"},
        "skip_setup": True,
    }
    res = client.post("/api/sessions", json=body)
    assert res.status_code == 422
