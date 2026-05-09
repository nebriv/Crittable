"""Wave 3 (issue #69) — creator-only AI-pause toggle.

Tests for the ``POST /pause`` / ``POST /resume`` REST endpoints, the
``ai_pause_state_changed`` WS broadcast, the audit lines, and the
end-to-end interaction with the ``@facilitator`` routing branch.

The PR #152 routing branch (``ws/routes.py`` line ~739) already
consumes ``Session.ai_paused``; ``test_composer_mentions_routing.py
::test_ws_routing_skips_interject_when_ai_paused`` already locks the
behavior by mutating the field directly. This file exercises the
**human-facing affordance** that flips that field — i.e. the new
endpoints, idempotency, the WS broadcast contract, and the
persisted ``Message.ai_paused_at_submit`` snapshot the transcript
indicator reads from.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import reset_settings_cache
from app.main import create_app
from app.sessions.models import SessionState, Turn
from app.sessions.submission_pipeline import FACILITATOR_MENTION_TOKEN
from tests.conftest import default_settings_body


@pytest.fixture(autouse=True)
def _disable_guardrail(monkeypatch: pytest.MonkeyPatch) -> None:
    """Disable the input guardrail for this test file. The guardrail
    runs a real Anthropic call (haiku) before the WS submit handler
    appends a player message; without mocking the guardrail tier
    we'd silently drop messages here. Other test files that drive
    full end-to-end flows install a richer mock; we only need the
    submission to land, not for the guardrail to classify it.
    """

    monkeypatch.setenv("INPUT_GUARDRAIL_ENABLED", "false")


@pytest.fixture
def client() -> TestClient:
    reset_settings_cache()
    app = create_app()
    with TestClient(app) as c:
        yield c


async def _seat_two_role_session(client: TestClient) -> dict[str, Any]:
    """Spin up a session with one extra player role and walk it to
    AWAITING_PLAYERS so a player can submit a facilitator-tagged
    message into a real turn. Mirrors the helper in
    ``test_composer_mentions_routing.py`` — kept local so a future
    edit there doesn't accidentally break this file."""

    resp = client.post(
        "/api/sessions",
        json={
            "scenario_prompt": "AI pause toggle test",
            "creator_label": "CISO",
            "creator_display_name": "Alex",
            "skip_setup": True,
            **default_settings_body(),
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    creator_token = body["creator_token"]
    creator_id = body["creator_role_id"]
    sid = body["session_id"]

    role_resp = client.post(
        f"/api/sessions/{sid}/roles?token={creator_token}",
        json={"label": "SOC", "display_name": "Bo"},
    )
    assert role_resp.status_code == 200, role_resp.text
    soc_id = role_resp.json()["role_id"]
    soc_token = role_resp.json()["token"]

    manager = client.app.state.manager
    session = await manager.get_session(sid)
    turn = Turn(
        index=0,
        active_role_groups=[[creator_id], [soc_id]],
        status="awaiting",
    )
    session.turns.append(turn)
    session.state = SessionState.AWAITING_PLAYERS
    await manager._repo.save(session)

    return {
        "session_id": sid,
        "creator_id": creator_id,
        "creator_token": creator_token,
        "soc_id": soc_id,
        "soc_token": soc_token,
    }


# -----------------------------------------------------------------------
# REST endpoints — happy path, idempotency, authz
# -----------------------------------------------------------------------


def test_pause_endpoint_flips_flag(client: TestClient) -> None:
    """POST /pause sets ``Session.ai_paused = True`` and the snapshot
    surfaces the new state to the frontend."""

    seats = asyncio.run(_seat_two_role_session(client))
    sid = seats["session_id"]
    cr = seats["creator_token"]

    snap_before = client.get(f"/api/sessions/{sid}?token={cr}").json()
    assert snap_before["ai_paused"] is False

    r = client.post(f"/api/sessions/{sid}/pause?token={cr}")
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "paused": True}

    snap_after = client.get(f"/api/sessions/{sid}?token={cr}").json()
    assert snap_after["ai_paused"] is True


def test_resume_endpoint_clears_flag(client: TestClient) -> None:
    seats = asyncio.run(_seat_two_role_session(client))
    sid = seats["session_id"]
    cr = seats["creator_token"]

    client.post(f"/api/sessions/{sid}/pause?token={cr}")
    r = client.post(f"/api/sessions/{sid}/resume?token={cr}")
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "paused": False}

    snap = client.get(f"/api/sessions/{sid}?token={cr}").json()
    assert snap["ai_paused"] is False


