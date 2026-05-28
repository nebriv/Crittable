"""Live-API smoke for the setup-tier *confirming-question floor*.

The setup prompt now requires the model to open its first turn with at
least one ``ask_setup_question`` — a short confirming question that
echoes back what it inferred from the seed and asks the creator to
confirm or amend — *before* it drafts. The old behavior (jump straight
to ``propose_scenario_plan`` on a rich seed) left the creator with zero
interaction and let the model bake in un-confirmed org assumptions.

Per ``docs/tool-design.md`` we assert *shape*, not content — only that
the model asks before it drafts. A miss is surfaced as ``xfail`` (the
model is non-deterministic) so a sweep can compute the ask-first rate
rather than gambling CI on a single roll — same pattern as
``test_workstreams_setup_routing.py``.

The carve-out — an explicit "skip setup / draft now" instruction makes
the model propose directly — is already exercised by
``test_workstreams_setup_routing.py``, whose seed message tells the
model to draft without asking and still expects a plan.

Setup-tier traffic flows through the standard message API; we bypass
the in-process turn driver so the test is self-contained (matches the
other setup/play live tests' style).
"""

from __future__ import annotations

from typing import Any

import pytest

from app.config import get_settings
from app.llm.prompts import build_setup_system_blocks
from app.llm.tools import setup_tools_for
from app.sessions.models import Role, Session, SessionState

pytestmark = [pytest.mark.asyncio, pytest.mark.live]


def _rich_seed_session() -> Session:
    """A detailed seed a model could plausibly draft from blind — the
    exact shape that used to skip straight to ``propose_scenario_plan``.
    Note: no "skip setup / draft now" instruction, so the carve-out does
    NOT apply and the floor (ask ≥1 confirming question first) governs.
    """

    creator = Role(id="role-ciso", label="CISO", display_name="A", is_creator=True)
    return Session(
        scenario_prompt=(
            "Dormant-persistence tabletop for a 5,000-seat US health system. "
            "An attacker-planted mailbox email-forwarding rule survived an "
            "earlier eviction; unified-audit-log retention is 30 days; the IR "
            "function is 4 people on Microsoft 365 E5 with Defender and "
            "Sentinel. Roles: CISO, IR Lead, Legal, Comms. Top objective: "
            "drill the re-eviction decision and the audit-log retention gap "
            "under regulator scrutiny."
        ),
        state=SessionState.SETUP,
        roles=[creator],
        creator_role_id=creator.id,
    )


async def _first_setup_turn(client: Any, *, model: str, session: Session) -> Any:
    """Reproduce the engine's first setup turn: with empty ``setup_notes``
    the seed prompt is the sole user message (see ``_setup_messages`` in
    ``turn_driver.py``). No extra instruction, so the model decides for
    itself whether to ask or draft."""

    system_blocks = build_setup_system_blocks(session, workstreams_enabled=True)
    messages: list[dict[str, Any]] = [
        {"role": "user", "content": session.scenario_prompt}
    ]
    return await client.messages.create(
        model=model,
        max_tokens=4096,
        system=system_blocks,
        messages=messages,
        tools=setup_tools_for(workstreams_enabled=True),
        tool_choice={"type": "any"},
    )


def _tool_uses(resp: Any) -> list[Any]:
    return [
        b
        for b in getattr(resp, "content", [])
        if getattr(b, "type", None) == "tool_use"
    ]


async def test_rich_seed_first_turn_asks_before_drafting(
    anthropic_client: Any,
    request: pytest.FixtureRequest,
) -> None:
    """Rich seed, no skip instruction → first turn emits ``ask_setup_question``.

    A miss (model went straight to a plan) is marked ``xfail`` so the
    ask-first rate is observable across a sweep rather than flaking CI
    on a single non-deterministic roll.
    """

    model = get_settings().model_for("setup")
    resp = await _first_setup_turn(
        anthropic_client, model=model, session=_rich_seed_session()
    )
    names = [u.name for u in _tool_uses(resp)]

    if "ask_setup_question" not in names:
        import warnings

        warnings.warn(
            f"setup_question_floor_missed tools={names}",
            stacklevel=1,
        )
        request.node.add_marker(
            pytest.mark.xfail(
                strict=False,
                reason=(
                    "model skipped ask_setup_question on a rich seed and "
                    "went straight to a plan; non-deterministic but "
                    "informative — the setup prompt's confirming-question "
                    "floor wants ≥1 ask before drafting."
                ),
            )
        )
        pytest.fail("ask_setup_question missing on first turn — see xfail marker")

    assert "ask_setup_question" in names
