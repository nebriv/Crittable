"""Shared fixtures + skip-rule for the live-API tool-routing suite.

These tests hit the real Anthropic API once each. Cost: roughly $0.01 per
test (~5K input + ~500 output tokens each). They are SKIPPED unless
``Settings.anthropic_api_key`` resolves AND ``TEST_MODE`` is not set.
The auto-skip uses the same key-resolution path the production code
uses (env var → Settings); for contributor convenience, we also load
the project-root ``.env`` into ``os.environ`` before the check, so a
contributor whose key lives in ``.env`` doesn't have to also export
it into their shell.

Run them explicitly:

    cd backend && ANTHROPIC_API_KEY=sk-ant-... pytest tests/live/ -v

Or with the project-root ``.env`` (auto-loaded by this conftest):

    cd backend && pytest tests/live/ -v   # if ANTHROPIC_API_KEY is in <repo>/.env

Or as part of a release gate:

    pytest tests/live/ -v -m live

The suite is the authoritative regression net for tool-routing
behavior — every new tool, prompt edit, or recovery directive should
add a case here.

**Do NOT read ``os.environ["ANTHROPIC_API_KEY"]`` directly in this
suite.** Use ``get_settings().require_anthropic_key()`` instead so the
test uses the same key-resolution path the production code uses (env
var → ``.env`` → fail).  ``test_live_fixtures.py`` source-greps every
file under ``tests/live/`` and fails the suite if the bad pattern
re-appears — see the test for the rationale.

**Why this conftest fights with ``TEST_MODE``:** the parent
``backend/tests/conftest.py`` force-sets ``TEST_MODE=true`` on every
test run so unit tests can bypass the API key requirement.  For live
tests that's exactly wrong — ``require_anthropic_key()`` would fall
back to the literal string ``"test-mode-no-key"`` and the SDK would
silently pass it through to Anthropic, producing a confusing 401
``invalid x-api-key`` instead of a clean ``"key not set"`` skip.  The
auto-skip below explicitly clears ``TEST_MODE`` before checking the
key, then resets the cached ``Settings`` so the check sees the live
state — not the placeholder fail-open.
"""

from __future__ import annotations

import os
import pathlib
from typing import Any

import pytest

from app.config import get_settings, reset_settings_cache
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
    SetupNote,
)
from app.sessions.turn_driver import _play_messages


