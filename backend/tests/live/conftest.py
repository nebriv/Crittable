"""Shared fixtures + skip-rule for the live-API tool-routing suite.

These tests hit the real Anthropic API once each. Cost: roughly $0.01 per
test (~5K input + ~500 output tokens each). They are SKIPPED unless
``ANTHROPIC_API_KEY`` is set in the environment, so normal CI / dev
loops never accidentally spend money.

Run them explicitly:

    cd backend && ANTHROPIC_API_KEY=sk-ant-... pytest tests/live/ -v

Or as part of a release gate:

    pytest tests/live/ -v -m live

The suite is the authoritative regression net for tool-routing
behavior — every new tool, prompt edit, or recovery directive should
add a case here.
"""

from __future__ import annotations

import os
from typing import Any

import pytest

from app.config import get_settings
from app.extensions.models import ExtensionBundle
from app.extensions.registry import freeze_bundle
from app.llm.prompts import build_play_system_blocks
from app.llm.tools import PLAY_TOOLS
from app.sessions.models import (
    Message,
    MessageKind,
    Role,
    ScenarioBeat,
    ScenarioInject,
    ScenarioPlan,
    Session,
    SessionState,
)
from app.sessions.turn_driver import _play_messages


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """Auto-skip the entire `tests/live/` directory unless the API key is set."""

    if os.environ.get("ANTHROPIC_API_KEY"):
        return
    skip_marker = pytest.mark.skip(
        reason="live-API tests require ANTHROPIC_API_KEY (cost ~$0.01/test)"
    )
    for item in items:
        if "tests/live" in str(item.fspath):
            item.add_marker(skip_marker)


@pytest.fixture
def empty_registry() -> Any:
    """Frozen registry with no extensions — every live test uses the same."""

    return freeze_bundle(ExtensionBundle())


@pytest.fixture
def anthropic_client() -> Any:
    """Async Anthropic client wired to the configured base URL."""

    from anthropic import AsyncAnthropic

    settings = get_settings()
    return AsyncAnthropic(
        api_key=os.environ["ANTHROPIC_API_KEY"],
        base_url=settings.anthropic_base_url,
    )


@pytest.fixture
def play_model() -> str:
    """The play-tier model identifier (matches production)."""

    return get_settings().model_for("play")


# ---------------------------------------------------------------- session shapes


def _ransomware_session(
    *,
    state: SessionState = SessionState.AI_PROCESSING,
    extra_messages: list[Message] | None = None,
) -> Session:
    """Standard 2-role ransomware scenario shared by most cases."""

    creator = Role(id="role-ciso", label="CISO", display_name="Dev Tester", is_creator=True)
    soc = Role(id="role-soc", label="SOC Analyst", display_name="Dev Bot")
    plan = ScenarioPlan(
        title="Ransomware via vendor portal",
        executive_summary="03:14 Wednesday. Ransomware on finance laptops.",
        key_objectives=["Confirm scope", "Contain", "Decide notification"],
        narrative_arc=[
            ScenarioBeat(beat=1, label="Detection & triage", expected_actors=["SOC", "IR Lead"]),
            ScenarioBeat(beat=2, label="Containment", expected_actors=["IR Lead", "Engineering"]),
        ],
        injects=[
            ScenarioInject(
                trigger="after beat 2",
                type="critical",
                summary="Slack screenshot leaked.",
            )
        ],
        guardrails=["stay in scope"],
        success_criteria=["containment before beat 3"],
        out_of_scope=["real exploit code"],
    )
    s = Session(
        scenario_prompt="Ransomware via vendor portal",
        state=state,
        roles=[creator, soc],
        creator_role_id=creator.id,
        plan=plan,
    )
    if extra_messages:
        s.messages.extend(extra_messages)
    return s