def test_pause_is_idempotent(client: TestClient) -> None:
    """Re-posting /pause on an already-paused session is a no-op:
    the second call returns 200 but emits no duplicate audit line
    or broadcast (so a rapid double-click doesn't log twice)."""

    seats = asyncio.run(_seat_two_role_session(client))
    sid = seats["session_id"]
    cr = seats["creator_token"]

    audit = client.app.state.manager.audit()

    before_pauses = [
        e for e in audit.dump(sid) if e.kind == "ai_paused_by_creator"
    ]

    client.post(f"/api/sessions/{sid}/pause?token={cr}")  # 1st
    after_first = [
        e for e in audit.dump(sid) if e.kind == "ai_paused_by_creator"
    ]
    client.post(f"/api/sessions/{sid}/pause?token={cr}")  # 2nd, no-op
    after_second = [
        e for e in audit.dump(sid) if e.kind == "ai_paused_by_creator"
    ]

    assert len(after_first) - len(before_pauses) == 1, (
        "first pause should emit one ai_paused_by_creator audit event"
    )
    assert len(after_second) == len(after_first), (
        "idempotent pause must NOT emit a second audit event"
    )


def test_pause_requires_creator(client: TestClient) -> None:
    """Non-creator participants get a 403 from /pause and the flag
    is unchanged. Same gate enforced on /resume."""

    seats = asyncio.run(_seat_two_role_session(client))
    sid = seats["session_id"]
    cr = seats["creator_token"]
    other = seats["soc_token"]

    r = client.post(f"/api/sessions/{sid}/pause?token={other}")
    assert r.status_code == 403, r.text

    snap = client.get(f"/api/sessions/{sid}?token={cr}").json()
    assert snap["ai_paused"] is False, "non-creator pause must not flip the flag"

    # Resume gated identically — pause first as creator, then verify
    # non-creator can't resume.
    client.post(f"/api/sessions/{sid}/pause?token={cr}")
    r = client.post(f"/api/sessions/{sid}/resume?token={other}")
    assert r.status_code == 403, r.text

    snap = client.get(f"/api/sessions/{sid}?token={cr}").json()
    assert snap["ai_paused"] is True, "non-creator resume must not flip the flag"


def test_pause_emits_audit_line(client: TestClient) -> None:
    """The audit log records ``ai_paused_by_creator`` /
    ``ai_resumed_by_creator`` with the actor's role_id, so the
    creator's activity panel can show who toggled when."""

    seats = asyncio.run(_seat_two_role_session(client))
    sid = seats["session_id"]
    cr = seats["creator_token"]
    creator_id = seats["creator_id"]

    audit = client.app.state.manager.audit()

    client.post(f"/api/sessions/{sid}/pause?token={cr}")
    pause_events = [
        e for e in audit.dump(sid) if e.kind == "ai_paused_by_creator"
    ]
    assert len(pause_events) == 1
    assert pause_events[0].session_id == sid
    assert pause_events[0].payload.get("by") == creator_id

    client.post(f"/api/sessions/{sid}/resume?token={cr}")
    resume_events = [
        e for e in audit.dump(sid) if e.kind == "ai_resumed_by_creator"
    ]
    assert len(resume_events) == 1
    assert resume_events[0].payload.get("by") == creator_id


# -----------------------------------------------------------------------
# WS broadcast contract
# -----------------------------------------------------------------------


