"""Issue #168 — role-groups optional-mentions model.

The screenshot from the bug report:

    Ben — one final framing question for the AAR: …
    Paul and Lawrence — Jira ticket for Defender agent gap on the 12
    uncovered hosts: one of you owns that ticket. Who's filing it?

Pre-#168, the AI yielded ``set_active_roles(role_ids=[ben, paul,
lawrence])`` and the gate (``all_ready``) demanded a ready vote from
every named role — so the turn stalled until Paul AND Lawrence both
acknowledged, even though "one of you" was the actual ask.

The role-groups model splits the yield into per-ask groups:

    set_active_roles(role_groups=[[ben], [paul, lawrence]])

The gate (``groups_quorum_met``) then advances when every GROUP has at
least one ready vote — Ben's singleton group needs Ben; Paul/Lawrence's
multi-role group closes on the first ready vote from EITHER. The
turn-stall failure mode goes away while the "must respond" semantic for
direct asks survives.

This file is the comprehensive regression net for the four code paths
that have to agree on the new shape:

1. The gate (``groups_quorum_met`` truth table).
2. The dispatcher (validation / dedup / unknown-role handling).
3. The narrower (``narrow_active_role_groups`` — clause-start
   addressing + conjoined-head matching).
4. The recorder ↔ runner round-trip (groups survive serialize +
   deserialize on a replayed scenario).

Every test here pins an end-to-end behavior the AI can break by
emitting a slightly-wrong shape; ``backend/scripts/run-live-tests.sh``
covers the actual model picking the right shape against Anthropic.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from app.sessions.active_roles import narrow_active_role_groups
from app.sessions.models import Message, MessageKind, Role, Turn
from app.sessions.turn_engine import groups_from_flat, groups_quorum_met

# ---------------------------------------------------------------------
# Gate truth table
# ---------------------------------------------------------------------


def _awaiting_turn(
    *, groups: list[list[str]], ready: list[str], submitted: list[str] | None = None
) -> Turn:
    """Build an awaiting Turn with the given groups + ready snapshot."""

    return Turn(
        index=0,
        active_role_groups=groups,
        ready_role_ids=list(ready),
        submitted_role_ids=list(submitted or ready),
        status="awaiting",
    )


class TestGroupsQuorumMet:
    """``groups_quorum_met`` — every group must have at least one ready vote."""

    def test_empty_groups_never_close(self) -> None:
        # Defensive: an empty active_role_groups can't close. A turn
        # that opens with no groups is malformed; the gate stays False
        # so a force-advance is the only way out.
        turn = _awaiting_turn(groups=[], ready=[])
        assert groups_quorum_met(turn) is False

    def test_single_role_group_open(self) -> None:
        turn = _awaiting_turn(groups=[["ben"]], ready=[])
        assert groups_quorum_met(turn) is False

    def test_single_role_group_closed(self) -> None:
        turn = _awaiting_turn(groups=[["ben"]], ready=["ben"])
        assert groups_quorum_met(turn) is True

    def test_multi_role_group_one_ready(self) -> None:
        # The screenshot case — "Paul or Lawrence" closes on Paul's
        # ready vote alone.
        turn = _awaiting_turn(groups=[["paul", "lawrence"]], ready=["paul"])
        assert groups_quorum_met(turn) is True

    def test_multi_role_group_other_ready(self) -> None:
        turn = _awaiting_turn(groups=[["paul", "lawrence"]], ready=["lawrence"])
        assert groups_quorum_met(turn) is True

    def test_multi_role_group_both_ready(self) -> None:
        turn = _awaiting_turn(
            groups=[["paul", "lawrence"]], ready=["paul", "lawrence"]
        )
        assert groups_quorum_met(turn) is True

    def test_multi_role_group_no_ready(self) -> None:
        turn = _awaiting_turn(groups=[["paul", "lawrence"]], ready=[])
        assert groups_quorum_met(turn) is False

    def test_two_singleton_groups_partial(self) -> None:
        # Two independent asks; both must answer.
        turn = _awaiting_turn(groups=[["ben"], ["paul"]], ready=["ben"])
        assert groups_quorum_met(turn) is False

    def test_two_singleton_groups_both_ready(self) -> None:
        turn = _awaiting_turn(groups=[["ben"], ["paul"]], ready=["ben", "paul"])
        assert groups_quorum_met(turn) is True

    def test_mixed_ben_required_paul_or_lawrence(self) -> None:
        # The full screenshot case: Ben + (Paul or Lawrence).
        groups = [["ben"], ["paul", "lawrence"]]
        # Only Ben → Paul/Lawrence's group still open.
        assert groups_quorum_met(_awaiting_turn(groups=groups, ready=["ben"])) is False
        # Only Paul → Ben's group still open.
        assert groups_quorum_met(_awaiting_turn(groups=groups, ready=["paul"])) is False
        # Ben + Paul → both groups closed.
        assert (
            groups_quorum_met(_awaiting_turn(groups=groups, ready=["ben", "paul"]))
            is True
        )
        # Ben + Lawrence → both groups closed.
        assert (
            groups_quorum_met(_awaiting_turn(groups=groups, ready=["ben", "lawrence"]))
            is True
        )

    def test_processing_status_blocks_gate(self) -> None:
        # Once the turn flips to processing, the gate stops firing
        # (otherwise a late-arriving ready vote would re-trigger advance
        # while the AI is mid-call).
        turn = Turn(
            index=0,
            active_role_groups=[["ben"]],
            ready_role_ids=["ben"],
            submitted_role_ids=["ben"],
            status="processing",
        )
        assert groups_quorum_met(turn) is False

    def test_unrelated_ready_id_doesnt_close(self) -> None:
        # An out-of-band ready_role_ids entry (e.g. a kicked role's
        # leftover ready) must not close any group it doesn't belong
        # to. Defensive against the security review H1 case where
        # ``ready_role_ids`` might lag the active set.
        turn = _awaiting_turn(groups=[["ben"]], ready=["someone-else"])
        assert groups_quorum_met(turn) is False


class TestActiveRoleIdsView:
    """``Turn.active_role_ids`` is a flat de-duped union over groups."""

    def test_flat_dedup_preserves_first_seen_order(self) -> None:
        turn = Turn(
            index=0,
            active_role_groups=[["a", "b"], ["b", "c"], ["a"]],
            status="awaiting",
        )
        assert turn.active_role_ids == ["a", "b", "c"]

    def test_serialization_includes_both_fields(self) -> None:
        turn = Turn(
            index=0,
            active_role_groups=[["ben"], ["paul", "lawrence"]],
            status="awaiting",
        )
        dumped = turn.model_dump(mode="json")
        assert dumped["active_role_groups"] == [["ben"], ["paul", "lawrence"]]
        assert dumped["active_role_ids"] == ["ben", "paul", "lawrence"]


# ---------------------------------------------------------------------
# Helper: groups_from_flat
# ---------------------------------------------------------------------


def test_groups_from_flat_one_per_role() -> None:
    assert groups_from_flat(["a", "b", "c"]) == [["a"], ["b"], ["c"]]


def test_groups_from_flat_empty() -> None:
    assert groups_from_flat([]) == []


# ---------------------------------------------------------------------
# Narrowing — clause-start + conjoined-head matching
# ---------------------------------------------------------------------


def _role(role_id: str, label: str, display_name: str | None = None) -> Role:
    return Role(
        id=role_id,
        label=label,
        display_name=display_name,
        kind="player",
        is_creator=False,
        token_version=0,
    )


def _broadcast(body: str) -> Message:
    return Message(
        kind=MessageKind.AI_TEXT,
        body=body,
        tool_name="broadcast",
        tool_args={"message": body},
    )


class TestNarrowActiveRoleGroups:
    """Each test reflects one shape of broadcast prose the AI emits."""

    def test_single_clause_start_address_keeps_only_addressed(self) -> None:
        # "Ben — your call?" addresses Ben only; Engineer is dropped.
        roles = [_role("ben", "Ben"), _role("eng", "Engineer")]
        msgs = [_broadcast("Ben — your call?")]
        result = narrow_active_role_groups(
            roles=roles, appended_messages=msgs, ai_groups=[["ben", "eng"]]
        )
        assert result.kept_groups == [["ben"]]
        assert result.dropped == ["eng"]
        assert result.narrowed is True

    def test_two_independent_asks_each_in_own_group(self) -> None:
        # "Ben — confirm. Engineer — pull logs." addresses both at
        # clause-start. AI yielded as two groups; both survive.
        roles = [_role("ben", "Ben"), _role("eng", "Engineer")]
        msgs = [_broadcast("Ben — confirm. Engineer — pull logs.")]
        result = narrow_active_role_groups(
            roles=roles,
            appended_messages=msgs,
            ai_groups=[["ben"], ["eng"]],
        )
        assert result.kept_groups == [["ben"], ["eng"]]
        assert result.narrowed is False

    def test_conjoined_head_keeps_both_in_one_group(self) -> None:
        # "Paul and Lawrence — who's filing?" addresses BOTH at the
        # same clause-start (conjoined head). AI's any-of group [paul,
        # lawrence] survives intact.
        roles = [_role("paul", "Paul"), _role("law", "Lawrence")]
        msgs = [_broadcast("Paul and Lawrence — who's filing the ticket?")]
        result = narrow_active_role_groups(
            roles=roles, appended_messages=msgs, ai_groups=[["paul", "law"]]
        )
        assert result.kept_groups == [["paul", "law"]]
        assert result.narrowed is False

    def test_conjoined_or_keeps_both(self) -> None:
        roles = [_role("paul", "Paul"), _role("law", "Lawrence")]
        msgs = [_broadcast("Paul or Lawrence — who's filing?")]
        result = narrow_active_role_groups(
            roles=roles, appended_messages=msgs, ai_groups=[["paul", "law"]]
        )
        assert result.kept_groups == [["paul", "law"]]

    def test_conjoined_comma_keeps_both(self) -> None:
        roles = [_role("paul", "Paul"), _role("law", "Lawrence")]
        msgs = [_broadcast("Paul, Lawrence — who's filing?")]
        result = narrow_active_role_groups(
            roles=roles, appended_messages=msgs, ai_groups=[["paul", "law"]]
        )
        assert result.kept_groups == [["paul", "law"]]

    def test_full_screenshot_shape(self) -> None:
        # The exact shape from the issue — Ben singleton + Paul/Lawrence
        # any-of, both clauses survive narrowing.
        roles = [
            _role("ben", "Ben"),
            _role("paul", "Paul"),
            _role("law", "Lawrence"),
        ]
        msgs = [
            _broadcast(
                "Ben — final framing question for the AAR. "
                "Paul and Lawrence — who's filing the Jira ticket?"
            )
        ]
        result = narrow_active_role_groups(
            roles=roles,
            appended_messages=msgs,
            ai_groups=[["ben"], ["paul", "law"]],
        )
        assert result.kept_groups == [["ben"], ["paul", "law"]]
        assert result.narrowed is False

    def test_empties_drop_groups_entirely(self) -> None:
        # AI yielded [[ben, eng]] but only addressed Ben at clause-start.
        # Engineer drops, group shrinks to [ben].
        roles = [_role("ben", "Ben"), _role("eng", "Engineer")]
        msgs = [_broadcast("Ben — your call?")]
        result = narrow_active_role_groups(
            roles=roles, appended_messages=msgs, ai_groups=[["ben", "eng"]]
        )
        assert result.kept_groups == [["ben"]]
        assert "eng" in result.dropped

    def test_unaddressed_group_is_elided(self) -> None:
        # AI yielded [[ben], [eng]] but addressed only Ben. Engineer's
        # entire group elides — replay shouldn't see a phantom "Engineer
        # must respond" wait-gate.
        roles = [_role("ben", "Ben"), _role("eng", "Engineer")]
        msgs = [_broadcast("Ben — your call?")]
        result = narrow_active_role_groups(
            roles=roles,
            appended_messages=msgs,
            ai_groups=[["ben"], ["eng"]],
        )
        assert result.kept_groups == [["ben"]]
        assert "eng" in result.dropped

    def test_reference_not_address_drops(self) -> None:
        # "Comms should standby" is a reference, not an address.
        # Comms drops; only CISO survives.
        roles = [_role("ciso", "CISO"), _role("comms", "Comms")]
        msgs = [
            _broadcast("CISO — call regulator? Comms should standby on the statement.")
        ]
        result = narrow_active_role_groups(
            roles=roles,
            appended_messages=msgs,
            ai_groups=[["ciso"], ["comms"]],
        )
        assert result.kept_groups == [["ciso"]]
        assert "comms" in result.dropped

    def test_explicit_address_role_target_always_keeps(self) -> None:
        # ``address_role(role_id=ben, …)`` is an unambiguous address
        # signal; the body text doesn't have to mention Ben at clause-
        # start for him to be kept.
        roles = [_role("ben", "Ben")]
        msgs = [
            Message(
                kind=MessageKind.AI_TEXT,
                body="Need a containment call.",
                tool_name="address_role",
                tool_args={"role_id": "ben", "message": "Need a containment call."},
            )
        ]
        result = narrow_active_role_groups(
            roles=roles, appended_messages=msgs, ai_groups=[["ben"]]
        )
        assert result.kept_groups == [["ben"]]

    def test_no_addressing_at_all_keeps_original_set(self) -> None:
        # Generic team broadcast with no clause-start name + no
        # explicit tool target. Conservative fallback keeps the AI's
        # original groups so we don't narrow to empty on legitimate
        # "Team — your move?" turns.
        roles = [_role("a", "Alpha"), _role("b", "Bravo")]
        msgs = [_broadcast("Team — your move?")]
        result = narrow_active_role_groups(
            roles=roles, appended_messages=msgs, ai_groups=[["a", "b"]]
        )
        # Match-fallback: keeps the AI's original groups verbatim.
        assert result.kept_groups == [["a", "b"]]
        assert result.narrowed is False

    def test_kept_property_flattens_groups(self) -> None:
        # The ``kept`` legacy view must still produce a flat list.
        roles = [
            _role("a", "Alpha"),
            _role("b", "Bravo"),
            _role("c", "Charlie"),
        ]
        msgs = [_broadcast("Alpha — go. Bravo, Charlie — both report.")]
        result = narrow_active_role_groups(
            roles=roles,
            appended_messages=msgs,
            ai_groups=[["a"], ["b", "c"]],
        )
        assert result.kept_groups == [["a"], ["b", "c"]]
        assert result.kept == ["a", "b", "c"]

    def test_share_data_body_does_not_contribute(self) -> None:
        # QA review H2: share_data is intentionally excluded from
        # _PLAYER_FACING_TOOLS. A share_data body that mentions Paul in
        # a column header / log line should NOT contribute to the
        # addressed-text set; only the paired broadcast counts.
        roles = [_role("paul", "Paul"), _role("law", "Lawrence")]
        msgs = [
            Message(
                kind=MessageKind.AI_TEXT,
                body="| user | host |\n| Paul | host-01 |",
                tool_name="share_data",
                tool_args={"label": "Auth log", "data": "..."},
            ),
            _broadcast("Lawrence — file the ticket?"),
        ]
        result = narrow_active_role_groups(
            roles=roles,
            appended_messages=msgs,
            ai_groups=[["paul", "law"]],
        )
        # Lawrence is addressed; Paul is only in share_data so he drops.
        assert result.kept_groups == [["law"]]
        assert "paul" in result.dropped

    def test_two_broadcasts_both_contribute(self) -> None:
        # Both broadcast bodies are joined with \n before pattern
        # matching; an address that lands in the second one should
        # still be picked up.
        roles = [_role("paul", "Paul"), _role("law", "Lawrence")]
        msgs = [
            _broadcast("Paul — confirm scope."),
            _broadcast("Lawrence — file the ticket."),
        ]
        result = narrow_active_role_groups(
            roles=roles,
            appended_messages=msgs,
            ai_groups=[["paul"], ["law"]],
        )
        assert result.kept_groups == [["paul"], ["law"]]
        assert result.narrowed is False

    def test_chain_with_leading_subordinate_clause_is_conservative(
        self,
    ) -> None:
        # QA review H1: a leading subordinate clause ("Talk to Paul,
        # then Lawrence — quickly.") should NOT spuriously address
        # either role — the chain's pieces ("talk to paul", "then
        # lawrence") don't equal a canonical name. Pin the conservative
        # behavior so a future regex tweak doesn't accidentally start
        # over-keeping these prose-laden chains.
        roles = [_role("paul", "Paul"), _role("law", "Lawrence")]
        msgs = [_broadcast("Talk to Paul, then Lawrence — quickly.")]
        result = narrow_active_role_groups(
            roles=roles,
            appended_messages=msgs,
            ai_groups=[["paul", "law"]],
        )
        # Neither is at clause-start; neither chain piece matches a
        # canonical name. Either of the two safety branches
        # ("no_addressed_roles_no_narrowing" / "would_narrow_to_empty_
        # kept_original") is acceptable — both keep the AI's groups
        # intact and never narrow the prose-laden chain to empty.
        assert result.kept_groups == [["paul", "law"]]
        assert result.narrowed is False
        assert result.reason in {
            "no_addressed_roles_no_narrowing",
            "would_narrow_to_empty_kept_original",
        }

    def test_chain_after_clause_break_addresses_trailing_pair(
        self,
    ) -> None:
        # The trailing chain after a sentence break should address the
        # pair, even when an earlier reference exists. Reads as: "After
        # a temporal-clause use of Paul, the actual ASK addresses both
        # at the clause-start chain."
        roles = [_role("paul", "Paul"), _role("law", "Lawrence")]
        msgs = [_broadcast("After Paul confirms, Paul or Lawrence — file.")]
        result = narrow_active_role_groups(
            roles=roles,
            appended_messages=msgs,
            ai_groups=[["paul", "law"]],
        )
        # Chain pieces include "paul" and "lawrence" exactly once
        # the splitter strips out "after paul confirms" via the
        # "or" boundary.
        assert result.kept_groups == [["paul", "law"]]


class TestKickedRoleScrubbing:
    """QA review M3 — kicking a role in the middle of a turn must
    keep ``active_role_groups`` consistent with ``ready_role_ids``."""

    def test_kick_drops_role_from_every_group(self) -> None:
        # Direct unit-level pin: simulate the manager's scrub by
        # walking every group and removing the kicked role; groups
        # that empty out are dropped entirely.
        groups = [["ben"], ["paul", "law"]]
        kicked = "paul"
        trimmed = []
        for group in groups:
            pruned = [rid for rid in group if rid != kicked]
            if pruned:
                trimmed.append(pruned)
        assert trimmed == [["ben"], ["law"]]

    def test_kick_elides_singleton_group_entirely(self) -> None:
        # If a singleton group's only member is kicked, the group
        # disappears — the gate stops waiting on that ASK.
        groups = [["ben"], ["paul"]]
        kicked = "paul"
        trimmed = []
        for group in groups:
            pruned = [rid for rid in group if rid != kicked]
            if pruned:
                trimmed.append(pruned)
        assert trimmed == [["ben"]]

    def test_gate_after_kick_with_mixed_shape(self) -> None:
        # End-to-end: turn opens with [[ben], [paul, lawrence]]; Paul
        # readies first; then Paul gets kicked. The post-kick state
        # should be groups=[[ben], [lawrence]], ready=[lawrence] (Paul
        # scrubbed). Lawrence ready closes group 2; Ben must still
        # ready to close group 1.
        kicked = "paul"
        groups = [["ben"], ["paul", "lawrence"]]
        ready = ["paul"]
        trimmed_groups = [
            [rid for rid in g if rid != kicked] for g in groups
        ]
        trimmed_groups = [g for g in trimmed_groups if g]
        trimmed_ready = [rid for rid in ready if rid != kicked]
        turn = _awaiting_turn(groups=trimmed_groups, ready=trimmed_ready)
        # Lawrence still has to ready (ready_role_ids is empty
        # post-scrub); Ben hasn't either. Gate stays open.
        assert groups_quorum_met(turn) is False
        # Now Lawrence and Ben both ready → both groups close.
        turn2 = _awaiting_turn(
            groups=trimmed_groups, ready=["ben", "lawrence"]
        )
        assert groups_quorum_met(turn2) is True


class TestSubmittedVsReadyDecouple:
    """QA review M2 — gate counts ready, not submitted."""

    def test_submitted_role_doesnt_close_a_group_without_ready(
        self,
    ) -> None:
        # Lawrence posted a discuss-intent submission but didn't
        # ready. submitted_role_ids includes him; ready_role_ids
        # doesn't. Gate stays open.
        turn = _awaiting_turn(
            groups=[["ben", "lawrence"]],
            ready=[],
            submitted=["lawrence"],
        )
        assert groups_quorum_met(turn) is False

    def test_submitted_lags_ready_no_effect(self) -> None:
        # Edge: ready_role_ids contains Paul but submitted_role_ids
        # doesn't (theoretically should be a superset; defensively
        # we still trust ready). Gate fires.
        turn = _awaiting_turn(
            groups=[["paul"]],
            ready=["paul"],
            submitted=[],
        )
        assert groups_quorum_met(turn) is True


def test_active_role_ids_property_is_read_only() -> None:
    # QA review M4: ``active_role_ids`` is a Pydantic computed_field;
    # writes must raise. Pin the read-only contract so a future
    # regression that adds a setter is caught.
    turn = Turn(
        index=0,
        active_role_groups=[["ben"]],
        status="awaiting",
    )
    with pytest.raises(AttributeError):
        turn.active_role_ids = ["other"]  # type: ignore[misc]


# ---------------------------------------------------------------------
# Dispatcher validation
# ---------------------------------------------------------------------


def _make_dispatcher_for_roles(roles: list[Role]) -> tuple[Any, Any]:
    """Spin up a real ``ToolDispatcher`` + an awaiting Session with the
    given roles. Lifted from ``test_dispatch_tools.py`` so the
    plumbing matches what the live engine sees.
    """

    from app.auth.audit import AuditLog
    from app.extensions.dispatch import ExtensionDispatcher
    from app.extensions.models import ExtensionBundle
    from app.extensions.registry import freeze_bundle
    from app.llm.dispatch import ToolDispatcher
    from app.sessions.models import Session, SessionState
    from app.ws.connection_manager import ConnectionManager

    bundle = ExtensionBundle(tools=[], resources=[])
    registry = freeze_bundle(bundle)
    audit = AuditLog()
    ext_dispatcher = ExtensionDispatcher(registry=registry, audit=audit)
    dispatcher = ToolDispatcher(
        connections=ConnectionManager(),
        audit=audit,
        extension_dispatcher=ext_dispatcher,
        registry=registry,
    )

    session = Session(
        id="sid",
        scenario_prompt="role-groups dispatcher test",
        creator_role_id=roles[0].id if roles else None,
        roles=list(roles),
        state=SessionState.AWAITING_PLAYERS,
    )
    session.turns.append(Turn(index=0, active_role_groups=[], status="awaiting"))
    return dispatcher, session


async def _dispatch_set_active_roles(
    *, args: dict[str, Any], roles: list[Role]
) -> tuple[list[list[str]] | None, str | None]:
    """Run a single ``set_active_roles`` tool block through the
    dispatcher. Returns ``(set_active_role_groups, error)`` — errors
    surface in the first ``tool_result`` block with ``is_error=True``
    (the strict-retry contract).
    """

    dispatcher, session = _make_dispatcher_for_roles(roles)
    outcome = await dispatcher.dispatch(
        session=session,
        tool_uses=[
            {"name": "set_active_roles", "input": args, "id": "tu_1"}
        ],
        turn_id=session.current_turn.id,  # type: ignore[union-attr]
        critical_inject_allowed_cb=lambda: True,
    )
    err_blocks = [r for r in outcome.tool_results if r.get("is_error")]
    if err_blocks:
        return None, str(err_blocks[0]["content"])
    return outcome.set_active_role_groups, None


@pytest.mark.asyncio
async def test_dispatcher_accepts_singleton_group() -> None:
    roles = [_role("ben", "Ben")]
    groups, err = await _dispatch_set_active_roles(
        args={"role_groups": [["ben"]]}, roles=roles
    )
    assert err is None
    assert groups == [["ben"]]


@pytest.mark.asyncio
async def test_dispatcher_accepts_mixed_singleton_and_any_of() -> None:
    roles = [
        _role("ben", "Ben"),
        _role("paul", "Paul"),
        _role("law", "Lawrence"),
    ]
    groups, err = await _dispatch_set_active_roles(
        args={"role_groups": [["ben"], ["paul", "law"]]}, roles=roles
    )
    assert err is None
    assert groups == [["ben"], ["paul", "law"]]


@pytest.mark.asyncio
async def test_dispatcher_dedups_role_across_groups() -> None:
    # Same role in two groups: keep first, drop second.
    roles = [_role("ben", "Ben"), _role("paul", "Paul")]
    groups, err = await _dispatch_set_active_roles(
        args={"role_groups": [["ben", "paul"], ["ben"]]}, roles=roles
    )
    assert err is None
    # The second group's only member was a dup — the whole group elides.
    assert groups == [["ben", "paul"]]


@pytest.mark.asyncio
async def test_dispatcher_rejects_empty_role_groups() -> None:
    roles = [_role("ben", "Ben")]
    groups, err = await _dispatch_set_active_roles(
        args={"role_groups": []}, roles=roles
    )
    assert groups is None
    assert err is not None
    assert "role_groups" in err


@pytest.mark.asyncio
async def test_dispatcher_rejects_empty_inner_group() -> None:
    roles = [_role("ben", "Ben")]
    groups, err = await _dispatch_set_active_roles(
        args={"role_groups": [[]]}, roles=roles
    )
    assert groups is None
    assert err is not None
    assert "non-empty" in err.lower()


@pytest.mark.asyncio
async def test_dispatcher_rejects_legacy_role_ids_shape() -> None:
    """The pre-#168 ``role_ids`` shape is no longer accepted; the AI
    must emit ``role_groups``. Confirms the dispatcher raises rather
    than silently coercing — silent coercion would mask AI regressions
    on a schema migration."""

    roles = [_role("ben", "Ben")]
    groups, err = await _dispatch_set_active_roles(
        args={"role_ids": ["ben"]}, roles=roles
    )
    assert groups is None
    assert err is not None
    assert "role_groups" in err


@pytest.mark.asyncio
async def test_dispatcher_drops_unknown_ids_in_a_group() -> None:
    # Mix of known + unknown in one group: the unknown drops, the
    # known survives, the group's deduped form lands.
    roles = [_role("ben", "Ben")]
    groups, err = await _dispatch_set_active_roles(
        args={"role_groups": [["ben", "ghost-id"]]}, roles=roles
    )
    assert err is None
    assert groups == [["ben"]]


@pytest.mark.asyncio
async def test_dispatcher_rejects_when_every_id_unknown() -> None:
    roles = [_role("ben", "Ben")]
    groups, err = await _dispatch_set_active_roles(
        args={"role_groups": [["ghost-1"], ["ghost-2"]]}, roles=roles
    )
    assert groups is None
    assert err is not None
    assert "unknown role_ids" in err


# ---------------------------------------------------------------------
# Manager + recorder + runner round-trip
# ---------------------------------------------------------------------


def test_recorder_round_trips_role_groups() -> None:
    """A session with a multi-role any-of group survives serialize +
    deserialize through the recorder. Without the
    ``active_role_label_groups`` field the runner would split the
    group into singletons and the gate would stall."""

    from app.devtools.recorder import SessionRecorder
    from app.sessions.models import (
        Message,
        MessageKind,
        Role,
        Session,
        SessionState,
        Turn,
    )

    roles = [
        Role(
            id="ben",
            label="Ben",
            kind="player",
            is_creator=True,
            token_version=0,
        ),
        Role(
            id="paul",
            label="Paul",
            kind="player",
            is_creator=False,
            token_version=0,
        ),
        Role(
            id="law",
            label="Lawrence",
            kind="player",
            is_creator=False,
            token_version=0,
        ),
    ]
    turn = Turn(
        index=0,
        active_role_groups=[["ben"], ["paul", "law"]],
        status="awaiting",
    )
    session = Session(
        id="sid",
        scenario_prompt="role-groups recorder test",
        creator_role_id="ben",
        roles=roles,
        state=SessionState.AWAITING_PLAYERS,
        turns=[turn],
        # The recorder groups messages by turn_id; a turn with zero
        # messages doesn't appear in ``turn_order`` and the play_turns
        # list comes back empty. Seat one player submission so the
        # recorder picks the turn up — this also exercises the
        # PlayStep capture path under the new groups model.
        messages=[
            Message(
                kind=MessageKind.PLAYER,
                role_id="paul",
                body="filing it now",
                turn_id=turn.id,

            ),
        ],
    )

    scenario = SessionRecorder.to_scenario(session, name="role-groups roundtrip")
    # Round-trip through JSON to ensure Pydantic serialization works.
    blob = scenario.model_dump_json()
    revived = type(scenario).model_validate_json(blob)

    assert len(revived.play_turns) == 1
    pt = revived.play_turns[0]
    # "creator" is the recorder's portable substitute for the creator
    # role's label, so Ben becomes "creator" on capture.
    assert pt.active_role_label_groups == [["creator"], ["Paul", "Lawrence"]]


def test_runner_resolves_label_groups_back_to_id_groups(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The runner's ``_next_active_role_groups`` resolves a captured
    label-groups list back to id-groups using its label↔id map."""

    from app.devtools.runner import ScenarioRunner
    from app.devtools.scenario import PlayTurn

    runner = ScenarioRunner.__new__(ScenarioRunner)  # type: ignore[call-arg]
    runner._role_ids = {  # type: ignore[attr-defined]
        "creator": "ben_id",
        "Paul": "paul_id",
        "Lawrence": "law_id",
    }

    turn = PlayTurn(
        submissions=[],
        ai_messages=[],
        active_role_label_groups=[["creator"], ["Paul", "Lawrence"]],
    )
    groups = runner._next_active_role_groups(turn)  # type: ignore[attr-defined]
    assert groups == [["ben_id"], ["paul_id", "law_id"]]


