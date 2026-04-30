"""Live-API tool-routing regression suite.

Each test hits the real Anthropic API and asserts the model picks the
right tool for a given scenario shape. Add a new case here whenever:

* you add a new tool to ``PLAY_TOOLS``,
* you change a tool's description,
* you change Block 6 of the system prompt, or
* you change the per-turn reminder in ``turn_driver._TURN_REMINDER``.

What we assert
--------------

The model is non-deterministic; we assert ROUTING (which tool family),
not specific text. Each case has:

* a ``primary_tools`` set — the model is expected to pick one of these
  on attempt 1; failure is a hard regression,
* an ``acceptable_tools`` set — adjacent good answers (e.g. ``broadcast``
  with markdown when ``share_data`` would be ideal); these soft-pass
  with a warning,
* a ``forbidden_tools`` set — picking these is a hard regression
  (e.g. ``inject_event`` for an answer to a player question),
* an optional ``response_must_contain`` substring — a content-quality
  check (e.g. the broadcast must mention "Defender" when the player
  asked about Defender logs).

Cost
----

~$0.01 per test. Suite cost ~$0.10 per run. Skipped unless
``ANTHROPIC_API_KEY`` is set.

Adding a case
-------------

1. Build a ``Session`` fixture in ``conftest.py`` that produces the
   transcript shape you want to test.
2. Add a ``@pytest.mark.asyncio`` test below that calls
   ``call_play(...)`` and asserts on ``tool_names(resp)``.
3. Run ``ANTHROPIC_API_KEY=... pytest tests/live/ -v``.
4. If a soft-pass shows up, decide whether to tighten the tool
   description / prompt or accept it as adjacent-good.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.llm.tools import PLAY_TOOLS

from .conftest import call_play, text_content, tool_names, tool_uses

pytestmark = [pytest.mark.asyncio, pytest.mark.live]


# ---------------------------------------------------------------- routing tests


async def test_player_data_question_routes_to_share_data_or_broadcast(
    anthropic_client: Any,
    play_model: str,
    session_with_player_data_question: Any,
    empty_registry: Any,
) -> None:
    """Player asks 'what do we see in Defender logs?' — answer IS data.

    Primary expectation: ``share_data`` (the tool dedicated to synthetic
    technical data dumps).
    Acceptable: ``broadcast`` with a markdown table — same content,
    just lives in a prose bubble.
    Forbidden: ``inject_event`` (renders as gray pill, players think
    AI ignored them — the captured production bug).
    """

    resp = await call_play(
        anthropic_client,
        model=play_model,
        session=session_with_player_data_question,
        registry=empty_registry,
    )
    names = tool_names(resp)

    assert "inject_event" not in names, (
        "inject_event used to ANSWER a player data question — this is "
        "the captured 2026-04-30 production regression. The tighter "
        "inject_event description should prevent this. "
        f"Tools: {names}, response: {resp.content[:1] if resp.content else None}"
    )
    assert names, f"model emitted no tool calls; stop_reason={resp.stop_reason}"

    primary = {"share_data", "broadcast"}
    assert any(n in primary for n in names), (
        f"expected share_data or broadcast on a data-question; got {names}"
    )

    # Quality check: the answer must reference the source the player asked
    # about (Defender / account activity).
    answer_blocks = [
        u.input
        for u in tool_uses(resp)
        if u.name in {"share_data", "broadcast", "address_role"}
    ]
    answer_text = " ".join(
        str(b.get("data", "") or b.get("message", "") or b.get("label", ""))
        for b in answer_blocks
    ).lower()
    assert "defender" in answer_text or "account" in answer_text, (
        "answer didn't reference the data source the player asked about; "
        f"answer text: {answer_text[:200]!r}"
    )


async def test_briefing_turn_routes_to_broadcast(
    anthropic_client: Any,
    play_model: str,
    briefing_session: Any,
    empty_registry: Any,
) -> None:
    """First play turn (briefing) — model should open with `broadcast`
    + `set_active_roles`. Briefing contract hard-requires DRIVE."""

    resp = await call_play(
        anthropic_client,
        model=play_model,
        session=briefing_session,
        registry=empty_registry,
    )
    names = tool_names(resp)
    assert names, f"no tool calls on briefing; stop_reason={resp.stop_reason}"
    primary = {"broadcast", "address_role"}
    assert any(n in primary for n in names), (
        f"briefing must open with a player-facing message tool; got {names}"
    )


async def test_player_decision_routes_to_broadcast(
    anthropic_client: Any,
    play_model: str,
    session_with_tactical_decision: Any,
    empty_registry: Any,
) -> None:
    """Player has made a tactical decision (no question, no data ask).
    Model should react with prose (`broadcast` / `address_role`), NOT
    silently advance via `inject_event`."""

    resp = await call_play(
        anthropic_client,
        model=play_model,
        session=session_with_tactical_decision,
        registry=empty_registry,
    )
    names = tool_names(resp)
    assert names, f"no tool calls; stop_reason={resp.stop_reason}"
    primary = {"broadcast", "address_role"}
    assert any(n in primary for n in names), (
        "after a player decision, model should react via a player-facing "
        f"message tool; got {names}"
    )
    assert "inject_event" not in names, (
        "inject_event used as the AI's reaction to a player call — this "
        "should be a broadcast in the AI's voice, not a gray system pill. "
        f"Tools: {names}"
    )


async def test_text_content_block_emitted_alongside_tools(
    anthropic_client: Any,
    play_model: str,
    session_with_player_data_question: Any,
    empty_registry: Any,
) -> None:
    """The model's text content block (its 'thinking') is what now feeds
    the creator-only decision log (replaces the removed
    ``record_decision_rationale`` tool). Verify the model emits a
    non-trivial text block — otherwise the decision log will be empty
    in production.

    NOTE: this is a soft signal; some turns may emit only tool calls
    with no text. The assertion is permissive — we just want to know
    when text emission stops happening, not fail every CI run on it.
    """

    resp = await call_play(
        anthropic_client,
        model=play_model,
        session=session_with_player_data_question,
        registry=empty_registry,
    )
    text = text_content(resp).strip()
    if not text:
        pytest.skip(
            "model emitted no text content block on this run; the "
            "decision log will be empty for this turn. If this skip "
            "fires consistently, tighten the rationale guidance in "
            "Block 6 of the system prompt."
        )
    assert len(text) <= 600, (
        f"text content was {len(text)} chars; the harvester caps at "
        "600. Text > 600 is a sign the model is using the text block "
        "as its primary output instead of as terse rationale."
    )


async def test_drive_recovery_pinned_broadcast_works(
    anthropic_client: Any,
    play_model: str,
    session_with_player_data_question: Any,
    empty_registry: Any,
) -> None:
    """When `tool_choice` pins ``broadcast`` (the drive recovery
    directive), the model emits exactly that tool — never tries to
    smuggle in a different tool or refuse."""

    resp = await call_play(
        anthropic_client,
        model=play_model,
        session=session_with_player_data_question,
        registry=empty_registry,
        tools=[t for t in PLAY_TOOLS if t["name"] == "broadcast"],
        tool_choice={"type": "tool", "name": "broadcast"},
    )
    names = tool_names(resp)
    assert names == ["broadcast"], (
        f"drive recovery must produce exactly one broadcast; got {names}"
    )


async def test_yield_recovery_pinned_set_active_roles_works(
    anthropic_client: Any,
    play_model: str,
    session_with_player_data_question: Any,
    empty_registry: Any,
) -> None:
    """When `tool_choice` pins ``set_active_roles`` (the strict-yield
    directive), the model yields with valid role IDs."""

    resp = await call_play(
        anthropic_client,
        model=play_model,
        session=session_with_player_data_question,
        registry=empty_registry,
        tools=[t for t in PLAY_TOOLS if t["name"] == "set_active_roles"],
        tool_choice={"type": "tool", "name": "set_active_roles"},
    )
    names = tool_names(resp)
    assert names == ["set_active_roles"], (
        f"yield recovery must produce exactly one set_active_roles; got {names}"
    )
    role_ids = tool_uses(resp)[0].input.get("role_ids", [])
    valid = {"role-ciso", "role-soc"}
    assert role_ids and all(rid in valid for rid in role_ids), (
        f"yield recovery returned invalid role_ids={role_ids}; "
        f"valid set = {valid}"
    )


async def test_doctrine_fork_routes_to_pose_choice_or_broadcast(
    anthropic_client: Any,
    play_model: str,
    session_with_doctrine_fork: Any,
    empty_registry: Any,
) -> None:
    """When the player explicitly asks for a structured choice, model
    should route to `pose_choice` (primary) or `broadcast` with an
    A/B/C list (acceptable). NOT `share_data` (no data ask) and NOT
    bookkeeping tools."""

    resp = await call_play(
        anthropic_client,
        model=play_model,
        session=session_with_doctrine_fork,
        registry=empty_registry,
    )
    names = tool_names(resp)
    assert names, f"no tool calls; stop_reason={resp.stop_reason}"
    primary = {"pose_choice", "broadcast", "address_role"}
    assert any(n in primary for n in names), (
        "doctrine-fork ask should route to pose_choice (best) or "
        f"broadcast with a structured list (acceptable); got {names}"
    )
    forbidden = {"share_data", "inject_event"}
    assert not any(n in forbidden for n in names), (
        f"doctrine-fork ask should not route to {forbidden}; got {names}"
    )


async def test_pose_choice_tool_call_well_formed(
    anthropic_client: Any,
    play_model: str,
    session_with_doctrine_fork: Any,
    empty_registry: Any,
) -> None:
    """If the model picks `pose_choice`, the input must validate
    against the schema (2–5 options, role_id resolvable, question
    non-empty)."""

    resp = await call_play(
        anthropic_client,
        model=play_model,
        session=session_with_doctrine_fork,
        registry=empty_registry,
    )
    pose_uses = [u for u in tool_uses(resp) if u.name == "pose_choice"]
    if not pose_uses:
        pytest.skip(
            "model didn't pick pose_choice on this run (broadcast with "
            "an inline list is acceptable); no schema check to perform"
        )
    pose = pose_uses[0]
    role_id = pose.input.get("role_id")
    question = pose.input.get("question", "")
    options = pose.input.get("options", [])
    assert role_id in {"role-ciso", "role-soc"}, (
        f"pose_choice role_id must be a seated role; got {role_id!r}"
    )
    assert question.strip(), "pose_choice question must be non-empty"
    assert 2 <= len(options) <= 5, (
        f"pose_choice options must be 2-5 items; got {len(options)}"
    )


async def test_single_addressee_yields_narrowly_or_engine_narrows(
    anthropic_client: Any,
    play_model: str,
    session_with_doctrine_fork: Any,
    empty_registry: Any,
) -> None:
    """End-to-end check that the audience-matches-yield rule + the
    server-side narrower together prevent the captured 2026-04-30
    production regression (AI addresses one role, yields to all, turn
    stalls).

    The doctrine-fork fixture sets up a scenario where the CISO has
    explicitly asked for the options to be laid out — the model's
    natural response is ``pose_choice(role_id=ciso, …)`` (or a
    broadcast addressing CISO at clause-start). Either path makes
    CISO the unambiguous addressee. SOC was not asked anything.

    Pipeline mirrored in production:
    1. Call live LLM with the session.
    2. If no ``set_active_roles`` came back, run strict-retry
       recovery (forced ``tool_choice``) to get the yield.
    3. Run ``narrow_active_roles`` against the appended messages +
       role_ids.
    4. Assert the FINAL active set is ``[ciso]`` — never ``[ciso, soc]``.

    Failure modes this test catches:
    * The matcher misses an addressing pattern the model legitimately
      used (false negative — drops too much, correctly fails the
      "ciso must be in final" assertion).
    * The matcher fires on a passing reference and keeps SOC (false
      positive — fails the "soc must NOT be in final" assertion).
    * The wiring in ``turn_driver`` doesn't run the narrower at all
      (final set still has SOC).
    """

    from app.sessions.active_roles import narrow_active_roles
    from app.sessions.models import Message, MessageKind

    resp = await call_play(
        anthropic_client,
        model=play_model,
        session=session_with_doctrine_fork,
        registry=empty_registry,
    )

    # Reconstruct the same Message objects the dispatcher would have
    # appended, so the narrower runs against the same surface it sees
    # in production. We only need ``broadcast`` / ``address_role`` /
    # ``pose_choice`` bodies + their ``tool_args``.
    def _appended_from(response: Any) -> list[Message]:
        appended: list[Message] = []
        for u in tool_uses(response):
            if u.name == "broadcast":
                appended.append(
                    Message(
                        kind=MessageKind.AI_TEXT,
                        body=u.input.get("message", ""),
                        tool_name="broadcast",
                        tool_args=dict(u.input),
                    )
                )
            elif u.name == "address_role":
                appended.append(
                    Message(
                        kind=MessageKind.AI_TEXT,
                        body=u.input.get("message", ""),
                        tool_name="address_role",
                        tool_args=dict(u.input),
                    )
                )
            elif u.name == "pose_choice":
                appended.append(
                    Message(
                        kind=MessageKind.AI_TEXT,
                        body=u.input.get("question", ""),
                        tool_name="pose_choice",
                        tool_args=dict(u.input),
                    )
                )
        return appended

    appended = _appended_from(resp)

    # First attempt: did the model yield on its own?
    set_active_calls = [u for u in tool_uses(resp) if u.name == "set_active_roles"]
    if not set_active_calls:
        # Mirror production strict-yield recovery: force the model to
        # emit ``set_active_roles`` via tool_choice. The engine does
        # this when the first attempt didn't yield. The yield from
        # this recovery pass is what production would commit.
        recovery = await call_play(
            anthropic_client,
            model=play_model,
            session=session_with_doctrine_fork,
            registry=empty_registry,
            tools=[t for t in PLAY_TOOLS if t["name"] == "set_active_roles"],
            tool_choice={"type": "tool", "name": "set_active_roles"},
        )
        set_active_calls = [u for u in tool_uses(recovery) if u.name == "set_active_roles"]
        assert set_active_calls, (
            "strict-retry recovery should have produced set_active_roles; "
            f"got {tool_names(recovery)}"
        )
    ai_set: list[str] = list(set_active_calls[-1].input.get("role_ids", []))

    result = narrow_active_roles(
        roles=session_with_doctrine_fork.roles,
        appended_messages=appended,
        ai_set=ai_set,
    )

    # The CISO is the role being asked the question (per the player
    # transcript: "Lay them out clearly — I want to pick one
    # explicitly"). The SOC was not asked anything. The final active
    # set must NOT include the SOC.
    assert "role-soc" not in result.kept, (
        "Final active set kept the SOC role even though it wasn't "
        "addressed. Either the model emitted text that matched the "
        "narrower's clause-start pattern for SOC, or the matcher has "
        "a bug. "
        f"AI yield: {ai_set}\n"
        f"narrower kept: {result.kept}\n"
        f"narrower dropped: {result.dropped}\n"
        f"narrower reason: {result.reason}\n"
        f"appended bodies: "
        f"{[m.body[:160] for m in appended]}"
    )
    assert "role-ciso" in result.kept, (
        f"CISO was the addressee but didn't make the final active "
        f"set. AI yield: {ai_set}, narrower kept: {result.kept}, "
        f"reason: {result.reason}, appended: "
        f"{[m.body[:160] for m in appended]}"
    )


async def test_no_attempt_to_call_removed_rationale_tool(
    anthropic_client: Any,
    play_model: str,
    session_with_player_data_question: Any,
    empty_registry: Any,
) -> None:
    """``record_decision_rationale`` was removed in the 2026-04-30
    redesign. The model should never call it — the engine's tool
    palette no longer includes it, and the API would reject the call
    if it did. Belt-and-braces: confirm at the response level."""

    resp = await call_play(
        anthropic_client,
        model=play_model,
        session=session_with_player_data_question,
        registry=empty_registry,
    )
    assert "record_decision_rationale" not in tool_names(resp), (
        "record_decision_rationale should not be in the tool palette "
        "any more; if the model called it the API would have errored. "
        f"Tool names: {tool_names(resp)}"
    )
