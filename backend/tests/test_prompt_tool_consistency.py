"""Phantom-tool detector — fails CI when a model-facing string mentions
a tool that isn't in the tier's palette.

This is the **explicit guardrail** for the class of bug that bit us in
PR #68:

* The 2026-04-30 redesign removed ``inject_event``,
  ``mark_timeline_point``, and ``record_decision_rationale`` from
  ``PLAY_TOOLS``.
* But the system prompt, recovery directives, kickoff message, turn
  reminder, and several tool descriptions still **named** those tools
  in backticks — model-facing text telling the model to use, or not
  use, tools that no longer exist.
* The model can't call a tool that isn't in ``tools=[...]`` of the
  API request — but seeing the name in the prompt confuses it,
  wastes tokens, and leaks the historical design into the model's
  attention.

This test reconstructs every model-facing string for each tier, regex-
extracts every backticked snake_case identifier, and asserts each one
is either a current tool in that tier's palette OR a known non-tool
concept (slot names, arg fields, block names).

When you remove a tool from a palette:
* Add its name to ``HISTORICAL_REMOVED_PLAY_TOOLS`` (or the equivalent
  per tier) so the regression test can flag any future re-introduction
  of references in the prompts.
* Search the codebase for the name in backticks and replace each
  reference with the appropriate current tool.

When you add a tool:
* Add the name to the tier's ``PLAY_TOOLS`` / ``SETUP_TOOLS`` /
  ``AAR_TOOLS`` array. The test pulls names directly from those, so
  no test edit is needed for additions.

When the test fails:
* The error message lists exactly which names leaked into which
  tier's prompts. Either remove the references (preferred — they're
  almost always wasted tokens) or, if the reference is intentional
  prose like "the legacy `foo` tool used to do X", phrase it
  un-backticked or add to the per-tier allowlist below.
"""

from __future__ import annotations

import re

import pytest

from app.extensions.models import ExtensionBundle
from app.extensions.registry import freeze_bundle
from app.llm.prompts import (
    INTERJECT_NOTE,
    build_aar_system_blocks,
    build_play_system_blocks,
    build_setup_system_blocks,
)
from app.llm.tools import AAR_TOOL, PLAY_TOOLS, setup_tools_for
from app.sessions.models import (
    Role,
    ScenarioBeat,
    ScenarioInject,
    ScenarioPlan,
    Session,
    SessionState,
)
from app.sessions.turn_driver import _KICKOFF_USER_MSG, _TURN_REMINDER
from app.sessions.turn_validator import (
    _DRIVE_RECOVERY_NOTE,
    _DRIVE_RECOVERY_USER_NUDGE_BASE,
    _DRIVE_RECOVERY_USER_NUDGE_TEMPLATE,
    _STRICT_YIELD_NOTE,
    _STRICT_YIELD_USER_NUDGE,
)

# Convenience: AAR has a single built-in tool. Wrap it in a list so the
# tier-walk logic below treats it like the play / setup tool arrays.
AAR_TOOLS = [AAR_TOOL]

# Pattern: a markdown-backticked snake_case identifier, the canonical
# shape of a tool reference in our prompts. Captures only the inner
# token. Tools are always lowercase + underscores so this regex is
# tight enough to avoid false positives on ``BACKEND``-style noise.
_BACKTICK_NAME = re.compile(r"`([a-z][a-z0-9_]+)`")

# Tools that have ever been in PLAY_TOOLS and have since been removed.
# Adding to this set is part of the removal protocol — never remove
# from it. The presence of any of these names in model-facing text is
# always a bug.
HISTORICAL_REMOVED_PLAY_TOOLS = frozenset(
    {
        "inject_event",
        "mark_timeline_point",
        "record_decision_rationale",
        # Issue #104 (2026-05-02): the AI used to be able to terminate
        # the session, but the model occasionally narrated the act
        # without calling the tool — leaving creators with the false
        # impression the exercise had wrapped up. Ending an exercise
        # is a creator-shaped commit (kicks off the AAR pipeline, no
        # undo) so the capability moved to creator-only.
        "end_session",
    }
)

