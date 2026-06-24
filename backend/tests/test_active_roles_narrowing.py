"""Coverage for ``app.sessions.active_roles.narrow_active_role_groups``.

The narrower is the safety net for the play tier's "AI yields wider
than its audience" failure mode (turn stalls until force-advance).
The cases below pin down every branch the failure mode touches in
practice + the user-flagged edge cases (mentioning a role in passing
must NOT count as addressing them).
"""

from __future__ import annotations

import pytest

from app.sessions.active_roles import narrow_active_role_groups
from app.sessions.models import Message, MessageKind, Role


def _make_role(*, id_label: str, display_name: str | None = None) -> Role:
    """Build a Role with a stable label-as-id-suffix for assertion clarity.

    The model uses opaque hex ids; tests use the label so a failing
    assertion reads "dropped Engineer when it shouldn't have" not
    "dropped a1b2c3d4e5f6".
    """

    return Role(label=id_label, display_name=display_name, kind="player")


def _broadcast(body: str) -> Message:
    return Message(
        kind=MessageKind.AI_TEXT,
        body=body,
        tool_name="broadcast",
        tool_args={"message": body},
    )


def _address_role(role_id: str, body: str) -> Message:
    return Message(
        kind=MessageKind.AI_TEXT,
        body=body,
        tool_name="address_role",
        tool_args={"role_id": role_id, "message": body},
    )


def _pose_choice(role_id: str, question: str, options: list[str]) -> Message:
    return Message(
        kind=MessageKind.AI_TEXT,
        body=question,
        tool_name="pose_choice",
        tool_args={"role_id": role_id, "question": question, "options": options},
    )


# ---------------------------------------------------------------------------
# Headline regression: the original bug from the user report.
# ---------------------------------------------------------------------------


def test_drops_unaddressed_role_when_broadcast_names_only_one() -> None:
    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")
    eng = _make_role(id_label="Cybersecurity Engineer")

    msgs = [_broadcast("Ben — you're in the advisor seat. What's the call?")]

    result = narrow_active_role_groups(
        roles=[ben, eng],
        appended_messages=msgs,
        ai_groups=[[ben.id], [eng.id]],
    )

    assert result.narrowed is True
    assert result.kept == [ben.id]
    assert result.dropped == [eng.id]
    assert result.reason == "dropped_unaddressed_roles"
    assert ben.id in result.addressed_role_ids
    assert eng.id not in result.addressed_role_ids


def test_drops_unaddressed_role_when_label_addressed() -> None:
    """The AI sometimes uses the role label instead of the display_name —
    'Cybersecurity Manager — Ready to close...'. Either form should match.
    """

    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")
    eng = _make_role(id_label="Cybersecurity Engineer")

    msgs = [_broadcast("Cybersecurity Manager — Ready to close Operation Frozen Ledger?")]

    result = narrow_active_role_groups(
        roles=[ben, eng],
        appended_messages=msgs,
        ai_groups=[[ben.id], [eng.id]],
    )

    assert result.narrowed is True
    assert result.kept == [ben.id]


# ---------------------------------------------------------------------------
# User-flagged edge case: passing-mention must NOT count as addressing.
# ---------------------------------------------------------------------------


def test_passing_mention_does_not_address() -> None:
    """'Ben — you should check with Mike, right?' — Ben is addressed,
    Mike is referenced. Mike must NOT be kept just because his name
    appears in the body.
    """

    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")
    mike = _make_role(id_label="CISO", display_name="Mike")

    msgs = [_broadcast("Ben — you should check with Mike, right?")]

    result = narrow_active_role_groups(
        roles=[ben, mike],
        appended_messages=msgs,
        ai_groups=[[ben.id], [mike.id]],
    )

    assert result.narrowed is True
    assert result.kept == [ben.id]
    assert result.dropped == [mike.id]


def test_referenced_role_in_loop_in_phrase_not_addressed() -> None:
    """'Engineer — pull the logs, then loop in Mike.' — Engineer is the
    addressee; Mike is just being looped in (not asked anything)."""

    eng = _make_role(id_label="Cybersecurity Engineer")
    mike = _make_role(id_label="CISO", display_name="Mike")

    msgs = [_broadcast("Cybersecurity Engineer — pull the logs, then loop in Mike.")]

    result = narrow_active_role_groups(
        roles=[eng, mike],
        appended_messages=msgs,
        ai_groups=[[eng.id], [mike.id]],
    )

    assert result.narrowed is True
    assert result.kept == [eng.id]
    assert result.dropped == [mike.id]


