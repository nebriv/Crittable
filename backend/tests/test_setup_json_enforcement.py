"""Tests for the setup-tier JSON-only enforcement.

Background: Haiku-class models occasionally fall back to the legacy
``<parameter name="X">…</parameter>`` / ``<item>…</item>`` /
``<![CDATA[]]>`` XML function-call format when emitting a tool input
that should be JSON. JSON is the only supported wire shape; instead
of reshaping the model's XML, we (a) give the model enough token
headroom to emit a full JSON plan in one shot, (b) instruct it
explicitly in the system prompt + tool descriptions to use JSON, and
(c) reject XML-shaped calls with a precise, instructive error so the
model self-corrects on the next turn.

These tests pin those three guarantees.
"""

from __future__ import annotations

import pytest

from app.llm.dispatch import (
    _DispatchError,
    _has_xml_marker,
    _reject_if_xml_emission,
    _walk_for_xml_markers,
)

# ------------------------ XML-detection helper ----------------------

@pytest.mark.parametrize(
    "value",
    [
        '<parameter name="key_objectives">x</parameter>',
        "<parameter\nname='x'>y</parameter>",
        "<![CDATA[ stuff ]]>",
        "<item>a</item><item>b</item>",
        "<invoke>...</invoke>",
        "prose with </parameter> closing tag in it",
    ],
)
def test_has_xml_marker_detects_legacy_formats(value: str) -> None:
    assert _has_xml_marker(value) is True


@pytest.mark.parametrize(
    "value",
    [
        "Triage SOC alerts then escalate",
        ["a", "b", "c"],  # not a string, never matches
        42,
        None,
        '"key_objectives": ["a", "b"]',  # JSON-shaped string
        "<>",  # bare angle brackets
    ],
)
def test_has_xml_marker_passes_clean_values(value: object) -> None:
    assert _has_xml_marker(value) is False


# ------------------ rejection of XML-shaped tool inputs ------------

def test_reject_when_key_objectives_is_xml_string() -> None:
    args = {
        "title": "Plan",
        "key_objectives": (
            "<item>Triage SOC</item>"
            "<item>Decide containment</item>"
        ),
        "narrative_arc": [
            {"beat": 1, "label": "Detection", "expected_actors": ["CISO"]}
        ],
        "injects": [
            {"trigger": "after beat 1", "type": "event", "summary": "x"}
        ],
    }
    with pytest.raises(_DispatchError) as ei:
        _reject_if_xml_emission(args, tool_name="propose_scenario_plan")
    msg = str(ei.value)
    # The error message must (a) name the offending field, (b) state
    # the canonical format, (c) show a JSON example so the model can
    # self-correct on the next turn without guessing.
    assert "key_objectives" in msg
    assert "JSON" in msg
    assert '"narrative_arc"' in msg
    assert "<parameter" in msg  # explicit denylist


def test_reject_when_narrative_arc_is_xml_string() -> None:
    args = {
        "title": "Plan",
        "key_objectives": ["a", "b", "c"],
        "narrative_arc": '<parameter name="beat">1</parameter>',
        "injects": [
            {"trigger": "after beat 1", "type": "event", "summary": "x"}
        ],
    }
    with pytest.raises(_DispatchError, match="narrative_arc"):
        _reject_if_xml_emission(args, tool_name="propose_scenario_plan")


def test_reject_lists_all_offending_fields() -> None:
    args = {
        "title": "Plan",
        "key_objectives": "<item>a</item>",
        "narrative_arc": "<parameter name='beat'>1</parameter>",
        "injects": "<![CDATA[ stuff ]]>",
    }
    with pytest.raises(_DispatchError) as ei:
        _reject_if_xml_emission(args, tool_name="finalize_setup")
    msg = str(ei.value)
    assert "key_objectives" in msg
    assert "narrative_arc" in msg
    assert "injects" in msg


def test_clean_json_input_does_not_raise() -> None:
    args = {
        "title": "Plan",
        "executive_summary": "Tabletop on phishing-led ransomware.",
        "key_objectives": [
            "Triage SOC alerts",
            "Decide containment posture",
            "Brief board within 30 minutes",
        ],
        "narrative_arc": [
            {"beat": 1, "label": "Detection", "expected_actors": ["CISO"]},
            {"beat": 2, "label": "Containment", "expected_actors": ["IR Lead"]},
            {"beat": 3, "label": "Comms", "expected_actors": ["Comms"]},
        ],
        "injects": [
            {"trigger": "after beat 1", "type": "event", "summary": "Second host hit"}
        ],
        "guardrails": ["No real CVEs"],
    }
    _reject_if_xml_emission(args, tool_name="propose_scenario_plan")  # no raise


# ---------------- recursive (nested) XML detection -----------------

def test_reject_when_xml_nested_in_inject_summary() -> None:
    """Regression for Copilot review: pre-fix the detector only
    scanned top-level string values, so XML emitted inside
    ``injects[0].summary`` (or any other nested string leaf) slipped
    through and was accepted as a valid plan. The detector now walks
    the input recursively."""

    args = {
        "title": "Plan",
        "key_objectives": ["a", "b", "c"],
        "narrative_arc": [
            {"beat": 1, "label": "Detection", "expected_actors": ["CISO"]}
        ],
        "injects": [
            {
                "trigger": "after beat 1",
                "type": "event",
                "summary": "<![CDATA[ second host hit ]]>",
            }
        ],
    }
    with pytest.raises(_DispatchError) as ei:
        _reject_if_xml_emission(args, tool_name="propose_scenario_plan")
    msg = str(ei.value)
    # Path must name the exact offending leaf, not just the top-level
    # field, so the model can fix the right place on retry.
    assert "injects[0].summary" in msg