# Non-tool identifiers that legitimately appear backticked in prompts
# (slot names, schema field names, tool input keys, conceptual terms).
# Add to this set when introducing a new concept — but pause first and
# ask: is this *really* not a tool name? If a teammate could plausibly
# read it as a tool, rename the concept.
_NON_TOOL_ALLOWLIST = frozenset(
    {
        # Slot vocabulary (see slots.py)
        "drive",
        "yield",
        "narrate",
        "pin",
        "escalate",
        "terminate",
        "bookkeeping",
        # Tool input fields the prompt references inline
        "role_id",
        "role_ids",
        # ``id`` (without the role prefix) is referenced in the AAR
        # tier's ``## Roster (canonical IDs)`` block — "use these
        # exact ``id`` values in ``per_role_scores[].role_id``".
        # It's a field name on the roster row, not a tool.
        "id",
        "rationale",
        "title",
        "note",
        "message",
        "data",
        "label",
        "display_name",
        "options",
        "question",
        "headline",
        "body",
        "severity",
        "trigger",
        "summary",
        "description",
        "args",
        "args_keys",
        # API-level concepts
        "is_error",
        "tool_use",
        "tool_result",
        "tool_choice",
        "stop_reason",
        "end_turn",
        "input_schema",
        "tools",
        "system",
        "messages",
        "max_tokens",
        # Plan / scenario fields (Block 7 references these)
        "narrative_arc",
        "expected_actors",
        "key_objectives",
        "injects",
        "guardrails",
        "out_of_scope",
        "success_criteria",
        "executive_summary",
        "scenario_prompt",
        # State / mode names referenced in prompts
        "state",
        "mode",
        "tier",
        "session_id",
        "turn_id",
        "turn_index",
        "creator",
        "player",
        "spectator",
        # Cross-tier references (a play-tier prompt may legitimately
        # mention a setup tool by name when explaining the lifecycle —
        # e.g. "the creator approved via finalize_setup")
        "ask_setup_question",
        "propose_scenario_plan",
        "finalize_setup",
        "finalize_report",
        # Audit / response shapes
        "audit_kind",
        "kind",
        "type",
        # CLI / config / file paths the prompts mention
        "ANTHROPIC_API_KEY",
        "claude_sonnet",
        # Markdown-ish words the prompts say in backticks for emphasis
        "any",
        "auto",
        "true",
        "false",
        "none",
        "null",
        "yes",
        "no",
        # Status enum values referenced inline (e.g. resolve_role_followup
        # status: done | dropped)
        "done",
        "dropped",
        "pending",
        "completed",
        "errored",
        # Per-tool input field names referenced inline by other tools'
        # descriptions
        "prompt",
        "status",
        "input",
        "beat",
        # AAR report structured-output fields
        "overall_rationale",
        "what_went_well",
        "gaps",
        "recommendations",
        "narrative",
        "key_decisions",
        "score",
        # AAR per-role-scores entry sub-fields (the AAR system block
        # now calls these out by name when explaining the JSON-array-
        # of-objects contract for ``per_role_scores``).
        "per_role_scores",
        "decision_quality",
        "communication",
        "speed",
        # Workstream-related field names + example IDs the prompt
        # copy uses to illustrate ``declare_workstreams`` / the
        # ``workstream_id`` field. Added when the iter-4 polish PR
        # flipped ``WORKSTREAMS_ENABLED`` to True by default — these
        # tokens now ship in every real setup/play prompt.
        "lead_role_id",
        "workstream_id",
        "workstreams",
        # Example workstream ids used inline in the setup directive
        # (e.g. "Examples: `containment`, `comms`, `disclosure`") —
        # not roles, not tool names, just illustrative ids the model
        # might re-use in its own declaration.
        "containment",
        "containment_1",
        "containment_2",
        "comms",
        "disclosure",
        "per_role",
        "highlights",
        "lowlights",
    }
)


def _build_session() -> Session:
    """Minimal session that exercises every block of `build_play_system_blocks`.

    Includes a frozen plan + a follow-up so Block 7 + Block 11 render."""

    return Session(
        scenario_prompt="ransomware via vendor portal",
        state=SessionState.AI_PROCESSING,
        roles=[
            Role(id="role-a", label="CISO", display_name="Alex", is_creator=True),
            Role(id="role-b", label="SOC", display_name="Bee"),
        ],
        creator_role_id="role-a",
        plan=ScenarioPlan(
            title="Vendor portal ransomware",
            executive_summary="03:14 W; ransomware on finance laptops",
            key_objectives=["confirm scope", "contain", "decide notification"],
            narrative_arc=[
                ScenarioBeat(beat=1, label="Detection", expected_actors=["SOC"]),
                ScenarioBeat(beat=2, label="Containment", expected_actors=["IR"]),
            ],
            injects=[
                ScenarioInject(trigger="after beat 2", type="critical", summary="Slack leak"),
            ],
            guardrails=["stay in scope"],
            success_criteria=["containment before beat 3"],
            out_of_scope=["real exploit code"],
        ),
    )


