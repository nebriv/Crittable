"""Wave 2 (composer mentions + facilitator routing).

Tests for the structural ``mentions`` list end-to-end:

* The submission pipeline drops unknown / non-string / oversized
  entries with a ``mention_dropped`` WARNING log. Each branch is
  exercised against a real (in-process) session built via the public
  REST API rather than mocking the manager — so a regression in the
  validator OR in how the manager carries ``mentions`` through to
  ``Message.mentions`` would trip these.
* The WS handler's routing branch fires ``run_interject`` iff
  ``"facilitator"`` is in the cleaned mention list AND the session
  isn't paused. Tested via real WebSocket connections to the same
  app the production server boots, so a regression in the WS
  payload contract or the routing branch surfaces here.
* ``Session.ai_paused`` (Wave 3 stub field) suppresses the dispatch
  even when ``@facilitator`` is mentioned, while still letting the
  message land in the transcript.
* The legacy ``_looks_like_question`` heuristic is fully gone — no
  symbol is left in either ``ws/routes.py`` or ``api/routes.py``.
  A source-grep regression test covers the case where someone
  re-introduces it under a different module name.

Test-design notes:

* Tests build sessions through the public ``POST /api/sessions``
  REST surface (not by constructing ``Session`` objects in-memory)
  so the fixtures match the real wire shape — including how the
  creator role's id flows into ``Session.roles``.
* The unusual / abusive cases (non-string entries, dict in the
  list, 50-element payload, malformed type) simulate misbehaving
  or stale clients. They live alongside the happy-path cases so
  every shape the wire can carry is locked.
* ``capsys`` is pytest's ``stdout/stderr`` capture fixture (see
  ``_structlog_lines`` below). The repo's structlog pipeline writes
  JSON lines via ``PrintLoggerFactory`` to stdout, so ``caplog``
  (which routes through stdlib ``logging``) doesn't see them. The
  same pattern is used in ``test_health.py``.

Pairs with:
  * ``test_e2e_session.py::test_ai_auto_interjects_on_facilitator_mention``
  * ``test_e2e_session.py::test_out_of_turn_facilitator_mention_fires_interject``
  * ``test_e2e_session.py::test_player_question_does_not_downgrade_drive_recovery``
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import reset_settings_cache
from app.main import create_app
from app.sessions.models import SessionState, Turn
from app.sessions.submission_pipeline import (
    _MENTIONS_CAP,
    FACILITATOR_MENTION_TOKEN,
    prepare_and_submit_player_response,
    validate_mentions,
)


@pytest.fixture
def client() -> TestClient:
    reset_settings_cache()
    app = create_app()
    with TestClient(app) as c:
        yield c


async def _seat_two_role_session(client: TestClient) -> dict[str, Any]:
    """Spin up a session with one extra player role and walk it to
    AWAITING_PLAYERS so the pipeline has a turn to submit into."""

    resp = client.post(
        "/api/sessions",
        json={
            "scenario_prompt": "Mentions routing test",
            "creator_label": "CISO",
            "creator_display_name": "Alex",
            "skip_setup": True,
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

    manager = client.app.state.manager
    session = await manager.get_session(sid)
    turn = Turn(
        index=0,
        active_role_ids=[creator_id, soc_id],
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
    }


# -----------------------------------------------------------------------
# validate_mentions
# -----------------------------------------------------------------------


def test_validate_mentions_keeps_known_role_id(client: TestClient) -> None:
    seats = asyncio.run(_seat_two_role_session(client))

    async def run() -> list[str]:
        return await validate_mentions(
            manager=client.app.state.manager,
            session_id=seats["session_id"],
            role_id=seats["creator_id"],
            submitted=[seats["soc_id"]],
        )

    out = asyncio.run(run())
    assert out == [seats["soc_id"]]


def test_validate_mentions_keeps_facilitator_literal(client: TestClient) -> None:
    seats = asyncio.run(_seat_two_role_session(client))

    async def run() -> list[str]:
        return await validate_mentions(
            manager=client.app.state.manager,
            session_id=seats["session_id"],
            role_id=seats["creator_id"],
            submitted=[FACILITATOR_MENTION_TOKEN],
        )

    out = asyncio.run(run())
    assert out == [FACILITATOR_MENTION_TOKEN]


def _structlog_lines(capsys: pytest.CaptureFixture[str]) -> list[dict[str, Any]]:
    """Drain stdout (structlog's ``PrintLoggerFactory`` target) and
    parse each JSON-shaped line into a dict.

    ``capsys`` is pytest's built-in fixture that captures whatever
    the code-under-test writes to ``sys.stdout`` / ``sys.stderr``.
    The repo's structlog pipeline writes JSON-shaped log lines to
    stdout via ``PrintLoggerFactory``; ``capsys.readouterr().out``
    is the captured buffer. We split it on newlines, parse each
    JSON line, and return the list — callers then filter by
    ``event`` to find the audit line they care about.

    Why not ``caplog``? ``caplog`` hooks the stdlib ``logging``
    module's record stream. Structlog has its own configurable
    pipeline that, in this repo, terminates at ``PrintLoggerFactory``
    (which calls ``print``, not stdlib ``logging``). So ``caplog``
    sees nothing. The ``test_health.py::test_http_access_log_emits_per_request``
    test established this same workaround for the access-log
    audit lines.
    """

    captured = capsys.readouterr()
    out: list[dict[str, Any]] = []
    for raw in captured.out.splitlines():
        raw = raw.strip()
        if not raw or not raw.startswith("{"):
            continue
        try:
            out.append(json.loads(raw))
        except Exception:
            continue
    return out


def test_validate_mentions_drops_unknown_id(
    client: TestClient, capsys: pytest.CaptureFixture[str]
) -> None:
    seats = asyncio.run(_seat_two_role_session(client))
    capsys.readouterr()  # discard setup-time logs

    async def run() -> list[str]:
        return await validate_mentions(
            manager=client.app.state.manager,
            session_id=seats["session_id"],
            role_id=seats["creator_id"],
            submitted=["not-a-real-role", seats["soc_id"], "creator"],
        )

    out = asyncio.run(run())
    lines = _structlog_lines(capsys)

    assert out == [seats["soc_id"]]
    drop_lines = [
        line for line in lines if line.get("event") == "mention_dropped"
    ]
    assert drop_lines, lines
    # The structured payload must include both the dropped and kept
    # lists so an operator can debug a "AI didn't pick up my @
    # mention" report from the audit log alone.
    drop = drop_lines[-1]
    assert "creator" in (drop.get("dropped") or [])
    assert "not-a-real-role" in (drop.get("dropped") or [])
    assert seats["soc_id"] in (drop.get("kept") or [])


def test_validate_mentions_drops_non_string_entries(client: TestClient) -> None:
    seats = asyncio.run(_seat_two_role_session(client))

    async def run() -> list[str]:
        return await validate_mentions(
            manager=client.app.state.manager,
            session_id=seats["session_id"],
            role_id=seats["creator_id"],
            submitted=[None, 42, {"role_id": seats["soc_id"]}, "", seats["soc_id"]],  # type: ignore[list-item]
        )

    out = asyncio.run(run())
    assert out == [seats["soc_id"]]


def test_validate_mentions_dedupes(client: TestClient) -> None:
    seats = asyncio.run(_seat_two_role_session(client))

    async def run() -> list[str]:
        return await validate_mentions(
            manager=client.app.state.manager,
            session_id=seats["session_id"],
            role_id=seats["creator_id"],
            submitted=[
                FACILITATOR_MENTION_TOKEN,
                seats["soc_id"],
                FACILITATOR_MENTION_TOKEN,
                seats["soc_id"],
            ],
        )

    out = asyncio.run(run())
    assert out == [FACILITATOR_MENTION_TOKEN, seats["soc_id"]]


def test_validate_mentions_caps_excessive_list(
    client: TestClient, capsys: pytest.CaptureFixture[str]
) -> None:
    seats = asyncio.run(_seat_two_role_session(client))
    capsys.readouterr()
    # 50 entries — well past the 16-entry cap. Build a list where the
    # first ``_MENTIONS_CAP`` entries are valid so we can assert the
    # cap kept exactly that prefix.
    big = [seats["soc_id"]] * (_MENTIONS_CAP + 5) + [FACILITATOR_MENTION_TOKEN]

    async def run() -> list[str]:
        return await validate_mentions(
            manager=client.app.state.manager,
            session_id=seats["session_id"],
            role_id=seats["creator_id"],
            submitted=big,
        )

    out = asyncio.run(run())
    lines = _structlog_lines(capsys)
    # The dedupe step keeps a single ``soc_id`` even though the cap
    # truncated the list to 16 entries — that's the order-preserving
    # contract.
    assert out == [seats["soc_id"]]
    drop_lines = [
        line for line in lines if line.get("event") == "mention_dropped"
    ]
    assert drop_lines, lines
    # QA review L4: explicitly assert the cap-truncated tail entries
    # land in the ``dropped`` field. Without this assertion, a
    # regression that drops the ``cap_dropped += list(submitted[CAP:])``
    # line in the validator would silently survive — the kept-list
    # shape would still pass the previous assert because it relies on
    # dedupe rather than the cap.
    drop = drop_lines[-1]
    dropped = drop.get("dropped") or []
    # The facilitator literal was at index 21 (past the cap of 16),
    # so the cap branch must have moved it into ``dropped``.
    assert FACILITATOR_MENTION_TOKEN in dropped, drop


def test_validate_mentions_handles_non_list_payload(
    client: TestClient, capsys: pytest.CaptureFixture[str]
) -> None:
    seats = asyncio.run(_seat_two_role_session(client))
    capsys.readouterr()

    async def run() -> list[str]:
        return await validate_mentions(
            manager=client.app.state.manager,
            session_id=seats["session_id"],
            role_id=seats["creator_id"],
            submitted="facilitator",  # type: ignore[arg-type]
        )

    out = asyncio.run(run())
    lines = _structlog_lines(capsys)
    assert out == []
    assert any(
        line.get("event") == "mention_dropped"
        and line.get("reason") == "payload_not_a_list"
        for line in lines
    ), lines


def test_validate_mentions_empty_input_short_circuits(client: TestClient) -> None:
    """The ``submitted=None`` path is the production case for an old
    client that never shipped a ``mentions`` field — must short-
    circuit cleanly to ``[]`` without an audit log line."""

    seats = asyncio.run(_seat_two_role_session(client))

    async def run() -> list[str]:
        return await validate_mentions(
            manager=client.app.state.manager,
            session_id=seats["session_id"],
            role_id=seats["creator_id"],
            submitted=None,
        )

    assert asyncio.run(run()) == []


def test_validate_mentions_empty_list_short_circuits(client: TestClient) -> None:
    """QA review M2: the ``submitted=[]`` path is structurally
    distinct from ``None`` (a regression that changes the
    short-circuit predicate from ``if not submitted`` to
    ``if submitted is None`` would only fail this case). Lock both
    branches independently."""

    seats = asyncio.run(_seat_two_role_session(client))

    async def run() -> list[str]:
        return await validate_mentions(
            manager=client.app.state.manager,
            session_id=seats["session_id"],
            role_id=seats["creator_id"],
            submitted=[],
        )

    assert asyncio.run(run()) == []


def test_validate_mentions_drops_oversized_entry(
    client: TestClient, capsys: pytest.CaptureFixture[str]
) -> None:
    """Sec review L2: an entry longer than ``_MENTION_ENTRY_MAX_CHARS``
    is dropped without trying to interpret it. Locks the per-entry
    cap so a regression that lifts the ceiling is caught — and
    makes sure the validator doesn't accidentally try to look up a
    1000-char string in the role-id set."""

    seats = asyncio.run(_seat_two_role_session(client))
    capsys.readouterr()
    long_entry = "x" * 200

    async def run() -> list[str]:
        return await validate_mentions(
            manager=client.app.state.manager,
            session_id=seats["session_id"],
            role_id=seats["creator_id"],
            submitted=[long_entry, seats["soc_id"]],
        )

    out = asyncio.run(run())
    lines = _structlog_lines(capsys)
    assert out == [seats["soc_id"]]
    drop_lines = [
        line for line in lines if line.get("event") == "mention_dropped"
    ]
    assert drop_lines, lines
    # Sec review L1: the audit payload must NOT echo the full 200-
    # char entry verbatim — the per-entry preview cap truncates with
    # ``...`` so log volume stays bounded on a megabyte-string abuse
    # payload.
    drop = drop_lines[-1]
    matched = [
        e for e in (drop.get("dropped") or []) if isinstance(e, str) and "x" in e
    ]
    assert matched, drop
    assert all(len(e) <= 100 for e in matched), matched
    assert any(e.endswith("...") for e in matched), matched


# -----------------------------------------------------------------------
# Pipeline → submit_response → Message.mentions
# -----------------------------------------------------------------------


def test_pipeline_persists_cleaned_mentions(client: TestClient) -> None:
    seats = asyncio.run(_seat_two_role_session(client))

    async def run() -> None:
        await prepare_and_submit_player_response(
            manager=client.app.state.manager,
            session_id=seats["session_id"],
            role_id=seats["creator_id"],
            content="@facilitator help",
            intent="discuss",
            mentions=[FACILITATOR_MENTION_TOKEN, "ghost-role-id"],
        )

    asyncio.run(run())
    snap = client.get(
        f"/api/sessions/{seats['session_id']}?token={seats['creator_token']}"
    ).json()
    last_player = next(
        m for m in reversed(snap["messages"]) if m.get("kind") == "player"
    )
    # Ghost ID dropped, facilitator literal kept on the persisted
    # message.
    session = asyncio.run(client.app.state.manager.get_session(seats["session_id"]))
    persisted = next(
        m for m in reversed(session.messages) if m.kind.value == "player"
    )
    assert persisted.mentions == [FACILITATOR_MENTION_TOKEN]
    assert last_player["body"] == "@facilitator help"


# -----------------------------------------------------------------------
# WS routing branch
# -----------------------------------------------------------------------


def test_ws_routing_fires_interject_when_facilitator_mentioned(
    client: TestClient,
) -> None:
    """Composer mention triggers ``run_interject`` end-to-end."""

    from tests.mock_anthropic import MockAnthropic, _ContentBlock, _Response

    seats = asyncio.run(_seat_two_role_session(client))
    interject = _Response(
        content=[
            _ContentBlock(
                type="tool_use",
                name="broadcast",
                input={"message": "Pulling Defender telemetry now."},
                id="tu_b",
            ),
        ],
        stop_reason="tool_use",
    )
    mock = MockAnthropic({"play": [interject]})
    client.app.state.llm.set_transport(mock.messages)

    creator_token = client.app.state.authn.mint(
        session_id=seats["session_id"],
        role_id=seats["creator_id"],
        kind="creator",
        version=0,
    )
    with client.websocket_connect(
        f"/ws/sessions/{seats['session_id']}?token={creator_token}"
    ) as ws:
        ws.send_json(
            {
                "type": "submit_response",
                "content": "@facilitator any new IOCs?",
                "intent": "discuss",
                "mentions": [FACILITATOR_MENTION_TOKEN],
            }
        )
        # Drain a few frames to let the interject complete.
        for _ in range(8):
            try:
                ws.receive_json(mode="text", timeout=2.0)
            except Exception:
                break

    snap = client.get(
        f"/api/sessions/{seats['session_id']}?token={seats['creator_token']}"
    ).json()
    broadcasts = [m for m in snap["messages"] if m.get("tool_name") == "broadcast"]
    assert any("Defender telemetry" in b.get("body", "") for b in broadcasts), (
        "facilitator mention must fire the interject; got: "
        f"{[b.get('body', '')[:60] for b in broadcasts]}"
    )


def test_ws_routing_skips_interject_without_facilitator_mention(
    client: TestClient,
) -> None:
    """Plain ``@<role>`` mentions are player-to-player; no AI side
    effect. The transcript-with-highlight is the entire affordance."""

    from tests.mock_anthropic import MockAnthropic

    seats = asyncio.run(_seat_two_role_session(client))
    # Empty transport — any LLM call would fail loudly. The test
    # asserts no LLM call is made, so this is a defensive belt to
    # catch a regression where the routing branch fires unexpectedly.
    mock = MockAnthropic({"play": []})
    client.app.state.llm.set_transport(mock.messages)

    creator_token = client.app.state.authn.mint(
        session_id=seats["session_id"],
        role_id=seats["creator_id"],
        kind="creator",
        version=0,
    )
    with client.websocket_connect(
        f"/ws/sessions/{seats['session_id']}?token={creator_token}"
    ) as ws:
        ws.send_json(
            {
                "type": "submit_response",
                "content": "@SOC anything weird in the logs",
                "intent": "discuss",
                "mentions": [seats["soc_id"]],
            }
        )
        for _ in range(4):
            try:
                ws.receive_json(mode="text", timeout=0.5)
            except Exception:
                break

    play_calls = [c for c in mock.messages.calls if "play" in c.get("model", "")]
    assert play_calls == [], (
        "plain @<role> mention must NOT fire the AI interject; "
        f"got {len(play_calls)} play call(s)"
    )


def test_ws_routing_skips_interject_when_ai_paused(client: TestClient) -> None:
    """``Session.ai_paused`` (Wave 3 stub) suppresses the dispatch
    even when ``@facilitator`` is mentioned. The message still lands
    in the transcript with the highlight."""

    from tests.mock_anthropic import MockAnthropic

    seats = asyncio.run(_seat_two_role_session(client))

    async def pause() -> None:
        manager = client.app.state.manager
        session = await manager.get_session(seats["session_id"])
        session.ai_paused = True
        await manager._repo.save(session)

    asyncio.run(pause())

    mock = MockAnthropic({"play": []})
    client.app.state.llm.set_transport(mock.messages)

    creator_token = client.app.state.authn.mint(
        session_id=seats["session_id"],
        role_id=seats["creator_id"],
        kind="creator",
        version=0,
    )
    with client.websocket_connect(
        f"/ws/sessions/{seats['session_id']}?token={creator_token}"
    ) as ws:
        ws.send_json(
            {
                "type": "submit_response",
                "content": "@facilitator are we live?",
                "intent": "discuss",
                "mentions": [FACILITATOR_MENTION_TOKEN],
            }
        )
        for _ in range(4):
            try:
                ws.receive_json(mode="text", timeout=0.5)
            except Exception:
                break

    play_calls = [c for c in mock.messages.calls if "play" in c.get("model", "")]
    assert play_calls == [], (
        "ai_paused must suppress run_interject even with @facilitator; "
        f"got {len(play_calls)} play call(s)"
    )

    # Message still lands in the transcript with the cleaned mentions.
    snap = client.get(
        f"/api/sessions/{seats['session_id']}?token={seats['creator_token']}"
    ).json()
    last_player = next(
        m for m in reversed(snap["messages"]) if m.get("kind") == "player"
    )
    assert "@facilitator are we live" in last_player["body"]


def test_ws_routing_facilitator_mention_with_ready_intent_still_interjects(
    client: TestClient,
) -> None:
    """QA review M1: the routing branch must fire on
    ``intent="ready"`` too — it reads ``mentions`` independently of
    intent, but a regression that accidentally guarded the branch
    on ``intent="discuss"`` would only fail this case. Note: with
    only ONE active role and ``intent="ready"``, the submission also
    closes the ready quorum and the regular play turn would normally
    fire — but the routing branch is structured so the
    ``outcome.advanced`` path takes precedence (the AI sees the
    ``@facilitator`` mention in its prompt and answers it on the
    full play turn, not via the side-channel interject). This test
    therefore uses TWO active roles so the asker's submission alone
    doesn't close the quorum, exercising the interject branch
    directly."""

    from tests.mock_anthropic import MockAnthropic, _ContentBlock, _Response

    seats = asyncio.run(_seat_two_role_session(client))
    interject = _Response(
        content=[
            _ContentBlock(
                type="tool_use",
                name="broadcast",
                input={"message": "Acknowledged — pulling now."},
                id="tu_b",
            ),
        ],
        stop_reason="tool_use",
    )
    mock = MockAnthropic({"play": [interject]})
    client.app.state.llm.set_transport(mock.messages)

    creator_token = client.app.state.authn.mint(
        session_id=seats["session_id"],
        role_id=seats["creator_id"],
        kind="creator",
        version=0,
    )
    with client.websocket_connect(
        f"/ws/sessions/{seats['session_id']}?token={creator_token}"
    ) as ws:
        ws.send_json(
            {
                "type": "submit_response",
                "content": "@facilitator confirm receipt",
                "intent": "ready",
                "mentions": [FACILITATOR_MENTION_TOKEN],
            }
        )
        for _ in range(8):
            try:
                ws.receive_json(mode="text", timeout=2.0)
            except Exception:
                break

    snap = client.get(
        f"/api/sessions/{seats['session_id']}?token={seats['creator_token']}"
    ).json()
    broadcasts = [m for m in snap["messages"] if m.get("tool_name") == "broadcast"]
    assert any(
        "Acknowledged" in b.get("body", "") for b in broadcasts
    ), [b.get("body", "")[:60] for b in broadcasts]


def test_ws_routing_combined_role_and_facilitator_fires_interject(
    client: TestClient,
) -> None:
    """QA review L3: a player addressing both a teammate AND the
    facilitator should still trigger ``run_interject`` (the routing
    predicate is ``"facilitator" in mentions``, regardless of other
    entries) AND persist BOTH targets on ``Message.mentions`` so
    Phase B's @-highlight rendering reads correctly for the addressed
    teammate."""

    from tests.mock_anthropic import MockAnthropic, _ContentBlock, _Response

    seats = asyncio.run(_seat_two_role_session(client))
    interject = _Response(
        content=[
            _ContentBlock(
                type="tool_use",
                name="broadcast",
                input={"message": "Loop in Bo on the egress trace."},
                id="tu_b",
            ),
        ],
        stop_reason="tool_use",
    )
    mock = MockAnthropic({"play": [interject]})
    client.app.state.llm.set_transport(mock.messages)

    creator_token = client.app.state.authn.mint(
        session_id=seats["session_id"],
        role_id=seats["creator_id"],
        kind="creator",
        version=0,
    )
    with client.websocket_connect(
        f"/ws/sessions/{seats['session_id']}?token={creator_token}"
    ) as ws:
        ws.send_json(
            {
                "type": "submit_response",
                "content": "@SOC @facilitator should we trace egress?",
                "intent": "discuss",
                "mentions": [seats["soc_id"], FACILITATOR_MENTION_TOKEN],
            }
        )
        for _ in range(8):
            try:
                ws.receive_json(mode="text", timeout=2.0)
            except Exception:
                break

    # Interject fires.
    snap = client.get(
        f"/api/sessions/{seats['session_id']}?token={seats['creator_token']}"
    ).json()
    broadcasts = [m for m in snap["messages"] if m.get("tool_name") == "broadcast"]
    assert any("Loop in Bo" in b.get("body", "") for b in broadcasts), broadcasts
    # Both mentions persisted on the player's message — order
    # preserved so the frontend can render the highlight in the
    # author's intended sequence.
    session = asyncio.run(
        client.app.state.manager.get_session(seats["session_id"])
    )
    asker_msg = next(
        m for m in reversed(session.messages) if m.kind.value == "player"
    )
    assert asker_msg.mentions == [seats["soc_id"], FACILITATOR_MENTION_TOKEN]


# -----------------------------------------------------------------------
# Interject reply auto-tagging: when a player @s the AI, the AI's
# reply should @ them back so the @YOU badge fires on the asker's
# bubble. ``address_role`` / ``pose_choice`` already auto-tag mentions
# from their ``role_id`` arg; ``broadcast`` / ``share_data`` (the
# common interject reply tools) used to land with empty mentions, so
# the asker saw a fresh AI message with no signal it was for them.
# -----------------------------------------------------------------------


def test_interject_broadcast_reply_tags_asker_mention(
    client: TestClient, capsys: pytest.CaptureFixture[str]
) -> None:
    """When a player @s the facilitator and the AI replies via
    ``broadcast``, the resulting AI message's ``mentions`` must
    include the asker's role_id so the frontend lights the @YOU
    badge on the asker's bubble. Also asserts the
    ``interject_reply_tagged`` audit line — without it an operator
    can't tell from logs whether the auto-tag ran on a stuck
    session."""

    from tests.mock_anthropic import MockAnthropic, _ContentBlock, _Response

    seats = asyncio.run(_seat_two_role_session(client))
    capsys.readouterr()  # discard setup-time logs
    interject = _Response(
        content=[
            _ContentBlock(
                type="tool_use",
                name="broadcast",
                input={"message": "CISO — pulling Defender now."},
                id="tu_b",
            ),
        ],
        stop_reason="tool_use",
    )
    mock = MockAnthropic({"play": [interject]})
    client.app.state.llm.set_transport(mock.messages)

    creator_token = client.app.state.authn.mint(
        session_id=seats["session_id"],
        role_id=seats["creator_id"],
        kind="creator",
        version=0,
    )
    with client.websocket_connect(
        f"/ws/sessions/{seats['session_id']}?token={creator_token}"
    ) as ws:
        ws.send_json(
            {
                "type": "submit_response",
                "content": "@facilitator any new IOCs?",
                "intent": "discuss",
                "mentions": [FACILITATOR_MENTION_TOKEN],
            }
        )
        for _ in range(8):
            try:
                ws.receive_json(mode="text", timeout=2.0)
            except Exception:
                break

    lines = _structlog_lines(capsys)
    session = asyncio.run(
        client.app.state.manager.get_session(seats["session_id"])
    )
    ai_msg = next(
        m
        for m in reversed(session.messages)
        if m.kind.value == "ai_text" and m.tool_name == "broadcast"
    )
    assert ai_msg.mentions == [seats["creator_id"]], (
        "broadcast interject reply must tag the asker's role_id in "
        f"mentions; got {ai_msg.mentions!r}"
    )
    tag_lines = [
        line for line in lines if line.get("event") == "interject_reply_tagged"
    ]
    assert tag_lines, (
        "interject_reply_tagged audit line missing — operators rely on "
        "it to debug @-back regressions; got events: "
        f"{[line.get('event') for line in lines]}"
    )
    tag = tag_lines[-1]
    assert tag["for_role_id"] == seats["creator_id"]
    assert tag["tagged_count"] == 1


def test_interject_share_data_reply_tags_asker_mention(
    client: TestClient,
) -> None:
    """``share_data`` is the interject reply for "show me the logs /
    IOCs / telemetry" asks (the screenshot bug). It currently lands
    without structural mentions, so the asker sees a Defender table
    drop in with no @YOU signal. Auto-tagging fixes that."""

    from tests.mock_anthropic import MockAnthropic, _ContentBlock, _Response

    seats = asyncio.run(_seat_two_role_session(client))
    interject = _Response(
        content=[
            _ContentBlock(
                type="tool_use",
                name="share_data",
                input={
                    "label": "Defender Telemetry — FS-01",
                    "data": "07:14 AM — Unusual auth event\n07:17 AM — chkdst.exe written",
                },
                id="tu_sd",
            ),
        ],
        stop_reason="tool_use",
    )
    mock = MockAnthropic({"play": [interject]})
    client.app.state.llm.set_transport(mock.messages)

    creator_token = client.app.state.authn.mint(
        session_id=seats["session_id"],
        role_id=seats["creator_id"],
        kind="creator",
        version=0,
    )
    with client.websocket_connect(
        f"/ws/sessions/{seats['session_id']}?token={creator_token}"
    ) as ws:
        ws.send_json(
            {
                "type": "submit_response",
                "content": "@facilitator show me the IOCs for FS-01",
                "intent": "discuss",
                "mentions": [FACILITATOR_MENTION_TOKEN],
            }
        )
        for _ in range(8):
            try:
                ws.receive_json(mode="text", timeout=2.0)
            except Exception:
                break

    session = asyncio.run(
        client.app.state.manager.get_session(seats["session_id"])
    )
    ai_msg = next(
        m
        for m in reversed(session.messages)
        if m.kind.value == "ai_text" and m.tool_name == "share_data"
    )
    assert ai_msg.mentions == [seats["creator_id"]], (
        "share_data interject reply must tag the asker's role_id in "
        f"mentions; got {ai_msg.mentions!r}"
    )


def test_interject_address_role_reply_does_not_duplicate_asker_mention(
    client: TestClient,
) -> None:
    """When the AI replies to the asker via ``address_role`` with the
    asker's role_id, the dispatcher already sets
    ``mentions=[asker_id]``. The interject auto-tag must NOT append a
    duplicate entry — exactly one occurrence."""

    from tests.mock_anthropic import MockAnthropic, _ContentBlock, _Response

    seats = asyncio.run(_seat_two_role_session(client))
    interject = _Response(
        content=[
            _ContentBlock(
                type="tool_use",
                name="address_role",
                input={
                    "role_id": seats["creator_id"],
                    "message": "no new IOCs since 07:42.",
                },
                id="tu_ar",
            ),
        ],
        stop_reason="tool_use",
    )
    mock = MockAnthropic({"play": [interject]})
    client.app.state.llm.set_transport(mock.messages)

    creator_token = client.app.state.authn.mint(
        session_id=seats["session_id"],
        role_id=seats["creator_id"],
        kind="creator",
        version=0,
    )
    with client.websocket_connect(
        f"/ws/sessions/{seats['session_id']}?token={creator_token}"
    ) as ws:
        ws.send_json(
            {
                "type": "submit_response",
                "content": "@facilitator status?",
                "intent": "discuss",
                "mentions": [FACILITATOR_MENTION_TOKEN],
            }
        )
        for _ in range(8):
            try:
                ws.receive_json(mode="text", timeout=2.0)
            except Exception:
                break

    session = asyncio.run(
        client.app.state.manager.get_session(seats["session_id"])
    )
    ai_msg = next(
        m
        for m in reversed(session.messages)
        if m.kind.value == "ai_text" and m.tool_name == "address_role"
    )
    assert ai_msg.mentions == [seats["creator_id"]], (
        "address_role to the asker must not produce a duplicate "
        f"mention entry; got {ai_msg.mentions!r}"
    )


def test_interject_address_role_to_other_role_appends_asker_mention(
    client: TestClient,
) -> None:
    """When the AI uses ``address_role`` to redirect the asker's
    question to a different role (e.g. CISO @s `@facilitator`, AI
    routes the operational ask to SOC), both the redirect target AND
    the asker should appear in ``mentions[]`` so:
      - SOC sees @YOU on their bubble (existing dispatch behavior)
      - CISO sees @YOU on their bubble (new auto-tag behavior)
    Order: dispatcher's `[target_id]` first, then the asker appended."""

    from tests.mock_anthropic import MockAnthropic, _ContentBlock, _Response

    seats = asyncio.run(_seat_two_role_session(client))
    interject = _Response(
        content=[
            _ContentBlock(
                type="tool_use",
                name="address_role",
                input={
                    "role_id": seats["soc_id"],
                    "message": "Bo — pull the egress trace and report.",
                },
                id="tu_ar_soc",
            ),
        ],
        stop_reason="tool_use",
    )
    mock = MockAnthropic({"play": [interject]})
    client.app.state.llm.set_transport(mock.messages)

    creator_token = client.app.state.authn.mint(
        session_id=seats["session_id"],
        role_id=seats["creator_id"],
        kind="creator",
        version=0,
    )
    with client.websocket_connect(
        f"/ws/sessions/{seats['session_id']}?token={creator_token}"
    ) as ws:
        ws.send_json(
            {
                "type": "submit_response",
                "content": "@facilitator who handles egress?",
                "intent": "discuss",
                "mentions": [FACILITATOR_MENTION_TOKEN],
            }
        )
        for _ in range(8):
            try:
                ws.receive_json(mode="text", timeout=2.0)
            except Exception:
                break

    session = asyncio.run(
        client.app.state.manager.get_session(seats["session_id"])
    )
    ai_msg = next(
        m
        for m in reversed(session.messages)
        if m.kind.value == "ai_text" and m.tool_name == "address_role"
    )
    assert ai_msg.mentions == [seats["soc_id"], seats["creator_id"]], (
        "address_role to a non-asker target must include both target "
        f"and asker in mentions; got {ai_msg.mentions!r}"
    )


def test_interject_pose_choice_reply_tags_asker_mention(
    client: TestClient,
) -> None:
    """``pose_choice`` is one of the four interject reply tools
    (turn_driver.py:828). When the AI poses a structured 2-choice
    fork to the asker, the dispatcher already tags the target;
    when it poses to a non-asker, the auto-tag must append the
    asker so they still see @YOU."""

    from tests.mock_anthropic import MockAnthropic, _ContentBlock, _Response

    seats = asyncio.run(_seat_two_role_session(client))
    interject = _Response(
        content=[
            _ContentBlock(
                type="tool_use",
                name="pose_choice",
                input={
                    "role_id": seats["soc_id"],
                    "question": "How aggressive should we go on egress block?",
                    "options": ["Block all outbound", "Block to known C2 only"],
                },
                id="tu_pc",
            ),
        ],
        stop_reason="tool_use",
    )
    mock = MockAnthropic({"play": [interject]})
    client.app.state.llm.set_transport(mock.messages)

    creator_token = client.app.state.authn.mint(
        session_id=seats["session_id"],
        role_id=seats["creator_id"],
        kind="creator",
        version=0,
    )
    with client.websocket_connect(
        f"/ws/sessions/{seats['session_id']}?token={creator_token}"
    ) as ws:
        ws.send_json(
            {
                "type": "submit_response",
                "content": "@facilitator should we block egress?",
                "intent": "discuss",
                "mentions": [FACILITATOR_MENTION_TOKEN],
            }
        )
        for _ in range(8):
            try:
                ws.receive_json(mode="text", timeout=2.0)
            except Exception:
                break

    session = asyncio.run(
        client.app.state.manager.get_session(seats["session_id"])
    )
    ai_msg = next(
        m
        for m in reversed(session.messages)
        if m.kind.value == "ai_text" and m.tool_name == "pose_choice"
    )
    assert ai_msg.mentions == [seats["soc_id"], seats["creator_id"]], (
        "pose_choice interject reply to a non-asker must include both "
        f"target and asker in mentions; got {ai_msg.mentions!r}"
    )


def test_interject_with_no_asker_does_not_tag_mentions(
    client: TestClient,
) -> None:
    """Defensive: ``run_interject`` accepts ``for_role_id: str | None``
    (turn_driver.py:719). The auto-tag is gated on a truthy
    ``for_role_id`` AND a real role lookup. Direct-call this path
    with ``for_role_id=None`` and assert the AI's broadcast reply
    has empty ``mentions`` (no spurious tagging when no asker)."""

    from app.sessions.turn_driver import TurnDriver
    from tests.mock_anthropic import MockAnthropic, _ContentBlock, _Response

    seats = asyncio.run(_seat_two_role_session(client))
    interject = _Response(
        content=[
            _ContentBlock(
                type="tool_use",
                name="broadcast",
                input={"message": "ack."},
                id="tu_b_noasker",
            ),
        ],
        stop_reason="tool_use",
    )
    mock = MockAnthropic({"play": [interject]})
    client.app.state.llm.set_transport(mock.messages)

    async def _run() -> Any:
        manager = client.app.state.manager
        session = await manager.get_session(seats["session_id"])
        turn = session.current_turn
        assert turn is not None
        await TurnDriver(manager=manager).run_interject(
            session=session, turn=turn, for_role_id=None
        )
        return await manager.get_session(seats["session_id"])

    session = asyncio.run(_run())
    ai_msg = next(
        m
        for m in reversed(session.messages)
        if m.kind.value == "ai_text" and m.tool_name == "broadcast"
    )
    assert ai_msg.mentions == [], (
        "run_interject with for_role_id=None must not auto-tag the "
        f"reply; got {ai_msg.mentions!r}"
    )


def test_play_turn_reply_tags_facilitator_asker_when_quorum_closes(
    client: TestClient,
) -> None:
    """When a player @s the facilitator AND their submission closes
    the quorum, the WS handler routes to ``run_play_turn`` (not
    ``run_interject``) because ``outcome.advanced`` takes precedence
    (ws/routes.py:722-728). The play-turn path's auto-tag in
    ``_apply_play_outcome`` must still @-back the asker so they see
    @YOU on the AI's response."""

    from tests.mock_anthropic import MockAnthropic, _ContentBlock, _Response

    # 1-active-role variant: only the creator is active, so their
    # ``intent="ready"`` submission closes quorum immediately and
    # the regular play turn fires.
    resp = client.post(
        "/api/sessions",
        json={
            "scenario_prompt": "Mentions routing test",
            "creator_label": "CISO",
            "creator_display_name": "Alex",
            "skip_setup": True,
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    sid = body["session_id"]
    creator_id = body["creator_role_id"]

    async def _seat() -> None:
        manager = client.app.state.manager
        session = await manager.get_session(sid)
        turn = Turn(
            index=0,
            active_role_ids=[creator_id],
            status="awaiting",
        )
        session.turns.append(turn)
        session.state = SessionState.AWAITING_PLAYERS
        await manager._repo.save(session)

    asyncio.run(_seat())

    # Two play responses: the first satisfies DRIVE+YIELD with a
    # broadcast + set_active_roles. The asker's @-back must land on
    # the broadcast.
    play_response = _Response(
        content=[
            _ContentBlock(
                type="tool_use",
                name="broadcast",
                input={"message": "Pulling Defender now."},
                id="tu_b_playturn",
            ),
            _ContentBlock(
                type="tool_use",
                name="set_active_roles",
                input={"role_ids": [creator_id]},
                id="tu_sar",
            ),
        ],
        stop_reason="tool_use",
    )
    mock = MockAnthropic({"play": [play_response]})
    client.app.state.llm.set_transport(mock.messages)

    auth_token = client.app.state.authn.mint(
        session_id=sid,
        role_id=creator_id,
        kind="creator",
        version=0,
    )
    with client.websocket_connect(
        f"/ws/sessions/{sid}?token={auth_token}"
    ) as ws:
        ws.send_json(
            {
                "type": "submit_response",
                "content": "@facilitator IOCs?",
                "intent": "ready",
                "mentions": [FACILITATOR_MENTION_TOKEN],
            }
        )
        for _ in range(12):
            try:
                ws.receive_json(mode="text", timeout=2.0)
            except Exception:
                break

    session = asyncio.run(client.app.state.manager.get_session(sid))
    ai_msg = next(
        m
        for m in reversed(session.messages)
        if m.kind.value == "ai_text" and m.tool_name == "broadcast"
    )
    assert creator_id in ai_msg.mentions, (
        "play-turn broadcast in response to a quorum-closing "
        "@facilitator submission must tag the asker; got "
        f"mentions={ai_msg.mentions!r}"
    )


# -----------------------------------------------------------------------
# Deletion regression — ensure the legacy heuristic is gone.
# -----------------------------------------------------------------------


def test_looks_like_question_helpers_removed_from_ws_routes() -> None:
    """``_looks_like_question`` and ``_QUESTION_PREFIXES`` must not
    exist on ``app.ws.routes`` anymore. Any future re-introduction
    would re-create the very brittleness Wave 2 deleted."""

    from app.ws import routes as ws_routes

    assert not hasattr(ws_routes, "_looks_like_question"), (
        "_looks_like_question was removed in Wave 2; the routing "
        "branch now reads ``mentions`` instead. Don't reintroduce it."
    )
    assert not hasattr(ws_routes, "_QUESTION_PREFIXES"), (
        "_QUESTION_PREFIXES was removed in Wave 2; don't reintroduce."
    )


def test_looks_like_question_helper_removed_from_api_routes() -> None:
    """The mirror copy in the REST proxy endpoint must also be gone."""

    from app.api import routes as api_routes

    assert not hasattr(api_routes, "_looks_like_question"), (
        "_looks_like_question was removed in Wave 2 from api/routes "
        "as well. The proxy-respond endpoint now branches on "
        "``mentions`` instead. Don't reintroduce it."
    )


def test_no_callsite_imports_looks_like_question() -> None:
    """Belt: source-grep the backend for any surviving import. A
    re-introduction would otherwise pass silently if it landed in a
    different module than the two we explicitly assert above."""

    import pathlib

    backend_app = pathlib.Path(__file__).parent.parent / "app"
    hits: list[str] = []
    for path in backend_app.rglob("*.py"):
        text = path.read_text()
        if "_looks_like_question" in text or "_QUESTION_PREFIXES" in text:
            hits.append(str(path.relative_to(backend_app)))
    assert not hits, (
        f"legacy heuristic symbol survived in: {hits}. "
        "Wave 2 deleted these — every callsite now branches on "
        "``mentions`` containing ``\"facilitator\"``."
    )
