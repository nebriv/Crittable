"""Developer testing tools — scenario record/replay for solo-dev workflow.

The pieces here address a workflow gap: a single dev cannot drive a multi-
participant exercise end-to-end by themselves. Existing god-mode helpers
(``proxy_submit_as`` / ``proxy_submit_pending``) let a creator type on
behalf of one role at a time, but driving a full ~15-turn exercise still
takes minutes of manual seat-juggling per test run.

A ``Scenario`` is a declarative JSON file describing:
  * session creation params (scenario_prompt, creator label/name)
  * the roster (one per role)
  * setup-phase replies (creator's side of the AI setup dialogue)
  * play-phase replies (per-turn, per-role player submissions)
  * optional ``mock_llm`` script — when provided the scenario plays
    against the deterministic ``MockAnthropic`` transport instead of
    burning real Anthropic tokens.

The ``ScenarioRunner`` drives a scenario through the live ``SessionManager``
+ HTTP/WS surface so the same code path runs in pytest, in a CLI, and in
the creator's God Mode panel — there's no "test-only" shortcut that could
hide a real-app regression.

The ``SessionRecorder`` walks the audit log + session state of a running
session and emits a Scenario JSON suitable for replay later. Recording is
the only way to capture a ``mock_llm`` script that exactly reproduces the
real Anthropic responses observed during a manual run.

Gating: ``DEV_TOOLS_ENABLED=true`` (or ``TEST_MODE=true``) is required
for the API surface; never wire these endpoints for unauthenticated
access on a deployed instance.
"""

from __future__ import annotations

from .recorder import SessionRecorder
from .runner import ScenarioRunner
from .scenario import (
    PlayStep,
    PlayTurn,
    RoleSpec,
    Scenario,
    ScenarioMeta,
    SetupReply,
    load_scenario_dir,
    load_scenario_file,
)

__all__ = [
    "PlayStep",
    "PlayTurn",
    "RoleSpec",
    "Scenario",
    "ScenarioMeta",
    "ScenarioRunner",
    "SessionRecorder",
    "SetupReply",
    "load_scenario_dir",
    "load_scenario_file",
]