def _empty_registry():
    return freeze_bundle(ExtensionBundle())


def _all_play_tier_text(*, workstreams_enabled: bool = True) -> str:
    """Concatenate every string the model can see while running a
    play-tier turn or its recovery passes.

    ``workstreams_enabled`` covers both branches of the feature flag.
    Phantom-tool regressions in the workstream-only blocks
    (``_WORKSTREAMS_PLAY_NOTE``) wouldn't fire under the False path —
    the test must scan the True path too. Default True since the
    iter-4 polish flipped the runtime default to True; the False path
    is exercised by the parametrized tests below as a kill-switch
    safety net.
    """

    session = _build_session()
    registry = _empty_registry()
    parts: list[str] = []

    # System blocks — Block 1 through Block 11 + extension prompts.
    for blk in build_play_system_blocks(
        session, registry=registry, workstreams_enabled=workstreams_enabled
    ):
        parts.append(blk.get("text", ""))

    # Per-tool description (sent in the tools array).
    for t in PLAY_TOOLS:
        parts.append(t.get("description", ""))

    # Recovery directives (system addendum + user nudge).
    parts.append(_DRIVE_RECOVERY_NOTE)
    parts.append(_DRIVE_RECOVERY_USER_NUDGE_BASE)
    parts.append(_DRIVE_RECOVERY_USER_NUDGE_TEMPLATE)
    parts.append(_STRICT_YIELD_NOTE)
    parts.append(_STRICT_YIELD_USER_NUDGE)

    # Per-call user-block contributions (kickoff for briefing, reminder
    # for normal turns).
    parts.append(_KICKOFF_USER_MSG)
    parts.append(_TURN_REMINDER)

    # Interject-mode override note.
    parts.append(INTERJECT_NOTE)

    return "\n".join(parts)


def _all_setup_tier_text(*, workstreams_enabled: bool = True) -> str:
    """Same widening as :func:`_all_play_tier_text` — the setup-tier
    has its own workstream-gated directive (``_WORKSTREAMS_SETUP_DIRECTIVE``)
    that needs the True branch scanned for phantom-tool refs.

    Note: with ``workstreams_enabled=True`` the setup palette gains
    ``declare_workstreams`` (added by ``setup_tools_for``); we pull the
    palette through that helper so the descriptions of the gated tool
    are scanned alongside the static palette.
    """

    session = _build_session()
    parts: list[str] = []
    for blk in build_setup_system_blocks(
        session, workstreams_enabled=workstreams_enabled
    ):
        parts.append(blk.get("text", ""))
    for t in setup_tools_for(workstreams_enabled=workstreams_enabled):
        parts.append(t.get("description", ""))
    return "\n".join(parts)


def _all_aar_tier_text() -> str:
    session = _build_session()
    parts: list[str] = []
    for blk in build_aar_system_blocks(session):
        parts.append(blk.get("text", ""))
    for t in AAR_TOOLS:
        parts.append(t.get("description", ""))
    return "\n".join(parts)


def _backtick_refs(text: str) -> set[str]:
    return set(_BACKTICK_NAME.findall(text))


# --------------------------------------------------------------- per-tier tests


@pytest.mark.parametrize("workstreams_enabled", [False, True])
def test_play_tier_prompts_dont_reference_removed_tools(
    workstreams_enabled: bool,
) -> None:
    """The bug from PR #68 review: model-facing strings mentioning
    tools that are no longer in PLAY_TOOLS. Always a regression.

    Both flag branches scanned — the workstream-only block
    (``_WORKSTREAMS_PLAY_NOTE``) ships in real prompts on the True
    branch, and a phantom-tool reference there must trip the test.
    """

    text = _all_play_tier_text(workstreams_enabled=workstreams_enabled)
    refs = _backtick_refs(text)
    leaked = refs & HISTORICAL_REMOVED_PLAY_TOOLS
    assert not leaked, (
        f"Model-facing play-tier text references removed tools: "
        f"{sorted(leaked)}. These tools are no longer in PLAY_TOOLS so "
        "the model cannot call them; mentioning them in prompts "
        "wastes tokens and misleads the model. Search the codebase "
        "(``grep -rn`` for each name) and remove the references. "
        "If you legitimately need to discuss the historical tool, "
        "phrase it un-backticked (e.g., 'the legacy timeline-pin "
        "tool' rather than '`mark_timeline_point`')."
    )


