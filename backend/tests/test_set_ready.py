"""Targeted tests for the decoupled ready quorum (PR #209).

PR #209 split the ``intent="ready"`` flag off the submission payload
into a dedicated ``set_ready`` WS event, dispatched in the manager by
:meth:`SessionManager.set_role_ready`. This file pins every branch of
that method end-to-end:

* idempotent re-mark — re-asserting the current state must ack
  cleanly without burning the per-turn flip cap or emitting an audit /
  broadcast
* per-role flip cap (``READY_FLIP_CAP_PER_TURN`` = 5) — toggles past
  the cap reject with ``flip_cap_exceeded`` and the broadcast / audit
  surface stays bounded
* server-side debounce (``READY_DEBOUNCE_MS`` = 250 ms) — same-role
  toggles arriving inside the window are silently dropped (accepted
  without state change), they don't burn the cap, and no
  ``ready_changed`` broadcast lands
* directed rejection reasons —
  ``not_awaiting_players`` / ``turn_already_advanced`` /
  ``no_current_turn`` / ``role_not_found`` / ``not_authorized`` /
  ``not_active_role``
* creator-impersonation auth — ``actor != subject`` is permitted only
  when the actor's role has ``is_creator=True``; otherwise it rejects
  with ``not_authorized`` even if the subject is on the active set
* monotonic ``client_seq`` echo — every accepted / rejected outcome
  carries the actor's ``client_seq`` back so the optimistic UI can
  reconcile
* WS routing surface — the directed ``set_ready_rejected`` /
  ``set_ready_ack`` frames land on the actor's socket; spectator
  tokens are blocked by ``require_participant`` before reaching the
  manager (would otherwise leak stateful rejection reasons)

Pairs with:
  * ``test_e2e_session.py`` — full WS-driven play loop using the new
    submit + set_ready dance.
  * ``tests/scenarios/test_scenario_runner.py`` — replay parity.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import reset_settings_cache
from app.main import create_app
from app.sessions.manager import (
    READY_DEBOUNCE_MS,
    READY_FLIP_CAP_PER_TURN,
    SetReadyOutcome,
)
from app.sessions.models import SessionState, Turn
from tests.conftest import default_settings_body
from tests.mock_chat_client import install_mock_chat_client


# Per-test env: keep all LLM model names mock-prefixed so the live
# Anthropic transport never gets reached, and pin a deterministic
# session secret. ``INPUT_GUARDRAIL_ENABLED=false`` is irrelevant for
# the manager-direct tests below but matches the rest of the suite.
@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> None:
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
        # Install a mock LLM client so the auto-kicked setup turn
        # on session creation never reaches the real Anthropic API.
        install_mock_chat_client(c)
        yield c


async def _seat_two_role_session(client: TestClient) -> dict[str, Any]:
    """Build a two-role session in ``AWAITING_PLAYERS`` with each
    role in its own singleton ASK group.

    The creator is the first role and is flagged ``is_creator=True``;
    the second role is a normal player. Both roles land in
    ``active_role_groups=[[creator_id], [other_id]]`` (two singleton
    groups, NOT a single combined group) so the quorum gate requires
    BOTH roles to mark ready before the turn advances. A combined
    ``[[creator_id, other_id]]`` group would close on the first
    toggle — any-member-ready closes a group (issue #168) — and
    would mask the multi-role quorum-gate tests below. The
    quorum-closing test explicitly narrows to a single-role group
    when it needs deterministic single-toggle advance.
    """
    resp = client.post(
        "/api/sessions",
        json={
            "scenario_prompt": "Set-ready test session",
            "creator_label": "CISO",
            "creator_display_name": "Alex",
            "skip_setup": True,
            **default_settings_body(),
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    sid = body["session_id"]
    creator_token = body["creator_token"]
    creator_id = body["creator_role_id"]

    role_resp = client.post(
        f"/api/sessions/{sid}/roles?token={creator_token}",
        json={"label": "SOC", "display_name": "Bo"},
    )
    assert role_resp.status_code == 200, role_resp.text
    other = role_resp.json()
    other_id = other["role_id"]
    other_token = other["token"]

    manager = client.app.state.manager
    session = await manager.get_session(sid)
    # Each role lives in its own ASK group so BOTH must mark ready
    # before the quorum closes (single-group `[[creator, other]]`
    # would close on the first toggle because any member ready
    # closes its group — issue #168). The two-singleton-group shape
    # is what most tests below want; the quorum-closing test
    # explicitly narrows to a single-role group.
    turn = Turn(
        index=0,
        active_role_groups=[[creator_id], [other_id]],
        status="awaiting",
    )
    session.turns.append(turn)
    session.state = SessionState.AWAITING_PLAYERS
    await manager._repo.save(session)

    return {
        "session_id": sid,
        "creator_id": creator_id,
        "creator_token": creator_token,
        "other_id": other_id,
        "other_token": other_token,
    }


# ----------------------------------------------------------------------
# Happy path — accepted toggle, optional quorum-close
# ----------------------------------------------------------------------


def test_set_ready_true_records_role_and_echoes_seq(client: TestClient) -> None:
    seats = asyncio.run(_seat_two_role_session(client))
    manager = client.app.state.manager

    async def _go() -> SetReadyOutcome:
        return await manager.set_role_ready(
            session_id=seats["session_id"],
            actor_role_id=seats["creator_id"],
            subject_role_id=seats["creator_id"],
            ready=True,
            client_seq=42,
        )

    outcome = asyncio.run(_go())
    assert outcome.accepted is True
    assert outcome.reason is None
    # Two-role group ASK — one ready does not close the quorum.
    assert outcome.ready_to_advance is False
    # Echo so the client can reconcile its optimistic flip.
    assert outcome.client_seq == 42

    session = asyncio.run(manager.get_session(seats["session_id"]))
    turn = session.current_turn
    assert turn is not None
    assert seats["creator_id"] in turn.ready_role_ids
    assert turn.ready_flip_count_by_role[seats["creator_id"]] == 1


def test_set_ready_closes_quorum_when_every_group_has_a_ready_role(
    client: TestClient,
) -> None:
    """The quorum closes when EVERY ASK group has at least one
    ready member (issue #168). The default fixture seats each role
    in its own group so we drive both toggles and assert the second
    one flips ``ready_to_advance=True`` and lands the session in
    ``AI_PROCESSING`` inside the same lock — without that the room
    would race a third toggle into the still-open gate."""

    seats = asyncio.run(_seat_two_role_session(client))
    manager = client.app.state.manager

    async def _go() -> tuple[SetReadyOutcome, SetReadyOutcome]:
        first = await manager.set_role_ready(
            session_id=seats["session_id"],
            actor_role_id=seats["creator_id"],
            subject_role_id=seats["creator_id"],
            ready=True,
            client_seq=1,
        )
        second = await manager.set_role_ready(
            session_id=seats["session_id"],
            actor_role_id=seats["other_id"],
            subject_role_id=seats["other_id"],
            ready=True,
            client_seq=1,
        )
        return first, second

    first, second = asyncio.run(_go())
    assert first.accepted is True
    assert first.ready_to_advance is False, (
        "first toggle closes one group but not the second — quorum still open"
    )
    assert second.accepted is True
    assert second.ready_to_advance is True
    # Manager must flip to AI_PROCESSING inside the same lock so a
    # follow-up ``set_role_ready`` can't race a re-open of the gate.
    session = asyncio.run(manager.get_session(seats["session_id"]))
    assert session.state == SessionState.AI_PROCESSING


# ----------------------------------------------------------------------
# Idempotent re-mark — accepted, no audit, no broadcast, no flip burn
# ----------------------------------------------------------------------


def test_set_ready_idempotent_remark_does_not_burn_flip_cap(
    client: TestClient,
) -> None:
    """Re-asserting the same state is an ack-only no-op. The flip cap
    is the surface a buggy / malicious client could hammer; the
    idempotent path explicitly bypasses the cap so a polite UI can
    re-send on reconnect without consuming credits."""

    seats = asyncio.run(_seat_two_role_session(client))
    manager = client.app.state.manager

    async def _go() -> tuple[SetReadyOutcome, SetReadyOutcome]:
        # Plant a real ready first so the re-mark is genuinely a no-op
        # (vs. asserting the initial state).
        first = await manager.set_role_ready(
            session_id=seats["session_id"],
            actor_role_id=seats["other_id"],
            subject_role_id=seats["other_id"],
            ready=True,
            client_seq=1,
        )
        # Re-mark the same state — must accept without touching the
        # flip cap counter, debounce ledger, audit log, or broadcast.
        second = await manager.set_role_ready(
            session_id=seats["session_id"],
            actor_role_id=seats["other_id"],
            subject_role_id=seats["other_id"],
            ready=True,
            client_seq=2,
        )
        return first, second

    first, second = asyncio.run(_go())
    assert first.accepted is True
    assert second.accepted is True
    # ``client_seq`` echoes through both paths so the client can
    # match the ack to the optimistic flip.
    assert second.client_seq == 2
    session = asyncio.run(manager.get_session(seats["session_id"]))
    turn = session.current_turn
    assert turn is not None
    # Critical: only ONE flip charged — the re-mark didn't touch the
    # ledger. Without this guard a misbehaving client could DOS the
    # audit log + broadcast surface by re-sending the current state.
    assert turn.ready_flip_count_by_role[seats["other_id"]] == 1

    # The audit log surface is the second DoS vector — a regression
    # that emits ``ready_changed`` on the idempotent path would
    # double the audit row count for a noisy reconnecting client.
    # Pin the emission count: exactly one ``ready_changed`` for the
    # first toggle, zero for the re-mark.
    audit_dump = manager.audit().dump(seats["session_id"])
    ready_changes = [e for e in audit_dump if e.kind == "ready_changed"]
    assert len(ready_changes) == 1, (
        f"idempotent re-mark must NOT emit a second ready_changed row; "
        f"got {len(ready_changes)} (kinds: {[e.kind for e in audit_dump]})"
    )


# ----------------------------------------------------------------------
# Per-role flip cap
# ----------------------------------------------------------------------


def test_set_ready_flip_cap_rejects_after_limit(client: TestClient) -> None:
    """``READY_FLIP_CAP_PER_TURN`` toggles per role per turn before the
    manager rejects with ``reason="flip_cap_exceeded"``. Toggle
    ready→not-ready alternately so each call is a real state flip
    (idempotent re-marks don't count). The debounce window would
    otherwise eat consecutive toggles, so we hand-back-date
    ``last_ready_change_ts_by_role`` between calls."""

    seats = asyncio.run(_seat_two_role_session(client))
    manager = client.app.state.manager
    role_id = seats["other_id"]

    async def _flip_n(n: int, *, start_ready: bool = True) -> SetReadyOutcome:
        last: SetReadyOutcome | None = None
        ready = start_ready
        for i in range(n):
            # Back-date the last accepted toggle so the debounce gate
            # doesn't silently drop the next call. Done inside the
            # manager's per-session lock would be ideal; the repo
            # write is short enough that re-fetching outside the lock
            # is safe under the test's single-task driver.
            session = await manager.get_session(seats["session_id"])
            turn = session.current_turn
            assert turn is not None
            turn.last_ready_change_ts_by_role[role_id] = (
                datetime.now(UTC) - timedelta(milliseconds=READY_DEBOUNCE_MS + 50)
            )
            await manager._repo.save(session)

            last = await manager.set_role_ready(
                session_id=seats["session_id"],
                actor_role_id=role_id,
                subject_role_id=role_id,
                ready=ready,
                client_seq=i + 1,
            )
            ready = not ready
        assert last is not None
        return last

    # Burn the cap with alternating flips — each is a real state
    # change so the cap counter ticks every time. The cap=5 default
    # means 5 accepted flips, then the 6th rejects.
    accepted = asyncio.run(_flip_n(READY_FLIP_CAP_PER_TURN))
    assert accepted.accepted is True

    async def _one_more() -> SetReadyOutcome:
        # One more flip — over the cap.
        session = await manager.get_session(seats["session_id"])
        turn = session.current_turn
        assert turn is not None
        # Push past debounce again.
        turn.last_ready_change_ts_by_role[role_id] = (
            datetime.now(UTC) - timedelta(milliseconds=READY_DEBOUNCE_MS + 50)
        )
        await manager._repo.save(session)
        # Whatever state the alternation finished on, request the
        # opposite so this is a real flip request (not idempotent).
        last_ready = role_id in turn.ready_role_ids
        return await manager.set_role_ready(
            session_id=seats["session_id"],
            actor_role_id=role_id,
            subject_role_id=role_id,
            ready=not last_ready,
            client_seq=999,
        )

    rejected = asyncio.run(_one_more())
    assert rejected.accepted is False
    assert rejected.reason == "flip_cap_exceeded"
    assert rejected.ready_to_advance is False
    assert rejected.client_seq == 999  # echo even on rejection

    # Cap counter must be exactly the cap — the rejected flip did
    # NOT increment past it.
    session = asyncio.run(manager.get_session(seats["session_id"]))
    turn = session.current_turn
    assert turn is not None
    assert turn.ready_flip_count_by_role[role_id] == READY_FLIP_CAP_PER_TURN


# ----------------------------------------------------------------------
# Debounce
# ----------------------------------------------------------------------


def test_set_ready_debounce_drops_burst_toggles_silently(
    client: TestClient,
) -> None:
    """Toggles within ``READY_DEBOUNCE_MS`` of the previous accepted
    toggle are silently accepted (no state change, no broadcast, no
    flip-cap charge). The point of the debounce is to smooth
    accidental double-clicks without burning the cap — without it a
    button-mashing user would consume the per-turn flip budget on a
    single intent."""

    seats = asyncio.run(_seat_two_role_session(client))
    manager = client.app.state.manager
    role_id = seats["other_id"]

    async def _go() -> tuple[SetReadyOutcome, SetReadyOutcome]:
        # First call — real flip from not-ready to ready. Plants a
        # ``last_ready_change_ts_by_role`` entry "now-ish".
        first = await manager.set_role_ready(
            session_id=seats["session_id"],
            actor_role_id=role_id,
            subject_role_id=role_id,
            ready=True,
            client_seq=1,
        )
        # Second call — request the OPPOSITE state so it's a genuine
        # flip request (not idempotent), arriving inside the debounce
        # window. The manager must accept (so the optimistic UI gets
        # a clean ack) but NOT mutate state.
        second = await manager.set_role_ready(
            session_id=seats["session_id"],
            actor_role_id=role_id,
            subject_role_id=role_id,
            ready=False,
            client_seq=2,
        )
        return first, second

    first, second = asyncio.run(_go())
    assert first.accepted is True
    assert second.accepted is True
    assert second.client_seq == 2

    # Critical state asserts: only the FIRST toggle landed.
    session = asyncio.run(manager.get_session(seats["session_id"]))
    turn = session.current_turn
    assert turn is not None
    # Role still ready — the second (debounced) call did NOT remove it.
    assert role_id in turn.ready_role_ids
    # Flip counter only ticked once.
    assert turn.ready_flip_count_by_role[role_id] == 1
    # Audit-log surface bounded too: the debounced toggle emits NO
    # ``ready_changed`` row. A regression that audited the
    # silent-accept path would re-introduce the DoS vector the
    # debounce was added to close.
    audit_dump = manager.audit().dump(seats["session_id"])
    ready_changes = [e for e in audit_dump if e.kind == "ready_changed"]
    assert len(ready_changes) == 1, (
        f"debounced toggle must NOT emit a second ready_changed row; "
        f"got {len(ready_changes)}"
    )


# ----------------------------------------------------------------------
# Authorization — actor vs. subject
# ----------------------------------------------------------------------


def test_set_ready_creator_can_impersonate_other_role(client: TestClient) -> None:
    """Creator-impersonation: the creator's role is allowed to flip
    another role's ready (mirrors ``proxy_submit_as``). Both ids are
    persisted distinct on the audit row so a future review can spot
    creator-impersonation paths separately from self-toggles.
    """

    seats = asyncio.run(_seat_two_role_session(client))
    manager = client.app.state.manager

    async def _go() -> SetReadyOutcome:
        return await manager.set_role_ready(
            session_id=seats["session_id"],
            actor_role_id=seats["creator_id"],
            subject_role_id=seats["other_id"],
            ready=True,
            client_seq=7,
        )

    outcome = asyncio.run(_go())
    assert outcome.accepted is True
    session = asyncio.run(manager.get_session(seats["session_id"]))
    turn = session.current_turn
    assert turn is not None
    assert seats["other_id"] in turn.ready_role_ids


def test_set_ready_non_creator_cannot_impersonate_another_role(
    client: TestClient,
) -> None:
    """Non-creator impersonation is the surface a stale-token /
    griefer would use. Reject loud (``not_authorized``) — the actor
    sees the rejection on its own socket and the subject's state is
    untouched, no broadcast leaks the attempt to the rest of the
    room."""

    seats = asyncio.run(_seat_two_role_session(client))
    manager = client.app.state.manager

    async def _go() -> SetReadyOutcome:
        return await manager.set_role_ready(
            session_id=seats["session_id"],
            actor_role_id=seats["other_id"],
            subject_role_id=seats["creator_id"],
            ready=True,
            client_seq=11,
        )

    outcome = asyncio.run(_go())
    assert outcome.accepted is False
    assert outcome.reason == "not_authorized"
    assert outcome.client_seq == 11
    session = asyncio.run(manager.get_session(seats["session_id"]))
    turn = session.current_turn
    assert turn is not None
    assert seats["creator_id"] not in turn.ready_role_ids
    # The flip cap must NOT tick on rejections — a future bug that
    # incremented the counter before the auth check would let an
    # attacker DoS another role's per-turn flip budget without
    # actually flipping state. Locks the auth-then-mutate ordering.
    assert turn.ready_flip_count_by_role.get(seats["creator_id"], 0) == 0


# ----------------------------------------------------------------------
# Active-set gating
# ----------------------------------------------------------------------


def test_set_ready_rejects_role_not_in_active_set(client: TestClient) -> None:
    """A role that isn't on the current turn's active set can't flip
    ready — the gate is the active-set membership, not just being
    seated. Without this an out-of-turn role's ready flip would
    incorrectly close the quorum and stall players who legitimately
    owe responses."""

    seats = asyncio.run(_seat_two_role_session(client))
    manager = client.app.state.manager

    async def _setup() -> None:
        # Restrict the active set to the creator only — the SOC role
        # is now "off-turn" and ready-flips for it must be rejected.
        session = await manager.get_session(seats["session_id"])
        turn = session.current_turn
        assert turn is not None
        turn.active_role_groups = [[seats["creator_id"]]]
        await manager._repo.save(session)

    asyncio.run(_setup())

    async def _go() -> SetReadyOutcome:
        return await manager.set_role_ready(
            session_id=seats["session_id"],
            actor_role_id=seats["other_id"],
            subject_role_id=seats["other_id"],
            ready=True,
            client_seq=3,
        )

    outcome = asyncio.run(_go())
    assert outcome.accepted is False
    assert outcome.reason == "not_active_role"
    assert outcome.client_seq == 3
    # Rejection MUST NOT tick the flip cap — see authz test for the
    # threat model. Same gate, different rejection path.
    session = asyncio.run(manager.get_session(seats["session_id"]))
    turn = session.current_turn
    assert turn is not None
    assert seats["other_id"] not in turn.ready_role_ids
    assert turn.ready_flip_count_by_role.get(seats["other_id"], 0) == 0


# ----------------------------------------------------------------------
# State-machine rejection branches
# ----------------------------------------------------------------------


def test_set_ready_rejects_when_session_is_ai_processing(
    client: TestClient,
) -> None:
    """Once the quorum closes and the session flips to ``AI_PROCESSING``,
    additional ready toggles must reject with
    ``turn_already_advanced`` so the optimistic UI can revert without
    flapping the server-authoritative state. Without this, a player
    walking-back ready 80 ms after another player closed the quorum
    would unwind the AI call mid-stream."""

    seats = asyncio.run(_seat_two_role_session(client))
    manager = client.app.state.manager

    async def _go() -> SetReadyOutcome:
        session = await manager.get_session(seats["session_id"])
        session.state = SessionState.AI_PROCESSING
        await manager._repo.save(session)
        return await manager.set_role_ready(
            session_id=seats["session_id"],
            actor_role_id=seats["other_id"],
            subject_role_id=seats["other_id"],
            ready=False,  # walk-back attempt
            client_seq=5,
        )

    outcome = asyncio.run(_go())
    assert outcome.accepted is False
    assert outcome.reason == "turn_already_advanced"
    assert outcome.client_seq == 5


def test_set_ready_rejects_when_session_state_is_neither_awaiting_nor_processing(
    client: TestClient,
) -> None:
    """``BRIEFING`` / ``READY`` / ``ENDED`` etc. — neither
    ``AWAITING_PLAYERS`` nor ``AI_PROCESSING`` — return the generic
    ``not_awaiting_players`` reason. Distinct from
    ``turn_already_advanced`` so the UI can render a different
    message ("session ended" vs "another player closed it")."""

    seats = asyncio.run(_seat_two_role_session(client))
    manager = client.app.state.manager

    async def _go() -> SetReadyOutcome:
        session = await manager.get_session(seats["session_id"])
        session.state = SessionState.ENDED
        await manager._repo.save(session)
        return await manager.set_role_ready(
            session_id=seats["session_id"],
            actor_role_id=seats["other_id"],
            subject_role_id=seats["other_id"],
            ready=True,
            client_seq=8,
        )

    outcome = asyncio.run(_go())
    assert outcome.accepted is False
    assert outcome.reason == "not_awaiting_players"
    assert outcome.client_seq == 8


def test_set_ready_rejects_unknown_role_id(client: TestClient) -> None:
    """An unknown ``actor_role_id`` or ``subject_role_id`` returns
    ``role_not_found``. Surface separately from ``not_authorized`` so
    a kicked / revoked role's stale token surfaces a distinct (and
    grep-able) rejection in the audit log."""

    seats = asyncio.run(_seat_two_role_session(client))
    manager = client.app.state.manager

    async def _go() -> SetReadyOutcome:
        return await manager.set_role_ready(
            session_id=seats["session_id"],
            actor_role_id=seats["creator_id"],
            subject_role_id="not-a-real-role-id",
            ready=True,
            client_seq=13,
        )

    outcome = asyncio.run(_go())
    assert outcome.accepted is False
    assert outcome.reason == "role_not_found"
    assert outcome.client_seq == 13
    # Rejection MUST NOT tick the flip cap.
    session = asyncio.run(manager.get_session(seats["session_id"]))
    turn = session.current_turn
    assert turn is not None
    assert turn.ready_flip_count_by_role == {}


def test_set_ready_rejects_when_no_current_turn(client: TestClient) -> None:
    """Defensive branch: ``AWAITING_PLAYERS`` with no turns appended
    should never happen in production (the state transitions append
    a turn first), but the manager guards against it to fail loud
    with ``no_current_turn`` rather than crashing on the
    ``turn.ready_role_ids`` access."""

    seats = asyncio.run(_seat_two_role_session(client))
    manager = client.app.state.manager

    async def _go() -> SetReadyOutcome:
        session = await manager.get_session(seats["session_id"])
        # Hold AWAITING_PLAYERS but drop every turn — exercises the
        # ``current_turn is None`` branch.
        session.turns = []
        await manager._repo.save(session)
        return await manager.set_role_ready(
            session_id=seats["session_id"],
            actor_role_id=seats["creator_id"],
            subject_role_id=seats["creator_id"],
            ready=True,
            client_seq=21,
        )

    outcome = asyncio.run(_go())
    assert outcome.accepted is False
    assert outcome.reason == "no_current_turn"
    assert outcome.client_seq == 21


# ----------------------------------------------------------------------
# Walk-back semantics
# ----------------------------------------------------------------------


def test_set_ready_false_removes_role_and_flips_cap(client: TestClient) -> None:
    """A real walk-back (ready→not-ready) is a state flip — the role
    is removed from ``ready_role_ids`` and the per-role flip counter
    increments. The walk-back path also fires a dedicated
    ``ready_walk_back`` audit kind so creators can spot griefing
    patterns ("X walked back ready 5 times")."""

    seats = asyncio.run(_seat_two_role_session(client))
    manager = client.app.state.manager

    async def _go() -> tuple[SetReadyOutcome, SetReadyOutcome]:
        first = await manager.set_role_ready(
            session_id=seats["session_id"],
            actor_role_id=seats["other_id"],
            subject_role_id=seats["other_id"],
            ready=True,
            client_seq=1,
        )
        # Walk back. Push past debounce so this is a real toggle.
        session = await manager.get_session(seats["session_id"])
        turn = session.current_turn
        assert turn is not None
        turn.last_ready_change_ts_by_role[seats["other_id"]] = (
            datetime.now(UTC) - timedelta(milliseconds=READY_DEBOUNCE_MS + 50)
        )
        await manager._repo.save(session)
        second = await manager.set_role_ready(
            session_id=seats["session_id"],
            actor_role_id=seats["other_id"],
            subject_role_id=seats["other_id"],
            ready=False,
            client_seq=2,
        )
        return first, second

    first, second = asyncio.run(_go())
    assert first.accepted is True
    assert second.accepted is True

    session = asyncio.run(manager.get_session(seats["session_id"]))
    turn = session.current_turn
    assert turn is not None
    assert seats["other_id"] not in turn.ready_role_ids
    # Two real flips — both ticked the cap.
    assert turn.ready_flip_count_by_role[seats["other_id"]] == 2

    # Walk-back fires a dedicated ``ready_walk_back`` audit kind
    # alongside the generic ``ready_changed`` row so the creator's
    # /activity panel can surface "X walked back ready N times" — a
    # griefing detection signal the high-volume toggle stream would
    # otherwise bury (manager.py:1307-1319). Pin the audit emission
    # so a refactor that drops the dedicated row fails loud.
    audit_dump = manager.audit().dump(seats["session_id"])
    walk_backs = [e for e in audit_dump if e.kind == "ready_walk_back"]
    assert len(walk_backs) == 1, (
        f"walk-back must emit exactly one ready_walk_back audit row; "
        f"got {len(walk_backs)} (kinds seen: {[e.kind for e in audit_dump]})"
    )
    assert walk_backs[0].payload["actor_role_id"] == seats["other_id"]
    assert walk_backs[0].payload["subject_role_id"] == seats["other_id"]


# ----------------------------------------------------------------------
# WS routing — directed frames + spectator gate
# ----------------------------------------------------------------------


def _drain(
    ws: Any,
    *,
    kinds: tuple[str, ...],
    cap: int = 64,
    timeout: float = 2.0,
) -> dict[str, Any] | None:
    """Receive WS events until one of ``kinds`` shows up or the cap
    is reached. Returns the matching event or ``None``.

    Starlette's ``WebSocketTestSession.receive_json`` does NOT accept
    a ``timeout`` kwarg — it blocks indefinitely on the underlying
    queue. Without an external bound, a regression that drops the
    expected frame would hang CI on this drain (Copilot review on
    PR #218). We bound each call by running it in a daemon thread
    and ``join(timeout=...)``-ing — if the thread is still alive
    after the timeout we abandon it (daemon, so it dies with the
    test) and return ``None`` so the caller's assertion fails fast.

    Exceptions raised by ``receive_json`` (closed socket, JSON decode
    failure) are logged before swallowing so the test failure points
    at the protocol problem rather than reporting a confusing
    "matching event never arrived". Per CLAUDE.md "Logging rules" —
    swallowed exceptions are bug-amplifiers in test infra too.
    """

    import threading

    def _recv(holder: dict[str, Any]) -> None:
        try:
            holder["evt"] = ws.receive_json()
        except Exception as exc:
            holder["err"] = exc

    for _ in range(cap):
        result_holder: dict[str, Any] = {}
        t = threading.Thread(
            target=_recv, args=(result_holder,), daemon=True
        )
        t.start()
        t.join(timeout=timeout)
        if t.is_alive():
            # Daemon thread will die with the test process.
            print(
                f"[test_set_ready] _drain: timed out after {timeout}s "
                f"waiting for {kinds!r}"
            )
            return None
        if "err" in result_holder:
            print(
                f"[test_set_ready] _drain: socket error before "
                f"{kinds!r} arrived: {result_holder['err']!r}"
            )
            return None
        evt = result_holder["evt"]
        if evt.get("type") in kinds:
            return evt
    return None


def test_ws_set_ready_emits_directed_ack_on_accepted_toggle(
    client: TestClient,
) -> None:
    """Even on an accepted toggle, the WS handler MUST send a
    directed ``set_ready_ack`` so the actor's optimistic flip
    reconciles against ``client_seq``. Idempotent re-marks and
    debounce-dropped toggles fire no ``ready_changed`` broadcast,
    so without a directed ack on EVERY accepted call the UI would
    silently get stuck on those silent-accept paths.
    """

    seats = asyncio.run(_seat_two_role_session(client))
    sid = seats["session_id"]

    with client.websocket_connect(
        f"/ws/sessions/{sid}?token={seats['other_token']}"
    ) as ws:
        ws.send_json({"type": "set_ready", "ready": True, "client_seq": 17})
        evt = _drain(ws, kinds=("set_ready_ack", "set_ready_rejected"))
    assert evt is not None, "WS handler must directed-ack every set_ready"
    assert evt["type"] == "set_ready_ack"
    assert evt["client_seq"] == 17
    # Two-role group → first toggle does not advance.
    assert evt["ready_to_advance"] is False


def test_ws_set_ready_emits_directed_rejection_for_unauthorized_actor(
    client: TestClient,
) -> None:
    """The non-creator actor's impersonation attempt must surface as
    a directed ``set_ready_rejected{reason: "not_authorized"}``
    frame on the actor's socket — not as a broadcast to the room.
    Other clients receive nothing."""

    seats = asyncio.run(_seat_two_role_session(client))
    sid = seats["session_id"]

    with client.websocket_connect(
        f"/ws/sessions/{sid}?token={seats['other_token']}"
    ) as ws:
        ws.send_json(
            {
                "type": "set_ready",
                "ready": True,
                "client_seq": 99,
                "subject_role_id": seats["creator_id"],
            }
        )
        evt = _drain(ws, kinds=("set_ready_ack", "set_ready_rejected"))
    assert evt is not None
    assert evt["type"] == "set_ready_rejected"
    assert evt["reason"] == "not_authorized"
    assert evt["client_seq"] == 99


def test_ws_set_ready_rejects_malformed_payload(client: TestClient) -> None:
    """``ready`` must be ``bool`` (not int / not str) and
    ``client_seq`` must be an ``int`` (Python's ``isinstance(x, int)``
    is True for booleans because ``bool`` subclasses ``int``;
    PR #209 Copilot review flagged this and the handler now uses
    ``type(x) is int`` to reject ``True/False`` for ``client_seq``).
    """

    seats = asyncio.run(_seat_two_role_session(client))
    sid = seats["session_id"]

    def _assert_only_error(payload: dict[str, Any]) -> None:
        """Send the malformed payload, assert ``error{scope=set_ready}``
        landed AND no ``set_ready_ack`` / ``set_ready_rejected`` frame
        leaked after it. The leaked-frame check guards against a
        future regression where the handler logs the error but falls
        through into ``manager.set_role_ready`` anyway — the manager
        would then echo the boolean ``client_seq`` back through the
        ack frame, defeating the type-coercion guard.
        """
        with client.websocket_connect(
            f"/ws/sessions/{sid}?token={seats['other_token']}"
        ) as ws:
            ws.send_json(payload)
            evt = _drain(
                ws, kinds=("error", "set_ready_ack", "set_ready_rejected")
            )
            assert evt is not None
            assert evt["type"] == "error"
            assert evt["scope"] == "set_ready"
            # Drain a few more events to confirm no late ack leaked.
            # The handler ``continue``s the loop after the error so
            # only unrelated traffic (presence, etc.) should follow.
            for _ in range(8):
                try:
                    extra = ws.receive_json(mode="text", timeout=0.2)
                except Exception:
                    break
                assert extra.get("type") not in (
                    "set_ready_ack",
                    "set_ready_rejected",
                ), (
                    f"malformed payload leaked a stateful set_ready frame "
                    f"after the error: {extra!r}"
                )

    # Boolean ``client_seq`` — stale / buggy clients have shipped this;
    # ``isinstance(True, int)`` is True so the handler uses
    # ``type(client_seq_raw) is not int`` to reject (PR #209 Copilot).
    _assert_only_error({"type": "set_ready", "ready": True, "client_seq": True})
    # String ``ready`` — common stale-client mistake.
    _assert_only_error({"type": "set_ready", "ready": "true", "client_seq": 1})


def test_ws_set_ready_rejects_spectator_token(client: TestClient) -> None:
    """Spectators can connect to the session WS for read-only fan-
    out, but every mutating event MUST go through
    ``require_participant`` first. Without this gate a spectator
    could call ``set_role_ready`` and leak stateful rejection
    reasons (``not_active_role`` confirms a role exists,
    ``flip_cap_exceeded`` reveals the cap counter), and would
    amplify into a high-volume broadcaster against the room.
    Copilot review on PR #209 explicitly added ``set_ready`` to
    the participant gate."""

    seats = asyncio.run(_seat_two_role_session(client))
    sid = seats["session_id"]

    # Mint a spectator-kind token reusing one of the seated roles —
    # the public role-add path doesn't currently mint spectator
    # tokens, so we go through the authn module directly (same
    # pattern as ``test_ws_rejects_spectator_for_mutating_events``).
    authn = client.app.state.authn
    spectator_token = authn.mint(
        session_id=sid, role_id=seats["other_id"], kind="spectator"
    )

    with client.websocket_connect(
        f"/ws/sessions/{sid}?token={spectator_token}"
    ) as ws:
        ws.send_json({"type": "set_ready", "ready": True, "client_seq": 1})
        # Either an ``error`` frame with scope=set_ready, OR the WS
        # gets closed — the handler emits the error and ``continue``s
        # the loop. We assert no ack/rejected leaked back so the
        # spectator never observed the manager's stateful response.
        saw_error = False
        saw_ack = False
        for _ in range(64):
            try:
                evt = ws.receive_json()
            except Exception as exc:
                print(f"[test_set_ready] spectator drain socket error: {exc!r}")
                break
            # Match on (type, scope) — a future regression that swaps
            # the rejection to a different scope (say, ``auth``) must
            # NOT be silently accepted by this test. Tighten to the
            # exact scope this branch produces.
            if evt.get("type") == "error" and evt.get("scope") == "set_ready":
                saw_error = True
                break
            if evt.get("type") in ("set_ready_ack", "set_ready_rejected"):
                saw_ack = True
                break
        assert saw_error, (
            "spectator must be rejected by require_participant before "
            "the manager runs — if they reach the manager they'd see "
            "ack/rejected frames."
        )
        assert not saw_ack, (
            "spectator must NEVER observe set_ready_ack / set_ready_rejected "
            "(those are stateful and leak the room's authoritative state)"
        )

    # Manager state is untouched — no ready ever recorded.
    manager = client.app.state.manager
    session = asyncio.run(manager.get_session(sid))
    turn = session.current_turn
    assert turn is not None
    assert seats["other_id"] not in turn.ready_role_ids
    assert turn.ready_flip_count_by_role.get(seats["other_id"], 0) == 0


def test_ws_set_ready_quorum_close_drives_play_turn(client: TestClient) -> None:
    """Closing the quorum via WS must kick the next play turn — same
    dispatch site the legacy submit-and-advance used to fire from.
    Without this the room would block forever after the second-to-
    last toggle: the manager flips state to ``AI_PROCESSING`` but
    never starts the AI call, so the UI's "AI is thinking" indicator
    spins indefinitely."""

    from tests.mock_chat_client import llm_result, tool_block

    seats = asyncio.run(_seat_two_role_session(client))
    sid = seats["session_id"]

    # Single-role group via active-set narrowing so ONE ready toggle
    # closes the quorum (keeps the test deterministic and minimises
    # the script).
    async def _narrow() -> None:
        manager = client.app.state.manager
        session = await manager.get_session(sid)
        turn = session.current_turn
        assert turn is not None
        turn.active_role_groups = [[seats["other_id"]]]
        await manager._repo.save(session)

    asyncio.run(_narrow())

    play_response = llm_result(
        tool_block("broadcast", {"message": "Got it. Move to containment."}, block_id="tu_b"),
        tool_block("set_active_roles", {"role_groups": [[seats["other_id"]]]}, block_id="tu_y"),
        stop_reason="tool_use",
    )
    mock = install_mock_chat_client(client, {"play": [play_response]})

    with client.websocket_connect(
        f"/ws/sessions/{sid}?token={seats['other_token']}"
    ) as ws:
        ws.send_json({"type": "set_ready", "ready": True, "client_seq": 1})
        # Drain for the directed ``set_ready_ack`` carrying
        # ``ready_to_advance=True``. The post-condition assertions
        # below (mock play-call count + transcript broadcast) prove
        # the WS dispatch site actually fired ``run_play_turn``; the
        # ack only confirms the manager flipped the gate. We don't
        # try to drain the ``message_complete`` broadcast over this
        # socket because ``run_play_turn`` is awaited inline by the
        # WS handler before the ack is sent, and the broadcast may
        # have already landed (and been replayed) before the WS
        # context exits.
        ack = _drain(ws, kinds=("set_ready_ack",))
        assert ack is not None
        assert ack["ready_to_advance"] is True

    # The mock LLM was called exactly once for the play tier.
    play_calls = [c for c in mock.calls if c.get("tier") == "play"]
    assert len(play_calls) == 1, (
        "set_ready quorum-close must drive run_play_turn exactly once; "
        f"got {len(play_calls)} play call(s)"
    )

    # The broadcast landed in the transcript.
    snap = client.get(f"/api/sessions/{sid}?token={seats['creator_token']}").json()
    broadcasts = [
        m for m in snap["messages"] if m.get("tool_name") == "broadcast"
    ]
    assert any("containment" in (b.get("body") or "") for b in broadcasts), (
        f"play turn broadcast missing; got bodies: "
        f"{[b.get('body') for b in broadcasts]}"
    )


# ----------------------------------------------------------------------
# Submission ↔ ready decoupling regression
# ----------------------------------------------------------------------


def test_submit_response_does_not_touch_ready_role_ids(client: TestClient) -> None:
    """The whole point of PR #209: ``submit_response`` MUST never
    touch ``ready_role_ids``. A regression that re-couples ready to
    submission would re-introduce the bug where a player mid-typing
    gets locked out when another player's ready closes the quorum.
    Locks the invariant directly at the manager API."""

    from app.sessions.submission_pipeline import (
        prepare_and_submit_player_response,
    )

    seats = asyncio.run(_seat_two_role_session(client))
    manager = client.app.state.manager

    async def _go() -> None:
        await prepare_and_submit_player_response(
            manager=manager,
            session_id=seats["session_id"],
            role_id=seats["other_id"],
            content="Containing now.",
            mentions=[],
        )

    asyncio.run(_go())

    session = asyncio.run(manager.get_session(seats["session_id"]))
    turn = session.current_turn
    assert turn is not None
    # Submission landed.
    assert seats["other_id"] in turn.submitted_role_ids
    # Ready quorum untouched.
    assert seats["other_id"] not in turn.ready_role_ids
    assert turn.ready_flip_count_by_role.get(seats["other_id"], 0) == 0
    # Session still AWAITING_PLAYERS — submissions never advance.
    assert session.state == SessionState.AWAITING_PLAYERS


