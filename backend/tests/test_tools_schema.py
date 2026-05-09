"""Schema-shape regression tests for the tool definitions.

The 2026-04-29 plan-generation outage was caused by a tool
``input_schema`` declaring ``narrative_arc`` and ``injects`` as bare
arrays without a per-item shape. Without the ``items`` schema Claude
improvised the shape and emitted XML-style strings that failed Pydantic
validation, locking the setup loop.

This test walks every tool we expose and asserts that every ``array``
field carries an ``items`` schema, recursively. A new array property
that lands without ``items`` will fail this test before it ever ships.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.llm.tools import AAR_TOOL, PLAY_TOOLS, SETUP_TOOLS


def _walk_arrays(node: Any, *, path: str) -> list[str]:
    """Return paths to ``array`` schemas missing an ``items`` definition."""

    missing: list[str] = []
    if not isinstance(node, dict):
        return missing
    node_type = node.get("type")
    if node_type == "array":
        items = node.get("items")
        if not isinstance(items, dict) or "type" not in items:
            missing.append(path)
        else:
            missing.extend(_walk_arrays(items, path=f"{path}.items"))
    if node_type == "object":
        props = node.get("properties") or {}
        for prop_name, prop_schema in props.items():
            missing.extend(_walk_arrays(prop_schema, path=f"{path}.{prop_name}"))
    return missing


def _all_tools() -> list[dict[str, Any]]:
    return [*SETUP_TOOLS, *PLAY_TOOLS, AAR_TOOL]


@pytest.mark.parametrize("tool", _all_tools(), ids=lambda t: t["name"])
def test_every_array_property_has_items_schema(tool: dict[str, Any]) -> None:
    """Anthropic accepts arrays without ``items`` but Claude then
    hallucinates the per-item shape, which fails Pydantic validation
    on the dispatcher side. Every array must declare its element
    type so the model's output is constrained.
    """

    schema = tool.get("input_schema", {})
    missing = _walk_arrays(schema, path=tool["name"])
    assert not missing, (
        f"tool {tool['name']!r} has array fields without ``items``: {missing}. "
        "Add an explicit ``items`` schema (object with required keys for "
        "structured arrays, or {'type': 'string'} / etc. for primitive arrays). "
        "See backend/app/llm/tools.py:_NARRATIVE_BEAT_SCHEMA for an example."
    )


def test_propose_scenario_plan_nested_shapes_match_pydantic() -> None:
    """``narrative_arc`` and ``injects`` items must mirror the
    ``ScenarioBeat`` and ``ScenarioInject`` Pydantic models. Drift
    between the tool schema and the Pydantic invariants is what
    produced the original validation-loop bug.
    """

    propose = next(t for t in SETUP_TOOLS if t["name"] == "propose_scenario_plan")
    finalize = next(t for t in SETUP_TOOLS if t["name"] == "finalize_setup")
    for tool in (propose, finalize):
        props = tool["input_schema"]["properties"]
        beat_items = props["narrative_arc"]["items"]
        assert beat_items["type"] == "object"
        assert set(beat_items["required"]) >= {"beat", "label", "expected_actors"}
        assert beat_items["properties"]["beat"]["type"] == "integer"
        assert beat_items["properties"]["expected_actors"]["type"] == "array"
        assert beat_items["properties"]["expected_actors"]["items"]["type"] == "string"

        inject_items = props["injects"]["items"]
        assert inject_items["type"] == "object"
        assert set(inject_items["required"]) >= {"trigger", "type", "summary"}


def test_setup_tool_descriptions_promise_match_schema_required() -> None:
    """Class-level: every field a setup-tool description names as
    'shown to every participant' / 'visible' / 'displayed' must be in
    the schema's ``required`` array. Drift between the description's
    promise and the schema is what produced the May 2026 bug-scrub H4:
    ``executive_summary`` was named in both tool descriptions as
    "shown to every participant on the join page", but neither schema
    listed it in ``required`` — a model that dropped the field still
    validated, producing a blank join-page summary.

    Mechanically: scan each setup tool's description for backticked
    snake_case names that occur within ~80 chars of one of the
    "participant-visible" phrases below. Every match must be in
    ``required``.
    """

    import re

    visible_phrases = (
        "shown to every participant",
        "shown on the join page",
        "shown on every join page",
        "displayed",
        "visible",
        "every join page",
        "join page",
    )

    setup_tools = [t for t in SETUP_TOOLS if t["name"] in {
        "propose_scenario_plan",
        "finalize_setup",
    }]
    assert setup_tools, "expected the two setup-plan tools to be present"

    for tool in setup_tools:
        desc = tool["description"]
        required = set(tool["input_schema"]["required"])
        properties = set(tool["input_schema"]["properties"].keys())

        promised: set[str] = set()
        # Find every "join page" / "shown to participant" mention; for
        # each, take a window around it and harvest backticked
        # snake_case names that map to a real top-level property.
        for phrase in visible_phrases:
            for m in re.finditer(re.escape(phrase), desc):
                window_start = max(0, m.start() - 80)
                window_end = min(len(desc), m.end() + 80)
                window = desc[window_start:window_end]
                for name in re.findall(r"`([a-z][a-z0-9_]*)`", window):
                    if name in properties:
                        promised.add(name)

        missing = promised - required
        assert not missing, (
            f"{tool['name']}: description names these fields as "
            f"participant-visible but schema doesn't require them: "
            f"{sorted(missing)}. Either add to ``required`` or remove "
            f"the participant-visible language from the description."
        )

        # Belt-and-braces sanity: ``executive_summary`` and ``title``
        # are the canonical join-page fields. If a refactor reworded
        # the description so neither phrase matched, we'd silently
        # stop guarding the contract. Pin the historic anchor.
        assert "executive_summary" in required, (
            f"{tool['name']}: executive_summary must be required (it's "
            f"shown on every participant's join page)."
        )
        assert "title" in required, (
            f"{tool['name']}: title must be required (it's the join-page heading)."
        )
