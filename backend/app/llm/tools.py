"""Built-in tool schemas exposed to Claude.

Three groups:
* play tools — facilitate a running session,
* setup tools — only valid in :data:`SessionState.SETUP`,
* AAR tools — only used by the export pipeline.

The dispatcher (`dispatch.py`) is state-aware and rejects tools that don't
match the current state.
"""

from __future__ import annotations

from typing import Any

PLAY_TOOLS: list[dict[str, Any]] = [
    {
        "name": "address_role",
        "description": (
            "Direct a message at a single role (still visible to all roles). "
            "Does NOT yield the turn — pair with `set_active_roles` to "
            "actually hand over."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "role_id": {"type": "string"},
                "message": {"type": "string"},
            },
            "required": ["role_id", "message"],
        },
    },
    {
        "name": "broadcast",
        "description": (
            "Send a message visible to all roles. Does NOT yield the turn "
            "— pair with `set_active_roles`."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"message": {"type": "string"}},
            "required": ["message"],
        },
    },
    {
        "name": "inject_event",
        "description": (
            "Narrate a *routine* development that doesn't deserve a banner. "
            "Renders as a SYSTEM-kind chat note — quieter than `broadcast`. "
            "Use for status confirmations, time advances, technical "
            "details. Does NOT yield."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"description": {"type": "string"}},
            "required": ["description"],
        },
    },
    {
        "name": "inject_critical_event",
        "description": (
            "Headline-grade escalation: data exfil confirmed, regulator "
            "inbound, public disclosure, attacker demand. Renders as a "
            "red banner above the chat that requires acknowledgement. "
            "MUST be followed in the SAME turn by a `broadcast` (or "
            "`address_role`) naming who acts on it, then a "
            "`set_active_roles` yielding to those roles. Routine "
            "developments use `inject_event`. Rate-limited (default 1 "
            "per 5 turns)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "severity": {"type": "string"},
                "headline": {"type": "string"},
                "body": {"type": "string"},
                "override_active_roles": {
                    "type": "array",
                    "items": {"type": "string"},
                },
            },
            "required": ["severity", "headline", "body"],
        },
    },
    {
        "name": "set_active_roles",
        "description": (
            "Yield the turn to one or more roles. Engine waits for all named "
            "submissions before advancing (or a force-advance from any "
            "participant)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "role_ids": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["role_ids"],
        },
    },
    {
        "name": "request_artifact",
        "description": (
            "Ask a role for a structured deliverable (IR plan, comms draft, "
            "regulator notification). The role responds in their next turn."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "role_id": {"type": "string"},
                "artifact_type": {"type": "string"},
                "instructions": {"type": "string"},
            },
            "required": ["role_id", "artifact_type", "instructions"],
        },
    },
    {
        "name": "use_extension_tool",
        "description": "Invoke any registered extension tool by name.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "args": {"type": "object"},
            },
            "required": ["name", "args"],
        },
    },
    {
        "name": "lookup_resource",
        "description": "Fetch the content of a registered extension resource.",
        "input_schema": {
            "type": "object",
            "properties": {"name": {"type": "string"}},
            "required": ["name"],
        },
    },
    {
        "name": "track_role_followup",
        "description": (
            "Open a per-role follow-up item — an unanswered question or a "
            "deferred ask you want to circle back to later. Keeps a running "
            "todo list per role so you can pick up the thread on a future "
            "turn instead of forgetting. Block 11 of your system prompt "
            "echoes the open list back to you every turn. Use ``prompt`` "
            "to phrase the ask in 1 short sentence (the players see this)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "role_id": {"type": "string"},
                "prompt": {"type": "string"},
            },
            "required": ["role_id", "prompt"],
        },
    },
    {
        "name": "resolve_role_followup",
        "description": (
            "Close a previously-tracked follow-up. ``status``: ``done`` if "
            "the role addressed it, ``dropped`` if the beat moved on and "
            "you no longer need it. Once resolved it stops showing in "
            "Block 11."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "followup_id": {"type": "string"},
                "status": {"type": "string", "enum": ["done", "dropped"]},
            },
            "required": ["followup_id", "status"],
        },
    },
    {
        "name": "mark_timeline_point",
        "description": (
            "Pin a key beat to the right-sidebar timeline. Use sparingly — "
            "only for moments players will want to scroll back to (a major "
            "decision, a turning point, an artifact ask, a critical "
            "consequence). The ``title`` is the short label shown in the "
            "timeline; the ``note`` is a one-line context blurb. Does NOT "
            "yield the turn — pair it with a ``broadcast`` / ``address_role`` "
            "and a final ``set_active_roles``."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "note": {"type": "string"},
            },
            "required": ["title"],
        },
    },
    {
        "name": "record_decision_rationale",
        "description": (
            "One-sentence creator-only debug note (≤300 chars). "
            "Format: `<plan-beat>: <one-clause why>`. NOT a place to "
            "think out loud — keep your reasoning in your own thoughts. "
            "NOT a player-facing message. Does NOT yield. Players never "
            "see this. Skip on strict-retry attempts (the prior turn's "
            "rationale still stands) and on INTERJECT MODE. Truncated "
            "at 600 chars."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "rationale": {"type": "string"},
            },
            "required": ["rationale"],
        },
    },
    {
        "name": "end_session",
        "description": "Terminate the exercise. Triggers the AAR generation pipeline.",
        "input_schema": {
            "type": "object",
            "properties": {
                "reason": {"type": "string"},
                "summary": {"type": "string"},
            },
            "required": ["reason"],
        },
    },
]


