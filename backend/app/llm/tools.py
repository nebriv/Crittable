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
        "description": "Address a single role directly (still visible to all roles).",
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
        "description": "Send a message visible to all roles.",
        "input_schema": {
            "type": "object",
            "properties": {"message": {"type": "string"}},
            "required": ["message"],
        },
    },
    {
        "name": "inject_event",
        "description": "Narrate a routine new development in the scenario.",
        "input_schema": {
            "type": "object",
            "properties": {"description": {"type": "string"}},
            "required": ["description"],
        },
    },
    {
        "name": "inject_critical_event",
        "description": (
            "Push a high-prominence breaking-news event into the transcript. "
            "Use sparingly (rate-limited)."
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
        "description": "Show the creator a draft scenario plan to review/edit.",
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "executive_summary": {"type": "string"},
                "key_objectives": {"type": "array", "items": {"type": "string"}},
                "narrative_arc": {"type": "array"},
                "injects": {"type": "array"},
                "guardrails": {"type": "array", "items": {"type": "string"}},
                "success_criteria": {"type": "array", "items": {"type": "string"}},
                "out_of_scope": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["title", "key_objectives"],
        },
    },
    {
        "name": "finalize_setup",
        "description": (
            "Commit the agreed scenario plan and lock it for the session. "
            "Transitions session to READY."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "executive_summary": {"type": "string"},
                "key_objectives": {"type": "array", "items": {"type": "string"}},
                "narrative_arc": {"type": "array"},
                "injects": {"type": "array"},
                "guardrails": {"type": "array", "items": {"type": "string"}},
                "success_criteria": {"type": "array", "items": {"type": "string"}},
                "out_of_scope": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["title", "key_objectives"],
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
