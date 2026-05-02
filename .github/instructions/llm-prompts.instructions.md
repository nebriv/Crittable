---
applyTo: "backend/app/llm/**,backend/app/sessions/turn_validator.py,backend/app/sessions/turn_driver.py,backend/app/sessions/phase_policy.py,backend/app/sessions/slots.py"
---

# LLM prompt & tool review (brittle surface)

Findings here are **BLOCK** by default; require PR-body justification to downgrade. Read `docs/tool-design.md` and `docs/turn-lifecycle.md` first.

## Prompts (`prompts.py`, tool descriptions, recovery directives, kickoff messages)
- **Phantom tools** — backticked snake_case name in any model-facing string not in that tier's palette (`SETUP_TOOLS` / `PLAY_TOOLS` / `AAR_TOOL`). Model can't call it; confuses routing, wastes tokens. **BLOCK**.
- **Removal protocol**: drop from palette → add to `HISTORICAL_REMOVED_*` in `backend/tests/test_prompt_tool_consistency.py` → grep backticks → run consistency test. Any step missed → **BLOCK**.
- **Conflicts** across blocks (e.g. "must yield" vs "yield when ready"). Quote both lines.
- **Ambiguity** — vague modals ("should", "may"), missing stop conditions for tool loops, unclear success criteria
- **Token waste** — restatements across blocks, verbose preambles, instructions duplicated in system + tool description
- **Missing guardrails** — jailbreak resistance, refusal-style boundaries, plan-disclosure prevention (model must not leak future inject plan)
- **Roster scaling** — small/medium/large blocks adapt to actual roster, not a fixed N
- **Best practice** — XML tags, examples-then-task, explicit success criteria, negative examples for known failure modes
- **Voice boundary** — system prompts use descriptive language ("AI cybersecurity tabletop facilitator"), NOT brand voice. Do not flag prompts for sounding unbranded.

## Tools (`tools.py` and tier palettes)
- Flag tools violating the five trap patterns in `docs/tool-design.md`
- New/renamed tools: was `pytest backend/tests/test_prompt_tool_consistency.py` run? Was `pytest backend/tests/live/ -v` run against a real `ANTHROPIC_API_KEY`? Mandatory if diff touches `tools.py`, Block 6 of `prompts.py`, or any recovery directive. Absence → **BLOCK**.
- New tool in a tier without updating `phase_policy.POLICIES` and `ALLOWED_*_TOOL_NAMES` → **BLOCK** (filtered from API; model hallucinates)
- New input field appearing in prompt copy (e.g. `share_data`'s `label`) — added to `_NON_TOOL_ALLOWLIST` in the consistency test?
- Description tells the model *how* instead of *when*. Descriptions are dispatch hints, not docs.

## Phase policy & dispatch
- New LLM call site without `assert_state(tier, session.state)` at entry → **BLOCK**
- Dispatch silently dropping a forbidden call instead of returning `is_error=True` `tool_result` → **BLOCK** (model gets stuck retrying)
- Extension tool names not passed to `filter_allowed_tools` on play tier → extensions disappear from palette → **BLOCK**

## Model-output trust boundary (`backend/app/llm/export.py::_extract_report` is the reference)
- Identity values (`role_id`, `turn_id`, `session_id`, `message_id`) accepted from the model without validating against our state → **BLOCK**. Identity is ours; canonical IDs go in the prompt as a `## ... (canonical IDs)` block; unmatched echoed IDs are **dropped** (not repaired) with a `WARNING` log carrying `dropped_count`, `kept_count`, rejected ids.
- Shape coercion (string → `[string]`) added in a route or React component instead of the extractor → **BLOCK**. One sanitization point per call site.
- Numeric fields not clamped to documented range (AAR sub-scores 0–5, etc.) → **HIGH**
- Drops/coercions/clamps without WARNING logs sufficient to debug a prompt regression from the audit log → **HIGH**
- New LLM feature taking user/role/turn refs without passing canonical IDs into the prompt → **HIGH**

## Turn lifecycle
Diff touching `turn_validator.py`, `turn_driver.py`, `slots.py`, or `dispatch.py` → PR body must reference the corresponding `docs/turn-lifecycle.md` section. Missing → **HIGH**.
