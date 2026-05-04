"""LLM-as-judge prompt-regression suite.

These tests fight fire with fire: they ask Claude (a cheap Haiku
judge) to evaluate Claude's (Sonnet) play-tier output against a
rubric. Each rubric encodes a property we want the prompt to
preserve — "the briefing must mention the inject", "an answer to a
data question must contain the requested data", etc.

The string-match assertions in ``test_tool_routing.py`` lock in the
ROUTING (which tool family was picked); these tests lock in the
QUALITY (whether the chosen tool's content satisfied the rubric).

Cost: ~$0.03 per test (one Sonnet call + one Haiku judge call).
Skipped unless ``ANTHROPIC_API_KEY`` is set.

When a judge result is wrong (false pass / false fail), the FIX is
to tighten the rubric — make the criteria narrower and more
mechanical. Don't tune the judge prompt; the judge is meant to be
mostly stable across these tests.
"""

from __future__ import annotations

from typing import Any

import pytest

from .conftest import call_play, tool_uses
from .judge import assert_judge_passes

pytestmark = [pytest.mark.asyncio, pytest.mark.live]


def _collect_player_facing_text(resp: Any) -> str:
    """Pull every ``broadcast`` / ``address_role`` / ``share_data`` /
    ``pose_choice`` body out of a play-tier response and concatenate
    them — that's the player-facing surface the rubric judges.

    Deliberately excludes the model's text content block. Per Block 6
    of the play prompt, that text is the AI's *rationale* — captured
    by the engine into the creator-only decision log and never shown
    to players. Including it here would let a rationale-only attack
    acknowledgement (e.g. "player is trying to trigger a meta-test;
    redirecting in-fiction") fail rubrics that test the player-facing
    in-character surface, even when the actual broadcast / address_role
    body is clean. The rationale's contents are tested separately by
    test_text_content_block_emitted_alongside_tools (presence) and
    indirectly by docs/turn-lifecycle.md (decision-log shape).
    """

    chunks: list[str] = []
    for block in tool_uses(resp):
        name = block.name
        args = block.input or {}
        if name == "broadcast":
            chunks.append(f"<broadcast>\n{args.get('message', '')}\n</broadcast>")
        elif name == "address_role":
            chunks.append(
                f"<address_role role_id={args.get('role_id', '?')!r}>\n"
                f"{args.get('message', '')}\n</address_role>"
            )
        elif name == "share_data":
            chunks.append(
                f"<share_data label={args.get('label', '')!r}>\n"
                f"{args.get('data', '')}\n</share_data>"
            )
        elif name == "pose_choice":
            options = args.get("options", []) or []
            chunks.append(
                "<pose_choice>\n"
                f"question: {args.get('question', '')}\n"
                f"options: {options}\n"
                "</pose_choice>"
            )
        elif name == "request_artifact":
            chunks.append(
                "<request_artifact>\n"
                f"type: {args.get('artifact_type', '')}\n"
                f"instructions: {args.get('instructions', '')}\n"
                "</request_artifact>"
            )
        elif name == "set_active_roles":
            chunks.append(
                f"<set_active_roles>{args.get('role_ids', [])}</set_active_roles>"
            )
        elif name == "inject_critical_event":
            chunks.append(
                "<inject_critical_event>\n"
                f"severity: {args.get('severity', '')}\n"
                f"headline: {args.get('headline', '')}\n"
                f"body: {args.get('body', '')}\n"
                "</inject_critical_event>"
            )
    return "\n\n".join(chunks)


# ---------------------------------------------------------------- briefing