def _load_project_root_dotenv() -> None:
    """Load ``KEY=VALUE`` lines from the project-root ``.env`` into
    ``os.environ`` so contributors with a ``.env`` don't have to also
    shell-export every variable.

    Tiny inline parser instead of pulling in ``python-dotenv`` —
    keeps the dev-dep surface small and avoids a hidden import.
    Idempotent: a key already present in ``os.environ`` is NOT
    overwritten, matching ``python-dotenv``'s ``override=False``
    default (so a shell-exported value still wins, useful for one-off
    runs against a non-default key).

    Used only by the live-test auto-skip to bridge ``Settings``'s
    ``env_file=None`` policy.  Production code reads strictly from
    ``os.environ`` — this conftest is contributor tooling, not part
    of the runtime contract.
    """

    here = pathlib.Path(__file__).resolve()
    # backend/tests/live/conftest.py → project root is 4 levels up.
    project_root = here.parent.parent.parent.parent
    env_path = project_root / ".env"
    if not env_path.exists():
        return
    try:
        for raw in env_path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            # Strip matching surrounding quotes — accept either ``"…"``
            # or ``'…'`` but don't mangle a value that legitimately
            # has only one quote at one end.
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
                value = value[1:-1]
            if key and key not in os.environ:
                os.environ[key] = value
    except OSError:
        # File became unreadable mid-test (Windows file-lock race,
        # network drive blip). Skip silently — the auto-skip below
        # still gates correctly off whatever ended up in the env.
        return


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """Auto-skip the entire ``tests/live/`` directory unless the API
    key is set AND we're not in ``TEST_MODE``.

    Three things this hook has to do correctly to avoid the
    confusing-401 trap (see module docstring):

    1. Load project-root ``.env`` so a contributor's key actually
       reaches the fixture (Settings has ``env_file=None`` and won't
       do it itself).
    2. Clear ``TEST_MODE`` from the env BEFORE checking the key —
       the parent ``tests/conftest.py`` force-sets it for unit tests,
       but with it on, ``require_anthropic_key()`` returns the
       placeholder string and live tests silently produce 401s.
    3. Reset the ``Settings`` cache so the check above sees the
       state we just adjusted, not the cached placeholder-mode value.

    The path check uses ``pathlib.Path.parts`` rather than substring
    matching — substring matching with ``"tests/live"`` silently
    fails on Windows where paths use ``\\`` separators, which is how
    this trap shipped in the first place.
    """

    _load_project_root_dotenv()

    # Live tests need a fresh Settings view that ignores ``TEST_MODE``.
    # The parent ``tests/conftest.py`` force-sets ``TEST_MODE=true`` so
    # unit tests can bypass the API key requirement; with it on, the
    # ``require_anthropic_key()`` fallback returns the placeholder
    # string ``"test-mode-no-key"`` and the SDK happily sends it to
    # Anthropic for a silent 401.  We snapshot ``TEST_MODE``, clear
    # it, reset the cached ``Settings`` so the auto-skip's check sees
    # the real key state, and restore TEST_MODE in the ``finally`` so
    # the unit tests that follow this collection hook still see their
    # expected env state.  Without the restore, the entire unit-test
    # suite breaks because ``Settings`` now demands a real API key
    # they don't have.
    saved_test_mode = os.environ.get("TEST_MODE")
    os.environ.pop("TEST_MODE", None)
    reset_settings_cache()
    try:
        settings = get_settings()
        if settings.anthropic_api_key is not None and not settings.test_mode:
            # Real key + no test mode → live tests are runnable.  Note
            # that we DO leave ``TEST_MODE`` cleared in this branch
            # (no early return out of the try) so the live tests
            # themselves see ``test_mode=False`` — the assertion in
            # ``anthropic_client`` would otherwise refuse to fire.
            # The unit tests later in the run get ``TEST_MODE``
            # restored via the ``finally``.  Use a sentinel below to
            # distinguish "live tests will run, keep TEST_MODE off
            # for them" from "live tests are skipped, restore now".
            _live_will_run = True
        else:
            _live_will_run = False
            if settings.test_mode:
                reason = (
                    "live-API tests cannot run with TEST_MODE=true — "
                    "``require_anthropic_key()`` would return the "
                    "``test-mode-no-key`` placeholder and Anthropic "
                    "would reject every call with 401. Unset "
                    "TEST_MODE for live runs."
                )
            else:
                reason = (
                    "live-API tests require ANTHROPIC_API_KEY (env "
                    "var or project-root .env; cost ~$0.01/test)"
                )
            skip_marker = pytest.mark.skip(reason=reason)

            for item in items:
                parts = pathlib.Path(str(item.fspath)).parts
                # Cross-platform: match "tests" + "live" as path
                # segments rather than as a substring. Substring
                # matching with a forward slash silently fails on
                # Windows where path separators are backslashes.
                if "tests" in parts and "live" in parts:
                    item.add_marker(skip_marker)
    finally:
        # Restore the unit-test invariant unless live tests are
        # actually about to run (in which case TEST_MODE must stay
        # off so the API path isn't poisoned).  ``reset_settings_cache``
        # is called either way so the next ``get_settings()`` reads
        # the post-restoration env.
        if not _live_will_run and saved_test_mode is not None:
            os.environ["TEST_MODE"] = saved_test_mode
        reset_settings_cache()


@pytest.fixture
def empty_registry() -> Any:
    """Frozen registry with no extensions — every live test uses the same."""

    return freeze_bundle(ExtensionBundle())