def test_descriptive_mention_with_following_word_not_addressed() -> None:
    """'Mike Benedetto is not yet notified.' — Mike at sentence start
    but followed by ' Benedetto' (no separator). Not addressing."""

    mike = _make_role(id_label="CISO", display_name="Mike")
    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")

    msgs = [_broadcast("Mike Benedetto is not yet notified. Ben — your call?")]

    result = narrow_active_role_groups(
        roles=[ben, mike],
        appended_messages=msgs,
        ai_groups=[[ben.id], [mike.id]],
    )

    assert result.narrowed is True
    assert result.kept == [ben.id]
    assert result.dropped == [mike.id]


# ---------------------------------------------------------------------------
# Multiple addressees — both should be kept.
# ---------------------------------------------------------------------------


def test_two_addressees_both_kept() -> None:
    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")
    eng = _make_role(id_label="Cybersecurity Engineer")

    msgs = [_broadcast("Ben — confirm isolation. Cybersecurity Engineer — pull logs.")]

    result = narrow_active_role_groups(
        roles=[ben, eng],
        appended_messages=msgs,
        ai_groups=[[ben.id], [eng.id]],
    )

    assert result.narrowed is False
    assert set(result.kept) == {ben.id, eng.id}
    assert result.dropped == []


def test_comma_separator_addressing_works() -> None:
    """'Ben, what's your call?' — comma separator is also valid addressing."""

    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")
    eng = _make_role(id_label="Cybersecurity Engineer")

    msgs = [_broadcast("Ben, what's your call? Engineer is on standby.")]

    result = narrow_active_role_groups(
        roles=[ben, eng],
        appended_messages=msgs,
        ai_groups=[[ben.id], [eng.id]],
    )

    # "Engineer is" — Engineer at clause start but followed by " is"
    # (no separator) so Engineer is NOT addressed. Should drop.
    assert result.narrowed is True
    assert result.kept == [ben.id]


# ---------------------------------------------------------------------------
# Explicit tool-arg targeting (highest-confidence signal).
# ---------------------------------------------------------------------------


def test_address_role_explicit_target_always_kept() -> None:
    """Even if the body text doesn't address Ben at clause-start, the
    explicit ``address_role(role_id=ben)`` tool call is unambiguous."""

    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")
    eng = _make_role(id_label="Cybersecurity Engineer")

    # Body doesn't use clause-start addressing — just a question.
    msgs = [_address_role(ben.id, "What's the next step here?")]

    result = narrow_active_role_groups(
        roles=[ben, eng],
        appended_messages=msgs,
        ai_groups=[[ben.id], [eng.id]],
    )

    assert result.narrowed is True
    assert result.kept == [ben.id]
    assert result.dropped == [eng.id]


def test_pose_choice_explicit_target_always_kept() -> None:
    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")
    eng = _make_role(id_label="Cybersecurity Engineer")

    msgs = [_pose_choice(ben.id, "Generate AAR now?", ["Yes", "No"])]

    result = narrow_active_role_groups(
        roles=[ben, eng],
        appended_messages=msgs,
        ai_groups=[[ben.id], [eng.id]],
    )

    assert result.narrowed is True
    assert result.kept == [ben.id]


# ---------------------------------------------------------------------------
# Conservative fallback: don't second-guess generic team broadcasts.
# ---------------------------------------------------------------------------


def test_generic_broadcast_no_names_keeps_full_set() -> None:
    """'Team — what do we do?' — no specific role named at clause start.
    Don't narrow; the AI's set is the source of truth."""

    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")
    eng = _make_role(id_label="Cybersecurity Engineer")

    msgs = [_broadcast("Team — what's our move? Everyone weigh in.")]

    result = narrow_active_role_groups(
        roles=[ben, eng],
        appended_messages=msgs,
        ai_groups=[[ben.id], [eng.id]],
    )

    assert result.narrowed is False
    assert set(result.kept) == {ben.id, eng.id}
    assert result.reason == "no_addressed_roles_no_narrowing"


def test_unmatched_nickname_keeps_original_set() -> None:
    """If the heuristic misses every name (e.g. the model used a
    nickname not in the roster), no role is addressed — fall into the
    no-addressed branch and keep the AI's directional intent rather than
    shrinking to empty."""

    ben = _make_role(id_label="Cybersecurity Manager", display_name="Benjamin")
    eng = _make_role(id_label="Cybersecurity Engineer")

    # Body uses "Benji" — neither label nor display_name. No clause-
    # start match for either role.
    msgs = [_broadcast("Benji — your call here?")]

    result = narrow_active_role_groups(
        roles=[ben, eng],
        appended_messages=msgs,
        ai_groups=[[ben.id], [eng.id]],
    )

    # No addressed roles found at all → reason is the no-addressed branch.
    assert result.narrowed is False
    assert set(result.kept) == {ben.id, eng.id}
    assert result.reason == "no_addressed_roles_no_narrowing"


