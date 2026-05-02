"""Notepad ↔ play-prompt isolation regression net (issue #98).

The shared markdown notepad is **strictly AAR-only** in v1: it must NOT
appear in any model-facing string built for the play / setup / interject
/ guardrail tiers. A user can write things into the notepad mid-exercise
("I think the next inject will be ransom"); leaking that into the play
prompt would let the AI "cheat" off the players' planning notes.

This test plants a canary into ``session.notepad.markdown_snapshot`` and
asserts the canary string is absent from every play-tier prompt builder
and the kickoff / turn-reminder / recovery scaffolding the turn-driver
appends. It is a positive companion test in ``test_aar_export.py`` that
asserts the canary IS present in the AAR user payload.

If this test fails, audit every diff that touched ``app/llm/prompts.py``,
``app/sessions/turn_driver.py``, ``app/sessions/turn_validator.py``, or
``app/llm/export.py`` since the last green run — one of them likely
folded ``session.notepad.markdown_snapshot`` (or a derived field) into
a model-facing string.
"""

from __future__ import annotations

from app.extensions.models import ExtensionBundle
from app.extensions.registry import freeze_bundle
from app.llm.prompts import (
    INTERJECT_NOTE,
    build_guardrail_system_blocks,
    build_play_system_blocks,
    build_setup_system_blocks,
)
from app.sessions.models import (
    Role,
    ScenarioBeat,
    ScenarioInject,
    ScenarioPlan,
    Session,
    SessionState,
)
from app.sessions.turn_driver import _KICKOFF_USER_MSG, _TURN_REMINDER
from app.sessions.turn_validator import (
    _DRIVE_RECOVERY_NOTE,
    _DRIVE_RECOVERY_USER_NUDGE_BASE,
    _DRIVE_RECOVERY_USER_NUDGE_TEMPLATE,
    _STRICT_YIELD_NOTE,
    _STRICT_YIELD_USER_NUDGE,
)

CANARY = "__NOTEPAD_LEAK_CANARY_DO_NOT_LEAK__"


def _session_with_notepad_canary() -> Session:
    """Build a minimally-valid Session whose notepad contains the canary
    in every plausible carrier field — markdown_snapshot is the AAR's
    source of truth, but a paranoid future regression might serialize
    the template_id, contributor list, or pinned_message_ids into a
    prompt block. Plant the canary in all of them."""
    session = Session(
        scenario_prompt="ransomware exercise",
        state=SessionState.AI_PROCESSING,
        plan=ScenarioPlan(
            title="Ransomware",
            executive_summary="Ransomware exercise",
            key_objectives=["Contain blast radius"],
            narrative_arc=[
                ScenarioBeat(beat=1, label="Detection", expected_actors=["SOC"]),
            ],
            injects=[
                ScenarioInject(trigger="T+0", type="event", summary="Beacon detected"),
            ],
        ),
        roles=[
            Role(label="CISO", id="r_ciso", is_creator=True),
            Role(label="IR Lead", id="r_ir"),
        ],
        creator_role_id="r_ciso",
    )
    session.notepad.markdown_snapshot = (
        f"## Timeline\nT+02:14 — {CANARY}\n\n"
        f"## Action Items\n- [ ] {CANARY} — @ir\n"
    )
    session.notepad.template_id = f"custom-{CANARY}"
    session.notepad.contributor_role_ids.append("r_ciso")
    session.notepad.pinned_message_ids.append(f"msg-{CANARY}")
    return session


def _empty_registry():
    return freeze_bundle(ExtensionBundle())


def _flatten_blocks(blocks: list[dict]) -> str:
    """Concatenate all text fields from a system-block list."""
    return "\n".join(b.get("text", "") for b in blocks)


def test_notepad_canary_absent_from_play_system_blocks() -> None:
    session = _session_with_notepad_canary()
    text = _flatten_blocks(
        build_play_system_blocks(session, registry=_empty_registry())
    )
    assert CANARY not in text, "notepad content leaked into play system blocks"


def test_notepad_canary_absent_from_setup_system_blocks() -> None:
    session = _session_with_notepad_canary()
    session.state = SessionState.SETUP
    text = _flatten_blocks(build_setup_system_blocks(session))
    assert CANARY not in text, "notepad content leaked into setup system blocks"


def test_notepad_canary_absent_from_guardrail_system_blocks() -> None:
    text = _flatten_blocks(build_guardrail_system_blocks())
    assert CANARY not in text, "notepad content leaked into guardrail system blocks"


def test_notepad_canary_absent_from_turn_scaffolding() -> None:
    """The turn-driver's kickoff message, reminder, and recovery
    directives are all model-facing strings appended to the user-message
    list. They are static templates, but a future change might
    interpolate session state into them — verify none echoes the
    notepad."""
    static_pieces = (
        _KICKOFF_USER_MSG,
        _TURN_REMINDER,
        INTERJECT_NOTE,
        _DRIVE_RECOVERY_NOTE,
        _DRIVE_RECOVERY_USER_NUDGE_BASE,
        _DRIVE_RECOVERY_USER_NUDGE_TEMPLATE,
        _STRICT_YIELD_NOTE,
        _STRICT_YIELD_USER_NUDGE,
    )
    for piece in static_pieces:
        assert CANARY not in piece, f"canary leaked into turn scaffolding: {piece[:80]!r}"