def test_runner_rejects_turn_missing_active_role_label_groups(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``active_role_label_groups`` is required on every recorded turn.
    Fixtures lacking it are pre-#168 and must be re-recorded; the runner
    fails loud (rather than inferring singletons) so the operator
    notices."""

    from app.devtools.runner import ScenarioRunner
    from app.devtools.scenario import PlayStep, PlayTurn

    runner = ScenarioRunner.__new__(ScenarioRunner)  # type: ignore[call-arg]
    runner._role_ids = {  # type: ignore[attr-defined]
        "creator": "ben_id",
        "Paul": "paul_id",
    }

    turn = PlayTurn(
        submissions=[
            PlayStep(role_label="creator", content="…"),
            PlayStep(role_label="Paul", content="…"),
        ],
        ai_messages=[],
        active_role_label_groups=[],
    )
    with pytest.raises(ValueError, match="active_role_label_groups"):
        runner._next_active_role_groups(turn)  # type: ignore[attr-defined]


# ---------------------------------------------------------------------
# Tool schema sanity (catches a model-output that doesn't match)
# ---------------------------------------------------------------------


def test_set_active_roles_tool_uses_role_groups_schema() -> None:
    """The Anthropic tool definition declares ``role_groups`` with the
    nested-array shape. A regression that re-renames it back to
    ``role_ids`` (or flattens the schema) would trip the AI silently."""

    from app.llm.tools import PLAY_TOOLS

    by_name = {t["name"]: t for t in PLAY_TOOLS}
    tool = by_name["set_active_roles"]
    schema = tool["input_schema"]
    assert schema["required"] == ["role_groups"]
    role_groups = schema["properties"]["role_groups"]
    assert role_groups["type"] == "array"
    assert role_groups["items"]["type"] == "array"
    assert role_groups["items"]["items"]["type"] == "string"
    assert role_groups["items"]["minItems"] == 1
    assert role_groups["minItems"] == 1


# ---------------------------------------------------------------------
# Promise-keeping: the Block 6 prompt mentions the new shape
# ---------------------------------------------------------------------


def test_play_prompt_block_documents_role_groups() -> None:
    """The play-tier prompt must mention ``role_groups`` and include
    a worked example for each shape (singleton, any-of, mixed). Without
    this the model keeps emitting the flat ``role_ids=[…]`` shape and
    the dispatcher rejects every yield."""

    from app.llm.prompts import _TOOL_USE_PROTOCOL

    assert "role_groups" in _TOOL_USE_PROTOCOL
    # Singleton example.
    assert "role_groups=[[ben.id]]" in _TOOL_USE_PROTOCOL
    # Any-of example matching the screenshot.
    assert "[paul.id, lawrence.id]" in _TOOL_USE_PROTOCOL
    # Mixed example (Ben + Paul-or-Lawrence).
    assert "[[ben.id], [paul.id, lawrence.id]]" in _TOOL_USE_PROTOCOL
    # Two-singleton-groups example (the most common shape — both
    # required, each in own group).
    assert "[[ciso.id], [soc.id]]" in _TOOL_USE_PROTOCOL
    # No-legacy-shape invariant: a regression that re-introduced the
    # flat ``role_ids=[…]`` shape in the worked examples would silently
    # coach the model toward a yield the dispatcher now rejects.
    assert "role_ids=[" not in _TOOL_USE_PROTOCOL


def test_set_active_roles_description_documents_groups_semantic() -> None:
    """The tool description must explain the per-group quorum so the
    model picks the right group shape AND explicitly names the
    behavioral split between singleton and multi-role groups."""

    from app.llm.tools import PLAY_TOOLS

    by_name = {t["name"]: t for t in PLAY_TOOLS}
    desc = by_name["set_active_roles"]["description"]
    # Core semantic.
    assert "ANY ONE of its members" in desc
    assert "every group" in desc.lower() or "EVERY group" in desc
    # Worked-example shape — the model needs to see both group flavors.
    assert "[ben_id]" in desc  # singleton
    assert "[paul_id, lawrence_id]" in desc  # multi-role any-of
    # Behavioral split — assert the description names BOTH the "must
    # respond" side (singleton) AND the "first vote wins" side (multi).
    assert "must respond" in desc.lower()
    assert "first ready vote" in desc.lower() or "any of you" in desc.lower()
    # Strict-subset rule survives the rename.
    assert "Strict subset rule" in desc


def test_address_role_and_broadcast_descriptions_use_role_groups() -> None:
    """Issue #168 prompt-expert C1+C2: ``address_role`` and ``broadcast``
    descriptions both reference how to pair with ``set_active_roles``.
    They must use the new ``role_groups=[[...]]`` shape, not the legacy
    flat ``[that_role_id]`` form. A regression here teaches the model
    to emit a yield the dispatcher rejects."""

    from app.llm.tools import PLAY_TOOLS

    by_name = {t["name"]: t for t in PLAY_TOOLS}
    addr_desc = by_name["address_role"]["description"]
    bcast_desc = by_name["broadcast"]["description"]
    # Both must mention role_groups when describing how to pair the
    # yield. The legacy "[that_role_id]" form (single brackets) is the
    # dispatcher-rejected shape.
    assert "role_groups" in addr_desc
    assert "role_groups" in bcast_desc
    # The legacy "exactly that one role_id" / "exactly two ids"
    # phrasing must not survive — they coach the flat shape.
    assert "exactly that one role_id" not in bcast_desc
    assert "exactly those two ids" not in bcast_desc


def test_strict_yield_recovery_directive_uses_role_groups() -> None:
    """Issue #168 prompt-expert H2: the strict-yield recovery note +
    user-nudge are read by the model when ``tool_choice`` pins to
    ``set_active_roles``. They must teach the new ``role_groups``
    shape — coaching ``role_ids`` here means the recovery itself
    fails (dispatcher rejects, model gets stuck)."""

    from app.sessions.turn_validator import (
        _STRICT_YIELD_NOTE,
        _STRICT_YIELD_USER_NUDGE,
    )

    assert "role_groups" in _STRICT_YIELD_NOTE
    assert "role_groups" in _STRICT_YIELD_USER_NUDGE
    # No legacy phrasing.
    assert "with the role_ids" not in _STRICT_YIELD_NOTE
    assert "with the role_ids" not in _STRICT_YIELD_USER_NUDGE


def test_recovery_directive_prose_action_matches_tools_allowlist() -> None:
    """Class-level: every recovery directive narrows ``tools_allowlist``;
    the prose tells the model "Issue a ``<tool>`` now". The action verb
    in the prose MUST name a tool that's actually in the allowlist —
    otherwise the model takes the prose's instruction, calls a tool
    the dispatcher rejects, and the recovery itself fails to recover.
    Symmetrically, the ``tool_choice`` pin must point at a tool in the
    allowlist.

    Catches the *class* of drift where someone tightens the allowlist
    but not the prose (or vice-versa) on any present-or-future
    recovery directive.
    """

    import re

    from app.sessions.turn_validator import (
        drive_recovery_directive,
        strict_yield_directive,
    )

    # Sample directive instances for every constructor we ship.
    # Add new recovery paths to this list when they land — the
    # class assertion below applies uniformly.
    directives = [
        ("strict_yield", strict_yield_directive()),
        (
            "drive_no_inject",
            drive_recovery_directive(
                pending_player_question=None,
                pending_critical_inject_args=None,
            ),
        ),
        (
            "drive_with_question",
            drive_recovery_directive(
                pending_player_question="@facilitator what about Jordan?",
                pending_critical_inject_args=None,
            ),
        ),
        (
            "drive_with_inject",
            drive_recovery_directive(
                pending_player_question=None,
                pending_critical_inject_args={
                    "severity": "warn",
                    "headline": "ransomware note",
                    "body": "posted to dark forum",
                },
            ),
        ),
    ]

    failures: list[str] = []
    for label, directive in directives:
        allowlist = directive.tools_allowlist
        assert allowlist, (
            f"{label}: tools_allowlist is empty (use None to mean "
            f"unconstrained, not empty)."
        )

        # tool_choice pin (when set) must be in the allowlist.
        if directive.tool_choice and directive.tool_choice.get("type") == "tool":
            pinned = directive.tool_choice.get("name")
            if pinned not in allowlist:
                failures.append(
                    f"{label}: tool_choice pin '{pinned}' is not in "
                    f"tools_allowlist {sorted(allowlist)}"
                )

        # Find every "Issue a `<tool>`" / "call `<tool>`" / "emit
        # `<tool>`" / "`<tool>` now" pattern in the prose. Each named
        # tool must be in the allowlist.
        prose = (directive.system_addendum or "") + "\n" + (directive.user_nudge or "")
        action_patterns = [
            r"[Ii]ssue (?:a|an) `([a-z_]+)`",
            r"[Cc]all `([a-z_]+)`",
            r"[Ee]mit `([a-z_]+)`",
            r"`([a-z_]+)` now\b",
        ]
        named: set[str] = set()
        for pattern in action_patterns:
            named.update(re.findall(pattern, prose))

        for tool in named:
            if tool not in allowlist:
                failures.append(
                    f"{label}: prose tells the model to act via `{tool}` "
                    f"but tools_allowlist is {sorted(allowlist)}. The "
                    f"dispatcher will reject and the recovery will fail."
                )

    assert not failures, (
        "Recovery directive ↔ allowlist drift:\n  " + "\n  ".join(failures)
    )


def test_drive_recovery_directive_uses_positive_player_facing_list() -> None:
    """Bug-scrub H5: the directive used to enumerate bookkeeping tools
    by name in a parenthetical that read as exhaustive ("these are
    the non-player-facing tools, everything else is fine"). The model
    occasionally inferred 'set_active_roles isn't on the bookkeeping
    list, so a second yield must be the bookkeeping move'.

    Pin the *replacement* contract (positive list of player-facing
    tools) by deriving the player-facing subset from the play-tier
    palette — if a player-facing tool gets renamed in PLAY_TOOLS,
    this test fails until the directive copy is updated too.
    """

    from app.llm.tools import PLAY_TOOLS
    from app.sessions.turn_validator import _DRIVE_RECOVERY_NOTE

    player_facing = {"broadcast", "address_role", "pose_choice", "share_data"}
    actual_play_tool_names = {t["name"] for t in PLAY_TOOLS}
    # Sanity: every name in our hardcoded subset must still exist in
    # PLAY_TOOLS, otherwise this test is guarding stale ground.
    missing_from_palette = player_facing - actual_play_tool_names
    assert not missing_from_palette, (
        f"player_facing subset references tool names that aren't in "
        f"PLAY_TOOLS anymore: {missing_from_palette}. Update the subset."
    )

    for tool in player_facing:
        assert tool in _DRIVE_RECOVERY_NOTE, (
            f"Drive-recovery directive must name '{tool}' (player-facing "
            f"tool) in its positive-list framing; missing."
        )

    # Negative-by-omission anti-pattern: the old enumeration listed
    # five bookkeeping tools together. Pin that the exact regression
    # substring is gone.
    assert "track_role_followup`, `resolve_role_followup`, `request_artifact`, `lookup_resource`, `use_extension_tool" not in _DRIVE_RECOVERY_NOTE, (
        "Drive-recovery directive shouldn't enumerate bookkeeping tools "
        "as an exhaustive list — it reads as 'these are the non-player-"
        "facing tools, everything else (incl. set_active_roles) is fine'."
    )


# ---------------------------------------------------------------------
# Suppress the unused-import warning for ``json`` if the file shrinks.
# ---------------------------------------------------------------------

_ = json  # silence ruff if no JSON usage remains after edits.


# ---------------------------------------------------------------------
# Class-level: every shipped scenario JSON populates the new field
# ---------------------------------------------------------------------


def test_every_shipped_scenario_populates_active_role_label_groups() -> None:
    """The May 2026 bug-scrub deleted the runner's legacy fallback
    branch that inferred ``active_role_label_groups`` from submissions
    when the field was absent. The four shipped scenarios were
    migrated to populate the field. This test pins the invariant for
    *every* scenario JSON shipped under ``backend/scenarios/``: each
    ``play_turns[]`` entry must carry a non-empty
    ``active_role_label_groups`` list.

    Catches the class of failure where a contributor re-records a
    scenario and forgets the field, OR adds a brand-new scenario
    without it. Either case would make the runner hard-fail at replay
    time; the test fails at CI time instead.
    """

    from pathlib import Path

    scenarios_dir = (
        Path(__file__).resolve().parents[1] / "scenarios"
    )
    scenario_files = sorted(scenarios_dir.glob("*.json"))
    assert scenario_files, (
        f"Expected to find scenario JSONs under {scenarios_dir}; "
        f"none found."
    )

    failures: list[str] = []
    for path in scenario_files:
        data = json.loads(path.read_text())
        play_turns = data.get("play_turns", [])
        for i, turn in enumerate(play_turns):
            groups = turn.get("active_role_label_groups")
            if i == 0 and not turn.get("submissions"):
                # The deterministic-mode contract: turn 0 is the
                # briefing — no submissions yet. The runner doesn't
                # consult the field for a turn that has no advance
                # gate. Allow empty here so the migration didn't have
                # to invent a yield-shape for the briefing.
                continue
            if groups is None or len(groups) == 0:
                failures.append(
                    f"{path.name} play_turns[{i}]: missing or empty "
                    f"active_role_label_groups"
                )
                continue
            for j, group in enumerate(groups):
                if not isinstance(group, list) or len(group) == 0:
                    failures.append(
                        f"{path.name} play_turns[{i}].active_role_label_groups[{j}]: "
                        f"each group must be a non-empty list of label strings"
                    )

    assert not failures, (
        "Scenario JSON missing required active_role_label_groups field:\n  "
        + "\n  ".join(failures)
        + "\n\nFix: re-record the scenario via the recorder, or hand-edit "
        "each play_turn to include `active_role_label_groups`: "
        "[[label1], [label2]] mirroring the recorded submissions."
    )