@pytest.fixture
def session_with_player_data_question() -> Session:
    """Player asks a direct question whose answer IS data (logs/IOCs)."""

    msgs = [
        Message(
            kind=MessageKind.AI_TEXT,
            tool_name="broadcast",
            body=(
                "**SOC Analyst** — what does the alert queue look like? "
                "**CISO** — first containment instinct: isolate or monitor?"
            ),
        ),
        Message(
            kind=MessageKind.PLAYER,
            role_id="role-ciso",
            body="We isolate immediately via defender.",
        ),
        Message(
            kind=MessageKind.PLAYER,
            role_id="role-soc",
            body=(
                "Yeah we can pull account activity via Defender. What do we see?"
            ),
        ),
    ]
    return _ransomware_session(extra_messages=msgs)


@pytest.fixture
def session_with_tactical_decision() -> Session:
    """Player has made a clean non-data decision; AI should react via
    `broadcast` and brief the next beat. Critically the player message
    should NOT contain phrases that look like data asks (the model
    will route to `share_data` if it sees ``logs``, ``IOCs``, etc. —
    that's a separate test case)."""

    msgs = [
        Message(
            kind=MessageKind.AI_TEXT,
            tool_name="broadcast",
            body="**CISO** — isolate or monitor first?",
        ),
        Message(
            kind=MessageKind.PLAYER,
            role_id="role-ciso",
            body=(
                "Isolate immediately via Defender. I'm pulling in IR Lead "
                "and the regulator-notification clock starts now."
            ),
        ),
        Message(
            kind=MessageKind.PLAYER,
            role_id="role-soc",
            body="Acknowledged — disabling the vendor account next.",
        ),
    ]
    return _ransomware_session(extra_messages=msgs)


@pytest.fixture
def briefing_session() -> Session:
    """First play turn — no prior messages. Briefing contract."""

    return _ransomware_session(state=SessionState.BRIEFING)


@pytest.fixture
def session_with_doctrine_fork() -> Session:
    """A discrete tactical fork — perfect for `pose_choice`. The AI's
    last broadcast set up a 2-3 way split; the player asks for the
    options, model should respond with `pose_choice`."""

    msgs = [
        Message(
            kind=MessageKind.AI_TEXT,
            tool_name="broadcast",
            body=(
                "**CISO** — three doctrine forks here. Containment "
                "playbook says we either isolate now (NIST 6.1), "
                "monitor 15 min for full scope mapping, or escalate "
                "to legal first to get the regulator-clock advice "
                "before touching anything."
            ),
        ),
        Message(
            kind=MessageKind.PLAYER,
            role_id="role-ciso",
            body=(
                "Lay out the choice clearly with the concrete "
                "options — I want to pick one explicitly."
            ),
        ),
    ]
    return _ransomware_session(extra_messages=msgs)


# ---------------------------------------------------------------- helpers


async def call_play(
    client: Any,
    *,
    model: str,
    session: Session,
    registry: Any,
    tools: list[dict[str, Any]] | None = None,
    tool_choice: dict[str, Any] | None = None,
) -> Any:
    """Call the live API with the production message-build path."""

    system_blocks = build_play_system_blocks(session, registry=registry)
    messages = _play_messages(session, strict=False)
    kwargs: dict[str, Any] = {
        "model": model,
        "max_tokens": 2048,
        "system": system_blocks,
        "messages": messages,
        "tools": tools if tools is not None else PLAY_TOOLS,
    }
    if tool_choice is not None:
        kwargs["tool_choice"] = tool_choice
    return await client.messages.create(**kwargs)


def tool_uses(resp: Any) -> list[Any]:
    return [b for b in getattr(resp, "content", []) if getattr(b, "type", None) == "tool_use"]


def text_content(resp: Any) -> str:
    return "".join(
        getattr(b, "text", "")
        for b in getattr(resp, "content", [])
        if getattr(b, "type", None) == "text"
    )


def tool_names(resp: Any) -> list[str]:
    return [u.name for u in tool_uses(resp)]
