"""Per-tool branch tests for the play-tier ToolDispatcher.

Coverage gap addressed: ``app/llm/dispatch.py`` was at 80% — many of
the per-tool branches (share_data, request_artifact, pose_choice,
track_role_followup, lookup_resource, use_extension_tool, the direct
extension-tool fallthrough) were never exercised by the e2e mock
script. Each branch handles trust-boundary identity coercion (role_id
resolution) and message-shape construction; a regression in any of
them shows up as either a misrouted tool error fed back to Claude, or
a malformed message in the transcript.

The dispatcher is exercised here in isolation — no SessionManager, no
LLM client. We hand it a ``Session`` directly and assert on the
resulting ``DispatchOutcome`` and any ``tool_results[*].is_error``.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.auth.audit import AuditLog
from app.extensions.dispatch import ExtensionDispatcher
from app.extensions.models import (
    ExtensionBundle,
    ExtensionResource,
    ExtensionTool,
)
from app.extensions.registry import freeze_bundle
from app.llm.dispatch import ToolDispatcher
from app.sessions.models import (
    MessageKind,
    Role,
    ScenarioBeat,
    ScenarioInject,
    ScenarioPlan,
    Session,
    SessionState,
)
from app.ws.connection_manager import ConnectionManager

# ---------------------------------------------------------------- helpers


def _build_session() -> Session:
    ciso = Role(id="role-ciso", label="CISO", display_name="Alex", is_creator=True)
    soc = Role(id="role-soc", label="SOC Analyst", display_name="Bo")
    plan = ScenarioPlan(
        title="Ransomware via vendor portal",
        executive_summary="03:14 Wednesday.",
        key_objectives=["Confirm scope"],
        narrative_arc=[
            ScenarioBeat(beat=1, label="Detection", expected_actors=["SOC"]),
        ],
        injects=[
            ScenarioInject(
                trigger="after beat 1",
                type="critical",
                summary="Slack screenshot leak",
            )
        ],
        guardrails=[],
        success_criteria=[],
        out_of_scope=[],
    )
    return Session(
        scenario_prompt="Ransomware",
        state=SessionState.AI_PROCESSING,
        roles=[ciso, soc],
        creator_role_id=ciso.id,
        plan=plan,
    )


def _make_dispatcher(
    *,
    tools: list[ExtensionTool] | None = None,
    resources: list[ExtensionResource] | None = None,
) -> ToolDispatcher:
    bundle = ExtensionBundle(
        tools=tools or [],
        resources=resources or [],
    )
    registry = freeze_bundle(bundle)
    audit = AuditLog()
    ext_dispatcher = ExtensionDispatcher(registry=registry, audit=audit)
    return ToolDispatcher(
        connections=ConnectionManager(),
        audit=audit,
        extension_dispatcher=ext_dispatcher,
        registry=registry,
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


# ---------------------------------------------------------------- broadcast / address_role


@pytest.mark.asyncio
async def test_broadcast_appends_ai_text_message() -> None:
    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher, session, _tu("broadcast", {"message": "Detection at 03:14"})
    )
    assert outcome.had_player_facing_message
    assert len(outcome.appended_messages) == 1
    msg = outcome.appended_messages[0]
    assert msg.kind == MessageKind.AI_TEXT
    assert "Detection at 03:14" in msg.body


@pytest.mark.asyncio
async def test_address_role_canonicalises_role_id_from_label() -> None:
    """Model often passes a label ("SOC Analyst") instead of the opaque
    role_id; the dispatcher should resolve it and rewrite tool_args."""

    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu("address_role", {"role_id": "SOC Analyst", "message": "go"}),
    )
    assert len(outcome.appended_messages) == 1
    msg = outcome.appended_messages[0]
    # The body uses the canonical label, and tool_args has the resolved id.
    assert msg.tool_args["role_id"] == "role-soc"
    assert "@SOC Analyst" in msg.body


@pytest.mark.asyncio
async def test_address_role_rejects_unknown_role() -> None:
    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu("address_role", {"role_id": "Marketing", "message": "go"}),
    )
    assert any(r.get("is_error") for r in outcome.tool_results)
    assert outcome.appended_messages == []


# ---------------------------------------------------------------- pose_choice


@pytest.mark.asyncio
async def test_pose_choice_appends_lettered_options() -> None:
    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu(
            "pose_choice",
            {
                "role_id": "role-ciso",
                "question": "Containment direction?",
                "options": ["Isolate", "Monitor", "Escalate to legal"],
            },
        ),
    )
    assert outcome.had_player_facing_message
    msg = outcome.appended_messages[0]
    assert msg.kind == MessageKind.AI_TEXT
    body = msg.body
    assert "**A.**" in body and "**B.**" in body and "**C.**" in body
    assert "Isolate" in body and "Monitor" in body
    assert msg.tool_args["role_id"] == "role-ciso"


@pytest.mark.asyncio
async def test_pose_choice_rejects_too_few_options() -> None:
    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu(
            "pose_choice",
            {
                "role_id": "role-ciso",
                "question": "Q?",
                "options": ["Only one"],
            },
        ),
    )
    err = next(r for r in outcome.tool_results if r.get("is_error"))
    assert "2–5 options" in err["content"]
    assert outcome.appended_messages == []


@pytest.mark.asyncio
async def test_pose_choice_rejects_too_many_options() -> None:
    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu(
            "pose_choice",
            {
                "role_id": "role-ciso",
                "question": "Q?",
                "options": ["a", "b", "c", "d", "e", "f"],
            },
        ),
    )
    assert any(r.get("is_error") for r in outcome.tool_results)


# ---------------------------------------------------------------- share_data


@pytest.mark.asyncio
async def test_share_data_with_label_renders_bold_header() -> None:
    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu(
            "share_data",
            {"label": "Defender alerts", "data": "| time | host |\n| --- | --- |"},
        ),
    )
    assert outcome.had_player_facing_message
    msg = outcome.appended_messages[0]
    assert msg.kind == MessageKind.AI_TEXT
    assert msg.body.startswith("**Defender alerts**")
    assert "| time |" in msg.body


@pytest.mark.asyncio
async def test_share_data_without_label_renders_raw_data() -> None:
    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu("share_data", {"data": "raw markdown"}),
    )
    assert outcome.appended_messages[0].body == "raw markdown"


# ---------------------------------------------------------------- request_artifact


@pytest.mark.asyncio
async def test_request_artifact_resolves_and_formats() -> None:
    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu(
            "request_artifact",
            {
                "role_id": "role-ciso",
                "artifact_type": "Comms draft",
                "instructions": "1-paragraph customer notification",
            },
        ),
    )
    msg = outcome.appended_messages[0]
    assert "[Artifact request] Comms draft from CISO" in msg.body
    assert "1-paragraph customer notification" in msg.body


@pytest.mark.asyncio
async def test_request_artifact_rejects_unknown_role() -> None:
    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu(
            "request_artifact",
            {
                "role_id": "role-ghost",
                "artifact_type": "draft",
                "instructions": "x",
            },
        ),
    )
    assert any(r.get("is_error") for r in outcome.tool_results)


# ---------------------------------------------------------------- track_role_followup


@pytest.mark.asyncio
async def test_track_role_followup_records_and_appends_system_message() -> None:
    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu(
            "track_role_followup",
            {"role_id": "role-soc", "prompt": "Pull endpoint telemetry by 04:00"},
        ),
    )
    assert len(session.role_followups) == 1
    fu = session.role_followups[0]
    assert fu.role_id == "role-soc"
    assert fu.status == "open"
    msg = outcome.appended_messages[0]
    assert msg.kind == MessageKind.SYSTEM
    assert "Follow-up tracked" in msg.body
    assert msg.tool_args["followup_id"] == fu.id


@pytest.mark.asyncio
async def test_track_role_followup_rejects_empty_prompt() -> None:
    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu("track_role_followup", {"role_id": "role-soc", "prompt": "   "}),
    )
    err = next(r for r in outcome.tool_results if r.get("is_error"))
    assert "prompt is required" in err["content"]


# ---------------------------------------------------------------- resolve_role_followup


@pytest.mark.asyncio
async def test_resolve_role_followup_marks_done() -> None:
    dispatcher = _make_dispatcher()
    session = _build_session()
    # Open one first.
    await _dispatch(
        dispatcher,
        session,
        _tu("track_role_followup", {"role_id": "role-soc", "prompt": "x"}),
    )
    fu_id = session.role_followups[0].id
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu("resolve_role_followup", {"followup_id": fu_id, "status": "done"}),
    )
    assert session.role_followups[0].status == "done"
    assert session.role_followups[0].resolved_at is not None
    assert "followup done" in outcome.tool_results[0]["content"]


@pytest.mark.asyncio
async def test_resolve_role_followup_rejects_invalid_status() -> None:
    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu("resolve_role_followup", {"followup_id": "x", "status": "complete"}),
    )
    err = next(r for r in outcome.tool_results if r.get("is_error"))
    assert "must be 'done' or 'dropped'" in err["content"]


@pytest.mark.asyncio
async def test_resolve_role_followup_rejects_unknown_id() -> None:
    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu("resolve_role_followup", {"followup_id": "ghost", "status": "done"}),
    )
    err = next(r for r in outcome.tool_results if r.get("is_error"))
    assert "unknown followup_id" in err["content"]


# ---------------------------------------------------------------- mark_timeline_point


@pytest.mark.asyncio
async def test_mark_timeline_point_appends_system_message() -> None:
    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu("mark_timeline_point", {"title": "Containment", "note": "isolated all"}),
    )
    msg = outcome.appended_messages[0]
    assert msg.kind == MessageKind.SYSTEM
    assert "Pinned: Containment" in msg.body
    assert "isolated all" in msg.body


# ---------------------------------------------------------------- inject_critical_event


@pytest.mark.asyncio
async def test_inject_critical_event_appends_critical_message() -> None:
    """Happy path: ``inject_critical_event`` paired with a DRIVE tool
    (per the Critical-inject chain mandate enforced by issue #151 fix
    A) appends the CRITICAL_INJECT message and marks the slot fired."""

    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu(
            "inject_critical_event",
            {"severity": "HIGH", "headline": "Reporter call", "body": "tabloid"},
            tool_id="tu-inject",
        ),
        _tu(
            "broadcast",
            {
                "message": (
                    "**SOC Analyst** — pull the screenshot's metadata. "
                    "**CISO** — call legal in the next 5 minutes."
                )
            },
            tool_id="tu-broadcast",
        ),
    )
    assert outcome.critical_inject_fired
    inject_msg = next(
        m for m in outcome.appended_messages if m.kind == MessageKind.CRITICAL_INJECT
    )
    assert "HIGH" in inject_msg.body and "Reporter call" in inject_msg.body


@pytest.mark.asyncio
async def test_inject_critical_event_respects_rate_limit() -> None:
    """Rate-limit rejection still fires when the inject is paired (the
    pairing check in fix A is independent of the rate-limit gate). A
    paired broadcast still lands; only the inject is rejected."""

    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu(
            "inject_critical_event",
            {"severity": "HIGH", "headline": "x", "body": "y"},
            tool_id="tu-inject",
        ),
        _tu(
            "broadcast",
            {"message": "**SOC Analyst** — what's the current alert volume?"},
            tool_id="tu-broadcast",
        ),
        critical_allowed=False,
    )
    err = next(
        r
        for r in outcome.tool_results
        if r.get("is_error") and r.get("tool_use_id") == "tu-inject"
    )
    assert "rate limit" in err["content"]
    assert not outcome.critical_inject_fired


@pytest.mark.asyncio
async def test_inject_critical_event_rejected_when_unpaired() -> None:
    """Issue #151 fix A: a solo ``inject_critical_event`` (no DRIVE-slot
    tool in the same response) is rejected at dispatch with a clear
    chain-shape error. The inject's side effects (banner, message
    append) are skipped so the strict-retry path can replay the
    structured error to the model on the cheaper layer instead of
    paying the post-turn DRIVE recovery cost.

    This is the headline regression issue #151 reports — the model
    fires `inject_critical_event` alone, the validator fires
    DRIVE+YIELD recovery (two extra LLM calls), the user sees the
    banner land then a brief stall while the recovery completes."""

    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu(
            "inject_critical_event",
            {
                "severity": "HIGH",
                "headline": "Reporter call",
                "body": "tabloid",
            },
            tool_id="tu-inject",
        ),
    )
    err = next(
        r
        for r in outcome.tool_results
        if r.get("is_error") and r.get("tool_use_id") == "tu-inject"
    )
    assert "without a same-response DRIVE-slot tool" in err["content"]
    assert "Re-fire as" in err["content"]
    # No banner / message landed.
    assert not outcome.critical_inject_fired
    assert not [
        m for m in outcome.appended_messages if m.kind == MessageKind.CRITICAL_INJECT
    ]
    # Fix B: the attempted args still propagate so the validator can
    # ground a missing-DRIVE recovery on the inject context.
    assert outcome.critical_inject_attempted_args == {
        "severity": "HIGH",
        "headline": "Reporter call",
        "body": "tabloid",
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "drive_tool,drive_args",
    [
        (
            "broadcast",
            {"message": "**SOC Analyst** — pull the metadata; **CISO** — call legal."},
        ),
        (
            "address_role",
            {
                "role_id": "role-soc",
                "message": "Pull the screenshot's metadata in the next 60 seconds.",
            },
        ),
        (
            "share_data",
            {
                "label": "Slack screenshot — viral copy",
                "data": "url: https://example/slack-screenshot",
            },
        ),
        (
            "pose_choice",
            {
                "role_id": "role-ciso",
                "question": "Containment posture given the leak?",
                "options": [
                    "Isolate the affected hosts immediately",
                    "Hold for 10 minutes for full scope",
                ],
            },
        ),
    ],
)
async def test_inject_paired_with_any_drive_tool_lands_chain(
    drive_tool: str, drive_args: dict[str, Any]
) -> None:
    """Issue #151 fix A: any DRIVE-slot tool — ``broadcast``,
    ``address_role``, ``share_data``, or ``pose_choice`` — satisfies
    the pairing requirement. Catches the failure mode where the rule
    is enforced too narrowly (e.g. only ``broadcast``) and a legit
    inject + share_data chain gets blocked."""

    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu(
            "inject_critical_event",
            {"severity": "HIGH", "headline": "Reporter call", "body": "tabloid"},
            tool_id="tu-inject",
        ),
        _tu(drive_tool, drive_args, tool_id="tu-drive"),
    )
    assert outcome.critical_inject_fired, (
        f"inject was rejected when paired with {drive_tool!r}; pairing "
        "should have satisfied fix A"
    )
    # The inject's tool_result is non-error.
    inject_result = next(
        r for r in outcome.tool_results if r.get("tool_use_id") == "tu-inject"
    )
    assert not inject_result.get("is_error")


@pytest.mark.asyncio
async def test_inject_attempted_args_captured_even_when_rejected() -> None:
    """Issue #151 fix B: regardless of whether the inject succeeds or
    is rejected for missing pairing, the attempted args propagate on
    ``DispatchOutcome.critical_inject_attempted_args`` so the turn
    validator can ground a missing-DRIVE recovery on the inject
    context. Without this, the recovery would fall back to the
    generic "skipped the player-facing message" prompt and the model's
    recovery broadcast would ignore the inject."""

    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu(
            "inject_critical_event",
            {
                "severity": "HIGH",
                "headline": "Slack screenshot leak",
                "body": "Reporter call in 30 minutes.",
            },
            tool_id="tu-inject",
        ),
    )
    # Inject was rejected (no pairing) but the args are captured.
    assert outcome.critical_inject_attempted_args is not None
    assert outcome.critical_inject_attempted_args["headline"] == "Slack screenshot leak"
    assert outcome.critical_inject_attempted_args["severity"] == "HIGH"


@pytest.mark.asyncio
async def test_multiple_injects_capture_most_recent_args() -> None:
    """When the model fires multiple injects in one batch (rare but
    possible — strict retry, model confusion), the most-recent attempt
    wins as the recovery anchor. Covers the single-anchor contract
    documented on ``critical_inject_attempted_args``."""

    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu(
            "inject_critical_event",
            {"severity": "HIGH", "headline": "First inject", "body": "earlier"},
            tool_id="tu-inject-1",
        ),
        _tu(
            "inject_critical_event",
            {"severity": "HIGH", "headline": "Second inject", "body": "later"},
            tool_id="tu-inject-2",
        ),
        _tu(
            "broadcast",
            {"message": "**CISO** — both events need a containment call."},
            tool_id="tu-broadcast",
        ),
    )
    assert outcome.critical_inject_attempted_args is not None
    assert outcome.critical_inject_attempted_args["headline"] == "Second inject"


def test_merge_outcomes_preserves_inject_args_across_recovery_passes() -> None:
    """Issue #151 fix B grounding payload survives recovery merges.

    The recovery path's narrowed tool surface excludes
    ``inject_critical_event`` (DRIVE recovery is pinned to
    ``broadcast`` only), so attempt-2's outcome NEVER carries an
    inject_attempts entry. Without the merge contract documented here,
    attempt-1's grounding payload would be silently dropped on
    re-validation, defeating fix B.

    Locks the contract: src=None must NOT clobber a non-None target.
    """

    from app.llm.dispatch import DispatchOutcome
    from app.sessions.turn_driver import _merge_outcomes

    target = DispatchOutcome()
    target.critical_inject_attempted_args = {
        "severity": "HIGH",
        "headline": "Press leak",
        "body": "Reporter calling.",
    }
    src = DispatchOutcome()  # recovery pass — no inject attempt
    assert src.critical_inject_attempted_args is None

    _merge_outcomes(target, src)

    assert target.critical_inject_attempted_args == {
        "severity": "HIGH",
        "headline": "Press leak",
        "body": "Reporter calling.",
    }


def test_merge_outcomes_replaces_inject_args_when_src_has_newer_attempt() -> None:
    """Inverse of the preservation test: when a later attempt fires
    its OWN inject (which is unusual on a recovery pass since DRIVE
    recovery's tool surface excludes ``inject_critical_event``, but
    the contract is the same as ``set_active_role_ids`` — last write
    wins). Documents the merge ordering so a future recovery
    directive that restores inject visibility behaves predictably."""

    from app.llm.dispatch import DispatchOutcome
    from app.sessions.turn_driver import _merge_outcomes

    target = DispatchOutcome()
    target.critical_inject_attempted_args = {
        "severity": "HIGH",
        "headline": "First",
        "body": "old",
    }
    src = DispatchOutcome()
    src.critical_inject_attempted_args = {
        "severity": "MEDIUM",
        "headline": "Second",
        "body": "new",
    }

    _merge_outcomes(target, src)

    assert target.critical_inject_attempted_args == {
        "severity": "MEDIUM",
        "headline": "Second",
        "body": "new",
    }


# ---------------------------------------------------------------- set_active_roles


@pytest.mark.asyncio
async def test_set_active_roles_resolves_label_fallback() -> None:
    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu("set_active_roles", {"role_ids": ["SOC Analyst"]}),
    )
    assert outcome.set_active_role_ids == ["role-soc"]
    assert outcome.had_yielding_call


@pytest.mark.asyncio
async def test_set_active_roles_soft_passes_with_unresolved() -> None:
    """One real id + one bogus = soft success: yields to the resolved
    set, surfaces a warning to the model in the tool_result content."""

    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu("set_active_roles", {"role_ids": ["role-soc", "Marketing"]}),
    )
    assert outcome.set_active_role_ids == ["role-soc"]
    # Soft-success returns 1 tool_result (not is_error) with both pieces of info.
    assert len(outcome.tool_results) == 1
    assert not outcome.tool_results[0].get("is_error")
    assert "ignored unknown" in outcome.tool_results[0]["content"]


@pytest.mark.asyncio
async def test_set_active_roles_hard_fails_when_all_unresolved() -> None:
    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu("set_active_roles", {"role_ids": ["Marketing", "Audit"]}),
    )
    assert outcome.set_active_role_ids is None
    assert any(r.get("is_error") for r in outcome.tool_results)


# ---------------------------------------------------------------- end_session


@pytest.mark.asyncio
async def test_end_session_records_reason_and_yields() -> None:
    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu("end_session", {"reason": "exercise complete"}),
    )
    assert outcome.end_session_reason == "exercise complete"
    assert outcome.had_yielding_call


# ---------------------------------------------------------------- lookup_resource


@pytest.mark.asyncio
async def test_lookup_resource_returns_registered_content() -> None:
    resource = ExtensionResource(
        name="ir_playbook",
        description="standard runbook",
        content="1) isolate 2) preserve 3) escalate",
    )
    dispatcher = _make_dispatcher(resources=[resource])
    session = _build_session()
    outcome = await _dispatch(
        dispatcher, session, _tu("lookup_resource", {"name": "ir_playbook"})
    )
    assert outcome.tool_results[0]["content"] == resource.content
    assert not outcome.tool_results[0].get("is_error")


@pytest.mark.asyncio
async def test_lookup_resource_rejects_unknown_name() -> None:
    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher, session, _tu("lookup_resource", {"name": "missing"})
    )
    err = next(r for r in outcome.tool_results if r.get("is_error"))
    assert "resource not registered" in err["content"]


# ---------------------------------------------------------------- use_extension_tool


@pytest.mark.asyncio
async def test_use_extension_tool_routes_through_registry() -> None:
    tool = ExtensionTool(
        name="lookup_threat_intel",
        description="get intel",
        input_schema={
            "type": "object",
            "properties": {"ioc": {"type": "string"}},
            "required": ["ioc"],
        },
        handler_kind="static_text",
        handler_config="known IOC: associated with APT-X",
    )
    dispatcher = _make_dispatcher(tools=[tool])
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu(
            "use_extension_tool",
            {"name": "lookup_threat_intel", "args": {"ioc": "1.2.3.4"}},
        ),
    )
    assert "APT-X" in outcome.tool_results[0]["content"]
    assert not outcome.tool_results[0].get("is_error")


@pytest.mark.asyncio
async def test_use_extension_tool_rejects_non_object_args() -> None:
    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu("use_extension_tool", {"name": "x", "args": "not-an-object"}),
    )
    err = next(r for r in outcome.tool_results if r.get("is_error"))
    assert "must be an object" in err["content"]


@pytest.mark.asyncio
async def test_use_extension_tool_unknown_extension_returns_error() -> None:
    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu("use_extension_tool", {"name": "ghost_tool", "args": {}}),
    )
    err = next(r for r in outcome.tool_results if r.get("is_error"))
    assert "extension tool not registered" in err["content"]


# ---------------------------------------------------------------- direct extension call fallthrough


@pytest.mark.asyncio
async def test_direct_extension_tool_call_is_honored() -> None:
    """Claude is supposed to wrap extension calls in
    ``use_extension_tool`` but occasionally inlines them. The dispatcher
    falls through to the registry instead of erroring."""

    tool = ExtensionTool(
        name="lookup_threat_intel",
        description="get intel",
        input_schema={
            "type": "object",
            "properties": {"ioc": {"type": "string"}},
            "required": ["ioc"],
        },
        handler_kind="static_text",
        handler_config="static intel result",
    )
    dispatcher = _make_dispatcher(tools=[tool])
    session = _build_session()
    outcome = await _dispatch(
        dispatcher, session, _tu("lookup_threat_intel", {"ioc": "1.2.3.4"})
    )
    assert "static intel result" in outcome.tool_results[0]["content"]


# ---------------------------------------------------------------- unknown tool


@pytest.mark.asyncio
async def test_unknown_tool_returns_error() -> None:
    dispatcher = _make_dispatcher()
    session = _build_session()
    outcome = await _dispatch(
        dispatcher, session, _tu("totally_made_up", {"x": 1})
    )
    err = next(r for r in outcome.tool_results if r.get("is_error"))
    assert "unknown tool" in err["content"]


# ---------------------------------------------------------------- phase enforcement


@pytest.mark.asyncio
async def test_setup_only_tool_rejected_during_play() -> None:
    """``ask_setup_question`` is setup-only — calling it during PLAY
    must produce a tool_use_rejected error so the model self-corrects."""

    dispatcher = _make_dispatcher()
    session = _build_session()  # state = AI_PROCESSING (play tier)
    outcome = await _dispatch(
        dispatcher,
        session,
        _tu("ask_setup_question", {"topic": "industry", "question": "?"}),
    )
    err = next(r for r in outcome.tool_results if r.get("is_error"))
    assert "setup-only" in err["content"]


@pytest.mark.asyncio
async def test_play_tool_rejected_during_setup() -> None:
    dispatcher = _make_dispatcher()
    session = _build_session()
    session.state = SessionState.SETUP
    outcome = await _dispatch(
        dispatcher, session, _tu("broadcast", {"message": "leaked"})
    )
    err = next(r for r in outcome.tool_results if r.get("is_error"))
    assert "not allowed during SETUP" in err["content"]


@pytest.mark.asyncio
async def test_no_tools_run_after_session_ended() -> None:
    dispatcher = _make_dispatcher()
    session = _build_session()
    session.state = SessionState.ENDED
    outcome = await _dispatch(
        dispatcher, session, _tu("broadcast", {"message": "x"})
    )
    err = next(r for r in outcome.tool_results if r.get("is_error"))
    assert "ended" in err["content"]