# ---------------------------------------------------------------------------
# Multi-tool turns: address_role + broadcast in one yield.
# ---------------------------------------------------------------------------


def test_address_role_plus_broadcast_combine_addressed() -> None:
    """Realistic shape: ``address_role(eng, ...)`` for a focused ask +
    ``broadcast`` summarizing state to the room. Keep both addressees."""

    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")
    eng = _make_role(id_label="Cybersecurity Engineer")

    msgs = [
        _address_role(eng.id, "Pull the auth logs for svc_artisan."),
        _broadcast("Ben — while the engineer runs that, brief Mike."),
    ]

    result = narrow_active_role_groups(
        roles=[ben, eng],
        appended_messages=msgs,
        ai_groups=[[ben.id], [eng.id]],
    )

    # Engineer addressed via tool target; Ben addressed via clause-start
    # in broadcast. Both kept, nothing dropped.
    assert result.narrowed is False
    assert set(result.kept) == {ben.id, eng.id}


def test_request_artifact_target_counts_as_addressed() -> None:
    """``request_artifact`` is also an unambiguous addressing tool."""

    legal = _make_role(id_label="Legal Counsel")
    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")

    artifact_msg = Message(
        kind=MessageKind.AI_TEXT,
        body="Draft the breach notification for NY AG.",
        tool_name="request_artifact",
        tool_args={
            "role_id": legal.id,
            "artifact_type": "regulator_letter",
            "instructions": "...",
        },
    )

    result = narrow_active_role_groups(
        roles=[ben, legal],
        appended_messages=[artifact_msg],
        ai_groups=[[ben.id], [legal.id]],
    )

    assert result.narrowed is True
    assert result.kept == [legal.id]
    assert result.dropped == [ben.id]


# ---------------------------------------------------------------------------
# Idempotence + boundary cases.
# ---------------------------------------------------------------------------


def test_empty_ai_set_no_address_returns_empty() -> None:
    """Empty yield + a generic broadcast with no clause-start address →
    nothing to keep and nothing to promote. (The promote-on-empty-yield
    recovery only fires when a role is actually addressed; see
    ``test_silent_yield_promotes_addressed_role``.)"""

    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")

    result = narrow_active_role_groups(
        roles=[ben],
        appended_messages=[_broadcast("Team — stand by for the next inject.")],
        ai_groups=[],
    )

    assert result.kept == []
    assert result.dropped == []
    assert result.promoted == []
    assert result.narrowed is False


def test_no_player_facing_messages_keeps_original() -> None:
    """If the turn somehow has no broadcast/address_role/etc. (e.g.
    pure tool-bookkeeping turn), there's nothing to match against.
    Don't narrow."""

    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")
    eng = _make_role(id_label="Cybersecurity Engineer")

    bookkeeping_msg = Message(
        kind=MessageKind.AI_TEXT,
        body="Internal rationale only",
        tool_name=None,
        tool_args=None,
    )

    result = narrow_active_role_groups(
        roles=[ben, eng],
        appended_messages=[bookkeeping_msg],
        ai_groups=[[ben.id], [eng.id]],
    )

    assert result.narrowed is False
    assert set(result.kept) == {ben.id, eng.id}


def test_em_dash_as_clause_separator() -> None:
    """The model uses em-dashes as soft sentence breaks. A name after
    an em-dash should be treated as clause-start, not mid-sentence."""

    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")
    eng = _make_role(id_label="Cybersecurity Engineer")

    msgs = [_broadcast("Logs are in — Ben, your read on this?")]

    result = narrow_active_role_groups(
        roles=[ben, eng],
        appended_messages=msgs,
        ai_groups=[[ben.id], [eng.id]],
    )

    assert result.narrowed is True
    assert result.kept == [ben.id]


def test_case_insensitive_match() -> None:
    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")

    msgs = [_broadcast("BEN — your call on this?")]

    result = narrow_active_role_groups(
        roles=[ben],
        appended_messages=msgs,
        ai_groups=[[ben.id]],
    )

    assert ben.id in result.addressed_role_ids
    # AI's yield already matches the addressed set → no drop, no promote.
    assert result.reason == "ai_set_already_matches_addressed"