def test_reject_when_xml_nested_in_narrative_arc_label() -> None:
    args = {
        "title": "Plan",
        "key_objectives": ["a", "b", "c"],
        "narrative_arc": [
            {"beat": 1, "label": "Detection", "expected_actors": ["CISO"]},
            {
                "beat": 2,
                "label": "<parameter name='label'>Containment</parameter>",
                "expected_actors": ["IR Lead"],
            },
        ],
        "injects": [
            {"trigger": "after beat 1", "type": "event", "summary": "x"}
        ],
    }
    with pytest.raises(_DispatchError) as ei:
        _reject_if_xml_emission(args, tool_name="propose_scenario_plan")
    assert "narrative_arc[1].label" in str(ei.value)


def test_walk_for_xml_markers_reports_all_paths() -> None:
    """When XML appears at multiple nested depths, every offending
    path must be reported so the model fixes them all in one
    re-emit."""

    args = {
        "title": "<item>x</item>",
        "key_objectives": ["clean", "<![CDATA[ dirty ]]>"],
        "narrative_arc": [
            {
                "beat": 1,
                "label": "Detection",
                "expected_actors": ["CISO", "<parameter name='r'>x</parameter>"],
            }
        ],
        "injects": [
            {"trigger": "ok", "type": "event", "summary": "</invoke>"}
        ],
    }
    paths = _walk_for_xml_markers(args)
    assert "title" in paths
    assert "key_objectives[1]" in paths
    assert "narrative_arc[0].expected_actors[1]" in paths
    assert "injects[0].summary" in paths
    assert len(paths) == 4


def test_walk_for_xml_markers_clean_input_is_empty() -> None:
    args = {
        "title": "Plan",
        "key_objectives": ["a", "b"],
        "narrative_arc": [
            {"beat": 1, "label": "Detection", "expected_actors": ["CISO"]}
        ],
        "injects": [
            {"trigger": "after beat 1", "type": "event", "summary": "x"}
        ],
    }
    assert _walk_for_xml_markers(args) == []


def test_string_value_with_innocent_angle_brackets_passes() -> None:
    """Free-form scenario text may legitimately contain angle brackets
    (e.g. ``"<200ms response time"``) without triggering the XML
    detector. Only the specific markup tokens count."""

    args = {
        "title": "Plan",
        "executive_summary": "Latency target: <200ms; out of scope: >5s tail.",
        "key_objectives": ["a", "b", "c"],
        "narrative_arc": [
            {"beat": 1, "label": "Detection", "expected_actors": ["CISO"]}
        ],
        "injects": [
            {"trigger": "after beat 1", "type": "event", "summary": "x"}
        ],
    }
    _reject_if_xml_emission(args, tool_name="propose_scenario_plan")  # no raise


# ------------------ token-budget + prompt guarantees ---------------

def test_default_setup_max_tokens_fits_a_full_json_plan() -> None:
    """Regression: a tight ``max_tokens`` budget caused Haiku to
    truncate JSON mid-output and switch to the more-compact legacy
    XML format. We bumped the default to 12288 so a full plan fits
    in one call. Pin the exact value so a regression that lowers it
    is caught."""

    from app.config import _MAX_TOKENS_DEFAULTS

    assert _MAX_TOKENS_DEFAULTS["setup"] == 12288


def test_setup_prompt_contains_json_example() -> None:
    """The setup system prompt must show a positive JSON example so
    the model can copy the shape verbatim. CLAUDE.md (prompt-expert
    review) flagged that pure-negative instruction is a priming
    risk; we anchor on a positive example."""

    from app.llm.prompts import _SETUP_SYSTEM

    assert "<format_rules>" in _SETUP_SYSTEM
    assert "<example>" in _SETUP_SYSTEM
    # The example must include the three structural arrays so the
    # model has a complete shape to mimic.
    assert '"key_objectives"' in _SETUP_SYSTEM
    assert '"narrative_arc"' in _SETUP_SYSTEM
    assert '"injects"' in _SETUP_SYSTEM
    # And it must explicitly call out that XML markup is rejected so
    # the model knows the dispatcher will return an error if it tries.
    assert "<parameter" in _SETUP_SYSTEM
    assert "is_error" in _SETUP_SYSTEM


def test_propose_scenario_plan_description_says_json() -> None:
    """The tool description carries the JSON convention alongside the
    schema so any caller (including a future operator browsing the
    tool list) sees it without reading the system prompt."""

    from app.llm.tools import SETUP_TOOLS

    propose = next(t for t in SETUP_TOOLS if t["name"] == "propose_scenario_plan")
    assert "JSON" in propose["description"]
    finalize = next(t for t in SETUP_TOOLS if t["name"] == "finalize_setup")
    assert "JSON" in finalize["description"]
