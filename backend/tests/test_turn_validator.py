"""Pure-function tests for the turn validator.

The validator is intentionally I/O-free; these tests cover its
behaviour at the unit level without spinning a TestClient. End-to-end
behaviour (recovery LLM calls actually firing) is covered in
``test_e2e_session.py``.
"""

from __future__ import annotations

from app.sessions.models import (
    Message,
    MessageKind,
    Role,
    ScenarioBeat,
    ScenarioInject,
    ScenarioPlan,
    Session,
    SessionState,
)
from app.sessions.slots import Slot
from app.sessions.turn_validator import (
    PLAY_CONTRACT_BRIEFING,
    PLAY_CONTRACT_INTERJECT,
    PLAY_CONTRACT_NORMAL,
    contract_for,
    drive_recovery_directive,
    order_directives,
    strict_yield_directive,
    validate,
)


def _session(*, state: SessionState = SessionState.AWAITING_PLAYERS) -> Session:
    return Session(
        scenario_prompt="x",
        state=state,
        roles=[Role(id="role-a", label="A", is_creator=True)],
        plan=ScenarioPlan(
            title="t",
            key_objectives=["o"],
            narrative_arc=[ScenarioBeat(beat=1, label="b", expected_actors=["A"])],
            injects=[ScenarioInject(trigger="after beat 1", summary="i")],
        ),
    )


def test_drive_and_yield_satisfied_validates_ok() -> None:
    s = _session()
    res = validate(
        session=s,
        cumulative_slots={Slot.DRIVE, Slot.YIELD},
        contract=PLAY_CONTRACT_NORMAL,
    )
    assert res.ok
    assert not res.violations
    assert not res.warnings


def test_terminate_satisfies_yield_requirement() -> None:
    """``end_session`` is a valid yielding outcome — players don't need
    a next active-roles set when the exercise wraps."""

    s = _session()
    res = validate(
        session=s,
        cumulative_slots={Slot.DRIVE, Slot.TERMINATE},
        contract=PLAY_CONTRACT_NORMAL,
    )
    assert res.ok


def test_missing_drive_emits_drive_recovery() -> None:
    s = _session()
    res = validate(
        session=s,
        cumulative_slots={Slot.YIELD, Slot.NARRATE},
        contract=PLAY_CONTRACT_NORMAL,
    )
    assert not res.ok
    kinds = [v.kind for v in res.violations]
    assert kinds == ["missing_drive"]


def test_missing_yield_emits_strict_yield_directive() -> None:
    s = _session()
    res = validate(
        session=s,
        cumulative_slots={Slot.DRIVE},
        contract=PLAY_CONTRACT_NORMAL,
    )
    assert not res.ok
    kinds = [v.kind for v in res.violations]
    assert kinds == ["missing_yield"]


def test_missing_both_emits_drive_then_yield_in_priority_order() -> None:
    """Compound violation = sequential calls, drive first (priority=10)
    then yield (priority=20). Per the user's plan-design decision."""

    s = _session()
    res = validate(
        session=s,
        cumulative_slots=set(),
        contract=PLAY_CONTRACT_NORMAL,
    )
    assert not res.ok
    ordered = order_directives(res.violations)
    assert [d.kind for d in ordered] == ["missing_drive", "missing_yield"]
    assert ordered[0].tools_allowlist == frozenset({"broadcast"})
    assert ordered[1].tools_allowlist == frozenset({"set_active_roles"})


def test_soft_drive_carve_out_for_open_question() -> None:
    """When the most-recent un-replied player message ends in ``?``
    AND no new beat fired, missing-drive is downgraded to a warning so
    the AI can yield silently while players are mid-discussion."""

    s = _session()
    s.messages.append(
        Message(kind=MessageKind.PLAYER, role_id="role-a", body="What's next?")
    )
    res = validate(
        session=s,
        cumulative_slots={Slot.YIELD},  # no DRIVE, no narrate/pin/escalate
        contract=PLAY_CONTRACT_NORMAL,
    )
    assert res.ok
    assert any("downgraded" in w for w in res.warnings)


def test_soft_drive_carve_out_disabled_when_new_beat_fired() -> None:
    """If the AI moved the story (inject_event / pin / critical) but
    forgot to drive, the carve-out doesn't apply — recovery fires."""

    s = _session()
    s.messages.append(
        Message(kind=MessageKind.PLAYER, role_id="role-a", body="What's next?")
    )
    res = validate(
        session=s,
        cumulative_slots={Slot.YIELD, Slot.NARRATE},
        contract=PLAY_CONTRACT_NORMAL,
    )
    assert not res.ok
    assert [v.kind for v in res.violations] == ["missing_drive"]


def test_briefing_contract_disables_soft_carve_out() -> None:
    """Briefing turn: there's no 'mid-discussion' on the very first
    turn, so a yield without a brief always recovers."""

    s = _session(state=SessionState.BRIEFING)
    s.messages.append(
        Message(kind=MessageKind.PLAYER, role_id="role-a", body="Quick q?")
    )
    res = validate(
        session=s,
        cumulative_slots={Slot.YIELD},
        contract=PLAY_CONTRACT_BRIEFING,
    )
    assert not res.ok
    assert [v.kind for v in res.violations] == ["missing_drive"]


def test_interject_contract_forbids_yield_and_terminate() -> None:
    """Interject path: the asking player has already submitted, others
    still owe responses. AI must drive (answer) but must NOT yield or
    terminate (those are the core forbidden moves)."""

    assert Slot.YIELD in PLAY_CONTRACT_INTERJECT.forbidden_slots
    assert Slot.TERMINATE in PLAY_CONTRACT_INTERJECT.forbidden_slots
    assert Slot.DRIVE in PLAY_CONTRACT_INTERJECT.required_slots


def test_drive_required_kill_switch() -> None:
    """``LLM_RECOVERY_DRIVE_REQUIRED=False`` reverts to pre-validator
    'yield-only' semantics — DRIVE drops out of the required set."""

    contract = contract_for(
        tier="play",
        state=SessionState.AWAITING_PLAYERS,
        mode="normal",
        drive_required=False,
    )
    assert Slot.DRIVE not in contract.required_slots
    assert Slot.YIELD in contract.required_slots


def test_directive_factories_produce_expected_pins() -> None:
    """Factories produce the exact tool_choice + allowlist combos the
    driver passes to the LLM client. Locks the wire format so a future
    factory edit doesn't silently break the recovery flow."""

    drive = drive_recovery_directive()
    assert drive.tools_allowlist == frozenset({"broadcast"})
    assert drive.tool_choice == {"type": "tool", "name": "broadcast"}
    assert drive.priority < 100

    yield_d = strict_yield_directive()
    assert yield_d.tools_allowlist == frozenset({"set_active_roles"})
    assert yield_d.tool_choice == {"type": "tool", "name": "set_active_roles"}
    assert yield_d.priority > drive.priority  # drive runs first
