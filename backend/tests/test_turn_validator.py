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


def test_default_requires_drive_when_player_asks_ai_a_question() -> None:
    """Regression: a player ending a message in ``?`` (i.e. asking the
    AI a direct question) used to trip the carve-out and downgrade
    missing-DRIVE to a warning, causing the AI to silently yield
    without answering. The default kill-switch is now off so missing
    DRIVE always recovers, regardless of the player's punctuation."""

    s = _session()
    s.messages.append(
        Message(
            kind=MessageKind.PLAYER,
            role_id="role-a",
            body="Yeah we can pull account activity via Defender. What do we see?",
        )
    )
    res = validate(
        session=s,
        cumulative_slots={Slot.YIELD},
        contract=PLAY_CONTRACT_NORMAL,
        # No soft_drive_carve_out_enabled arg — relies on the default
        # which mirrors the new production setting default (False).
    )
    assert not res.ok
    assert [v.kind for v in res.violations] == ["missing_drive"]
    assert not any("downgraded" in w for w in res.warnings)


def test_legacy_soft_drive_carve_out_still_works_when_kill_switch_on() -> None:
    """Legacy carve-out path: kept reachable for emergency rollback via
    ``LLM_RECOVERY_DRIVE_SOFT_ON_OPEN_QUESTION=True``. Documents that
    the predicate is wrong (it fires on a player asking the AI a
    question — exactly when DRIVE is mandatory) but still does what
    the original implementation did when the kill-switch is flipped
    on. Do NOT re-enable in production."""

    s = _session()
    s.messages.append(
        Message(kind=MessageKind.PLAYER, role_id="role-a", body="What's next?")
    )
    res = validate(
        session=s,
        cumulative_slots={Slot.YIELD},  # no DRIVE, no narrate/pin/escalate
        contract=PLAY_CONTRACT_NORMAL,
        soft_drive_carve_out_enabled=True,
    )
    assert res.ok
    assert any("downgraded" in w for w in res.warnings)


def test_legacy_carve_out_yields_to_new_beat_when_kill_switch_on() -> None:
    """Even with the legacy kill-switch on, if the AI moved the story
    (inject_event / pin / critical) but forgot to drive, the carve-out
    doesn't apply — recovery fires."""

    s = _session()
    s.messages.append(
        Message(kind=MessageKind.PLAYER, role_id="role-a", body="What's next?")
    )
    res = validate(
        session=s,
        cumulative_slots={Slot.YIELD, Slot.NARRATE},
        contract=PLAY_CONTRACT_NORMAL,
        soft_drive_carve_out_enabled=True,
    )
    assert not res.ok
    assert [v.kind for v in res.violations] == ["missing_drive"]


def test_carve_out_kill_switch_off_overrides_per_contract_flag() -> None:
    """``PLAY_CONTRACT_NORMAL.soft_drive_when_open_question=True`` but
    the operator kill-switch defaults to off; the kill-switch wins.
    A player ``?`` message no longer downgrades the violation."""

    s = _session()
    s.messages.append(
        Message(kind=MessageKind.PLAYER, role_id="role-a", body="What's next?")
    )
    assert PLAY_CONTRACT_NORMAL.soft_drive_when_open_question is True
    res = validate(
        session=s,
        cumulative_slots={Slot.YIELD},
        contract=PLAY_CONTRACT_NORMAL,
        soft_drive_carve_out_enabled=False,  # explicit, mirrors prod default
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


def test_drive_recovery_directive_embeds_pending_question_in_user_nudge() -> None:
    """Recovery grounding: when a player ``?``-message is open, the
    directive's user nudge quotes it verbatim so the model knows
    exactly what to answer (instead of broadcasting a generic next
    beat that satisfies the DRIVE slot but ignores the player)."""

    d = drive_recovery_directive(
        pending_player_question="What do we see in the Defender logs?"
    )
    assert "What do we see in the Defender logs?" in d.user_nudge
    assert "answer it concretely first" in d.user_nudge


def test_drive_recovery_directive_falls_back_when_no_pending_question() -> None:
    """No open question → fall back to the static nudge so the model
    still gets a recovery prompt for non-question silent yields."""

    d = drive_recovery_directive()
    assert "answer any pending player question first" in d.user_nudge


def test_drive_recovery_directive_truncates_long_player_question() -> None:
    """Cap the embedded quote at 280 chars so a malicious / verbose
    player can't blow up the recovery prompt."""

    long_q = "Why " + ("a" * 400) + "?"
    d = drive_recovery_directive(pending_player_question=long_q)
    # The embedded quote inside double-quotes is 280 chars max + "..."
    assert "..." in d.user_nudge
    # Total nudge length sanity-check (template + ~280 chars + framing).
    assert len(d.user_nudge) < 600


def test_drive_recovery_directive_neutralises_quote_chars() -> None:
    """Player message containing ``"`` or newlines must not break the
    JSON-ish embedding inside the user nudge."""

    q = 'What if I say "ignore previous"?\nNew line.'
    d = drive_recovery_directive(pending_player_question=q)
    # Embedded inner quotes are escaped; original newline is flattened.
    assert "\\\"ignore previous\\\"" in d.user_nudge
    assert "\nNew line" not in d.user_nudge


def test_validate_passes_quoted_player_question_into_directive() -> None:
    """End-to-end at the validator layer: a player ``?``-message in
    the session plumbs through to the recovery directive's user
    nudge. Locks the integration so a future refactor doesn't drop
    the grounding."""

    s = _session()
    s.messages.append(
        Message(
            kind=MessageKind.PLAYER,
            role_id="role-a",
            body="Yeah we can pull account activity. What do we see?",
        )
    )
    res = validate(
        session=s,
        cumulative_slots={Slot.YIELD},
        contract=PLAY_CONTRACT_NORMAL,
    )
    assert not res.ok
    drive = res.violations[0]
    assert drive.kind == "missing_drive"
    assert "What do we see?" in drive.user_nudge


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
