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
                intent="ready",
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


def test_runner_falls_back_to_singleton_groups_for_legacy_fixtures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Pre-#168 fixtures lack ``active_role_label_groups``; the runner
    infers singleton groups from the recorded submissions so the
    legacy 'all must ready' semantic survives without re-recording."""

    from app.devtools.runner import ScenarioRunner
    from app.devtools.scenario import PlayStep, PlayTurn

    runner = ScenarioRunner.__new__(ScenarioRunner)  # type: ignore[call-arg]
    runner._role_ids = {  # type: ignore[attr-defined]
        "creator": "ben_id",
        "Paul": "paul_id",
    }

    turn = PlayTurn(
        submissions=[
            PlayStep(role_label="creator", content="…", intent="ready"),
            PlayStep(role_label="Paul", content="…", intent="ready"),
        ],
        ai_messages=[],
        active_role_label_groups=[],
    )
    groups = runner._next_active_role_groups(turn)  # type: ignore[attr-defined]
    assert groups == [["ben_id"], ["paul_id"]]


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


def test_set_active_roles_description_documents_groups_semantic() -> None:
    """The tool description must explain the per-group quorum so the
    model picks the right group shape. Without this the model defaults
    to one big group (any-of for everyone) or back to flat ids."""

    from app.llm.tools import PLAY_TOOLS

    by_name = {t["name"]: t for t in PLAY_TOOLS}
    desc = by_name["set_active_roles"]["description"]
    # Core semantic.
    assert "ANY ONE of its members" in desc
    assert "every group" in desc.lower() or "EVERY group" in desc
    # Worked-example shape — the model needs to see both group flavors.
    assert "[ben_id]" in desc  # singleton
    assert "[paul_id, lawrence_id]" in desc  # multi-role any-of


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


# ---------------------------------------------------------------------
# Suppress the unused-import warning for ``json`` if the file shrinks.
# ---------------------------------------------------------------------

_ = json  # silence ruff if no JSON usage remains after edits.