SETUP_TOOLS: list[dict[str, Any]] = [
    {
        "name": "ask_setup_question",
        "description": (
            "Ask the creator a structured question during scenario setup. "
            "Use ``options`` for quick-pick chips when appropriate."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "topic": {"type": "string"},
                "question": {"type": "string"},
                "options": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["topic", "question"],
        },
    },
    {
        "name": "propose_scenario_plan",
        "description": (
            "Show the creator a draft scenario plan to review/edit. "
            "narrative_arc, key_objectives, and injects are REQUIRED "
            "and must each contain at least one entry — empty plans "
            "are rejected because the play tier has no structure to "
            "facilitate against. Iterate via repeated calls until "
            "approved, then call finalize_setup."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "executive_summary": {"type": "string"},
                "key_objectives": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 1,
                },
                "narrative_arc": {"type": "array", "minItems": 1},
                "injects": {"type": "array", "minItems": 1},
                "guardrails": {"type": "array", "items": {"type": "string"}},
                "success_criteria": {"type": "array", "items": {"type": "string"}},
                "out_of_scope": {"type": "array", "items": {"type": "string"}},
            },
            "required": [
                "title",
                "key_objectives",
                "narrative_arc",
                "injects",
            ],
        },
    },
    {
        "name": "finalize_setup",
        "description": (
            "Commit the agreed scenario plan and lock it for the session. "
            "Transitions session to READY. Same array invariants as "
            "propose_scenario_plan: narrative_arc / key_objectives / "
            "injects MUST each contain at least one entry."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "executive_summary": {"type": "string"},
                "key_objectives": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 1,
                },
                "narrative_arc": {"type": "array", "minItems": 1},
                "injects": {"type": "array", "minItems": 1},
                "guardrails": {"type": "array", "items": {"type": "string"}},
                "success_criteria": {"type": "array", "items": {"type": "string"}},
                "out_of_scope": {"type": "array", "items": {"type": "string"}},
            },
            "required": [
                "title",
                "key_objectives",
                "narrative_arc",
                "injects",
            ],
        },
    },
]


AAR_TOOL: dict[str, Any] = {
    "name": "finalize_report",
    "description": (
        "Emit the structured after-action report. Exactly one call per AAR run."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "executive_summary": {"type": "string"},
            "narrative": {"type": "string"},
            "what_went_well": {"type": "array", "items": {"type": "string"}},
            "gaps": {"type": "array", "items": {"type": "string"}},
            "recommendations": {"type": "array", "items": {"type": "string"}},
            "per_role_scores": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "role_id": {"type": "string"},
                        "decision_quality": {"type": "integer"},
                        "communication": {"type": "integer"},
                        "speed": {"type": "integer"},
                        "rationale": {"type": "string"},
                    },
                    "required": [
                        "role_id",
                        "decision_quality",
                        "communication",
                        "speed",
                        "rationale",
                    ],
                },
            },
            "overall_score": {"type": "integer"},
            "overall_rationale": {"type": "string"},
        },
        "required": [
            "executive_summary",
            "narrative",
            "per_role_scores",
            "overall_score",
            "overall_rationale",
        ],
    },
}


def play_tools_with_extensions(extension_specs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Anthropic-API-shaped tool list = built-in play tools + extensions."""

    return list(PLAY_TOOLS) + list(extension_specs)


__all__ = ["AAR_TOOL", "PLAY_TOOLS", "SETUP_TOOLS", "play_tools_with_extensions"]
