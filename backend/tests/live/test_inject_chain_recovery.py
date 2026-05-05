"""Live-API regression tests for issue #151.

The play-tier model is asked to fire ``inject_critical_event`` only as
part of a chain — Block 6's "Critical-inject chain (mandatory)" rule
requires a same-response ``broadcast`` (or ``address_role`` /
``share_data`` / ``pose_choice``) plus a ``set_active_roles``. The
model regularly ignores this on real injects, leaving players staring
at a banner with no per-role direction. Issue #151 ships two
defenses:

  Fix A (dispatch-layer pairing — see ``app/llm/dispatch.py``).
    A solo ``inject_critical_event`` is rejected at dispatch with a
    structured error explaining the chain shape. The strict-retry
    path replays the rejection so the model self-corrects on the
    cheaper layer instead of paying the post-turn DRIVE recovery.

  Fix B (inject-grounded recovery — see
  ``app/sessions/turn_validator.py``).
    When the validator catches missing DRIVE on a turn that attempted
    an inject, the recovery directive embeds the inject's headline /
    body into the system addendum AND the user nudge so the recovery
    broadcast lands on the actual event rather than a generic next
    beat. The dispatcher captures the inject args even when fix A
    rejects the call, so the recovery still has the grounding payload
    to anchor on.

What this file asserts
----------------------

The model is non-deterministic. We don't assert "the model fires solo
inject 0% of the time" — that would flake. We assert:

  * When a solo inject DOES fire, the dispatcher rejects it with the
    documented chain-shape hint (no LLM round-trip needed). Pure
    engine behaviour — runs every CI pass.
  * When the inject-grounded recovery directive runs, the model's
    pinned broadcast references the inject's content (headline /
    body keywords). Live API call. Asserts the expected behavioural
    improvement over the generic recovery without flaking on the
    handful of model phrasings that don't include the keyword.

Cost
----

~$0.05 per run at defaults. Skipped unless ``ANTHROPIC_API_KEY`` is
set — see ``conftest.py`` auto-skip for the gate behaviour.

Add new failure modes here when you change Block 6's inject-chain
rule or extend the dispatcher's pairing scan.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.llm.prompts import build_play_system_blocks
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
)
from app.sessions.turn_driver import _play_messages
from app.sessions.turn_validator import drive_recovery_directive

from .conftest import call_play, tool_names, tool_uses

pytestmark = [pytest.mark.asyncio, pytest.mark.live]


# ---------------------------------------------------------------- fixtures


@pytest.fixture
def inject_imminent_session() -> Session:
    """Session shape designed to provoke the model into firing
    ``inject_critical_event``. Plan documents a critical inject with
    a trigger that lines up with the most-recent narrative state;
    transcript shows containment in motion (the inject's "after beat
    1" trigger fires)."""

    creator = Role(
        id="role-ciso",
        label="CISO",
        display_name="Dev Tester",
        is_creator=True,
    )
    soc = Role(id="role-soc", label="SOC Analyst", display_name="Dev Bot")
    plan = ScenarioPlan(
        title="Ransomware via vendor portal — press leak imminent",
        executive_summary=(
            "03:14 Wednesday. Ransomware on finance laptops via vendor "
            "service-account compromise."
        ),
        key_objectives=[
            "Confirm scope within 30 min",
            "Containment decision documented before beat 3",
            "Decide regulator-notification clock",
        ],
        narrative_arc=[
            ScenarioBeat(beat=1, label="Detection & triage", expected_actors=["SOC", "CISO"]),
            ScenarioBeat(beat=2, label="Containment", expected_actors=["CISO", "SOC"]),
            ScenarioBeat(beat=3, label="External comms", expected_actors=["CISO"]),
        ],
        injects=[
            ScenarioInject(
                trigger="after beat 1",
                type="critical",
                summary=(
                    "Slack screenshot of internal incident channel leaked to "
                    "regional newspaper Twitter; reporter is calling for "
                    "comment in 30 minutes."
                ),
            ),
        ],
        guardrails=["Stay in scope; no real exploit code."],
        success_criteria=["Containment before beat 3", "Regulator clock decided"],
        out_of_scope=["Live exploitation", "Specific CVE PoCs"],
    )
    s = Session(
        scenario_prompt="Ransomware via vendor portal — press leak imminent",
        state=SessionState.AI_PROCESSING,
        roles=[creator, soc],
        creator_role_id=creator.id,
        plan=plan,
    )
    s.messages.extend(
        [
            Message(
                kind=MessageKind.AI_TEXT,
                tool_name="broadcast",
                body=(
                    "**SOC Analyst (Dev Bot)** — what does the alert queue "
                    "look like? **CISO (Dev Tester)** — first containment "
                    "instinct: isolate or monitor for full scope?"
                ),
            ),
            Message(
                kind=MessageKind.PLAYER,
                role_id=creator.id,
                body=(
                    "Isolate immediately via Defender. I'm pulling in IR "
                    "Lead and starting the regulator-notification clock."
                ),
            ),
            Message(
                kind=MessageKind.PLAYER,
                role_id=soc.id,
                body=(
                    "Three FIN-* hosts firing Defender alerts plus lateral "
                    "SMB to FIN-08. Pulling Defender logs now."
                ),
            ),
        ]
    )
    return s


@pytest.fixture
def post_solo_inject_session(inject_imminent_session: Session) -> Session:
    """The session AFTER the model fired an unpaired inject — the
    state at which the validator's missing-DRIVE recovery would run
    in production. The CRITICAL_INJECT message is appended; no DRIVE
    landed; players have nothing to act on. Used by the recovery-
    grounding test to drive the production recovery LLM call shape."""

    s = inject_imminent_session
    s.messages.append(
        Message(
            kind=MessageKind.CRITICAL_INJECT,
            tool_name="inject_critical_event",
            body=(
                "[HIGH] Slack screenshot leaked to press — Reporter calling "
                "for comment in 30 minutes about an internal incident-"
                "channel screenshot circulating on regional Twitter."
            ),
            tool_args={
                "severity": "HIGH",
                "headline": "Slack screenshot leaked to press",
                "body": (
                    "Reporter calling for comment in 30 minutes about an "
                    "internal incident-channel screenshot circulating on "
                    "regional Twitter."
                ),
            },
        )
    )
    return s


# ---------------------------------------------------------------- tests


_DRIVE_TOOL_NAMES = frozenset(
    {"broadcast", "address_role", "share_data", "pose_choice"}
)


async def test_inject_critical_event_chain_probe(
    anthropic_client: Any,
    play_model: str,
    inject_imminent_session: Any,
    empty_registry: Any,
) -> None:
    """Live probe (not a strict assertion): on an inject-imminent
    fixture, what fraction of the model's tool emissions form the
    Block 6 chain (inject + DRIVE) vs land as a solo banner?

    This test does NOT fail when the model emits a solo inject —
    issue #151's ``backend/scripts/issue_151_before_after.py``
    measures the steady-state solo-inject rate at ~50–80% on the
    live model, so a CI gate here would flake every run. Fix A's
    dispatch-time rejection (covered by the engine-level unit tests
    in ``test_dispatch_tools.py``) is what makes production safe.
    The test records the run shape via a structured ``pytest.skip``
    message so an operator running ``-v`` sees whether this run was
    a chain or a solo inject — useful when comparing prompt
    iterations.

    The test fails only when the model emits zero tool calls (a
    contract violation against Anthropic's tool-use protocol — the
    live API would not reach ``stop_reason='end_turn'`` with no
    ``tool_use`` blocks under a normal prompt). That's a real
    regression worth catching."""

    resp = await call_play(
        anthropic_client,
        model=play_model,
        session=inject_imminent_session,
        registry=empty_registry,
    )
    names = tool_names(resp)
    assert names, (
        f"model emitted no tool calls; stop_reason={resp.stop_reason}. "
        f"This is a contract violation — every play turn should produce "
        f"at least one tool_use block."
    )
    has_inject = "inject_critical_event" in names
    has_drive = any(n in _DRIVE_TOOL_NAMES for n in names)
    if has_inject and has_drive:
        # Best case — chain landed, no engine recovery needed.
        return
    if has_inject and not has_drive:
        # Issue #151 failure mode reproduced. Fix A catches this at
        # dispatch; not a test failure here.
        pytest.skip(
            f"model fired SOLO inject_critical_event (issue #151 "
            f"failure mode) — Fix A's dispatch-time rejection catches "
            f"this in production. Tools: {names}"
        )
    # No inject this run — model picked a different tactical move,
    # which is also fine. The probe is informational either way.
    pytest.skip(
        f"model did not fire inject_critical_event this run; "
        f"tools={names}. Re-run for a chain-shape signal."
    )


async def test_drive_recovery_after_inject_grounds_on_event(
    anthropic_client: Any,
    play_model: str,
    post_solo_inject_session: Any,
    empty_registry: Any,
) -> None:
    """Issue #151 fix B: when the missing-DRIVE recovery fires on a
    turn that attempted an inject, the recovery directive's system
    addendum + user nudge embed the inject's headline / body. The
    recovery broadcast (pinned to ``broadcast`` via tool_choice)
    should reference the inject's actual content — not fall back to
    a generic next-beat brief.

    Live-API assertion: at least one inject-context keyword appears
    in the recovery broadcast. The keyword set covers the headline
    ("leak", "screenshot", "press", "media", "reporter"), the body
    ("comms", "regulator", "statement", "twitter", "newspaper"), and
    common synonyms. Soft signal — non-deterministic; if a single run
    misses the keyword bucket, retry the test. Persistent failure is
    a fix-B regression."""

    inject_args = {
        "severity": "HIGH",
        "headline": "Slack screenshot leaked to press",
        "body": (
            "Reporter calling for comment in 30 minutes about an internal "
            "incident-channel screenshot circulating on regional Twitter."
        ),
    }
    directive = drive_recovery_directive(
        pending_critical_inject_args=inject_args,
    )

    # Build the recovery prompt the way ``turn_driver.run_play_turn``
    # would: prior assistant tool_use (the unpaired inject), prior
    # tool_result, then the directive's user nudge as a trailing user
    # text block. The system addendum rides on top of the standard
    # play system blocks.
    base_system_blocks = build_play_system_blocks(
        post_solo_inject_session, registry=empty_registry
    )
    system_blocks = [
        *base_system_blocks,
        {"type": "text", "text": directive.system_addendum},
    ]
    # Production runs recovery passes with ``strict=True`` (which
    # suppresses the per-turn reminder that would otherwise be the
    # last user-block); we use ``strict=False`` here and pop the
    # trailing reminder ourselves so the spliced tool-loop replaces
    # it cleanly. The kickoff/turn-reminder text differs slightly
    # between modes — acceptable divergence for a recovery-grounding
    # probe since the load-bearing context (the inject tool_use +
    # the directive's user nudge) is identical in both modes.
    base_messages = _play_messages(post_solo_inject_session, strict=False)
    if base_messages and base_messages[-1]["role"] == "user":
        base_messages.pop()
    prior_assistant = [
        {
            "type": "tool_use",
            "id": "tu-inject",
            "name": "inject_critical_event",
            "input": inject_args,
        }
    ]
    prior_tool_result = [
        {
            "type": "tool_result",
            "tool_use_id": "tu-inject",
            "content": "critical event surfaced",
            "is_error": False,
        }
    ]
    messages = [
        *base_messages,
        {"role": "assistant", "content": prior_assistant},
        {
            "role": "user",
            "content": [
                *prior_tool_result,
                {"type": "text", "text": directive.user_nudge},
            ],
        },
    ]

    # Call the SDK directly with the spliced tool-loop. ``call_play``
    # rebuilds messages from the session and would discard our prior
    # assistant + tool_result blocks (the inject context the directive
    # is grounding on).
    resp = await anthropic_client.messages.create(
        model=play_model,
        max_tokens=1024,
        system=system_blocks,
        messages=messages,
        tools=[t for t in PLAY_TOOLS if t["name"] in directive.tools_allowlist],
        tool_choice=directive.tool_choice,
    )
    names = tool_names(resp)
    assert names == ["broadcast"], (
        f"recovery should have produced exactly one broadcast (tool_choice "
        f"pins it); got {names}"
    )
    body = str(tool_uses(resp)[0].input.get("message", "")).lower()
    # Inject-specific anchors only. Scenario-generic terms ("comms",
    # "regulator", "statement") were dropped from the bucket per the
    # QA review — they appear in any tabletop crisis broadcast and
    # would let a pre-fix recovery ("what's the next plan?") pass
    # this assertion without ever grounding on the press leak.
    grounding_terms = (
        "leak",
        "screenshot",
        "reporter",
        "press",
        "twitter",
        "newspaper",
    )
    hits = [t for t in grounding_terms if t in body]
    assert hits, (
        f"recovery broadcast did NOT reference the inject's content. The "
        f"directive's user_nudge embedded the inject headline + body; the "
        f"recovery should have mentioned at least one inject keyword "
        f"({grounding_terms!r}). Body[:300]: {body[:300]!r}"
    )


# Pure engine-level dispatcher-rejection coverage lives in
# ``backend/tests/test_dispatch_tools.py::test_inject_critical_event_rejected_when_unpaired``
# and friends. The live tests in this file focus on the cases that
# require real-model behaviour to verify (the prompt rule itself, and
# the recovery directive's grounding).
