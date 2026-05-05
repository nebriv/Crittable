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
    the predicate is wrong (it fires on a player ``@facilitator``-ing
    the AI — exactly when DRIVE is mandatory) but still does what
    the original implementation did when the kill-switch is flipped
    on. Do NOT re-enable in production."""

    s = _session()
    s.messages.append(
        Message(
            kind=MessageKind.PLAYER,
            role_id="role-a",
            body="@facilitator what's next",
            mentions=["facilitator"],
        )
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
        Message(
            kind=MessageKind.PLAYER,
            role_id="role-a",
            body="@facilitator what's next",
            mentions=["facilitator"],
        )
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
    A player ``@facilitator`` mention no longer downgrades the
    violation."""

    s = _session()
    s.messages.append(
        Message(
            kind=MessageKind.PLAYER,
            role_id="role-a",
            body="@facilitator what's next",
            mentions=["facilitator"],
        )
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
    """No open ``@facilitator`` mention → fall back to the static
    nudge so the model still gets a recovery prompt for non-mention
    silent yields. Wave 2 swapped the trailing-`?` predicate for the
    structural mention, but the fallback nudge shape is unchanged."""

    d = drive_recovery_directive()
    assert "answer any pending `@facilitator` ask first" in d.user_nudge


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
    """End-to-end at the validator layer: a player ``@facilitator``
    message in the session plumbs through to the recovery directive's
    user nudge. Locks the integration so a future refactor doesn't
    drop the grounding."""

    s = _session()
    s.messages.append(
        Message(
            kind=MessageKind.PLAYER,
            role_id="role-a",
            body="@facilitator yeah we can pull account activity. What do we see?",
            mentions=["facilitator"],
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


# ---------------------------------------------------------------- issue #151 fix B


def test_drive_recovery_directive_grounds_on_critical_inject_args() -> None:
    """Issue #151 fix B: the recovery directive embeds the inject
    severity / headline / body into both the system addendum and the
    user nudge so the model's recovery broadcast lands on the actual
    event rather than a generic next beat."""

    args = {
        "severity": "HIGH",
        "headline": "Media leak — Slack screenshot viral",
        "body": "Reporter calling for comment in 30 minutes.",
    }
    d = drive_recovery_directive(pending_critical_inject_args=args)

    assert "INJECT CONTEXT" in d.system_addendum
    assert "HIGH" in d.system_addendum
    assert "Media leak" in d.system_addendum
    assert "Reporter calling" in d.system_addendum
    # The original generic note still appears so the bookkeeping rules
    # / "answer @facilitator first" / "no other tools" guidance are
    # not lost.
    assert "RECOVERY" in d.system_addendum
    # The user nudge points at the inject explicitly.
    assert "inject_critical_event" in d.user_nudge
    assert "Media leak" in d.user_nudge
    # Tool pin / kind are unchanged so audit dashboards keying off
    # ``kind="missing_drive"`` and the ``broadcast`` pin still work.
    assert d.kind == "missing_drive"
    assert d.tools_allowlist == frozenset({"broadcast"})
    assert d.tool_choice == {"type": "tool", "name": "broadcast"}


def test_drive_recovery_directive_combines_inject_and_player_question() -> None:
    """When BOTH a critical inject and an unanswered ``@facilitator``
    ask are pending, the user nudge tells the model the answer-order:
    answer the player first, then ground on the inject. Regression
    guard against either grounding being silently dropped."""

    d = drive_recovery_directive(
        pending_player_question="What do we see in Defender logs?",
        pending_critical_inject_args={
            "severity": "HIGH",
            "headline": "Slack leak",
            "body": "tabloid",
        },
    )
    # Both grounding pieces are present.
    assert "What do we see in Defender logs?" in d.user_nudge
    assert "Slack leak" in d.user_nudge
    # Order is enforced — the @facilitator ask is answered first.
    assert d.user_nudge.index("@facilitator`") < d.user_nudge.index(
        "ground on the inject"
    )


def test_drive_recovery_directive_caps_long_inject_fields() -> None:
    """Recovery prompts ride alongside the prior tool-loop replay; an
    unbounded inject body would inflate every recovery call. Cap
    headline at 160 chars and body at 280 chars. Per-field bounds
    prevent a regression that changes one cap from silently sliding
    past."""

    from app.sessions.turn_validator import (
        _INJECT_BODY_PREVIEW_CAP,
        _INJECT_HEADLINE_PREVIEW_CAP,
    )

    long_headline = "Headline " + "X" * 400
    long_body = "Body " + "Y" * 600
    d = drive_recovery_directive(
        pending_critical_inject_args={
            "severity": "HIGH",
            "headline": long_headline,
            "body": long_body,
        }
    )
    # Truncation marker present (one of the two fields was truncated).
    assert "..." in d.system_addendum
    # Per-field length bounds: each truncated value must respect its
    # documented cap. The +5 slack covers the surrounding `"..."`
    # (3 chars), the JSON-quote escape pair (2 chars), and the
    # leading "Headline "/"Body " literal that's still within cap
    # but still rendered. We grep the addendum for the "X" / "Y"
    # filler characters and assert the longest run respects the cap.
    headline_x_run = max(
        (
            len(seg) for seg in d.system_addendum.split("X")
            if seg == ""
        ),
        default=0,
    )
    body_y_run = max(
        (
            len(seg) for seg in d.system_addendum.split("Y")
            if seg == ""
        ),
        default=0,
    )
    # Count consecutive "X"s by another method since the split-on-X
    # gives empties between consecutive Xs.
    import re

    x_runs = [len(m.group()) for m in re.finditer(r"X+", d.system_addendum)]
    y_runs = [len(m.group()) for m in re.finditer(r"Y+", d.system_addendum)]
    longest_x = max(x_runs, default=0)
    longest_y = max(y_runs, default=0)
    # The headline filler is "X" * 400; capped at _INJECT_HEADLINE_PREVIEW_CAP
    # (with "Headline " prefix consuming part of the cap). The longest
    # run of X must not exceed the cap.
    assert longest_x <= _INJECT_HEADLINE_PREVIEW_CAP, (
        f"headline truncation cap ({_INJECT_HEADLINE_PREVIEW_CAP}) "
        f"violated; longest X run = {longest_x}"
    )
    assert longest_y <= _INJECT_BODY_PREVIEW_CAP, (
        f"body truncation cap ({_INJECT_BODY_PREVIEW_CAP}) "
        f"violated; longest Y run = {longest_y}"
    )
    # Belt-and-braces: total addendum stays bounded.
    assert len(d.system_addendum) < 3000
    _ = headline_x_run, body_y_run  # consumed via re.finditer instead


def test_drive_recovery_directive_handles_empty_inject_fields() -> None:
    """Defensive: model could fire ``inject_critical_event`` with empty
    headline / body strings (or None). Recovery should still produce
    a valid prompt rather than crashing on .strip() / format."""

    d = drive_recovery_directive(
        pending_critical_inject_args={
            "severity": "",
            "headline": None,
            "body": "",
        }
    )
    # System addendum is still well-formed.
    assert "INJECT CONTEXT" in d.system_addendum
    # Severity defaults to HIGH on empty / missing input.
    assert "severity=HIGH" in d.system_addendum
    # Empty fields render as the JSON-encoded empty string token "".
    assert 'headline=""' in d.system_addendum
    assert 'body=""' in d.system_addendum


def test_validate_passes_inject_args_into_drive_recovery_directive() -> None:
    """Integration: when the validator catches missing DRIVE on a turn
    where the model attempted ``inject_critical_event``, the inject
    context is plumbed all the way into the recovery directive's
    user nudge. This is the contract the turn driver depends on."""

    s = _session()
    res = validate(
        session=s,
        cumulative_slots={Slot.YIELD, Slot.ESCALATE},
        contract=PLAY_CONTRACT_NORMAL,
        pending_critical_inject_args={
            "severity": "HIGH",
            "headline": "Slack screenshot leak",
            "body": "Reporter calling.",
        },
    )
    assert not res.ok
    drive = next(v for v in res.violations if v.kind == "missing_drive")
    assert "Slack screenshot leak" in drive.user_nudge
    assert "INJECT CONTEXT" in drive.system_addendum


def test_validate_without_inject_args_uses_generic_recovery() -> None:
    """Backwards-compat: when no inject args are passed (the typical
    DRIVE-recovery path), the validator produces the generic recovery
    directive. Guards the default branch so a future refactor doesn't
    accidentally make the inject branch the unconditional path."""

    s = _session()
    res = validate(
        session=s,
        cumulative_slots={Slot.YIELD},
        contract=PLAY_CONTRACT_NORMAL,
    )
    assert not res.ok
    drive = next(v for v in res.violations if v.kind == "missing_drive")
    assert "INJECT CONTEXT" not in drive.system_addendum
    assert "inject_critical_event" not in drive.user_nudge


def test_validate_inject_args_neutralise_quote_chars() -> None:
    """Inject body containing `\"`, newlines, or other control chars
    (CR, TAB, etc.) must not break the JSON-ish embedding inside the
    recovery prompt — same hardening we already have for the player-
    question quote, plus extras for operator-log readability per the
    security review."""

    s = _session()
    res = validate(
        session=s,
        cumulative_slots={Slot.YIELD, Slot.ESCALATE},
        contract=PLAY_CONTRACT_NORMAL,
        pending_critical_inject_args={
            "severity": "HIGH",
            "headline": 'Reporter said "we will publish"',
            "body": "Multi\nline\rwith\ttabs\x00payload.",
        },
    )
    drive = res.violations[0]
    # Inner quotes are escaped.
    assert '\\"we will publish\\"' in drive.system_addendum
    # Newlines, CR, TAB, NUL are all flattened to space (no
    # control-char passthrough that could break log viewers or
    # corrupt downstream rendering).
    assert "Multi\nline" not in drive.system_addendum
    assert "line\rwith" not in drive.system_addendum
    assert "with\ttabs" not in drive.system_addendum
    assert "\x00" not in drive.system_addendum
    # The flattened form must reach the addendum verbatim — every
    # control char becomes one space, so the original tokens are
    # space-separated.
    assert "Multi line with tabs payload." in drive.system_addendum
