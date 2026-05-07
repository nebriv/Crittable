"""End-to-end test that ``run_play_turn`` actually fetches live presence
from the connection manager and passes it into Block 10.

The unit tests in ``test_prompt_presence.py`` lock the *renderer*'s
contract — given a presence set, the right column lands. This file
locks the *plumbing*: the turn driver must read presence from
``ConnectionManager.connected_role_ids`` / ``focused_role_ids`` at
call time. A regression where someone swapped ``self._manager.connections()``
for ``set()`` would still pass the unit tests but reproduce the
original bug ("AI is asking the empty seat").

Strategy: spin a real app stack, register a session through the public
HTTP surface, simulate a partial WebSocket connect by directly poking
``ConnectionManager.register`` (no real sockets needed for the
presence snapshot — just role rows on the manager), trigger the
play turn, and inspect the system blocks the mock LLM transport
captured.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import reset_settings_cache
from app.main import create_app
from tests.conftest import default_settings_body
from tests.mock_anthropic import MockAnthropic, setup_then_play_script


@pytest.fixture(autouse=True)
def _env(monkeypatch) -> None:
    monkeypatch.setenv("LLM_MODEL_PLAY", "mock-play")
    monkeypatch.setenv("LLM_MODEL_SETUP", "mock-setup")
    monkeypatch.setenv("LLM_MODEL_AAR", "mock-aar")
    monkeypatch.setenv("LLM_MODEL_GUARDRAIL", "mock-guardrail")
    monkeypatch.setenv("SESSION_SECRET", "x" * 32)
    monkeypatch.setenv("INPUT_GUARDRAIL_ENABLED", "false")
    reset_settings_cache()


@pytest.fixture
def client() -> TestClient:
    reset_settings_cache()
    app = create_app()
    with TestClient(app) as c:
        c.app.state.llm.set_transport(MockAnthropic({}).messages)
        yield c


def _seat_three(client: TestClient) -> dict[str, Any]:
    """Three seats so we can leave one definitively unjoined while the
    other two have at least one open WS connection."""

    resp = client.post(
        "/api/sessions",
        json={
            "scenario_prompt": "Ransomware via vendor portal",
            "creator_label": "CISO",
            "creator_display_name": "Ben",
            **default_settings_body(),
        },
    )
    created = resp.json()
    sid = created["session_id"]
    creator_token = created["creator_token"]
    creator_role_id = created["creator_role_id"]

    r1 = client.post(
        f"/api/sessions/{sid}/roles?token={creator_token}",
        json={"label": "SOC", "display_name": "Sam"},
    )
    soc = r1.json()
    r2 = client.post(
        f"/api/sessions/{sid}/roles?token={creator_token}",
        json={"label": "IC", "display_name": None},
    )
    ic = r2.json()

    return {
        "sid": sid,
        "creator_token": creator_token,
        "creator_role_id": creator_role_id,
        "soc_role_id": soc["role_id"],
        "ic_role_id": ic["role_id"],
    }


def _system_text(call: dict[str, Any]) -> str:
    """Concatenate the system blocks from a captured mock-LLM call."""

    blocks = call.get("system") or []
    return "\n".join(b.get("text", "") for b in blocks if isinstance(b, dict))


def _play_call(transport: Any) -> dict[str, Any] | None:
    """Find the first captured play-tier LLM call."""

    for call in transport.calls:
        model = (call.get("model") or "").lower()
        if "play" in model:
            return call
    return None


@pytest.mark.asyncio
async def test_play_turn_marks_unjoined_seat_in_block_10(client: TestClient) -> None:
    """The headline contract: when CISO + SOC are connected but IC has
    NOT opened the join link, the prompt the model sees lists CISO/SOC
    as ``joined_*`` and IC as ``not_joined``. A regression where the
    turn driver dropped the presence fetch (or hard-coded an empty
    set) would either:
      (a) flip every seat to ``not_joined`` (the model can't yield —
          turn wedges immediately), or
      (b) flip every seat to ``joined_focused`` (the original bug —
          model directs questions at IC even though nobody's there).
    Both regressions show up here as a missing or wrong row.
    """

    seats = _seat_three(client)
    role_ids = [seats["creator_role_id"], seats["soc_role_id"], seats["ic_role_id"]]
    scripts = setup_then_play_script(role_ids=role_ids, extension_tool="")
    transport = MockAnthropic(scripts).messages
    client.app.state.llm.set_transport(transport)

    # Plant CISO + SOC into the connection manager directly. We don't
    # need real WebSockets — the manager's ``connected_role_ids`` /
    # ``focused_role_ids`` snapshot reads off the in-memory connection
    # registry, which ``register()`` populates without needing a live
    # socket. IC stays unregistered → ``not_joined``.
    connections = client.app.state.connections
    await connections.register(
        session_id=seats["sid"],
        role_id=seats["creator_role_id"],
        is_creator=True,
        websocket=None,
    )
    await connections.register(
        session_id=seats["sid"],
        role_id=seats["soc_role_id"],
        is_creator=False,
        websocket=None,
    )

    # Skip setup + start play; this fires the briefing turn through
    # ``run_play_turn`` which is the path that reads presence.
    client.post(f"/api/sessions/{seats['sid']}/setup/skip?token={seats['creator_token']}")
    client.post(f"/api/sessions/{seats['sid']}/start?token={seats['creator_token']}")

    play_call = _play_call(transport)
    assert play_call is not None, "expected at least one play-tier LLM call"
    text = _system_text(play_call)

    # Block 10 must show the new column.
    assert "| role_id | label | display_name | kind | presence |" in text

    # The two registered seats land in the joined column. ``register()``
    # defaults ``focused=True`` (matches the WS handler's default —
    # ``focused`` is then refined by ``tab_focus`` events).
    ciso_line = next(
        line for line in text.splitlines() if f"`{seats['creator_role_id']}`" in line
    )
    assert "`joined_focused`" in ciso_line
    soc_line = next(
        line for line in text.splitlines() if f"`{seats['soc_role_id']}`" in line
    )
    assert "`joined_focused`" in soc_line

    # The unregistered seat is the headline assertion: prompt must say
    # the IC is NOT in the room. Without this the model happily
    # ``address_role``s the empty chair.
    ic_line = next(
        line for line in text.splitlines() if f"`{seats['ic_role_id']}`" in line
    )
    assert "`not_joined`" in ic_line

    # Live presence summary echoes the count — useful for the model's
    # "at-a-glance" check on small rosters.
    assert "2 of 3 seats currently joined" in text


class _PresenceCallCounter:
    """Wraps the live ConnectionManager and counts how many times the
    presence-snapshot methods are invoked. Used by the
    "snapshot ONCE per turn" invariant test below."""

    def __init__(self, real: Any) -> None:
        self._real = real
        self.connected_calls = 0
        self.focused_calls = 0

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)

    async def connected_role_ids(self, *args: Any, **kwargs: Any) -> Any:
        self.connected_calls += 1
        return await self._real.connected_role_ids(*args, **kwargs)

    async def focused_role_ids(self, *args: Any, **kwargs: Any) -> Any:
        self.focused_calls += 1
        return await self._real.focused_role_ids(*args, **kwargs)


@pytest.mark.asyncio
async def test_play_turn_snapshots_presence_exactly_once_per_turn(
    client: TestClient,
) -> None:
    """Lock the single-snapshot-per-turn invariant explicitly (QA review
    HIGH#2). The comment in ``turn_driver.run_play_turn`` says:

        "Snapshot live presence ONCE per turn so every attempt + recovery
         pass sees a stable seated-roster ``presence`` column. A flap
         mid-attempt would otherwise let the model see ``joined`` on
         attempt 1 and ``not_joined`` on attempt 2…"

    Without this lock, a future refactor that moved the snapshot inside
    the ``while attempt < budget`` loop would silently re-introduce the
    flap. The mock LLM transport responds with valid play-tier tools on
    the first attempt so we expect no recovery — but the assertion is
    "exactly once", not "at least once", so even a stray duplicate call
    fails.
    """

    seats = _seat_three(client)
    role_ids = [seats["creator_role_id"], seats["soc_role_id"], seats["ic_role_id"]]
    scripts = setup_then_play_script(role_ids=role_ids, extension_tool="")
    transport = MockAnthropic(scripts).messages
    client.app.state.llm.set_transport(transport)

    # Wrap the live connection manager AFTER skip_setup so the setup
    # path doesn't pollute the count. The wrapper passes through every
    # other method to the real manager so play-tier callers (LLM client,
    # WS routes) keep working.
    client.post(f"/api/sessions/{seats['sid']}/setup/skip?token={seats['creator_token']}")
    real = client.app.state.connections
    counter = _PresenceCallCounter(real)
    client.app.state.connections = counter
    client.app.state.manager._connections = counter
    client.app.state.llm.set_connections(counter)

    client.post(f"/api/sessions/{seats['sid']}/start?token={seats['creator_token']}")

    # Exactly one call per snapshot method, per turn. ``run_play_turn``
    # fires the briefing (turn 0); the mock script's first response
    # satisfies the validator so no recovery attempt fires.
    assert counter.connected_calls == 1, (
        f"connected_role_ids was called {counter.connected_calls} times "
        f"during one play turn; the snapshot-once invariant requires "
        f"exactly 1. Likely cause: someone moved the snapshot inside "
        f"the recovery loop in run_play_turn."
    )
    assert counter.focused_calls == 1, (
        f"focused_role_ids was called {counter.focused_calls} times "
        f"during one play turn; same invariant applies."
    )


@pytest.mark.asyncio
async def test_run_interject_marks_unjoined_seat_in_block_10(
    client: TestClient,
) -> None:
    """``run_interject`` is the second presence-aware call site (the
    @facilitator answer path). QA review HIGH#3: the existing
    ``test_briefing_and_play_share_same_block_10`` only proves the
    renderer works for both states; it doesn't prove ``run_interject``
    actually plumbs presence through. Lock that explicitly here.

    Strategy: drive a session into AWAITING_PLAYERS, then directly
    call ``TurnDriver.run_interject`` (mirrors the existing
    ``test_run_interject_emits_phase_interject`` pattern in
    ``test_turn_driver.py``). Inspect the captured LLM call's system
    blocks for the presence column.
    """

    from app.sessions.turn_driver import TurnDriver

    seats = _seat_three(client)
    role_ids = [seats["creator_role_id"], seats["soc_role_id"], seats["ic_role_id"]]
    scripts = setup_then_play_script(role_ids=role_ids, extension_tool="")
    transport = MockAnthropic(scripts).messages
    client.app.state.llm.set_transport(transport)

    # Plant CISO + SOC connections; IC stays unregistered.
    connections = client.app.state.connections
    await connections.register(
        session_id=seats["sid"],
        role_id=seats["creator_role_id"],
        is_creator=True,
        websocket=None,
    )
    await connections.register(
        session_id=seats["sid"],
        role_id=seats["soc_role_id"],
        is_creator=False,
        websocket=None,
    )

    client.post(f"/api/sessions/{seats['sid']}/setup/skip?token={seats['creator_token']}")
    client.post(f"/api/sessions/{seats['sid']}/start?token={seats['creator_token']}")

    snap = client.get(
        f"/api/sessions/{seats['sid']}?token={seats['creator_token']}"
    ).json()
    if snap["state"] != "AWAITING_PLAYERS":
        pytest.skip("scripted setup did not yield to players; cannot exercise interject")

    manager = client.app.state.manager
    session = await manager.get_session(seats["sid"])
    turn = session.current_turn
    assert turn is not None

    # Snapshot the call count BEFORE run_interject so we can pick the
    # interject's call out of the transport log even if the briefing
    # produced multiple calls.
    pre_calls = len(transport.calls)
    await TurnDriver(manager=manager).run_interject(
        session=session, turn=turn, for_role_id=seats["soc_role_id"]
    )
    new_calls = transport.calls[pre_calls:]
    assert new_calls, "run_interject should fire at least one LLM call"
    play_call = next(
        (c for c in new_calls if "play" in (c.get("model") or "").lower()),
        None,
    )
    assert play_call is not None, (
        "run_interject did not produce a play-tier LLM call; without "
        f"this we can't verify presence wiring. Calls: {new_calls}"
    )
    text = _system_text(play_call)

    # Same shape as the briefing test — IC must be marked not_joined.
    ic_line = next(
        line for line in text.splitlines() if f"`{seats['ic_role_id']}`" in line
    )
    assert "`not_joined`" in ic_line, (
        f"run_interject did not pass presence to Block 10; IC row: "
        f"{ic_line!r}"
    )


@pytest.mark.asyncio
async def test_play_turn_with_no_connected_seats_marks_all_not_joined(
    client: TestClient,
) -> None:
    """Edge case: solo creator triggers Start without any role having
    opened a tab yet (e.g. they're testing alone via proxy). The
    presence sets are empty, so EVERY seat is ``not_joined``. The
    model gets the truthful signal — it's the prompt's
    presence-aware-addressing block that tells it how to handle
    "everyone is missing." We don't fall back to ``joined_focused``
    here because the caller DID supply a snapshot (an empty one);
    the fallback only kicks in for ``None``.
    """

    seats = _seat_three(client)
    role_ids = [seats["creator_role_id"], seats["soc_role_id"], seats["ic_role_id"]]
    scripts = setup_then_play_script(role_ids=role_ids, extension_tool="")
    transport = MockAnthropic(scripts).messages
    client.app.state.llm.set_transport(transport)

    # Deliberately don't register any connection.
    client.post(f"/api/sessions/{seats['sid']}/setup/skip?token={seats['creator_token']}")
    client.post(f"/api/sessions/{seats['sid']}/start?token={seats['creator_token']}")

    play_call = _play_call(transport)
    assert play_call is not None
    text = _system_text(play_call)

    for role_id in (
        seats["creator_role_id"],
        seats["soc_role_id"],
        seats["ic_role_id"],
    ):
        line = next(line for line in text.splitlines() if f"`{role_id}`" in line)
        assert "`not_joined`" in line, line

    assert "0 of 3 seats currently joined" in text
    # Make sure we're NOT showing the "presence unknown" hint when an
    # empty snapshot was passed — that hint is reserved for ``None``.
    assert "Presence unknown" not in text
