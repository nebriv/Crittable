"""Live-API edge-fixture coverage.

The standard fixtures in conftest.py exercise the typical case:
2-role roster, 2-beat plan, 1 critical inject, plain English. The
prompt's branching logic for unusual rosters / plans is not tested by
those fixtures, so a regression that breaks (e.g.) a single-role
roster or all-event-no-critical injects path silently passes the
existing suite.

These tests probe three documented branches as **negative**
assertions: each test names a specific failure mode the prompt
guards against, then asserts the model didn't fall into it. The
positive-shape requirement (must emit ``broadcast``, must yield) is
covered by the standard fixtures; here we lock in the edge invariants.

1. **Solo creator briefing** (1-role roster). The
   ``unseated_block`` rule says the model must NOT pass non-seated
   role_ids to ``set_active_roles`` / ``address_role``. With a single
   seated role and 2+ plan-mentioned but unseated roles, this is the
   tightest test of the rule.

2. **Event-only injects plan**. ``ScenarioPlan`` requires ≥1 inject
   (schema), but the inject can be ``type="event"`` (background
   advance) instead of ``type="critical"`` (red banner). The model
   must NOT promote an event-typed inject to a ``inject_critical_event``
   tool call — that's the planned-trigger mismatch class of bug.

3. **Large roster** (15 roles, ``roster_size == "large"`` bucket).
   Block 9's roster strategy says "name a primary subgroup of 2-4
   actors". The ``set_active_roles`` yield must NOT contain all
   15 roles — that's the "wide yield" / "addresses everyone" bug.

Cost: ~$0.06 (3 Sonnet calls). Skipped unless ``ANTHROPIC_API_KEY``
is set.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.sessions.models import (
    Role,
    ScenarioBeat,
    ScenarioInject,
    ScenarioPlan,
    Session,
    SessionState,
)

from .conftest import call_play, tool_uses

pytestmark = [pytest.mark.asyncio, pytest.mark.live]


# ---------------------------------------------------------------- fixtures


def _solo_creator_session() -> Session:
    """Single seated role; plan mentions IR Lead + Comms as unseated."""

    creator = Role(
        id="role-ciso",
        label="CISO",
        display_name="Solo",
        is_creator=True,
    )
    plan = ScenarioPlan(
        title="Phishing-led ransomware (solo run)",
        executive_summary=(
            "Solo creator dry-run. Phishing email → vendor token compromise."
        ),
        key_objectives=["Contain", "Notify", "Document"],
        narrative_arc=[
            ScenarioBeat(beat=1, label="Detection", expected_actors=["CISO"]),
            ScenarioBeat(
                beat=2, label="Containment", expected_actors=["IR Lead"]
            ),
            ScenarioBeat(beat=3, label="Comms", expected_actors=["Comms"]),
        ],
        injects=[
            ScenarioInject(
                trigger="after beat 2", type="critical", summary="Press leak."
            ),
        ],
        guardrails=["stay in scope"],
        success_criteria=["containment before beat 3"],
        out_of_scope=["real exploit code"],
    )
    return Session(
        scenario_prompt="Phishing-led ransomware",
        state=SessionState.BRIEFING,
        roles=[creator],
        creator_role_id=creator.id,
        plan=plan,
    )


def _event_only_injects_session() -> Session:
    """Plan with only ``type="event"`` injects — no critical-typed
    inject. The model must NOT escalate an event-typed inject to a
    ``inject_critical_event`` tool call."""

    creator = Role(
        id="role-ciso",
        label="CISO",
        display_name="Dev",
        is_creator=True,
    )
    soc = Role(id="role-soc", label="SOC Analyst", display_name="Bee")
    plan = ScenarioPlan(
        title="Ransomware (event-only injects)",
        executive_summary=(
            "Routine ransomware drill. Background events only — no "
            "headline-grade critical injects in this plan."
        ),
        key_objectives=["Detect", "Contain", "Recover"],
        narrative_arc=[
            ScenarioBeat(beat=1, label="Detection", expected_actors=["SOC"]),
            ScenarioBeat(
                beat=2, label="Containment", expected_actors=["CISO"]
            ),
            ScenarioBeat(beat=3, label="Recovery", expected_actors=["SOC"]),
        ],
        injects=[
            ScenarioInject(
                trigger="after beat 1",
                type="event",
                summary="Second host shows lateral activity (background advance).",
            ),
            ScenarioInject(
                trigger="after beat 2",
                type="event",
                summary="Backup verification needed (background advance).",
            ),
        ],
        guardrails=["stay in scope"],
        success_criteria=["recovery before beat 4"],
        out_of_scope=["real exploit code"],
    )
    return Session(
        scenario_prompt="Ransomware event-only drill",
        state=SessionState.BRIEFING,
        roles=[creator, soc],
        creator_role_id=creator.id,
        plan=plan,
    )


def _large_roster_session() -> Session:
    """15-role session — exercises the ``large`` roster bucket."""

    labels = [
        "CISO", "IR Lead", "SOC Analyst", "Threat Hunter",
        "Network Engineer", "AppSec", "Cloud Security",
        "Endpoint Engineer", "Identity", "Legal", "Comms",
        "Executive Sponsor", "GRC", "Forensics Lead", "DPO",
    ]
    roles: list[Role] = []
    for i, label in enumerate(labels):
        roles.append(
            Role(
                id=f"role-{i:02d}",
                label=label,
                display_name=label.split(" ", 1)[0] + str(i),
                is_creator=(i == 0),
            )
        )
    plan = ScenarioPlan(
        title="Large-org ransomware",
        executive_summary="15-role org-wide ransomware exercise.",
        key_objectives=["Contain", "Notify", "Recover"],
        narrative_arc=[
            ScenarioBeat(beat=1, label="Detection", expected_actors=["SOC Analyst"]),
            ScenarioBeat(
                beat=2, label="Containment",
                expected_actors=["IR Lead", "Endpoint Engineer"],
            ),
            ScenarioBeat(beat=3, label="Comms", expected_actors=["Comms", "Legal"]),
        ],
        injects=[
            ScenarioInject(
                trigger="after beat 2", type="critical", summary="Reporter call."
            ),
        ],
        guardrails=["stay in scope"],
        success_criteria=["containment before beat 3"],
        out_of_scope=["real exploit code"],
    )
    return Session(
        scenario_prompt="Large-org ransomware",
        state=SessionState.BRIEFING,
        roles=roles,
        creator_role_id=roles[0].id,
        plan=plan,
    )


# ---------------------------------------------------------------- tests


async def test_solo_creator_briefing_does_not_leak_to_unseated(
    anthropic_client: Any,
    play_model: str,
    empty_registry: Any,
) -> None:
    """Single seated role + unseated plan roles. Negative assertion:
    the model must NOT pass any non-seated role_id to
    ``set_active_roles`` / ``address_role`` / ``request_artifact``."""

    session = _solo_creator_session()
    seated_ids = {r.id for r in session.roles}
    resp = await call_play(
        anthropic_client,
        model=play_model,
        session=session,
        registry=empty_registry,
    )

    leaked: list[tuple[str, str]] = []
    for block in tool_uses(resp):
        args = dict(block.input or {})
        if block.name == "set_active_roles":
            for rid in args.get("role_ids", []) or []:
                if rid and rid not in seated_ids:
                    leaked.append((block.name, rid))
        elif block.name in {"address_role", "request_artifact"}:
            rid = args.get("role_id", "")
            if rid and rid not in seated_ids:
                leaked.append((block.name, rid))

    assert not leaked, (
        "model passed non-seated role_id(s) to a role-targeted tool on "
        f"the solo-creator briefing: {leaked} (seated: {seated_ids})"
    )


async def test_event_only_injects_plan_does_not_invent_critical(
    anthropic_client: Any,
    play_model: str,
    empty_registry: Any,
) -> None:
    """Plan with only event-typed injects. The model must NOT emit
    ``inject_critical_event`` on the briefing turn — the plan only
    has background events, no headline-grade escalations."""

    session = _event_only_injects_session()
    resp = await call_play(
        anthropic_client,
        model=play_model,
        session=session,
        registry=empty_registry,
    )

    names = [u.name for u in tool_uses(resp)]
    assert "inject_critical_event" not in names, (
        "model fired inject_critical_event on a plan whose only injects "
        "are type='event' — that's an invented critical-grade event, not "
        "a planned one. The tool description says critical injects are "
        "for headline-grade escalations only. "
        f"Tools called: {names}"
    )


async def test_large_roster_does_not_yield_to_full_roster(
    anthropic_client: Any,
    play_model: str,
    empty_registry: Any,
) -> None:
    """15-role briefing. Negative assertion: ``set_active_roles`` must
    NOT contain all 15 roles — Block 9's large-roster strategy says
    "name a primary subgroup of 2-4 actors" (we accept up to 6 to be
    resilient to small overshoot)."""

    session = _large_roster_session()
    seated_ids = {r.id for r in session.roles}
    assert session.roster_size == "large", "fixture mis-sized; expected 'large'"

    resp = await call_play(
        anthropic_client,
        model=play_model,
        session=session,
        registry=empty_registry,
    )

    yielded_ids: list[str] = []
    for block in tool_uses(resp):
        if block.name == "set_active_roles":
            yielded_ids.extend(block.input.get("role_ids", []) or [])

    yielded_unique = set(yielded_ids)

    # Negative assertion: must NOT be the full roster.
    assert yielded_unique != seated_ids, (
        "model yielded to the full 15-role roster on a single turn — "
        "Block 9 strategy says name a 2-4 actor subgroup. "
        f"yielded: {sorted(yielded_unique)}"
    )

    # Tractable bound — ≤ 6 catches the "addresses everyone" bug while
    # staying resilient to small overshoot.
    assert len(yielded_unique) <= 6, (
        "large-roster briefing yielded too widely; Block 9 says 2-4 "
        f"actors per beat. yielded {len(yielded_unique)} role_ids: "
        f"{sorted(yielded_unique)}"
    )
