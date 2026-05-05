"""Shared fixtures + skip-rule for the live-API tool-routing suite.

These tests hit the real Anthropic API once each. Cost: roughly $0.01 per
test (~5K input + ~500 output tokens each). They are SKIPPED unless a
real ``ANTHROPIC_API_KEY`` resolves at collection time.

The parent ``backend/tests/conftest.py`` injects a dummy
``ANTHROPIC_API_KEY=dummy-key-for-tests`` so unit tests can boot
``Settings`` without a real key.  For live tests that placeholder is
exactly wrong — the SDK would happily forward it to Anthropic and
produce a confusing 401 ``invalid x-api-key`` instead of a clean
"key not set" skip.  The collection hook below pops the dummy, loads
the project-root ``.env`` so a contributor's real key reaches the
fixture, then checks whether what's left is a real key.  If yes,
live tests run with the real key; if no, the dummy is restored so
later unit tests still boot.

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
from tests.conftest import DUMMY_ANTHROPIC_API_KEY
from tests.live.cost_cap import (
    _wrap_messages_create,
    get_tracker,
)


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
    """Auto-skip the entire ``tests/live/`` directory unless a real
    ``ANTHROPIC_API_KEY`` is set.

    Three things this hook has to do correctly to avoid the
    confusing-401 trap (see module docstring):

    1. Pop the parent-conftest dummy key (``dummy-key-for-tests``) so
       the .env loader below has a chance to install the real value.
       Without this the dummy "wins" because the loader uses
       ``setdefault``-style semantics.
    2. Load project-root ``.env`` so a contributor's key actually
       reaches the fixture (Settings has ``env_file=None`` and won't
       do it itself).
    3. Reset the ``Settings`` cache so the check below sees whatever
       ended up in ``os.environ``.

    The path check uses ``pathlib.Path.parts`` rather than substring
    matching — substring matching with ``"tests/live"`` silently
    fails on Windows where paths use ``\\`` separators, which is how
    this trap shipped in the first place.
    """

    saved_dummy_key = (
        os.environ.pop("ANTHROPIC_API_KEY", None)
        if os.environ.get("ANTHROPIC_API_KEY") == DUMMY_ANTHROPIC_API_KEY
        else None
    )
    _load_project_root_dotenv()
    reset_settings_cache()
    _live_will_run = False
    try:
        settings = get_settings()
        real_key = (
            settings.anthropic_api_key.get_secret_value()
            if settings.anthropic_api_key is not None
            else None
        )
        if real_key is not None and real_key != DUMMY_ANTHROPIC_API_KEY:
            _live_will_run = True
        else:
            reason = (
                "live-API tests require a real ANTHROPIC_API_KEY (env "
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
        # Restore the unit-test dummy key unless live tests are
        # actually about to run (in which case the real key must
        # stay set so the SDK path isn't poisoned). Without the
        # restore, the unit-test suite would break because
        # ``Settings`` would demand a real API key it doesn't have.
        if not _live_will_run and saved_dummy_key is not None:
            os.environ["ANTHROPIC_API_KEY"] = saved_dummy_key
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

    Hard-asserts the resolved key is not the parent-conftest dummy
    as belt-and-braces against the auto-skip's path check missing an
    item: the SDK would happily pass the dummy to Anthropic for a
    silent 401 — the failure mode that originally inspired this
    defence.
    """

    from anthropic import AsyncAnthropic

    settings = get_settings()
    key = settings.require_anthropic_key()
    assert key != DUMMY_ANTHROPIC_API_KEY, (
        "anthropic_client fixture must not run with the test-conftest "
        "dummy key; the auto-skip in pytest_collection_modifyitems "
        "should have skipped this test. If you see this assertion, "
        "the path-matching in the auto-skip likely failed for this item."
    )
    client = AsyncAnthropic(
        api_key=key,
        base_url=settings.anthropic_base_url,
    )
    # The session-scoped __init__ patch in ``_live_cost_cap`` already
    # wraps every AsyncAnthropic; this is belt-and-braces for the
    # case where this fixture is called before the autouse fixture
    # has executed (parametrize ordering is not formally guaranteed
    # to put session-scope before function-scope on the first item).
    _wrap_messages_create(client)
    return client


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
    workstreams_enabled: bool = False,
) -> Any:
    """Call the live API with the production message-build path.

    ``workstreams_enabled`` defaults to ``False`` to preserve the
    existing live-test behaviour. Pass ``True`` explicitly when a
    test needs production-parity prompts (production
    ``Settings.workstreams_enabled`` defaults to ``True``); an audit
    of every existing call site is tracked separately so this default
    can be flipped without surprising regressions in tests not
    designed for the workstream-aware prompt."""

    system_blocks = build_play_system_blocks(
        session, registry=registry, workstreams_enabled=workstreams_enabled
    )
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


