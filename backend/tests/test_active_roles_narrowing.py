"""Coverage for ``app.sessions.active_roles.narrow_active_roles``.

The narrower is the safety net for the play tier's "AI yields wider
than its audience" failure mode (turn stalls until force-advance).
The cases below pin down every branch the failure mode touches in
practice + the user-flagged edge cases (mentioning a role in passing
must NOT count as addressing them).
"""

from __future__ import annotations

import pytest

from app.sessions.active_roles import narrow_active_roles
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

    result = narrow_active_roles(
        roles=[ben, eng],
        appended_messages=msgs,
        ai_set=[ben.id, eng.id],
    )

    assert result.narrowed is True
    assert result.kept == [ben.id]
    assert result.dropped == [eng.id]
    assert ben.id in result.addressed_role_ids
    assert eng.id not in result.addressed_role_ids


def test_drops_unaddressed_role_when_label_addressed() -> None:
    """The AI sometimes uses the role label instead of the display_name —
    'Cybersecurity Manager — Ready to close...'. Either form should match.
    """

    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")
    eng = _make_role(id_label="Cybersecurity Engineer")

    msgs = [_broadcast("Cybersecurity Manager — Ready to close Operation Frozen Ledger?")]

    result = narrow_active_roles(
        roles=[ben, eng],
        appended_messages=msgs,
        ai_set=[ben.id, eng.id],
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

    result = narrow_active_roles(
        roles=[ben, mike],
        appended_messages=msgs,
        ai_set=[ben.id, mike.id],
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

    result = narrow_active_roles(
        roles=[eng, mike],
        appended_messages=msgs,
        ai_set=[eng.id, mike.id],
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

    result = narrow_active_roles(
        roles=[ben, mike],
        appended_messages=msgs,
        ai_set=[ben.id, mike.id],
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

    result = narrow_active_roles(
        roles=[ben, eng],
        appended_messages=msgs,
        ai_set=[ben.id, eng.id],
    )

    assert result.narrowed is False
    assert set(result.kept) == {ben.id, eng.id}
    assert result.dropped == []


def test_comma_separator_addressing_works() -> None:
    """'Ben, what's your call?' — comma separator is also valid addressing."""

    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")
    eng = _make_role(id_label="Cybersecurity Engineer")

    msgs = [_broadcast("Ben, what's your call? Engineer is on standby.")]

    result = narrow_active_roles(
        roles=[ben, eng],
        appended_messages=msgs,
        ai_set=[ben.id, eng.id],
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

    result = narrow_active_roles(
        roles=[ben, eng],
        appended_messages=msgs,
        ai_set=[ben.id, eng.id],
    )

    assert result.narrowed is True
    assert result.kept == [ben.id]
    assert result.dropped == [eng.id]


def test_pose_choice_explicit_target_always_kept() -> None:
    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")
    eng = _make_role(id_label="Cybersecurity Engineer")

    msgs = [_pose_choice(ben.id, "Generate AAR now?", ["Yes", "No"])]

    result = narrow_active_roles(
        roles=[ben, eng],
        appended_messages=msgs,
        ai_set=[ben.id, eng.id],
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

    result = narrow_active_roles(
        roles=[ben, eng],
        appended_messages=msgs,
        ai_set=[ben.id, eng.id],
    )

    assert result.narrowed is False
    assert set(result.kept) == {ben.id, eng.id}
    assert result.reason == "no_addressed_roles_no_narrowing"


def test_would_narrow_to_empty_keeps_original() -> None:
    """If the heuristic misses every name in the AI's set (e.g. the
    model used a nickname not in the roster), don't shrink to empty —
    keep the AI's directional intent."""

    ben = _make_role(id_label="Cybersecurity Manager", display_name="Benjamin")
    eng = _make_role(id_label="Cybersecurity Engineer")

    # Body uses "Benji" — neither label nor display_name. No clause-
    # start match for either role.
    msgs = [_broadcast("Benji — your call here?")]

    result = narrow_active_roles(
        roles=[ben, eng],
        appended_messages=msgs,
        ai_set=[ben.id, eng.id],
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
    ``broadcast`` summarising state to the room. Keep both addressees."""

    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")
    eng = _make_role(id_label="Cybersecurity Engineer")

    msgs = [
        _address_role(eng.id, "Pull the auth logs for svc_artisan."),
        _broadcast("Ben — while the engineer runs that, brief Mike."),
    ]

    result = narrow_active_roles(
        roles=[ben, eng],
        appended_messages=msgs,
        ai_set=[ben.id, eng.id],
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

    result = narrow_active_roles(
        roles=[ben, legal],
        appended_messages=[artifact_msg],
        ai_set=[ben.id, legal.id],
    )

    assert result.narrowed is True
    assert result.kept == [legal.id]
    assert result.dropped == [ben.id]


# ---------------------------------------------------------------------------
# Idempotence + boundary cases.
# ---------------------------------------------------------------------------


def test_empty_ai_set_returns_empty() -> None:
    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")

    result = narrow_active_roles(
        roles=[ben],
        appended_messages=[_broadcast("Ben — your call?")],
        ai_set=[],
    )

    assert result.kept == []
    assert result.dropped == []
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

    result = narrow_active_roles(
        roles=[ben, eng],
        appended_messages=[bookkeeping_msg],
        ai_set=[ben.id, eng.id],
    )

    assert result.narrowed is False
    assert set(result.kept) == {ben.id, eng.id}


def test_em_dash_as_clause_separator() -> None:
    """The model uses em-dashes as soft sentence breaks. A name after
    an em-dash should be treated as clause-start, not mid-sentence."""

    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")
    eng = _make_role(id_label="Cybersecurity Engineer")

    msgs = [_broadcast("Logs are in — Ben, your read on this?")]

    result = narrow_active_roles(
        roles=[ben, eng],
        appended_messages=msgs,
        ai_set=[ben.id, eng.id],
    )

    assert result.narrowed is True
    assert result.kept == [ben.id]


def test_case_insensitive_match() -> None:
    ben = _make_role(id_label="Cybersecurity Manager", display_name="Ben")

    msgs = [_broadcast("BEN — your call on this?")]

    result = narrow_active_roles(
        roles=[ben],
        appended_messages=msgs,
        ai_set=[ben.id],
    )

    assert ben.id in result.addressed_role_ids


def test_kept_preserves_input_order() -> None:
    """``kept`` returns role_ids in the same order they appeared in
    ``ai_set``, which preserves any deterministic ordering the
    upstream caller relied on (test-friendly snapshots, etc.)."""

    a = _make_role(id_label="Alpha")
    b = _make_role(id_label="Bravo")
    c = _make_role(id_label="Charlie")

    msgs = [_broadcast("Alpha — go. Charlie — go. Bravo, hold.")]

    result = narrow_active_roles(
        roles=[a, b, c],
        appended_messages=msgs,
        ai_set=[c.id, a.id, b.id],  # deliberately scrambled
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

    # The cumulative ``set_active_role_ids`` is the attempt-2 yield.
    ai_set = [ciso.id, soc.id]

    result = narrow_active_roles(
        roles=[ciso, soc],
        appended_messages=cumulative_messages,
        ai_set=ai_set,
    )

    assert result.narrowed is True, (
        "narrower must see the cumulative broadcast text from attempt 1; "
        "if this fails, _merge_outcomes was likely changed to pass the "
        "per-attempt outcome (which would have empty appended_messages)"
    )
    assert result.kept == [ciso.id]
    assert result.dropped == [soc.id]


if __name__ == "__main__":  # pragma: no cover — convenience for local runs
    pytest.main([__file__, "-v"])
