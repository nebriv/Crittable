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