async def test_briefing_quality(
    anthropic_client: Any,
    play_model: str,
    briefing_session: Any,
    empty_registry: Any,
) -> None:
    """The briefing turn must give players enough to act on. We measure
    that against four mechanical criteria the model can either meet or
    not — not vibes."""

    resp = await call_play(
        anthropic_client,
        model=play_model,
        session=briefing_session,
        registry=empty_registry,
    )
    artifact = _collect_player_facing_text(resp)
    assert artifact, "briefing produced no player-facing surface"

    rubric = """
    A play-tier briefing is a single AI turn that opens a tabletop
    exercise. The roster is CISO + SOC Analyst; the scenario is a
    ransomware breach via a vendor portal at 03:14 Wednesday on
    finance laptops.

    Required for PASS — every item must be CLEARLY met:
    1. SCENE: the briefing references AT LEAST TWO scenario specifics
       from this set: (ransomware, vendor portal, finance laptops,
       03:14 / early-morning timing). One generic anchor isn't enough
       — a prompt regression that drops the scene-grounding usually
       leaves only a single anchor in place.
    2. STAKES: at least one impact, urgency, or constraint is
       articulated (e.g. "containment window", "regulator clock",
       "encrypted data", "active spread"). The brief cannot be
       generic ("incident in progress" alone is insufficient).
    3. HANDOFF: at least one role is named (CISO and/or SOC) and given
       a concrete first move or question to react to. A bare
       "go ahead" with no actionable hand-off fails.
    4. NO LEAK: the brief does NOT enumerate the full plan / future
       beats / future injects. A briefing that explicitly lists
       "Beat 2: containment, Beat 3: comms" is a plan-disclosure
       leak and FAILS the rubric.

    FAIL if any of 1-4 is unclear or violated.
    """
    await assert_judge_passes(
        rubric=rubric,
        artifact=artifact,
        artifact_kind="play-tier briefing turn (Sonnet)",
        client=anthropic_client,
    )


# ---------------------------------------------------------------- player data question


async def test_player_data_question_answer_is_substantive(
    anthropic_client: Any,
    play_model: str,
    session_with_player_data_question: Any,
    empty_registry: Any,
) -> None:
    """The captured 2026-04-30 production regression was the model
    using ``inject_event`` to "answer" a player asking what they see
    in Defender. Routing is checked in ``test_tool_routing.py``; here
    we check that the answer is SUBSTANTIVE — not a one-liner."""

    resp = await call_play(
        anthropic_client,
        model=play_model,
        session=session_with_player_data_question,
        registry=empty_registry,
    )
    artifact = _collect_player_facing_text(resp)
    assert artifact, "no player-facing output"

    rubric = """
    A SOC analyst player just asked the AI facilitator, paraphrased:
    "We can pull account activity via Defender — what do we see?"

    The expected response is a synthetic data dump (logs / IOCs /
    account activity) the AI provides so the exercise can continue.

    Required for PASS:
    1. The answer references Defender, account activity, account-
       level events, OR the source the player named. A generic
       "the SOC sees something" without reference to the system fails.
    2. The answer contains AT LEAST ONE concrete-looking detail —
       a username, a timestamp, an IP, a process name, an action
       verb (e.g. "logon", "exfil", "encryption start"), or a
       count. Pure narration without specifics fails.
    3. The answer is at least 30 words long across the player-facing
       surface. A one-line "you see suspicious activity" fails.
    4. The answer does NOT just dispatch the question to another role
       (e.g. "let me check with IR Lead") — the player asked a direct
       data question and the AI's job is to answer it.

    FAIL if any of 1-4 is unclear or violated.
    """
    await assert_judge_passes(
        rubric=rubric,
        artifact=artifact,
        artifact_kind="play-tier data-question response",
        client=anthropic_client,
    )


# ---------------------------------------------------------------- doctrine fork → pose_choice