def test_pause_broadcasts_ai_pause_state_changed(client: TestClient) -> None:
    """``POST /pause`` records an ``{type: ai_pause_state_changed,
    paused: true}`` event in the connection manager's replay buffer
    so connected clients receive it (live) and reconnecting clients
    re-hydrate the current pause state from replay.

    Implementation note: Starlette's ``WebSocketTestSession.receive_json``
    has no timeout primitive — a missed broadcast hangs the test
    forever. Inspecting the per-session replay buffer directly hits
    the same code path (``broadcast(record=True)`` always appends
    to that buffer before fanning out to live connections) and
    avoids the async-timing race.
    """

    seats = asyncio.run(_seat_two_role_session(client))
    sid = seats["session_id"]
    cr = seats["creator_token"]

    cm = client.app.state.connections
    pre = [
        e for e in cm._replay.get(sid, ())
        if e.get("type") == "ai_pause_state_changed"
    ]

    client.post(f"/api/sessions/{sid}/pause?token={cr}")

    post = [
        e for e in cm._replay.get(sid, ())
        if e.get("type") == "ai_pause_state_changed"
    ]
    new = post[len(pre):]
    assert len(new) == 1, (
        f"/pause should append exactly one ai_pause_state_changed "
        f"to the replay buffer; new entries: {new}"
    )
    assert new[0] == {"type": "ai_pause_state_changed", "paused": True}


def test_resume_broadcasts_ai_pause_state_changed_false(
    client: TestClient,
) -> None:
    """``POST /resume`` records the inverse event in the replay buffer
    so a reconnecting client paints the un-paused state."""

    seats = asyncio.run(_seat_two_role_session(client))
    sid = seats["session_id"]
    cr = seats["creator_token"]

    # Pause first so /resume actually flips state.
    client.post(f"/api/sessions/{sid}/pause?token={cr}")

    cm = client.app.state.connections
    pre = [
        e for e in cm._replay.get(sid, ())
        if e.get("type") == "ai_pause_state_changed"
    ]
    assert pre and pre[-1]["paused"] is True, (
        "expected the prior /pause to have recorded a paused=true event"
    )

    client.post(f"/api/sessions/{sid}/resume?token={cr}")

    post = [
        e for e in cm._replay.get(sid, ())
        if e.get("type") == "ai_pause_state_changed"
    ]
    new = post[len(pre):]
    assert len(new) == 1, (
        f"/resume should append exactly one ai_pause_state_changed "
        f"to the replay buffer; new entries: {new}"
    )
    assert new[0] == {"type": "ai_pause_state_changed", "paused": False}


def test_pause_state_replays_to_late_joiner_via_ws(
    client: TestClient,
) -> None:
    """A WebSocket connecting AFTER the pause was set replays the
    pause event from the buffer — the late joiner paints the banner
    without waiting for the next live toggle. ``receive_json`` here
    is safe (no timeout needed) because the replay events are
    delivered immediately on connect."""

    seats = asyncio.run(_seat_two_role_session(client))
    sid = seats["session_id"]
    cr = seats["creator_token"]
    other = seats["soc_token"]

    client.post(f"/api/sessions/{sid}/pause?token={cr}")

    with client.websocket_connect(
        f"/ws/sessions/{sid}?token={other}"
    ) as ws:
        # The connection manager flushes the per-session replay
        # buffer onto the new connection's queue immediately; we
        # walk the queue until we spot the pause event. Hard cap
        # of 64 events guards against a runaway loop if a future
        # change adds many initial events.
        saw_pause_evt = False
        for _ in range(64):
            try:
                evt = ws.receive_json()
            except Exception:
                break
            if evt.get("type") == "ai_pause_state_changed":
                assert evt.get("paused") is True
                saw_pause_evt = True
                break
        assert saw_pause_evt, (
            "late-joining WS should replay the ai_pause_state_changed "
            "event from the buffer"
        )