# ---------------------------------------------------------------- cost cap


@pytest.fixture(autouse=True, scope="session")
def _live_cost_cap() -> Any:
    """Patch ``AsyncAnthropic.__init__`` so every client built during
    the live session is wrapped with the cost-tracking ``messages.create``.

    Catches three categories of caller:
      1. The ``anthropic_client`` fixture above.
      2. The per-test ``judge_client`` fixture in
         ``test_aar_quality_judge.py``.
      3. ``LLMClient`` in ``app/llm/client.py`` (used by the
         ``AARGenerator`` and the setup driver), which constructs
         ``AsyncAnthropic`` lazily on first call.

    Lifetime: this is a session-scoped autouse fixture, so once any
    live test triggers it the patch stays active for the *entire*
    pytest session and is only reverted at session teardown. Unit
    tests that run BEFORE the live suite in the same invocation see
    an unwrapped class; unit tests that run AFTER the live suite has
    activated the fixture (and before the session ends) would see
    the patched ``__init__``. In practice this only matters in a
    single ``pytest`` invocation that mixes ``tests/`` and
    ``tests/live/`` — CI runs them in separate jobs, and the wrapper
    is benign for non-live AsyncAnthropic instances anyway (it just
    counts usage that no test asserts on).
    """

    try:
        from anthropic import AsyncAnthropic
    except ImportError:
        # Live tests will skip via the auto-skip hook anyway; nothing
        # to wrap.
        yield None
        return

    original_init = AsyncAnthropic.__init__

    def init_wrapper(self: Any, *args: Any, **kwargs: Any) -> None:
        original_init(self, *args, **kwargs)
        _wrap_messages_create(self)

    # Test-only monkeypatch of the SDK's __init__ so every
    # AsyncAnthropic constructed during the live session gets the
    # cost-cap wrapper. mypy flags re-assigning a method on a class
    # (method-assign); intentional here.
    AsyncAnthropic.__init__ = init_wrapper  # type: ignore[method-assign]
    try:
        yield get_tracker()
    finally:
        # Restore the original at session end so a later non-live
        # test invocation in the same shell sees an unwrapped class.
        AsyncAnthropic.__init__ = original_init  # type: ignore[method-assign]


def pytest_runtest_teardown(item: pytest.Item, nextitem: pytest.Item | None) -> None:
    """Halt the suite cleanly when the cost cap fires.

    The ``_CostTracker.record`` path doesn't call ``pytest.exit``
    directly because that would raise inside an in-flight ``await``,
    leaving the HTTP request orphaned. Instead, the tracker just
    flips ``abort_message``; this hook checks the flag at the next
    test-teardown boundary and asks pytest to stop. The current test
    finishes; subsequent tests are skipped.
    """

    tracker = get_tracker()
    if tracker.abort_message is None:
        return
    session = getattr(item, "session", None)
    if session is None:
        return
    # Don't clobber a prior shouldstop reason — if some other plugin
    # / fixture already asked pytest to halt, that diagnosis is more
    # useful than ours. ``shouldstop`` is a documented pytest hook
    # attribute; setting it to a truthy string halts the run at the
    # next safe point.
    if not getattr(session, "shouldstop", None):
        session.shouldstop = tracker.abort_message


def pytest_terminal_summary(
    terminalreporter: Any, exitstatus: int, config: pytest.Config
) -> None:
    """Always print the cumulative live-test cost so a contributor
    can see "I just spent $X" on every run, not only when the cap
    fires. Quiet when no live calls were recorded (unit-only run).
    """

    tracker = get_tracker()
    if tracker.calls == 0:
        return
    cap_label = (
        f"cap ${tracker.cap_usd:.2f}"
        if tracker.cap_enabled
        else "cap disabled"
    )
    line = (
        f"live-API spend: ${tracker.cumulative_usd:.4f} across "
        f"{tracker.calls} call(s) ({cap_label})"
    )
    terminalreporter.write_sep("=", line)
    if tracker.abort_message is not None:
        terminalreporter.write_line(tracker.abort_message)
