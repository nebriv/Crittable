"""Tool → slot classification for the turn validator.

A turn's *slots* describe what kinds of work the AI did on this turn —
DRIVE (asks the next question), YIELD (advances), NARRATE (stage
direction), etc. The validator (``turn_validator.py``) maps the
:class:`~app.llm.dispatch.DispatchOutcome` to a set of slots and
checks against a state-aware ``TurnContract``.

This module is the SINGLE PLACE that knows "tool X belongs to slot Y".
Both the dispatcher (which writes ``DispatchOutcome.slots``) and the
validator (which reads them) import :data:`TOOL_TO_SLOT` from here so
they cannot drift.

Adding a new tool: add it to :class:`Slot` (or pick an existing slot)
and to :data:`TOOL_TO_SLOT`. ``test_slots.py`` confirms every name in
``PLAY_TOOLS`` / ``SETUP_TOOLS`` / ``AAR_TOOL`` is mapped.
"""

from __future__ import annotations

from enum import StrEnum


class Slot(StrEnum):
    # Player-facing question / addressable narrative beat.
    # Tools: ``broadcast``, ``address_role``.
    DRIVE = "drive"
    # Advances the turn — the engine moves to AWAITING_PLAYERS.
    # Tools: ``set_active_roles``.
    YIELD = "yield"
    # FYI / stage-direction system note (rendered as SYSTEM bubble).
    # Tools: ``inject_event``.
    NARRATE = "narrate"
    # Sidebar pin only — does NOT render as a chat bubble.
    # Tools: ``mark_timeline_point``.
    PIN = "pin"
    # Headline-grade escalation that must be paired with DRIVE + YIELD.
    # Tools: ``inject_critical_event``.
    ESCALATE = "escalate"
    # Terminates the session, kicks AAR. Counts as a yielding call
    # but is NOT compatible with DRIVE-required contracts (the AAR
    # is what players see next).
    # Tools: ``end_session``.
    TERMINATE = "terminate"
    # Bookkeeping — follow-up tracking, artifact requests, extension
    # invocations. Neither drives nor yields; surfaces as SYSTEM or
    # AI_TEXT bubbles depending on the tool.
    BOOKKEEPING = "bookkeeping"
    # Setup-tier: AI asks the creator a question. Yielding for the
    # setup tier (the creator's reply advances setup).
    ASK_QUESTION = "ask_question"
    # Setup-tier: AI proposes a draft scenario plan.
    PLAN_PROPOSE = "plan_propose"
    # Setup-tier: AI commits the agreed plan; transitions to READY.
    PLAN_FINALIZE = "plan_finalize"
    # AAR-tier: AI emits the structured report.
    REPORT = "report"


TOOL_TO_SLOT: dict[str, Slot] = {
    # play tier — drive (player-facing AI voice)
    "broadcast": Slot.DRIVE,
    "address_role": Slot.DRIVE,
    "share_data": Slot.DRIVE,  # player-facing data dump — IS a drive
    "pose_choice": Slot.DRIVE,  # multi-choice decision prompt — IS a drive
    # play tier — yield / terminate
    "set_active_roles": Slot.YIELD,
    "end_session": Slot.TERMINATE,
    # play tier — narrative aids
    "inject_event": Slot.NARRATE,
    "mark_timeline_point": Slot.PIN,
    "inject_critical_event": Slot.ESCALATE,
    # play tier — bookkeeping
    "track_role_followup": Slot.BOOKKEEPING,
    "resolve_role_followup": Slot.BOOKKEEPING,
    "request_artifact": Slot.BOOKKEEPING,
    "lookup_resource": Slot.BOOKKEEPING,
    "use_extension_tool": Slot.BOOKKEEPING,
    # setup tier
    "ask_setup_question": Slot.ASK_QUESTION,
    "propose_scenario_plan": Slot.PLAN_PROPOSE,
    "finalize_setup": Slot.PLAN_FINALIZE,
    # aar tier
    "finalize_report": Slot.REPORT,
}


def slot_for(tool_name: str) -> Slot | None:
    """Return the slot for a known tool name, or ``None`` if unknown.

    Unknown names come from operator-loaded extension tools: those
    classify as :data:`Slot.BOOKKEEPING` by default (they invoke
    extensions, not the core turn-driving tools). Callers that want
    to treat unknowns as bookkeeping can use ``slot_for(name) or
    Slot.BOOKKEEPING``.
    """

    return TOOL_TO_SLOT.get(tool_name)


__all__ = ["TOOL_TO_SLOT", "Slot", "slot_for"]