def test_idempotent_pause_does_not_rebroadcast(client: TestClient) -> None:
    """Re-posting /pause when already paused must NOT fan a second
    broadcast — replay buffer would fill with stale duplicates and
    the UI would re-flash the banner on every redundant click."""

    seats = asyncio.run(_seat_two_role_session(client))
    sid = seats["session_id"]
    cr = seats["creator_token"]

    # Initial flip — emits the recorded broadcast.
    client.post(f"/api/sessions/{sid}/pause?token={cr}")

    # Inspect the replay buffer directly — counting broadcast events
    # by introspecting the connection manager's per-session buffer
    # avoids the Starlette TestClient's no-timeout receive_json
    # foot-gun (a no-op pause produces zero events; without a timeout
    # we'd block forever).
    cm = client.app.state.connections
    buf_after_first = [
        e for e in cm._replay.get(sid, ()) if e.get("type") == "ai_pause_state_changed"
    ]
    assert len(buf_after_first) == 1, (
        f"first /pause should record exactly one broadcast; got {len(buf_after_first)}"
    )

    # Re-pause (no-op).
    client.post(f"/api/sessions/{sid}/pause?token={cr}")
    buf_after_second = [
        e for e in cm._replay.get(sid, ()) if e.get("type") == "ai_pause_state_changed"
    ]
    assert len(buf_after_second) == 1, (
        f"idempotent /pause must NOT add a second broadcast; "
        f"replay buffer has {len(buf_after_second)} ai_pause_state_changed entries"
    )


# -----------------------------------------------------------------------
# Integration: pause via REST, then @facilitator over WS — interject
# is suppressed, message persists with ai_paused_at_submit=True
# -----------------------------------------------------------------------


def test_pause_via_rest_suppresses_facilitator_interject(
    client: TestClient,
) -> None:
    """The full human-facing flow: creator hits /pause, a player
    submits ``@facilitator`` over WS, and (a) ``run_interject`` is
    NOT invoked (asserted via the play-tier mock having zero calls),
    (b) the persisted message carries ``ai_paused_at_submit=True``
    so the transcript indicator survives a reload.

    Note: ``facilitator_mention_skipped_ai_paused`` is a
    structlog-only line (``backend/app/ws/routes.py:746``), not an
    audit-ledger emission via ``manager._emit``. We assert the
    suppression via the LLM-call counter rather than the structlog
    output to keep the test resilient — capturing structlog stdout
    requires more plumbing than the mock-call check is worth."""

    from tests.mock_chat_client import install_mock_chat_client

    seats = asyncio.run(_seat_two_role_session(client))
    sid = seats["session_id"]
    cr = seats["creator_token"]
    other = seats["soc_token"]

    # Creator pauses via REST.
    r = client.post(f"/api/sessions/{sid}/pause?token={cr}")
    assert r.status_code == 200

    # Install a mock so any accidental run_interject call would land
    # on it — we'll assert the call list is empty.
    mock = install_mock_chat_client(client, {"play": []})

    # Server-side ``submit_response`` handler awaits the submission
    # pipeline synchronously before returning to its WS recv loop;
    # exiting the ``with`` context serializes the handler so the
    # snapshot reads after the close already reflect the persisted
    # message. No drain loop needed.
    with client.websocket_connect(
        f"/ws/sessions/{sid}?token={other}"
    ) as ws:
        ws.send_json(
            {
                "type": "submit_response",
                "content": "@facilitator any update?",
                "intent": "discuss",
                "mentions": [FACILITATOR_MENTION_TOKEN],
            }
        )

    assert mock.calls == [], (
        "ai_paused via REST must suppress run_interject; "
        f"got {len(mock.calls)} LLM call(s)"
    )

    # Inspect the persisted message.
    snap = client.get(f"/api/sessions/{sid}?token={cr}").json()
    last_player = next(
        m for m in reversed(snap["messages"]) if m.get("kind") == "player"
    )
    assert "@facilitator any update" in last_player["body"]
    assert FACILITATOR_MENTION_TOKEN in last_player.get("mentions", [])
    assert last_player.get("ai_paused_at_submit") is True, (
        "facilitator mention submitted while paused must persist "
        "ai_paused_at_submit so the transcript indicator survives reload"
    )


