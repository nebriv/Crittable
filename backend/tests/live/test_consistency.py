"""Live-API consistency probes — repeat-call and paraphrase robustness.

The other live suites assert single-call shape: "given fixture X, the
model picks tool family Y." Those tests catch the average behavior but
miss two adjacent failure modes:

1. **Non-deterministic routing.** A prompt branch that flakes 30-50% of
   the time (the ``share_data`` flake we just fixed had a 40% failure
   rate before commit 42f38cc) silently passes single-call tests until
   the unlucky CI run lights it up. A repeat-call probe runs the same
   fixture N times and asserts every run picks the right tool family —
   one flake fails the test deterministically.

2. **Prompt phrasing fragility.** The prompt teaches the model to parse
   participant intent, not literal phrasing. A regression that has the
   model match keywords (e.g. ``"isolate"`` literal) instead of intent
   would not show up on the existing fixtures, which all use a single
   phrasing of each scenario. A paraphrase probe submits three
   semantically equivalent player messages and asserts all three route
   to the same tool family.

Cost: ~$0.07 per file (3 + 3 Sonnet calls × ~$0.012). Skipped unless
``ANTHROPIC_API_KEY`` is set.

These tests answer the operator question "does the AI respond
consistently?" the way the user asked it on the live-test sweep PR.
They are not new feature coverage — they're the regression net for
the kind of flake the existing tests don't catch.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.sessions.models import Message, MessageKind

from .conftest import call_play, tool_names

pytestmark = [pytest.mark.asyncio, pytest.mark.live]


# ---------------------------------------------------------------- self-consistency


_PRIMARY_PROSE_TOOLS = frozenset({"broadcast", "address_role"})


async def test_player_decision_routes_consistently_across_repeats(
    anthropic_client: Any,
    play_model: str,
    session_with_tactical_decision: Any,
    empty_registry: Any,
) -> None:
    """Run the same player-decision fixture 3 times. Every run must
    route to a prose tool **AND** the routings must match across
    runs — same tool family, no rotation between broadcast /
    address_role / share_data / inject_critical_event.

    This is the deterministic version of the existing
    ``test_player_decision_routes_to_broadcast`` single-call check.
    The single-call test passes ~60% of the time on a flaky prompt;
    this 3x version fails any flake immediately.

    Two assertions:
    1. Every run contains a prose tool. (covers "no prose tool at
       all" — the original failure mode the inject-only flake hit.)
    2. The "primary tool family" (broadcast vs address_role) is the
       same across all 3 runs. A run that produces ``[broadcast]``
       and another that produces ``[broadcast, share_data]`` is
       still a routing inconsistency the prompt should bind. We
       don't compare exact tool sets (set_active_roles is always
       there; auxiliary tools may legitimately vary) — we compare
       which prose tool the model chose as the primary.

    Cost: 3 Sonnet calls (~$0.04).
    """

    routings: list[list[str]] = []
    for _ in range(3):
        resp = await call_play(
            anthropic_client,
            model=play_model,
            session=session_with_tactical_decision,
            registry=empty_registry,
        )
        routings.append(tool_names(resp))

    bad_routings = [
        names for names in routings
        if not any(n in _PRIMARY_PROSE_TOOLS for n in names)
    ]
    assert not bad_routings, (
        "after a clean tactical decision the model must react via "
        "broadcast/address_role on every call; got non-prose routings on "
        f"{len(bad_routings)}/3 runs: {bad_routings} (all 3 routings: "
        f"{routings})"
    )

    # Cross-run consistency: which primary prose tool did the model pick?
    # Sorted tuple of {broadcast, address_role} ∩ names is stable per run;
    # if the model alternates (broadcast in run 1, address_role in run 2)
    # that's still a routing flake worth catching.
    primary_per_run = [
        tuple(sorted(set(n for n in names if n in _PRIMARY_PROSE_TOOLS)))
        for names in routings
    ]
    distinct_primaries = set(primary_per_run)
    assert len(distinct_primaries) == 1, (
        "model rotated between prose-tool families across the 3 runs; "
        "the same fixture should route to the same primary tool every "
        "time. primary tool per run: "
        f"{primary_per_run} (full routings: {routings})"
    )

    # Also assert no run added share_data or inject_critical_event as
    # an auxiliary — those are routing decisions for different pattern
    # families, not auxiliary noise.
    forbidden_auxiliaries = {"share_data", "inject_critical_event"}
    bad_aux = [
        names for names in routings
        if any(n in forbidden_auxiliaries for n in names)
    ]
    assert not bad_aux, (
        "tactical-commit ack-and-advance must not pull in share_data or "
        "inject_critical_event as auxiliaries; those belong to different "
        f"pattern families. routings: {routings}"
    )


# ---------------------------------------------------------------- paraphrase robustness


# Three semantically equivalent ways to say "isolate the affected hosts
# now". Different vocabulary, same intent. The prompt's tool-routing
# rules ask the model to parse intent, so all three should produce the
# same routing (broadcast/address_role to ack and advance).
_TACTICAL_DECISION_PARAPHRASES = [
    "Isolate immediately via Defender. I'm pulling in IR Lead.",
    "Pull the plug on those hosts now — quarantine them all.",
    "Kill the network for the affected laptops. Containment first.",
]


async def test_tactical_decision_routes_robustly_across_paraphrases(
    anthropic_client: Any,
    play_model: str,
    briefing_session: Any,
    empty_registry: Any,
) -> None:
    """All three semantically equivalent paraphrases must route to the
    SAME tool family — not just "some prose tool each time."

    Catches a regression where the prompt teaches the model to match a
    specific phrasing (e.g. literal ``"isolate"``) instead of intent.
    A regression where one phrasing routes to ``broadcast`` and
    another to ``share_data`` or ``inject_critical_event+broadcast``
    must fail this test.

    Implementation: a single test (not parametrized) runs all three
    paraphrases sequentially and asserts:

    1. Every paraphrase produces a prose tool (none defaults to a
       non-routing path).
    2. The set of tool families is identical across paraphrases —
       no broadcast→share_data, no broadcast→inject swap.
    3. No paraphrase pulls in share_data or inject_critical_event
       as auxiliaries (different pattern family).

    Cost: 3 Sonnet calls × $0.012 = ~$0.04.
    """

    routings_by_phrasing: dict[str, list[str]] = {}
    for phrasing in _TACTICAL_DECISION_PARAPHRASES:
        session = briefing_session.model_copy(deep=True)
        session.messages.extend([
            Message(
                kind=MessageKind.AI_TEXT,
                tool_name="broadcast",
                body="**CISO** — isolate or monitor first?",
            ),
            Message(
                kind=MessageKind.PLAYER,
                role_id=session.creator_role_id,
                body=phrasing,
            ),
        ])
        resp = await call_play(
            anthropic_client,
            model=play_model,
            session=session,
            registry=empty_registry,
        )
        names = tool_names(resp)
        assert names, (
            f"no tool calls for phrasing={phrasing!r}; "
            f"stop_reason={resp.stop_reason}"
        )
        routings_by_phrasing[phrasing] = names

    # 1. Every paraphrase produces a prose tool.
    bad = {
        p: r for p, r in routings_by_phrasing.items()
        if not any(n in _PRIMARY_PROSE_TOOLS for n in r)
    }
    assert not bad, (
        "tactical decision (no question, no data ask) must route to a "
        f"prose tool regardless of phrasing; missing on: {bad}"
    )

    # 2. Same primary tool family across all paraphrases.
    primary_per_phrasing = {
        p: tuple(sorted(set(n for n in r if n in _PRIMARY_PROSE_TOOLS)))
        for p, r in routings_by_phrasing.items()
    }
    distinct_primaries = set(primary_per_phrasing.values())
    assert len(distinct_primaries) == 1, (
        "model rotated between prose-tool families across paraphrases; "
        "same intent should produce same routing. primary tool per "
        f"phrasing: {primary_per_phrasing} "
        f"(full routings: {routings_by_phrasing})"
    )

    # 3. No paraphrase pulls in share_data or inject_critical_event.
    forbidden_auxiliaries = {"share_data", "inject_critical_event"}
    bad_aux = {
        p: r for p, r in routings_by_phrasing.items()
        if any(n in forbidden_auxiliaries for n in r)
    }
    assert not bad_aux, (
        "tactical-commit paraphrases must not pull in share_data or "
        "inject_critical_event as auxiliaries; those belong to "
        f"different pattern families. paraphrases tripping: {bad_aux}"
    )