def test_kept_preserves_input_order() -> None:
    """``kept`` returns role_ids in the same order they appeared in
    ``ai_set``, which preserves any deterministic ordering the
    upstream caller relied on (test-friendly snapshots, etc.)."""

    a = _make_role(id_label="Alpha")
    b = _make_role(id_label="Bravo")
    c = _make_role(id_label="Charlie")

    msgs = [_broadcast("Alpha — go. Charlie — go. Bravo, hold.")]

    result = narrow_active_role_groups(
        roles=[a, b, c],
        appended_messages=msgs,
        ai_groups=[[c.id], [a.id], [b.id]],  # deliberately scrambled
    )

    assert result.kept == [c.id, a.id, b.id]


# ---------------------------------------------------------------------------
# Cumulative-outcome merge: the production hot path is DRIVE attempt 1
# emits a broadcast (no yield), strict-retry attempt 2 emits only the
# yield. ``_merge_outcomes`` accumulates ``appended_messages`` so the
# narrower sees the broadcast text from attempt 1 alongside the
# ``set_active_role_ids`` from attempt 2. If a future refactor passes
# the per-attempt outcome instead of the cumulative one, the narrower
# would see an empty body and silently fall into the "no addressed
# roles" branch — defeating the safety net. This test pins the
# cumulative shape.
# ---------------------------------------------------------------------------


def test_cumulative_merge_after_strict_retry_narrows_correctly() -> None:
    """Simulate the merged outcome from a 2-attempt turn:

    * Attempt 1 (DRIVE-only): emits ``broadcast("CISO — your call?")``
      and STOPS without yielding. Returns 1 ``appended_message``.
    * Attempt 2 (YIELD-only recovery): emits only
      ``set_active_roles([ciso, soc])``, no new player-facing message.
      Returns 0 ``appended_messages`` but sets ``set_active_role_ids``.

    ``_merge_outcomes`` accumulates ``appended_messages`` so the
    cumulative outcome that reaches ``_apply_play_outcome`` carries
    BOTH the attempt-1 broadcast AND the attempt-2 yield. The narrower
    must see the broadcast text and drop SOC.
    """

    ciso = _make_role(id_label="CISO", display_name="Mike")
    soc = _make_role(id_label="SOC Analyst")

    # The cumulative ``appended_messages`` carries the attempt-1
    # broadcast forward; the recovery pass adds nothing new because
    # ``tool_choice`` was pinned to ``set_active_roles``.
    cumulative_messages = [_broadcast("CISO — your call on isolation?")]

    # The cumulative ``set_active_role_groups`` is the attempt-2 yield.
    ai_groups = [[ciso.id], [soc.id]]

    result = narrow_active_role_groups(
        roles=[ciso, soc],
        appended_messages=cumulative_messages,
        ai_groups=ai_groups,
    )

    assert result.narrowed is True, (
        "narrower must see the cumulative broadcast text from attempt 1; "
        "if this fails, _merge_outcomes was likely changed to pass the "
        "per-attempt outcome (which would have empty appended_messages)"
    )
    assert result.kept == [ciso.id]
    assert result.dropped == [soc.id]


# ---------------------------------------------------------------------------
# Promotion: a role the AI ADDRESSED but did NOT yield to is added back as
# its own ASK. Mirror of the drop pass. This is the user-reported bug:
# "John was added, the AI addressed him, but he couldn't mark ready." A
# role that joined mid-turn isn't in the roster snapshot when the model
# drafts its yield, so it writes "John — pull the portal" but ships
# set_active_roles=[ben]; without promotion John gets "NOT YOUR TURN".
# ---------------------------------------------------------------------------


def test_promotes_addressed_role_missing_from_yield() -> None:
    """Headline bug: AI addresses Ben AND John but only yields Ben. John
    is promoted into his own singleton group so he can respond."""

    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")
    john = _make_role(id_label="Security Engineer", display_name="John")

    msgs = [
        _broadcast(
            "Ben — kick off the audit log pull. "
            "John — check the M365 admin portal for live inbox rules."
        )
    ]

    result = narrow_active_role_groups(
        roles=[ben, john],
        appended_messages=msgs,
        ai_groups=[[ben.id]],  # AI under-yielded — John omitted.
    )

    assert result.promoted == [john.id]
    assert result.dropped == []
    assert result.kept_groups == [[ben.id], [john.id]]
    assert result.kept == [ben.id, john.id]
    assert result.reason == "promoted_addressed_roles"
    # ``narrowed`` tracks the DROP direction only; a promote-only turn is
    # not "narrowed" — the promotion is reported via ``promoted``.
    assert result.narrowed is False