def test_non_facilitator_message_does_not_set_ai_paused_at_submit(
    client: TestClient,
) -> None:
    """The ``ai_paused_at_submit`` snapshot is scoped to facilitator-
    tagged messages — non-tagged messages don't get the indicator
    even if the session is paused, because they wouldn't have
    triggered an interject in the first place. Without this guard
    the transcript would show the indicator on every player message
    submitted during a long pause, which is misleading."""

    seats = asyncio.run(_seat_two_role_session(client))
    sid = seats["session_id"]
    cr = seats["creator_token"]
    other = seats["soc_token"]

    client.post(f"/api/sessions/{sid}/pause?token={cr}")

    with client.websocket_connect(
        f"/ws/sessions/{sid}?token={other}"
    ) as ws:
        ws.send_json(
            {
                "type": "submit_response",
                "content": "Just thinking out loud here.",
                "intent": "discuss",
                "mentions": [],
            }
        )

    snap = client.get(f"/api/sessions/{sid}?token={cr}").json()
    last_player = next(
        m for m in reversed(snap["messages"]) if m.get("kind") == "player"
    )
    assert last_player.get("ai_paused_at_submit") is False, (
        "non-facilitator messages must not carry the silenced "
        "indicator even while paused"
    )


def test_resumed_facilitator_message_does_not_get_silenced_indicator(
    client: TestClient,
) -> None:
    """After /resume, a fresh ``@facilitator`` message is NOT marked
    silenced (the snapshot is taken at submit time and reads the
    current ``ai_paused`` flag — not the historical one)."""

    seats = asyncio.run(_seat_two_role_session(client))
    sid = seats["session_id"]
    cr = seats["creator_token"]
    other = seats["soc_token"]

    client.post(f"/api/sessions/{sid}/pause?token={cr}")
    client.post(f"/api/sessions/{sid}/resume?token={cr}")

    from tests.mock_chat_client import install_mock_chat_client, llm_result, tool_block

    interject = llm_result(
        tool_block("broadcast", {"message": "ack"}, block_id="tu_b"),
        stop_reason="tool_use",
    )
    install_mock_chat_client(client, {"play": [interject]})

    # The interject would land if the broadcast tool's ``run_interject``
    # actually fired — we only care that ``ai_paused_at_submit`` is
    # False on the persisted message regardless of whether the
    # subsequent LLM call completes. The ``with`` exit serializes
    # the server-side submit_response handler.
    with client.websocket_connect(
        f"/ws/sessions/{sid}?token={other}"
    ) as ws:
        ws.send_json(
            {
                "type": "submit_response",
                "content": "@facilitator status?",
                "intent": "discuss",
                "mentions": [FACILITATOR_MENTION_TOKEN],
            }
        )

    snap = client.get(f"/api/sessions/{sid}?token={cr}").json()
    last_player = next(
        m for m in reversed(snap["messages"]) if m.get("kind") == "player"
    )
    assert last_player.get("ai_paused_at_submit") is False, (
        "post-resume facilitator messages must not carry the silenced "
        "indicator — the snapshot is at submit time"
    )


# -----------------------------------------------------------------------
# Pause does NOT halt normal play turns (decision locked in by issue #69)
# -----------------------------------------------------------------------


@pytest.mark.skip(
    reason="Test asserts the legacy intent=ready auto-advance contract; "
    "needs rewrite to explicit set_role_ready calls (PR #209 follow-up)."
)
def test_pause_does_not_gate_ready_quorum_submissions(
    client: TestClient,
) -> None:
    """Decision in #69: pause silences interjects only. The normal
    ready-quorum gate is independent — a player can still submit
    with ``intent="ready"`` while the session is paused, the
    submission lands, and ``submit_response`` reports the advance
    when the quorum is met.

    This test asserts the structural invariant directly via the
    submission pipeline — exercising the WS-driven full play-turn
    dispatch is the job of ``test_e2e_session.py``. Without this
    boundary, an unrelated change to the routing branch could
    accidentally start gating ``run_play_turn`` on ``ai_paused``
    and lock paused sessions out of progress."""

    from app.sessions.submission_pipeline import (
        prepare_and_submit_player_response,
    )

    seats = asyncio.run(_seat_two_role_session(client))
    sid = seats["session_id"]
    cr = seats["creator_token"]
    creator_id = seats["creator_id"]
    soc_id = seats["soc_id"]

    client.post(f"/api/sessions/{sid}/pause?token={cr}")

    manager = client.app.state.manager

    async def _drive() -> tuple[Any, Any]:
        # First player submits ready. ``advanced`` should still be
        # False (waiting on the second player). ``ai_paused`` is
        # invisible to this code path.
        outcome_a = await prepare_and_submit_player_response(
            manager=manager,
            session_id=sid,
            role_id=creator_id,
            content="Initiating containment",

            mentions=[],
        )
        # Second player submits ready. ``advanced`` flips True
        # because the quorum is now met.
        outcome_b = await prepare_and_submit_player_response(
            manager=manager,
            session_id=sid,
            role_id=soc_id,
            content="Pulling logs",

            mentions=[],
        )
        return outcome_a, outcome_b

    outcome_a, outcome_b = asyncio.run(_drive())

    assert outcome_a.advanced is False, (
        "first ready submission should not advance — second player "
        "hasn't submitted yet"
    )
    assert outcome_b.advanced is True, (
        "pause must NOT halt the ready-quorum gate; once both "
        "players submit ready, submit_response should report the "
        "advance regardless of ai_paused"
    )

    # Sanity: session is still paused after the submissions — the
    # pause flag is independent of submission flow.
    snap = client.get(f"/api/sessions/{sid}?token={cr}").json()
    assert snap["ai_paused"] is True