@pytest.fixture
def anthropic_client() -> Any:
    """Async Anthropic client wired to the configured base URL.

    Reads the API key via ``Settings.require_anthropic_key()`` — the
    same resolution path the production ``LLMClient`` uses.  Reading
    ``os.environ["ANTHROPIC_API_KEY"]`` directly here would diverge:
    a contributor with the key in ``.env`` (which the auto-skip's
    dotenv loader handles into ``os.environ`` first) would otherwise
    see ``KeyError`` on the fixture even though the application boots
    cleanly.

    Hard-asserts ``not test_mode`` as belt-and-braces against the
    auto-skip's path check missing an item: ``require_anthropic_key()``
    would return the ``"test-mode-no-key"`` placeholder string in
    that case, which the SDK happily passes to Anthropic for a
    silent 401 — the failure mode that originally inspired this
    triple-defence.
    """

    from anthropic import AsyncAnthropic

    settings = get_settings()
    assert not settings.test_mode, (
        "anthropic_client fixture must not run with test_mode=True; "
        "the auto-skip in pytest_collection_modifyitems should have "
        "skipped this test. If you see this assertion, the path-"
        "matching in the auto-skip likely failed for this item."
    )
    return AsyncAnthropic(
        api_key=settings.require_anthropic_key(),
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
def aar_session() -> Session:
    """A short but complete tabletop transcript with two roles, three
    beats of dialogue and one critical inject. Used by both
    ``test_aar_generation`` (routing-level smoke) and
    ``test_aar_quality_judge`` (semantic-rubric judge)."""

    ciso = Role(id="role-ciso", label="CISO", display_name="Alex", is_creator=True)
    soc = Role(id="role-soc", label="SOC Analyst", display_name="Bo")
    plan = ScenarioPlan(
        title="Ransomware via vendor portal",
        executive_summary="03:14 Wednesday. Ransomware on finance laptops.",
        key_objectives=[
            "Confirm scope before containment",
            "Decide regulator-notification clock",
            "Stage Comms draft for legal review",
        ],
        narrative_arc=[
            ScenarioBeat(beat=1, label="Detection & triage", expected_actors=["SOC"]),
            ScenarioBeat(
                beat=2, label="Containment & comms", expected_actors=["CISO", "SOC"]
            ),
        ],
        injects=[
            ScenarioInject(
                trigger="after beat 1",
                type="critical",
                summary="Reporter calls about leaked Slack screenshot.",
            ),
        ],
        guardrails=["stay in scope", "no real exploit code"],
        success_criteria=["containment before beat 3", "regulator clock decided"],
        out_of_scope=["live exploitation", "specific CVE PoCs"],
    )
    s = Session(
        scenario_prompt="Ransomware via vendor portal",
        state=SessionState.ENDED,
        roles=[ciso, soc],
        creator_role_id=ciso.id,
        plan=plan,
    )
    s.setup_notes.append(
        SetupNote(speaker="creator", topic="scope", content="Finance org, 50 people."),
    )
    s.messages.extend(
        [
            Message(
                kind=MessageKind.AI_TEXT,
                tool_name="broadcast",
                body=(
                    "**Beat 1 — Detection.** Defender just lit up on three "
                    "finance laptops. **CISO** — first call: isolate or "
                    "monitor for scope?"
                ),
            ),
            Message(
                kind=MessageKind.PLAYER,
                role_id=ciso.id,
                body="Isolate now. Pull IR Lead in. Start the regulator clock.",
            ),
            Message(
                kind=MessageKind.AI_TEXT,
                tool_name="broadcast",
                body=(
                    "Acknowledged — isolation in progress. **SOC** — what "
                    "does the alert queue actually show?"
                ),
            ),
            Message(
                kind=MessageKind.PLAYER,
                role_id=soc.id,
                body=(
                    "Three FIN-* hosts with Defender alert + lateral SMB "
                    "attempts to FIN-08. Pulling Defender logs now."
                ),
            ),
            Message(
                kind=MessageKind.CRITICAL_INJECT,
                tool_name="inject_critical_event",
                body="Reporter calls about leaked Slack screenshot.",
            ),
            Message(
                kind=MessageKind.PLAYER,
                role_id=ciso.id,
                body=(
                    "No comment to press. Have Comms draft a holding "
                    "statement with Legal."
                ),
            ),
        ]
    )
    return s


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