def test_drop_and_promote_in_one_turn() -> None:
    """The AI yields a role it didn't address (drop) AND fails to yield a
    role it did (promote). Both directions fire; reason reflects both."""

    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")
    john = _make_role(id_label="Security Engineer", display_name="John")
    eng = _make_role(id_label="Cybersecurity Engineer")

    # Addresses Ben + John; yields Ben + Eng (Eng never addressed).
    msgs = [_broadcast("Ben — confirm containment. John — pull the portal logs.")]

    result = narrow_active_role_groups(
        roles=[ben, john, eng],
        appended_messages=msgs,
        ai_groups=[[ben.id], [eng.id]],
    )

    assert result.dropped == [eng.id]  # yielded but not addressed
    assert result.promoted == [john.id]  # addressed but not yielded
    assert result.kept_groups == [[ben.id], [john.id]]
    assert result.narrowed is True
    assert result.reason == "reconciled_dropped_and_promoted"


def test_promotion_order_is_roster_order() -> None:
    """Two addressed-but-unyielded roles promote in ROSTER order, not the
    order they appear in the text (``addressed`` is an unordered set, so
    promotion must be deterministic for replay)."""

    a = _make_role(id_label="Alpha")
    b = _make_role(id_label="Bravo")
    c = _make_role(id_label="Charlie")

    # Text addresses Charlie before Alpha; roster order is A, B, C.
    msgs = [_broadcast("Charlie — go. Alpha — go.")]

    result = narrow_active_role_groups(
        roles=[a, b, c],
        appended_messages=msgs,
        ai_groups=[[b.id]],  # only Bravo yielded; Bravo NOT addressed.
    )

    assert result.dropped == [b.id]
    assert result.promoted == [a.id, c.id]  # roster order, not text order
    assert result.kept_groups == [[a.id], [c.id]]


def test_promotes_explicit_tool_target_missing_from_yield() -> None:
    """An ``address_role`` tool target the AI forgot to yield to is also
    promoted (explicit targets are the highest-confidence address)."""

    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")
    legal = _make_role(id_label="Legal Counsel")

    msgs = [
        _broadcast("Ben — confirm containment posture."),
        _address_role(legal.id, "Draft the breach notification for the AG."),
    ]

    result = narrow_active_role_groups(
        roles=[ben, legal],
        appended_messages=msgs,
        ai_groups=[[ben.id]],  # Legal addressed via tool but not yielded.
    )

    assert legal.id in result.promoted
    assert result.kept == [ben.id, legal.id]


def test_promotion_preserves_any_of_group() -> None:
    """An any-of group the AI yielded for two addressed roles survives
    intact; a THIRD addressed-but-unyielded role promotes as its own
    REQUIRED singleton (not folded into the any-of)."""

    paul = _make_role(id_label="DevOps", display_name="Paul")
    lawrence = _make_role(id_label="IT", display_name="Lawrence")
    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")

    msgs = [
        _broadcast(
            "Paul or Lawrence — who files the Jira ticket? "
            "Ben — you own the comms update."
        )
    ]

    result = narrow_active_role_groups(
        roles=[paul, lawrence, ben],
        appended_messages=msgs,
        ai_groups=[[paul.id, lawrence.id]],  # any-of; Ben omitted.
    )

    assert [paul.id, lawrence.id] in result.kept_groups  # any-of preserved
    assert [ben.id] in result.kept_groups  # promoted singleton
    assert result.promoted == [ben.id]


def test_silent_yield_promotes_addressed_role() -> None:
    """Defensive: an empty yield (the 'silent yield' failure mode) plus a
    clause-start address recovers the addressed role, so the turn opens
    with a real active seat instead of none."""

    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")

    result = narrow_active_role_groups(
        roles=[ben],
        appended_messages=[_broadcast("Ben — your call on isolation?")],
        ai_groups=[],
    )

    assert result.kept == [ben.id]
    assert result.promoted == [ben.id]


def test_passing_mention_is_not_promoted() -> None:
    """The promote pass uses the SAME addressing heuristic as the drop
    pass — a referenced-but-not-addressed role must NOT be promoted. AI
    addresses Ben, merely mentions Mike, and yields only Ben: nothing
    changes (Mike is neither kept nor promoted). Guards against promotion
    re-introducing the wide-yield stall the drop pass exists to prevent."""

    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")
    mike = _make_role(id_label="CISO", display_name="Mike")

    msgs = [_broadcast("Ben — your call? Loop in Mike when you can.")]

    result = narrow_active_role_groups(
        roles=[ben, mike],
        appended_messages=msgs,
        ai_groups=[[ben.id]],
    )

    assert result.promoted == []
    assert mike.id not in result.kept
    assert result.kept == [ben.id]


if __name__ == "__main__":  # pragma: no cover — convenience for local runs
    pytest.main([__file__, "-v"])