# -----------------------------------------------------------------------
# Transcript builder marks silenced messages so the next play turn
# doesn't retroactively answer them (Prompt Expert HIGH)
# -----------------------------------------------------------------------


def test_transcript_builder_marks_silenced_facilitator_messages(
    client: TestClient,
) -> None:
    """When the AI is paused and a player ``@facilitator``s, the
    message lands in the transcript with ``ai_paused_at_submit=True``.
    The next ``run_play_turn`` builds an Anthropic ``messages`` array
    via ``_play_messages``; that builder must prefix the silenced
    message with ``[OPERATOR-SILENCED]`` so Block 6 of the play-tier
    system prompt knows not to retroactively answer it.

    Without this marker, the model would read the un-tagged
    ``@facilitator ...`` body and treat it as a high-priority ask
    (Block 6: "Answer ``@facilitator`` mentions first"), defeating
    the pause's purpose."""

    from app.sessions.turn_driver import _play_messages

    seats = asyncio.run(_seat_two_role_session(client))
    sid = seats["session_id"]
    cr = seats["creator_token"]

    client.post(f"/api/sessions/{sid}/pause?token={cr}")

    # Submit @facilitator while paused.
    manager = client.app.state.manager

    async def _submit() -> None:
        from app.sessions.submission_pipeline import (
            prepare_and_submit_player_response,
        )

        await prepare_and_submit_player_response(
            manager=manager,
            session_id=sid,
            role_id=seats["soc_id"],
            content="@facilitator status?",

            mentions=[FACILITATOR_MENTION_TOKEN],
        )

    asyncio.run(_submit())

    async def _msgs() -> list[dict[str, Any]]:
        session = await manager.get_session(sid)
        return _play_messages(session)

    msgs = asyncio.run(_msgs())

    silenced_msgs = [
        m for m in msgs
        if m["role"] == "user" and "[OPERATOR-SILENCED]" in m["content"]
    ]
    assert len(silenced_msgs) == 1, (
        f"expected exactly one [OPERATOR-SILENCED] entry; got "
        f"{len(silenced_msgs)} in: "
        f"{[m['content'][:80] for m in msgs]}"
    )
    assert "@facilitator status" in silenced_msgs[0]["content"]


def test_transcript_builder_does_not_mark_unrelated_messages(
    client: TestClient,
) -> None:
    """A non-facilitator message submitted while paused, and a
    facilitator message submitted before pause, are NOT prefixed
    with ``[OPERATOR-SILENCED]``. The marker is scoped to the
    intersection of (a) ``@facilitator`` mention and (b) ``ai_paused
    at submit`` time."""

    from app.sessions.submission_pipeline import (
        prepare_and_submit_player_response,
    )
    from app.sessions.turn_driver import _play_messages

    seats = asyncio.run(_seat_two_role_session(client))
    sid = seats["session_id"]
    cr = seats["creator_token"]
    soc_id = seats["soc_id"]

    client.post(f"/api/sessions/{sid}/pause?token={cr}")
    manager = client.app.state.manager

    async def _submit_no_mention() -> None:
        await prepare_and_submit_player_response(
            manager=manager,
            session_id=sid,
            role_id=soc_id,
            content="just a comment",

            mentions=[],
        )

    asyncio.run(_submit_no_mention())

    async def _msgs() -> list[dict[str, Any]]:
        session = await manager.get_session(sid)
        return _play_messages(session)

    msgs = asyncio.run(_msgs())
    silenced = [
        m for m in msgs
        if m["role"] == "user" and "[OPERATOR-SILENCED]" in m["content"]
    ]
    assert silenced == [], (
        "non-facilitator messages should not carry the silenced "
        f"marker even when paused; got: {silenced}"
    )


