"""Phase B chat-declutter regression tests.

Phase B (docs/plans/chat-decluttering.md §3.1, §4.7) extends the
``workstream_id`` validation from Phase A's ``address_role`` to three
more routing tools — ``pose_choice``, ``share_data``, and
``inject_critical_event``. The dispatch path is shared
(``_validate_workstream_id``) so the four branches collapse onto the
same set of tests; what's new in this file is wiring each tool through
that path and asserting the message stamp + ``tool_args``
canonicalization.

The schema-shape tests live alongside the existing Phase A schema tests
in ``test_chat_declutter_phase_a.py``; this file is dispatch-side only.

The frontend filter logic + UI components are tested in the frontend
suite under ``frontend/src/__tests__/transcriptFilters.test.ts`` and
``transcriptFiltersUI.test.tsx``.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.auth.audit import AuditLog
from app.extensions.dispatch import ExtensionDispatcher
from app.extensions.models import ExtensionBundle
from app.extensions.registry import freeze_bundle
from app.llm.dispatch import ToolDispatcher
from app.llm.tools import PLAY_TOOLS
from app.sessions.models import (
    Message,
    MessageKind,
    Role,
    ScenarioBeat,
    ScenarioInject,
    ScenarioPlan,
    Session,
    SessionState,
    Workstream,
)
from app.ws.connection_manager import ConnectionManager

# ----------------------------------------------------------------------
# Helpers


def _build_play_session() -> Session:
    ciso = Role(id="role-ciso", label="CISO", is_creator=True)
    ir_lead = Role(id="role-ir", label="IR Lead")
    plan = ScenarioPlan(
        title="Ransomware",
        key_objectives=["Contain"],
        narrative_arc=[
            ScenarioBeat(beat=1, label="Detection", expected_actors=["SOC"])
        ],
        injects=[
            ScenarioInject(trigger="after beat 1", type="event", summary="x")
        ],
        workstreams=[
            Workstream(id="containment", label="Containment"),
            Workstream(id="comms", label="Comms"),
        ],
    )
    return Session(
        scenario_prompt="r",
        state=SessionState.AI_PROCESSING,
        roles=[ciso, ir_lead],
        creator_role_id=ciso.id,
        plan=plan,
    )


def _make_dispatcher(*, workstreams_enabled: bool = True) -> ToolDispatcher:
    bundle = ExtensionBundle()
    registry = freeze_bundle(bundle)
    audit = AuditLog()
    ext_dispatcher = ExtensionDispatcher(registry=registry, audit=audit)
    return ToolDispatcher(
        connections=ConnectionManager(),
        audit=audit,
        extension_dispatcher=ext_dispatcher,
        registry=registry,
        workstreams_enabled=workstreams_enabled,
    )


async def _dispatch(
    dispatcher: ToolDispatcher,
    session: Session,
    *tool_uses: dict[str, Any],
    critical_allowed: bool = True,
) -> Any:
    return await dispatcher.dispatch(
        session=session,
        tool_uses=list(tool_uses),
        turn_id="t1",
        critical_inject_allowed_cb=lambda: critical_allowed,
    )


def _tu(name: str, args: dict[str, Any], tool_id: str = "tu1") -> dict[str, Any]:
    return {"name": name, "input": args, "id": tool_id}


# ----------------------------------------------------------------------
# Schema shape — Phase B tools must each gain the optional field


class TestPhaseBToolSchemas:
    """All three new tools accept ``workstream_id`` and keep their
    pre-existing required lists intact."""

    @pytest.mark.parametrize(
        "tool_name,required",
        [
            ("pose_choice", {"role_id", "question", "options"}),
            ("share_data", {"label", "data"}),
            ("inject_critical_event", {"severity", "headline", "body"}),
        ],
    )
    def test_workstream_id_field_added(
        self, tool_name: str, required: set[str]
    ) -> None:
        tool = next(t for t in PLAY_TOOLS if t["name"] == tool_name)
        props = tool["input_schema"]["properties"]
        assert "workstream_id" in props, (
            f"{tool_name} missing the optional workstream_id field"
        )
        assert set(tool["input_schema"]["required"]) == required, (
            f"{tool_name}.required was widened — workstream_id must "
            "stay optional per plan §3.1"
        )

    def test_descriptions_did_not_grow_prose(self) -> None:
        """Plan §3.1 guardrail: only the input_schema grows. The
        per-tool descriptions stay shape-equivalent to pre-Phase-B —
        no new directives, examples, or directives that could
        conflict across tools (Prompt Expert review specifically
        flagged this as the failure mode for "four near-identical
        schema diffs at once")."""

        for name in ("pose_choice", "share_data", "inject_critical_event"):
            tool = next(t for t in PLAY_TOOLS if t["name"] == name)
            desc = tool["description"]
            # The description must NOT mention the field name — that
            # would be a redundant restatement of the input_schema's
            # description and is the exact kind of prompt-tax the
            # Prompt Expert review guards against.
            assert "workstream_id" not in desc, (
                f"{name} description leaked workstream_id; per plan "
                "§3.1 only the input_schema grows"
            )


# ----------------------------------------------------------------------
# Dispatch — pose_choice


class TestPoseChoiceWorkstreamDispatch:
    @pytest.mark.asyncio
    async def test_valid_workstream_id_is_recorded(self) -> None:
        dispatcher = _make_dispatcher()
        session = _build_play_session()
        outcome = await _dispatch(
            dispatcher,
            session,
            _tu(
                "pose_choice",
                {
                    "role_id": "role-ir",
                    "question": "Isolate now?",
                    "options": ["Isolate", "Monitor"],
                    "workstream_id": "containment",
                },
            ),
        )
        msg = outcome.appended_messages[0]
        assert msg.kind == MessageKind.AI_TEXT
        assert msg.workstream_id == "containment"
        # Phase B parity with address_role: pose_choice is
        # single-addressee so the target role gets stamped as a
        # structural mention (drives the @-highlight + (@you) badge).
        assert msg.mentions == ["role-ir"]
        assert msg.tool_args is not None
        assert msg.tool_args["workstream_id"] == "containment"
        assert outcome.tool_results[0]["is_error"] is False

    @pytest.mark.asyncio
    async def test_invalid_workstream_id_is_tool_error(self) -> None:
        dispatcher = _make_dispatcher()
        session = _build_play_session()
        outcome = await _dispatch(
            dispatcher,
            session,
            _tu(
                "pose_choice",
                {
                    "role_id": "role-ir",
                    "question": "Q?",
                    "options": ["A", "B"],
                    "workstream_id": "vendor_management",
                },
            ),
        )
        assert outcome.tool_results[0]["is_error"] is True
        content = outcome.tool_results[0]["content"]
        assert "vendor_management" in content
        assert "containment" in content
        # Strict-retry semantics: rejected calls do NOT append a
        # message; the model self-corrects on the next turn.
        assert outcome.appended_messages == []

    @pytest.mark.asyncio
    async def test_missing_field_is_none(self) -> None:
        dispatcher = _make_dispatcher()
        session = _build_play_session()
        outcome = await _dispatch(
            dispatcher,
            session,
            _tu(
                "pose_choice",
                {
                    "role_id": "role-ir",
                    "question": "Q?",
                    "options": ["A", "B"],
                },
            ),
        )
        msg = outcome.appended_messages[0]
        assert msg.workstream_id is None
        assert msg.tool_args is not None
        assert msg.tool_args["workstream_id"] is None


# ----------------------------------------------------------------------
# Dispatch — share_data


class TestShareDataWorkstreamDispatch:
    @pytest.mark.asyncio
    async def test_valid_workstream_id_is_recorded(self) -> None:
        dispatcher = _make_dispatcher()
        session = _build_play_session()
        outcome = await _dispatch(
            dispatcher,
            session,
            _tu(
                "share_data",
                {
                    "label": "Defender telemetry",
                    "data": "FIN-04 isolated",
                    "workstream_id": "containment",
                },
            ),
        )
        msg = outcome.appended_messages[0]
        assert msg.workstream_id == "containment"
        # share_data is non-addressed by design (cross-cutting data
        # dump) — no structural mentions even when scoped.
        assert msg.mentions == []
        assert msg.tool_args is not None
        assert msg.tool_args["workstream_id"] == "containment"

    @pytest.mark.asyncio
    async def test_empty_string_falls_back_to_none(self) -> None:
        dispatcher = _make_dispatcher()
        session = _build_play_session()
        outcome = await _dispatch(
            dispatcher,
            session,
            _tu(
                "share_data",
                {"label": "X", "data": "Y", "workstream_id": ""},
            ),
        )
        msg = outcome.appended_messages[0]
        assert msg.workstream_id is None

    @pytest.mark.asyncio
    async def test_invalid_workstream_id_is_tool_error(self) -> None:
        dispatcher = _make_dispatcher()
        session = _build_play_session()
        outcome = await _dispatch(
            dispatcher,
            session,
            _tu(
                "share_data",
                {
                    "label": "X",
                    "data": "Y",
                    "workstream_id": "ghost_track",
                },
            ),
        )
        assert outcome.tool_results[0]["is_error"] is True
        assert outcome.appended_messages == []


# ----------------------------------------------------------------------
# Dispatch — inject_critical_event


class TestInjectCriticalEventWorkstreamDispatch:
    @pytest.mark.asyncio
    async def test_valid_workstream_id_is_recorded(self) -> None:
        dispatcher = _make_dispatcher()
        session = _build_play_session()
        outcome = await _dispatch(
            dispatcher,
            session,
            _tu(
                "inject_critical_event",
                {
                    "severity": "HIGH",
                    "headline": "Reporter call",
                    "body": "tabloid leak",
                    "workstream_id": "comms",
                },
            ),
        )
        msg = outcome.appended_messages[0]
        assert msg.kind == MessageKind.CRITICAL_INJECT
        assert msg.workstream_id == "comms"
        assert outcome.critical_inject_fired

    @pytest.mark.asyncio
    async def test_invalid_workstream_id_is_tool_error_no_inject(self) -> None:
        # Plan §4.5: validation runs BEFORE the WS broadcast so a bad
        # value short-circuits without fanning out a critical_event
        # the frontend would have to retract.
        dispatcher = _make_dispatcher()
        session = _build_play_session()
        outcome = await _dispatch(
            dispatcher,
            session,
            _tu(
                "inject_critical_event",
                {
                    "severity": "HIGH",
                    "headline": "x",
                    "body": "y",
                    "workstream_id": "made_up",
                },
            ),
        )
        assert outcome.tool_results[0]["is_error"] is True
        assert outcome.critical_inject_fired is False
        assert outcome.appended_messages == []

    @pytest.mark.asyncio
    async def test_flag_off_silently_drops_workstream_id(self) -> None:
        # Defence in depth — an upgraded model emitting the field
        # against a flag-off backend MUST NOT error the inject.
        dispatcher = _make_dispatcher(workstreams_enabled=False)
        session = _build_play_session()
        outcome = await _dispatch(
            dispatcher,
            session,
            _tu(
                "inject_critical_event",
                {
                    "severity": "HIGH",
                    "headline": "ok",
                    "body": "y",
                    "workstream_id": "containment",
                },
            ),
        )
        msg = outcome.appended_messages[0]
        assert msg.workstream_id is None
        assert outcome.critical_inject_fired


# ----------------------------------------------------------------------
# §4.4 — player-reply workstream inheritance


class TestPlayerReplyInheritance:
    """Plan §4.4 rule (2): the most recent AI message that addressed
    this player carries a ``workstream_id``; the player's reply
    inherits it. Validated through the helper directly so the test
    pins the contract without standing up a full SessionManager."""

    def _addressing_msg(
        self,
        *,
        role_id: str,
        workstream_id: str | None,
    ) -> Message:
        return Message(
            kind=MessageKind.AI_TEXT,
            body=f"@{role_id}: do the thing",
            mentions=[role_id],
            workstream_id=workstream_id,
        )

    def test_inherits_from_most_recent_addressing_ai_message(self) -> None:
        from app.sessions.manager import _inherit_workstream_id

        session = _build_play_session()
        session.messages.append(
            self._addressing_msg(role_id="role-ir", workstream_id="comms")
        )
        session.messages.append(
            self._addressing_msg(role_id="role-ir", workstream_id="containment")
        )
        # Most recent wins.
        assert _inherit_workstream_id(session, role_id="role-ir") == "containment"

    def test_returns_none_when_no_addressing_message(self) -> None:
        from app.sessions.manager import _inherit_workstream_id

        session = _build_play_session()
        # AI message addresses someone else — ir's reply has nothing
        # to inherit.
        session.messages.append(
            self._addressing_msg(role_id="role-ciso", workstream_id="comms")
        )
        assert _inherit_workstream_id(session, role_id="role-ir") is None

    def test_returns_none_when_addressing_message_was_unscoped(self) -> None:
        from app.sessions.manager import _inherit_workstream_id

        session = _build_play_session()
        session.messages.append(
            self._addressing_msg(role_id="role-ir", workstream_id=None)
        )
        assert _inherit_workstream_id(session, role_id="role-ir") is None

    def test_skips_player_messages_when_walking_back(self) -> None:
        # An intervening player post must NOT short-circuit the walk
        # — only AI messages count as "addressing" events per §4.4.
        from app.sessions.manager import _inherit_workstream_id

        session = _build_play_session()
        session.messages.append(
            self._addressing_msg(role_id="role-ir", workstream_id="containment")
        )
        session.messages.append(
            Message(
                kind=MessageKind.PLAYER,
                role_id="role-ir",
                body="acknowledged",
            )
        )
        # Even though a player message intervenes, the AI message's
        # workstream is still the most recent ADDRESSING event.
        assert _inherit_workstream_id(session, role_id="role-ir") == "containment"
