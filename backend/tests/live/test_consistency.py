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
    route to a prose tool (broadcast or address_role).

    This is the deterministic version of the existing
    ``test_player_decision_routes_to_broadcast`` single-call check.
    The single-call test passes ~60% of the time on a flaky prompt;
    this 3x version fails any flake immediately.

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


@pytest.mark.parametrize("phrasing", _TACTICAL_DECISION_PARAPHRASES)
async def test_tactical_decision_routes_robustly_across_paraphrases(
    anthropic_client: Any,
    play_model: str,
    briefing_session: Any,
    empty_registry: Any,
    phrasing: str,
) -> None:
    """Three semantically equivalent player tactical decisions, same
    expected routing (prose ack-and-advance).

    Catches a regression where the prompt teaches the model to match a
    specific phrasing (e.g. literal ``"isolate"``) instead of intent.
    All three paraphrases describe a tactical containment commit; all
    three should produce a prose response from the model.

    Cost: 3 Sonnet calls × $0.012 = ~$0.04 (one per paraphrase via
    parametrize).
    """

    session = briefing_session
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
    assert names, f"no tool calls; phrasing={phrasing!r}; stop_reason={resp.stop_reason}"
    assert any(n in _PRIMARY_PROSE_TOOLS for n in names), (
        "tactical decision (no question, no data ask) must route to a "
        "prose tool regardless of phrasing; "
        f"got {names} for phrasing {phrasing!r}"
    )