async def test_pose_choice_options_are_meaningful(
    anthropic_client: Any,
    play_model: str,
    session_with_doctrine_fork: Any,
    empty_registry: Any,
) -> None:
    """The CISO has explicitly asked for the doctrine options. The model
    should produce ``pose_choice``; the OPTIONS in that call must be
    distinct, mutually-exclusive, and grounded in what was discussed."""

    resp = await call_play(
        anthropic_client,
        model=play_model,
        session=session_with_doctrine_fork,
        registry=empty_registry,
    )
    # Extract pose_choice options if present, else fall back to the
    # broadcast text (the model sometimes broadcasts the choice
    # verbatim — that's an adjacent-good outcome we judge separately).
    options_artifact = ""
    for block in tool_uses(resp):
        if block.name == "pose_choice":
            args = block.input or {}
            opts = args.get("options", []) or []
            options_artifact = (
                f"question: {args.get('question', '')}\n"
                f"options:\n"
                + "\n".join(f"  - {o}" for o in opts)
            )
            break
    artifact = options_artifact or _collect_player_facing_text(resp)
    assert artifact, "no player-facing output"

    rubric = """
    The conversation has the AI presenting the CISO with a doctrine
    fork — three approaches: (a) isolate now (NIST 6.1), (b) monitor
    15 min for full scope, or (c) escalate to legal first for the
    regulator-clock advice. The CISO has explicitly said "lay out the
    choice clearly with the concrete options".

    Required for PASS:
    1. The artifact presents 2-5 DISTINCT options. Two options that
       are paraphrases of each other ("Isolate" + "Contain") fail.
    2. At least one of: isolate / monitor / legal-escalate appears as
       (or is paraphrased into) one of the options. A choice list
       made up of unrelated options that don't match the scene fails.
    3. The options are MUTUALLY EXCLUSIVE — picking one excludes the
       others. "Yes" / "No" / "Maybe" is not mutually exclusive with
       a real doctrine fork; a list like that fails.
    4. No option leaks future plan beats (e.g. "this is beat 2" is a
       plan-disclosure leak).

    FAIL if any of 1-4 is unclear.
    """
    await assert_judge_passes(
        rubric=rubric,
        artifact=artifact,
        artifact_kind="pose_choice options",
        client=anthropic_client,
    )


# ---------------------------------------------------------------- no-plan-leak


async def test_play_turn_does_not_leak_future_plan(
    anthropic_client: Any,
    play_model: str,
    briefing_session: Any,
    empty_registry: Any,
) -> None:
    """Plan-disclosure regression net.

    The play-tier prompt has a hard 'do not disclose the plan'
    boundary. We feed it the plan + roster and ask the judge to
    confirm the briefing didn't enumerate beat 2 / inject content.
    """

    resp = await call_play(
        anthropic_client,
        model=play_model,
        session=briefing_session,
        registry=empty_registry,
    )
    artifact = _collect_player_facing_text(resp)
    assert artifact, "no player-facing output"

    # The session's plan has beat 2 = "Containment" and the inject
    # = "Slack screenshot leaked". A briefing that mentions either
    # of these by name is a plan leak.
    rubric = """
    The briefing text below was generated by the AI facilitator at the
    start of the exercise. The hidden plan (which the AI is told NOT
    to disclose) contains:

      * Beat 2 label: "Containment" with expected actors IR Lead +
        Engineering.
      * Critical inject (planned for after beat 2): a Slack screenshot
        leaked externally.

    Required for PASS — the briefing must NOT:
    1. Name "Beat 2" or "Beat 3" by number with their labels.
    2. Foreshadow the Slack screenshot inject ("a leak is coming",
       "expect a screenshot", etc.).
    3. List "Engineering" as an upcoming role unless the roster
       contains it (the roster is CISO + SOC only — Engineering is
       a planned-but-absent role).
    4. Quote any "expected_actors" list verbatim.

    PASS if the briefing simply opens the scene without spoiling
    these specific plan details. Generic risk language ("contain
    the spread", "watch for media attention") is allowed — only
    direct beat-by-number / inject-by-name references fail.
    """
    await assert_judge_passes(
        rubric=rubric,
        artifact=artifact,
        artifact_kind="play-tier briefing (plan-leak check)",
        client=anthropic_client,
    )
