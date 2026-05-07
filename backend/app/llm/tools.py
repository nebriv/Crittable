"""Built-in tool schemas exposed to Claude.

Three groups:
* play tools — facilitate a running session,
* setup tools — only valid in :data:`SessionState.SETUP`,
* AAR tools — only used by the export pipeline.

The dispatcher (`dispatch.py`) is state-aware and rejects tools that don't
match the current state.

Tool-call format
----------------
Every tool here uses the modern Anthropic **JSON tool use** format —
the model emits a ``tool_use`` block whose ``input`` is a JSON object
matching the declared ``input_schema``. The legacy
``<parameter name="X">…</parameter>`` / ``<item>…</item>`` /
``<![CDATA[]]>`` XML function-call format is **not** accepted: the
dispatcher hard-rejects calls that contain those markers via
``dispatch._reject_if_xml_emission``, returning a precise instructive
error so the model self-corrects on the next turn. There is no XML
recovery path. New tools must follow the JSON convention. See
`docs/prompts.md` § "Tool-call format: JSON only" for the rationale
and the three-layer enforcement (token headroom, prompt instruction,
dispatcher rejection).
"""

from __future__ import annotations

from typing import Any

# Nested item schemas for the scenario-plan tool calls. Without these the
# model treats ``narrative_arc`` / ``injects`` as opaque arrays and
# improvises the per-item shape — observed failure mode is the model
# emitting ``<parameter name="beat">1`` / ``<item>...</item>`` XML soup
# as raw strings, which then fails Pydantic validation. Mirrors
# ``ScenarioBeat`` / ``ScenarioInject`` in ``sessions/models.py``.
_NARRATIVE_BEAT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "beat": {"type": "integer"},
        "label": {"type": "string"},
        "expected_actors": {
            "type": "array",
            "items": {"type": "string"},
        },
    },
    "required": ["beat", "label", "expected_actors"],
}

_SCENARIO_INJECT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "trigger": {"type": "string"},
        "type": {"type": "string", "enum": ["event", "critical"]},
        "summary": {"type": "string"},
    },
    "required": ["trigger", "type", "summary"],
}


# Phase B chat-declutter (docs/plans/chat-decluttering.md §3.1):
# shared optional ``workstream_id`` field used by every routing tool
# that can reasonably belong to one of the session's declared
# workstreams (``address_role`` / ``pose_choice`` / ``share_data`` /
# ``inject_critical_event``). Centralised so future schema tweaks
# (rewordings, additional constraints) only happen in one place — the
# Prompt Expert review specifically asked we don't let the four
# descriptions drift across tools.
#
# Strict enum on the *value* is intentionally NOT in the JSON schema:
# the dispatch-time validator (``_validate_workstream_id``) returns a
# structured ``tool_result is_error=True`` instead so the strict-retry
# loop can recover (per plan §4.5), rather than the schema-validation
# layer rejecting before the model gets a chance to self-correct.
_WORKSTREAM_ID_FIELD: dict[str, Any] = {
    "type": "string",
    "description": (
        "Optional. Workstream this beat belongs to. Must match an id "
        "from the session's declared workstreams (declared during "
        "setup). Omit (or pass empty string) for cross-cutting / "
        "general beats; the message renders under the default "
        "unscoped bucket. **If no workstreams were declared for this "
        "session, OMIT this field on every call — do not invent "
        "values.** UI-filter affordance only; not load-bearing for "
        "play correctness."
    ),
}