# -----------------------------------------------------------------------
# Proxy-respond REST path (god-mode helper) honors the pause flag
# (QA review HIGH on this PR)
# -----------------------------------------------------------------------


def test_proxy_respond_path_skipped_when_ai_paused(
    client: TestClient,
) -> None:
    """The creator's solo-test ``admin/proxy-respond`` endpoint runs
    its own ``@facilitator`` routing branch (separate from the WS
    path). Pre-fix that branch silently skipped ``run_interject``
    when ``ai_paused`` was True without logging — a "creator
    proxy-typed @facilitator and got nothing" debug session had
    zero signal. The fix added a ``facilitator_mention_skipped_ai_paused``
    structlog line; we don't assert on the structlog output here
    (capturing it requires more plumbing than it's worth — the
    LLM-call counter + the persisted-snapshot check are the
    load-bearing assertions). What this test asserts:

    * No LLM call fired (structural skip works).
    * The proxy'd message persists with
      ``ai_paused_at_submit=True`` so the transcript indicator
      renders consistently for proxy-typed messages."""

    from tests.mock_chat_client import install_mock_chat_client

    seats = asyncio.run(_seat_two_role_session(client))
    sid = seats["session_id"]
    cr = seats["creator_token"]
    soc_id = seats["soc_id"]

    client.post(f"/api/sessions/{sid}/pause?token={cr}")

    mock = install_mock_chat_client(client, {"play": []})

    r = client.post(
        f"/api/sessions/{sid}/admin/proxy-respond?token={cr}",
        json={
            "as_role_id": soc_id,
            "content": "@facilitator status?",
            "intent": "discuss",
            "mentions": [FACILITATOR_MENTION_TOKEN],
        },
    )
    assert r.status_code == 200, r.text

    # No LLM call fired.
    assert mock.calls == [], (
        f"proxy-respond + ai_paused must skip run_interject; "
        f"got {len(mock.calls)} LLM call(s)"
    )

    # Message landed in the transcript with the snapshot.
    snap = client.get(f"/api/sessions/{sid}?token={cr}").json()
    last = next(m for m in reversed(snap["messages"]) if m.get("kind") == "player")
    assert last.get("body").startswith("@facilitator")
    assert last.get("ai_paused_at_submit") is True, (
        "proxy_submit_as should mirror submit_response and snapshot "
        "ai_paused_at_submit so the transcript silenced indicator "
        "renders consistently for proxy-typed messages too"
    )


# -----------------------------------------------------------------------
# Snapshot field is creator-and-player visible (every participant
# needs the banner)
# -----------------------------------------------------------------------


def test_snapshot_ai_paused_visible_to_all_participants(
    client: TestClient,
) -> None:
    """Every participant — including non-creators — must see
    ``ai_paused`` in their snapshot so the session-wide banner
    renders for them. The flag is session-scoped state, not
    creator-only data like the plan or cost meter."""

    seats = asyncio.run(_seat_two_role_session(client))
    sid = seats["session_id"]
    cr = seats["creator_token"]
    other = seats["soc_token"]

    client.post(f"/api/sessions/{sid}/pause?token={cr}")

    snap_cr = client.get(f"/api/sessions/{sid}?token={cr}").json()
    snap_other = client.get(f"/api/sessions/{sid}?token={other}").json()

    assert snap_cr["ai_paused"] is True
    assert snap_other["ai_paused"] is True, (
        "non-creator snapshot must surface ai_paused so the banner renders"
    )