@pytest.mark.parametrize("workstreams_enabled", [False, True])
def test_play_tier_prompts_only_reference_known_play_tools_or_concepts(
    workstreams_enabled: bool,
) -> None:
    """Stricter check: every backticked snake_case name in play-tier
    model-facing text must be either (a) a current play-tier tool,
    or (b) a known non-tool concept in ``_NON_TOOL_ALLOWLIST``.

    Parametrized so the workstream-gated block
    (``_WORKSTREAMS_PLAY_NOTE``) is scanned on the True branch — the
    polish PR flipped the runtime default to True so this is now the
    common path.
    """

    text = _all_play_tier_text(workstreams_enabled=workstreams_enabled)
    refs = _backtick_refs(text)
    play_tool_names = {t["name"] for t in PLAY_TOOLS}

    unknown = refs - play_tool_names - _NON_TOOL_ALLOWLIST
    assert not unknown, (
        f"Backticked names in play-tier prompts are neither a current "
        f"play tool nor a known concept: {sorted(unknown)}.\n"
        "If a removed/typo'd tool name → remove the reference.\n"
        "If a new genuine non-tool concept (slot, field, etc.) → add "
        "to ``_NON_TOOL_ALLOWLIST`` in this test file.\n"
        "If a new tool you just added → add it to ``PLAY_TOOLS`` first."
    )


@pytest.mark.parametrize("workstreams_enabled", [False, True])
def test_setup_tier_prompts_only_reference_known_setup_tools_or_concepts(
    workstreams_enabled: bool,
) -> None:
    """Same guard for the setup tier. Setup-tier prompts may mention
    play-tier tools when explaining the post-finalize lifecycle, so
    play tools are also allowed.

    Parametrized so ``_WORKSTREAMS_SETUP_DIRECTIVE`` is scanned on
    both flag branches (it ships only on True).
    """

    text = _all_setup_tier_text(workstreams_enabled=workstreams_enabled)
    refs = _backtick_refs(text)
    setup_tool_names = {
        t["name"] for t in setup_tools_for(workstreams_enabled=workstreams_enabled)
    }
    play_tool_names = {t["name"] for t in PLAY_TOOLS}
    unknown = refs - setup_tool_names - play_tool_names - _NON_TOOL_ALLOWLIST
    assert not unknown, (
        f"Backticked names in setup-tier prompts unrecognised: "
        f"{sorted(unknown)}. Same fix as the play-tier test."
    )


def test_aar_tier_prompts_only_reference_known_aar_tools_or_concepts() -> None:
    """Same guard for the AAR tier."""

    text = _all_aar_tier_text()
    refs = _backtick_refs(text)
    aar_tool_names = {t["name"] for t in AAR_TOOLS}
    play_tool_names = {t["name"] for t in PLAY_TOOLS}  # AAR refers to play history
    unknown = refs - aar_tool_names - play_tool_names - _NON_TOOL_ALLOWLIST
    assert not unknown, (
        f"Backticked names in AAR-tier prompts unrecognised: "
        f"{sorted(unknown)}. Same fix as the play-tier test."
    )


# --------------------------------------------------------------- meta-tests


def test_historical_removed_tools_set_is_disjoint_from_current_play_tools() -> None:
    """If a tool name is in ``HISTORICAL_REMOVED_PLAY_TOOLS`` AND in
    ``PLAY_TOOLS``, that means we re-added a tool we previously
    removed — almost certainly a mistake. Force a deliberate
    decision: remove from the historical set if the re-add is
    intentional, or pull from PLAY_TOOLS if not."""

    play_tool_names = {t["name"] for t in PLAY_TOOLS}
    overlap = HISTORICAL_REMOVED_PLAY_TOOLS & play_tool_names
    assert not overlap, (
        f"Tool(s) {sorted(overlap)} appear in both PLAY_TOOLS and "
        "HISTORICAL_REMOVED_PLAY_TOOLS. Either the tool was re-added "
        "(remove from HISTORICAL_REMOVED_PLAY_TOOLS) or it shouldn't "
        "be in PLAY_TOOLS (remove it). Make a deliberate call."
    )


def test_phantom_detector_actually_catches_leaked_names() -> None:
    """Self-test for the regex + the historical set. If the detector
    can't catch a deliberately leaked name, the production tests
    above will silently pass even on real regressions."""

    bait = (
        "If you must, fall back to `record_decision_rationale` for "
        "the bookkeeping note."
    )
    refs = _backtick_refs(bait)
    leaked = refs & HISTORICAL_REMOVED_PLAY_TOOLS
    assert leaked == {"record_decision_rationale"}, (
        f"Self-test failed: {leaked!r}. The phantom-ref detector is "
        "broken — fix the regex or the historical set before trusting "
        "the production tests above."
    )
