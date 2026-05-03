"""Engine-side phase policy — structural guardrails for LLM calls.

This module is the single source of truth for "what is the LLM allowed
to do in tier X at session state Y?" It does NOT trust the prompt to
keep the model on track; the rules are enforced in Python at the
boundaries that build / dispatch / receive LLM calls.

Three boundaries:

1. **Entry-state check** — every turn driver asserts the session state
   is one the tier may run in (`assert_state`). Catches engine bugs
   like "we accidentally called ``run_play_turn`` while still in
   SETUP".
2. **Tool-list filter** — the LLM client drops tools not in the
   tier's allowed set before forwarding to Anthropic
   (`filter_allowed_tools`). A misbehaving caller (or a future
   refactor) cannot accidentally expose setup-tier tools to a play
   call.
3. **Tool-choice posture** — each tier has a recommended
   ``tool_choice`` (`tool_choice_for`). The setup and AAR tiers pin
   to ``any`` / a specific tool because their downstream code cannot
   handle a bare-text response; the play tier defaults to ``auto`` so
   the model can chain narration + yield.

Bare-text policy is also recorded here (`bare_text_allowed`) so
turn drivers can act consistently when an LLM ignores the constraint.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Final

from ..config import ModelTier
from ..llm.tools import _DECLARE_WORKSTREAMS_TOOL, AAR_TOOL, PLAY_TOOLS, SETUP_TOOLS
from .models import SessionState


@dataclass(frozen=True)
class TierPolicy:
    """The phase policy for one LLM tier.

    Attributes
    ----------
    tier:
        Which tier this policy applies to.
    allowed_states:
        Session states the tier may run in. Empty set = no state
        precondition (used for the input-side guardrail tier, which
        runs on raw participant text in any state).
    allowed_tool_names:
        Names of tools that may appear in this tier's API request.
        Extension specs are NOT part of this set — see
        :func:`filter_allowed_tools` which adds them on the play tier.
    tool_choice:
        Default ``tool_choice`` to forward to Anthropic. ``None`` =
        let the SDK pick (``"auto"``).
    bare_text_allowed:
        Whether a tier's response may legitimately be text-only with
        no tool call. ``False`` means the turn driver should treat
        bare text as a failure (drop / retry).
    """

    tier: ModelTier
    allowed_states: frozenset[SessionState]
    allowed_tool_names: frozenset[str]
    tool_choice: dict[str, Any] | None
    bare_text_allowed: bool


_PLAY_TOOL_NAMES: Final[frozenset[str]] = frozenset(t["name"] for t in PLAY_TOOLS)
# ``declare_workstreams`` (Phase A chat-declutter,
# docs/plans/chat-decluttering.md §6.8) is feature-flagged at the call
# site via ``setup_tools_for(workstreams_enabled=...)`` rather than
# included in ``SETUP_TOOLS`` directly. The phase-policy filter
# (``filter_allowed_tools``) still needs to recognize the name —
# otherwise it would be dropped as "not in tier" the moment the flag
# flips on. Including it here is unconditional; the gate is "is the
# tool present in the request payload at all", which lives one layer up.
_SETUP_TOOL_NAMES: Final[frozenset[str]] = frozenset(
    [*(t["name"] for t in SETUP_TOOLS), _DECLARE_WORKSTREAMS_TOOL["name"]]
)
_AAR_TOOL_NAMES: Final[frozenset[str]] = frozenset({AAR_TOOL["name"]})


POLICIES: Final[dict[ModelTier, TierPolicy]] = {
    "setup": TierPolicy(
        tier="setup",
        allowed_states=frozenset({SessionState.SETUP}),
        allowed_tool_names=_SETUP_TOOL_NAMES,
        # Force a tool call. Pre-fix the bare-text path could leak
        # setup-style assistant prose into the play history; pinning
        # ``any`` makes that structurally impossible.
        tool_choice={"type": "any"},
        bare_text_allowed=False,
    ),
    "play": TierPolicy(
        tier="play",
        allowed_states=frozenset(
            {
                SessionState.BRIEFING,
                SessionState.AI_PROCESSING,
                # ``run_interject`` runs in AWAITING_PLAYERS without
                # advancing the turn.
                SessionState.AWAITING_PLAYERS,
            }
        ),
        allowed_tool_names=_PLAY_TOOL_NAMES,
        # Default ``auto``; specific paths (strict-retry, interject)
        # override at the call site.
        tool_choice=None,
        # Play turns legitimately contain narration text alongside
        # tool calls; the missing-yield case is detected separately
        # via ``had_yielding_call``.
        bare_text_allowed=True,
    ),
    "aar": TierPolicy(
        tier="aar",
        allowed_states=frozenset({SessionState.ENDED}),
        allowed_tool_names=_AAR_TOOL_NAMES,
        # Pin to the AAR tool — there is exactly one valid output
        # shape for this tier.
        tool_choice={"type": "tool", "name": AAR_TOOL["name"]},
        bare_text_allowed=False,
    ),
    "guardrail": TierPolicy(
        tier="guardrail",
        # Input classifier runs on raw participant text; no state
        # precondition.
        allowed_states=frozenset(),
        allowed_tool_names=frozenset(),
        # No tools, no tool_choice — the response is a single-word
        # verdict.
        tool_choice=None,
        bare_text_allowed=True,
    ),
}


class PhaseViolation(RuntimeError):
    """Raised when a tier is asked to run in an incompatible state.

    Engine bug, not user input — surfaces at the boundary so a
    refactor can't silently ship a regression that, e.g., calls the
    play turn driver during ENDED.
    """


def assert_state(tier: ModelTier, state: SessionState) -> None:
    """Reject calls into ``tier`` from incompatible states."""

    policy = POLICIES[tier]
    if not policy.allowed_states:
        return  # tier is state-agnostic (guardrail)
    if state not in policy.allowed_states:
        raise PhaseViolation(
            f"tier {tier!r} cannot run in state {state.value!r}; "
            f"allowed: {sorted(s.value for s in policy.allowed_states)}"
        )


def filter_allowed_tools(
    tier: ModelTier,
    tools: list[dict[str, Any]],
    *,
    extension_tool_names: frozenset[str] | None = None,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Return (kept, dropped_names).

    Tools whose ``name`` isn't in the tier's allowed set are dropped.
    Extension specs (provided by the operator at startup) are
    permitted only on the play tier and only when their names are
    explicitly passed in ``extension_tool_names``.

    The caller decides what to do with ``dropped_names`` — typically
    the LLM client logs them at warning level so a regression is
    visible in the audit trail.
    """

    policy = POLICIES[tier]
    allowed = policy.allowed_tool_names
    if extension_tool_names and tier == "play":
        allowed = allowed | extension_tool_names
    kept: list[dict[str, Any]] = []
    dropped: list[str] = []
    for t in tools:
        name = str(t.get("name", ""))
        if name in allowed:
            kept.append(t)
        else:
            dropped.append(name)
    return kept, dropped


def tool_choice_for(tier: ModelTier) -> dict[str, Any] | None:
    """Default ``tool_choice`` for the tier.

    Specific code paths (strict-retry, interject) override at the
    call site; this is the safe default."""

    return POLICIES[tier].tool_choice


def bare_text_allowed(tier: ModelTier) -> bool:
    return POLICIES[tier].bare_text_allowed


__all__ = [
    "POLICIES",
    "PhaseViolation",
    "TierPolicy",
    "assert_state",
    "bare_text_allowed",
    "filter_allowed_tools",
    "tool_choice_for",
]