PLAY_TOOLS: list[dict[str, Any]] = [
    {
        "name": "address_role",
        "description": (
            "PLAYER-FACING MESSAGE FROM YOU directed at one role (visible to "
            "all). Renders as your AI bubble in the chat — this is YOUR "
            "VOICE speaking to the role. USE THIS WHEN: you want to brief, "
            "prompt, or push one specific role; you're redirecting one role "
            "without sidetracking the others; you're replying to a single "
            "player's ask (including a player who tagged you with "
            "`@facilitator`). Does NOT yield the turn — pair with "
            "`set_active_roles`. "
            "**Single-addressee rule:** if this is the only player-facing "
            "tool on the turn and you're not asking any other role anything, "
            "`set_active_roles` MUST be exactly `[that_role_id]`. Adding "
            "other roles makes the engine wait on people you didn't address."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "role_id": {"type": "string"},
                "message": {"type": "string"},
                "workstream_id": _WORKSTREAM_ID_FIELD,
            },
            "required": ["role_id", "message"],
        },
    },
    {
        "name": "broadcast",
        "description": (
            "PLAYER-FACING MESSAGE FROM YOU to all roles. Renders as your "
            "AI bubble in the chat — this is YOUR VOICE speaking to the "
            "team. USE THIS WHEN: narrating the next beat; briefing a "
            "decision the WHOLE team needs; reporting telemetry / logs / "
            "findings the team asked about; redirecting an off-topic "
            "message; reacting to a player's call (\"good — proceed with"
            "...\"). This is the DEFAULT player-facing tool when the "
            "audience is the whole roster. Does NOT yield the turn — "
            "pair with `set_active_roles`. "
            "**Audience matches yield.** If the body of your broadcast "
            "only asks ONE role a question (e.g. \"Ben — what's your "
            "call?\"), `set_active_roles` MUST be exactly that one "
            "role_id. If two roles are asked, exactly those two ids. "
            "Including roles you didn't actually ask anything of stalls "
            "the turn — the engine waits for replies that aren't coming. "
            "When you genuinely want a single-addressee turn, prefer "
            "`address_role` over `broadcast` to make the audience "
            "explicit."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"message": {"type": "string"}},
            "required": ["message"],
        },
    },
    # Note: ``inject_event`` was removed from the standard play palette
    # in the 2026-04-30 redesign for the same reason as
    # ``mark_timeline_point`` — the model was using it as a "do
    # something easy and stop" attractor, picking it to narrate
    # ambient state and never producing a player-facing reply. The
    # legitimate use cases (time advances, third-party actions) can
    # all be done via ``broadcast`` with a stylized markdown prefix
    # (``*[T+5min — Defender auto-isolated FIN-04]*``). This keeps
    # every AI message in one consistent rendering channel and
    # eliminates the silent-yield class of bug. The dispatcher handler
    # is retained as defensive dead code so that if an extension or
    # legacy mock script emits the tool, it still routes correctly.
    {
        "name": "pose_choice",
        "description": (
            "PLAYER-FACING MULTIPLE-CHOICE DECISION PROMPT — use when "
            "you want a role to pick from a SHORT (2–5 item) list of "
            "concrete options. Renders as your AI bubble in the chat, "
            "with the question in bold and each option labeled "
            "**A**, **B**, **C**, … on its own line. The role can "
            "respond with the letter, the option text, or a free-form "
            "answer (no clickable buttons yet — see issue #71). USE "
            "THIS WHEN: the decision is binary or small-cardinality "
            "and you want to make the trade-off explicit (e.g. "
            "\"isolate now / monitor 15 min / escalate to legal "
            "first\"); the team is dithering and structured options "
            "would unstick them; you're surfacing a known doctrine "
            "fork (e.g. NIST containment vs eradication-first). "
            "DO NOT use `pose_choice`: "
            "(a) for open-ended questions (\"what would you do?\") — "
            "that's `broadcast`; "
            "(b) when the role hasn't been briefed on the situation "
            "yet — pair `broadcast`/`share_data` first, then pose; "
            "(c) for more than 5 options — too many is decision "
            "paralysis; "
            "(d) as a substitute for a player-facing message after a "
            "data dump — pair with `set_active_roles` to actually "
            "yield. "
            "``role_id`` is the role being asked. ``question`` is one "
            "short sentence (≤140 chars) framing the decision. "
            "``options`` is a list of 2–5 short option strings (each "
            "≤120 chars). Does NOT yield — pair with "
            "`set_active_roles`."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "role_id": {"type": "string"},
                "question": {"type": "string"},
                "options": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 2,
                    "maxItems": 5,
                },
                "workstream_id": _WORKSTREAM_ID_FIELD,
            },
            "required": ["role_id", "question", "options"],
        },
    },
    {
        "name": "share_data",
        "description": (
            "PLAYER-FACING SYNTHETIC DATA DUMP — fire when a role has "
            "either (1) explicitly ASKED for data, or (2) explicitly "
            "COMMITTED to inspecting a specific data source. Either "
            "way the player has named a data surface they want to "
            "see, and your job is to surface it. Data shapes you may "
            "render: telemetry, logs, IOCs, alert lists, packet "
            "captures, threat-intel records, host inventories — any "
            "structured fictional data the team would screenshot or "
            "copy. Renders as your AI bubble with the data clearly "
            "labeled and monospace-friendly. "
            "PLAYER-SIDE TRIGGER PHRASES (must be in a recent player "
            "message): "
            "  Ask form — \"what do we see in <tool>?\", \"pull the "
            "<X> logs\", \"give me the indicators\", \"show me the "
            "alerts\", \"what does <SIEM/EDR/IDS> show?\". "
            "  Commit form — \"I'm pulling the Sentinel host page\", "
            "\"checking the auth log\", \"running the lateral-movement "
            "graph\", \"opening the EDR alert chain on FIN-08\". "
            "Both forms name a data source the player wants you to "
            "narrate; treat them identically — surface what the named "
            "source shows. These are PLAYER-SIDE triggers only — the "
            "AI must NEVER pose these phrasings as questions to "
            "players (Block 5b's telemetry-boundary rule). "
            "DO NOT use `share_data`: "
            "(a) when no role asked for data and no role named a data "
            "source they're inspecting — use `broadcast` to brief or "
            "react instead; "
            "(b) to volunteer telemetry on top of a player's tactical "
            "decision (\"isolate the host\", \"call the regulator\") — "
            "a tactical decision is NOT a commit to inspecting a data "
            "source; they didn't ask, don't dump it on them; "
            "(c) for prose narration with a few stats inline — that's "
            "`broadcast` with markdown; "
            "(d) for the situation brief at the top of a beat — that's "
            "`broadcast`. "
            "Provide ``data`` as well-formatted markdown (code fences "
            "for log lines, bullet lists for IOCs, tables for host "
            "inventories — whatever matches the data shape). ``label`` "
            "is a short header (e.g. \"Defender telemetry — 03:14 "
            "UTC\"). Does NOT yield — pair with `set_active_roles` "
            "(and optionally a `broadcast` / `address_role` framing "
            "the next decision)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "label": {"type": "string"},
                "data": {"type": "string"},
                "workstream_id": _WORKSTREAM_ID_FIELD,
            },
            "required": ["label", "data"],
        },
    },
    {
        "name": "inject_critical_event",
        "description": (
            "Headline-grade escalation: data exfil confirmed, regulator "
            "inbound, public disclosure, attacker demand. Renders as a "
            "red banner above the chat that requires acknowledgement. "
            "**Never a standalone turn.** MUST be followed in the SAME "
            "turn by a `broadcast` (or `address_role`) naming who acts "
            "on it, then a `set_active_roles` yielding to those roles. "
            "An inject-only response fails post-hoc validation and the "
            "engine retries the turn — players see the banner with no "
            "direction and the turn stalls. Use ONLY for headline-grade "
            "escalations — routine developments and background events "
            "stay inside a regular `broadcast` (stylize the urgency in "
            "prose if needed). NEVER use this to answer a player "
            "question — that's `broadcast` / `address_role`. **Beat-"
            "trigger interpretation.** Plan injects with triggers like "
            "`\"after beat 2\"` fire when ALL of beat 2 is COMPLETE — "
            "multiple turns of beat-2 work, not the first turn that "
            "starts beat-2 actions. A player committing to containment "
            "(\"isolate immediately\") is the START of containment, not "
            "the end. Wait at least one turn for the action to land "
            "and a follow-up exchange to confirm scope before firing "
            "the after-containment inject. Rate-limited (default 1 per "
            "5 turns)."
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
                "workstream_id": _WORKSTREAM_ID_FIELD,
            },
            "required": ["severity", "headline", "body"],
        },
    },
    {
        "name": "set_active_roles",
        "description": (
            "Yield the turn to one or more roles. Engine waits for all "
            "named submissions before advancing (or a force-advance from "
            "any participant). MUST be the LAST tool call of the turn "
            "and MUST be paired with a `broadcast` or `address_role` in "
            "the same response (the player-facing message that tells the "
            "named roles what to do). "
            "**Strict subset rule.** `role_ids` must contain ONLY the "
            "roles you actually asked something of in this same turn's "
            "player-facing message. If you used `address_role(Ben, …)` "
            "and asked nothing of the engineer, do NOT include the "
            "engineer here. If your `broadcast` body asks only Ben, do "
            "NOT include other roles. Every extra id in this list creates "
            "a wait gate on a reply the model never requested — the turn "
            "stalls until force-advanced. When in doubt, yield narrower."
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
            "regulator notification). The role responds in their next turn. "
            "This is the ASK; you still need to deliver the player-facing "
            "framing of the ask via `broadcast` or `address_role` in the "
            "same turn (and yield to that role via `set_active_roles`)."
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
    # Note: ``mark_timeline_point`` was removed from the standard play
    # palette in the 2026-04-30 redesign. The model treated it as a
    # cheap "do something quick and stop" attractor — picking it alone
    # leaves players with no chat message, the AI appears to ignore
    # them. The creator-only decision log (harvested from text content
    # blocks) covers the "pin the moment" need for retrospectives. If
    # we want a player-visible timeline pin in the future, it should
    # be a side-effect of a critical inject or an end-of-beat
    # broadcast, not a standalone tool.
    #
    # Note: ``end_session`` was removed in the 2026-05-02 cleanup
    # (issue #104). The AI was occasionally narrating "I'll end the
    # session here" without actually calling the tool, which gave
    # creators the false impression that the AI had wrapped up. Beyond
    # that signal-loss, ending an exercise is a creator-shaped
    # decision: it commits everyone to the AAR pipeline and there's no
    # undo. The creator surface (POST /api/sessions/{id}/end + the WS
    # ``request_end_session`` event) remains the only path. The
    # dispatcher / turn-driver still carry the ``end_session_reason``
    # plumbing as defensive dead code — if a future regression
    # re-adds the tool the engine still wires it correctly.
]


_DECLARE_WORKSTREAMS_TOOL: dict[str, Any] = {
    "name": "declare_workstreams",
    "description": (
        "Declare 0–5 parallel workstreams for this exercise. A workstream is a "
        "long-running concern (e.g. 'Containment', 'Disclosure', 'Comms') that "
        "groups related chat messages so participants can filter their view. "
        "Each workstream has a stable id (lowercase, snake_case), a 1–3 word "
        "label, and an optional lead role. Subsequent ``address_role`` calls "
        "may reference the workstream via a ``workstream_id`` field; messages "
        "without one render under the default '#main' bucket."
        "\n\n"
        "WHEN TO CALL THIS: only when you expect 3+ participants to work on "
        "2+ distinct concerns concurrently for a sustained portion of the "
        "exercise. Examples that warrant workstreams: ransomware with "
        "parallel containment / disclosure / comms tracks; multi-region "
        "outage with separate site teams; supply-chain breach with "
        "investigation + customer-comms + vendor-management running at "
        "once."
        "\n\n"
        "WHEN TO SKIP THIS: small or sequential scenarios where every actor "
        "is working the same concern at any given moment. Examples that "
        "don't need workstreams: phishing-triage with sequential "
        "investigate-then-remediate; a 2-person tabletop; an insider-threat "
        "investigation where HR + Legal + IT are collaborating on one "
        "thread. Skipping is harmless — the @Me filter, the Critical filter, "
        "and the hidden-mentions banner all still work without workstreams "
        "(they read from message metadata, not workstream membership). The "
        "user only loses the workstream pills, which would have been empty "
        "or single-valued and therefore useless anyway."
        "\n\n"
        "Call this once during setup, after ``propose_scenario_plan`` is "
        "finalized and before ``finalize_setup`` closes the setup tier. "
        "Hard cap: 8 total per session. When in doubt, skip — the UI is "
        "well-behaved either way."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "workstreams": {
                "type": "array",
                "minItems": 0,
                "maxItems": 8,
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {
                            "type": "string",
                            "pattern": "^[a-z][a-z0-9_]*$",
                            "maxLength": 32,
                        },
                        "label": {"type": "string", "maxLength": 24},
                        "lead_role_id": {"type": "string"},
                    },
                    "required": ["id", "label"],
                },
            },
        },
        "required": ["workstreams"],
    },
}


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
            "approved, then call finalize_setup. Emit ``input`` as a "
            "JSON object matching this input_schema; legacy XML "
            "function-call markup is not accepted. **`title` and "
            "`executive_summary` are shown to every participant on the "
            "join page — keep them spoiler-free (scenario type/stakes, "
            "not antagonist/root-cause/twist).**"
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
                "narrative_arc": {
                    "type": "array",
                    "items": _NARRATIVE_BEAT_SCHEMA,
                    "minItems": 1,
                },
                "injects": {
                    "type": "array",
                    "items": _SCENARIO_INJECT_SCHEMA,
                    "minItems": 1,
                },
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
            "injects MUST each contain at least one entry. Emit ``input`` "
            "as a JSON object matching this input_schema. **`title` and "
            "`executive_summary` are shown to every participant on the "
            "join page — keep them spoiler-free (scenario type/stakes, "
            "not antagonist/root-cause/twist).**"
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
                "narrative_arc": {
                    "type": "array",
                    "items": _NARRATIVE_BEAT_SCHEMA,
                    "minItems": 1,
                },
                "injects": {
                    "type": "array",
                    "items": _SCENARIO_INJECT_SCHEMA,
                    "minItems": 1,
                },
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
            # Issue #117 — moments the players flagged during the
            # exercise via the "Mark for AAR" highlight action (and
            # any others the model judges flag-worthy when reading
            # the transcript). Deliberately category-agnostic: a flag
            # might be a decision, a question, a follow-up, something
            # to debrief, a team-level concern, etc. The renderer
            # surfaces them as a single ``### Flagged for review``
            # section so operators have one scannable list of "things
            # the room said were worth coming back to" without having
            # to force each one into decision / gap / win shapes.
            "flagged_for_review": {"type": "array", "items": {"type": "string"}},
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


def setup_tools_for(*, workstreams_enabled: bool) -> list[dict[str, Any]]:
    """Setup-tier tool list, gated on the ``workstreams_enabled`` flag.

    docs/plans/chat-decluttering.md §6.8 — when the flag is False (the
    default in Phase A), ``declare_workstreams`` is invisible to the
    model. When True, it's appended to the standard setup palette so
    the AI can declare workstreams between ``propose_scenario_plan``
    and ``finalize_setup``. The phase-policy filter
    (``filter_allowed_tools``) reads names from ``SETUP_TOOLS``; the
    same flag-gated filter applies on the call site in
    ``turn_driver.run_setup_turn``.
    """

    if workstreams_enabled:
        return [*SETUP_TOOLS, _DECLARE_WORKSTREAMS_TOOL]
    return list(SETUP_TOOLS)


__all__ = [
    "AAR_TOOL",
    "PLAY_TOOLS",
    "SETUP_TOOLS",
    "play_tools_with_extensions",
    "setup_tools_for",
]
