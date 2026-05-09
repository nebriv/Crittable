"""WebSocket endpoint."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, status

from ..auth.authn import HMACAuthenticator, InvalidTokenError, ParticipantKindLiteral
from ..auth.authz import AuthorizationError, require_creator, require_participant
from ..config import Settings
from ..logging_setup import bind_session_context, clear_session_context, get_logger
from ..sessions.manager import SessionManager
from ..sessions.repository import SessionNotFoundError
from ..sessions.turn_driver import TurnDriver
from ..sessions.turn_engine import IllegalTransitionError
from .connection_manager import ConnectionManager, _Connection

_logger = get_logger("ws.routes")

CLOSE_BAD_TOKEN = 4401
CLOSE_NOT_FOUND = 4404
CLOSE_BAD_PAYLOAD = 4400
CLOSE_FORBIDDEN_ORIGIN = 4403
CLOSE_HEARTBEAT_TIMEOUT = 4408


def register_ws_routes(app: FastAPI) -> None:
    @app.websocket("/ws/sessions/{session_id}")
    async def session_socket(websocket: WebSocket, session_id: str) -> None:
        authn: HMACAuthenticator = websocket.app.state.authn
        manager: SessionManager = websocket.app.state.manager
        connections: ConnectionManager = websocket.app.state.connections
        settings: Settings = websocket.app.state.settings

        # Origin check — when the operator has narrowed CORS_ORIGINS, refuse WS
        # upgrades from any other origin. This is the post-token-leak defense:
        # even if a join URL escapes (referrer header, screenshot, support
        # session), it can't be opened from a malicious page.
        cors = settings.cors_origin_list()
        if cors != "*":
            origin = websocket.headers.get("origin")
            if not origin or origin not in cors:
                _logger.warning(
                    "ws_origin_rejected",
                    session_id=session_id,
                    origin=origin,
                    allowed=cors,
                )
                await websocket.close(code=CLOSE_FORBIDDEN_ORIGIN)
                return

        token = websocket.query_params.get("token")
        if not token:
            await websocket.close(code=CLOSE_BAD_TOKEN)
            return
        try:
            payload = authn.verify(token)
        except InvalidTokenError:
            await websocket.close(code=CLOSE_BAD_TOKEN)
            return
        if payload["session_id"] != session_id:
            await websocket.close(code=CLOSE_BAD_TOKEN)
            return

        try:
            session = await manager.get_session(session_id)
        except SessionNotFoundError:
            await websocket.close(code=CLOSE_NOT_FOUND)
            return

        # Token-version check — same revocation primitive as REST. A kicked
        # role's tab gets a 4401 close on (re)connect.
        role = session.role_by_id(payload["role_id"])
        if role is None or int(payload.get("v", 0)) != role.token_version:
            await websocket.close(code=CLOSE_BAD_TOKEN)
            return

        is_creator = payload["role_id"] == session.creator_role_id
        bind_session_context(session_id=session_id, role_id=payload["role_id"])
        await websocket.accept()

        conn = await connections.register(
            session_id=session_id,
            role_id=payload["role_id"],
            is_creator=is_creator,
            websocket=websocket,
        )
        _logger.info(
            "ws_connected",
            session_id=session_id,
            role_id=payload["role_id"],
            kind=payload["kind"],
            is_creator=is_creator,
        )

        # Presence: tell every other connection that this role is now
        # online, and tell the new connection who is currently online so
        # its UI doesn't have to wait for the next event to populate.
        # Presence frames are NOT recorded in the replay buffer — they
        # describe live state, not history; replaying a stale "online"
        # event after the player has actually disconnected would be
        # misleading. See issue #52.
        connected = await connections.connected_role_ids(session_id)
        focused = await connections.focused_role_ids(session_id)
        # Total open WS tabs (distinct from ``connected`` role count). The
        # creator's top bar surfaces this so they can see at a glance how
        # many participant tabs are watching the session — useful when
        # facilitating to spot dropped tabs vs stale invitee links.
        conn_count = await connections.connection_count(session_id)
        await websocket.send_json(
            {
                "type": "presence_snapshot",
                "role_ids": connected,
                "focused_role_ids": focused,
                "connection_count": conn_count,
            }
        )
        await connections.broadcast(
            session_id,
            {
                "type": "presence",
                "role_id": payload["role_id"],
                "active": True,
                "focused": True,
                "connection_count": conn_count,
            },
            record=False,
        )

        recv_task = asyncio.create_task(
            _client_pump(
                websocket=websocket,
                manager=manager,
                session_id=session_id,
                role_id=payload["role_id"],
                kind=payload["kind"],
                token_version=int(payload.get("v", 0)),
                conn=conn,
                connections=connections,
            )
        )
        send_task = asyncio.create_task(_server_pump(websocket, conn, connections))

        try:
            _done, pending = await asyncio.wait(
                {recv_task, send_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
        finally:
            await connections.unregister(conn)
            _logger.info(
                "ws_disconnected",
                session_id=session_id,
                role_id=payload["role_id"],
            )
            # Only emit ``offline`` when this was the role's last open
            # connection. A creator with two tabs open who closes one
            # should still show as active in everyone else's roster.
            still_connected = await connections.role_has_other_connections(
                session_id, payload["role_id"]
            )
            # Recompute the total connection count *after* this conn has
            # been unregistered so the broadcast reflects the new tab
            # total. Always emit on disconnect (even when the role is
            # still connected via another tab) so the count stays
            # accurate — a creator with two tabs who closes one should
            # see the count drop in real time.
            conn_count = await connections.connection_count(session_id)
            if not still_connected:
                await connections.broadcast(
                    session_id,
                    {
                        "type": "presence",
                        "role_id": payload["role_id"],
                        "active": False,
                        "focused": False,
                        "connection_count": conn_count,
                    },
                    record=False,
                )
            else:
                # Role still has other tabs — but the tab count changed,
                # so emit a count-only update for the top-bar chip.
                # ``focused`` reflects whether *any* remaining tab is in
                # the foreground; if all surviving tabs are background,
                # the role drops to "joined but not active".
                role_focused = await connections.role_has_focused_connection(
                    session_id, payload["role_id"]
                )
                await connections.broadcast(
                    session_id,
                    {
                        "type": "presence",
                        "role_id": payload["role_id"],
                        "active": True,
                        "focused": role_focused,
                        "connection_count": conn_count,
                    },
                    record=False,
                )
            clear_session_context()


async def _broadcast_typing(
    *,
    manager: SessionManager,
    session_id: str,
    role_id: str,
    typing: bool,
) -> None:
    """Fan out a ``typing`` event to every connection on the session.

    The receiving clients filter by ``role_id`` so a sender doesn't echo
    their own typing state. Kept symmetric (start + stop both broadcast)
    rather than only-on-change, because clients expire their own state.

    ``record=False`` keeps these out of the replay buffer — typing is a
    stale signal by the time anyone reconnects, and they're emitted at
    high volume (~1 Hz/typer post issue #77) so they'd evict legitimate
    state events from the bounded buffer otherwise.

    Issue #77 sub-agent review (Security L2 + project logging policy):
    a *complete-silence* relay leaves ops with no signal if a
    malicious client floods or a flapping connection causes the
    cadence to spike. We emit a ``debug`` line per packet — yes,
    that's once per heartbeat per typing user (~1 Hz × concurrent
    typers), but at debug level it's filtered out in production by
    default and gives operators a complete bisection trail when
    investigating cadence anomalies. If volume becomes a concern,
    swap to per-(session, role) edge-tracking with a TTL — sketch
    in the Copilot-review thread on PR #99.
    """

    _logger.debug(
        "ws_typing_broadcast",
        session_id=session_id,
        role_id=role_id,
        typing=typing,
    )
    await manager.connections().broadcast(
        session_id,
        {"type": "typing", "role_id": role_id, "typing": typing},
        record=False,
    )


async def _handle_notepad_event(
    *,
    websocket: WebSocket,
    manager: SessionManager,
    session_id: str,
    role_id: str,
    event_type: str,
    payload: dict[str, Any],
) -> None:
    """Apply a notepad WS event under the session's lock.

    All mutations of the per-session pycrdt Doc go through here so the
    NotepadService never sees concurrent calls. ``record=False`` on
    every broadcast — Yjs updates are not replay-safe; reconnecting
    clients send ``notepad_sync_request`` to fetch the current state.
    """
    import base64

    from ..sessions.notepad import (
        NotepadLockedError,
        NotepadOversizedError,
        NotepadRateLimitedError,
        NotepadRoleNotAllowedError,
    )

    # Awareness updates (cursor presence, role names) are pure relay —
    # they don't touch the canonical Doc, don't take the session lock,
    # and aren't recorded in the replay buffer. The y-protocols
    # ``Awareness`` API encodes one client's caret position + user
    # metadata as a small binary payload; we forward it to every other
    # connection so live cursors render in their editors. Awareness
    # updates that originate from a non-roster role never reach this
    # branch because the require_participant gate already filters them
    # at the dispatch level.
    if event_type == "notepad_awareness":
        awareness_b64 = payload.get("awareness")
        if not isinstance(awareness_b64, str):
            await websocket.send_json(
                {"type": "error", "scope": "notepad", "message": "missing awareness"}
            )
            return
        # Length cap (16KB is generous for a y-protocols awareness frame).
        if len(awareness_b64) > 16 * 1024:
            await websocket.send_json(
                {
                    "type": "error",
                    "scope": "notepad",
                    "message": "awareness frame too large",
                }
            )
            return
        await manager.connections().broadcast(
            session_id,
            {
                "type": "notepad_awareness",
                "awareness": awareness_b64,
                "origin_role_id": role_id,
            },
            record=False,
        )
        return

    notepad = manager.notepad()
    async with await manager.with_lock(session_id):
        session = await manager.get_session(session_id)
        if event_type == "notepad_sync_request":
            state = notepad.state_as_update(session_id)
            await websocket.send_json(
                {
                    "type": "notepad_sync_response",
                    "state": base64.b64encode(state).decode("ascii"),
                    "locked": session.notepad.locked,
                    "template_id": session.notepad.template_id,
                }
            )
            return
        # event_type == "notepad_update"
        update_b64 = payload.get("update")
        if not isinstance(update_b64, str):
            await websocket.send_json(
                {"type": "error", "scope": "notepad", "message": "missing update"}
            )
            return
        try:
            update_bytes = base64.b64decode(update_b64, validate=True)
        except (ValueError, TypeError):
            await websocket.send_json(
                {"type": "error", "scope": "notepad", "message": "invalid base64"}
            )
            return
        try:
            notepad.apply_update(session, role_id, update_bytes)
        except NotepadLockedError:
            await websocket.send_json(
                {"type": "error", "scope": "notepad", "message": "notepad is locked"}
            )
            return
        except NotepadRoleNotAllowedError:
            await websocket.send_json(
                {"type": "error", "scope": "notepad", "message": "role not in roster"}
            )
            return
        except NotepadOversizedError:
            await websocket.send_json(
                {
                    "type": "error",
                    "scope": "notepad",
                    "message": "update too large",
                }
            )
            return
        except NotepadRateLimitedError:
            await websocket.send_json(
                {
                    "type": "error",
                    "scope": "notepad",
                    "message": "rate limited",
                }
            )
            return
        # Audit + structured log.
        manager._emit(
            "notepad_edit",
            session,
            role_id=role_id,
            update_size=len(update_bytes),
            edit_count=session.notepad.edit_count,
        )
    # Broadcast the merged update to every connection (Yjs idempotently
    # ignores its own update on the sender). record=False keeps the
    # 256-event replay buffer clean.
    await manager.connections().broadcast(
        session_id,
        {
            "type": "notepad_update",
            "update": update_b64,
            "origin_role_id": role_id,
        },
        record=False,
    )


async def _server_pump(
    websocket: WebSocket,
    conn: _Connection,
    connections: ConnectionManager,
) -> None:
    try:
        async for event in connections.stream(conn):
            await websocket.send_json(event)
    except (WebSocketDisconnect, RuntimeError):
        return


async def _client_pump(
    *,
    websocket: WebSocket,
    manager: SessionManager,
    session_id: str,
    role_id: str,
    kind: ParticipantKindLiteral,
    token_version: int,
    conn: _Connection,
    connections: ConnectionManager,
) -> None:
    # Mutating-event gate: spectators can connect (read-only fan-out) but
    # cannot submit, force-advance, or end the session. The REST layer enforces
    # the same rule via require_participant(); without this gate the WS path
    # was a back door.
    from ..auth.authn import JoinTokenPayload as _Payload

    # ``v`` is intentionally 0 here — the version match was already
    # enforced at WS upgrade time. This payload is only used downstream by
    # require_participant(), which only inspects ``kind``.
    token_payload: _Payload = {
        "session_id": session_id,
        "role_id": role_id,
        "kind": kind,
        "v": 0,
    }

    async def _role_still_authorized() -> bool:
        """Issue #127: re-check the role's existence + token_version
        before processing each mutating event.

        The WS upgrade gate (``session_socket`` above) only fires
        once. After that the recv pump can in principle process events
        for milliseconds-to-seconds while the creator is in the
        middle of revoking / removing this role. The
        ``ConnectionManager.disconnect_role`` call from
        ``SessionManager`` will close this socket asynchronously, but
        a frame already in the local recv buffer can still race ahead.
        Without this gate, a kicked player can squeeze in a
        ``submit_response`` / ``request_force_advance`` /
        ``notepad_update`` / ``notepad_awareness`` between the
        token-version bump and the close landing.

        On detection: send a typed error frame, then close the
        socket so the recv loop exits immediately rather than
        looping on subsequent buffered frames. The error frame is
        intentionally vague — we don't tell a kicked attacker
        whether the role was removed vs revoked.
        """

        try:
            session = await manager.get_session(session_id)
        except SessionNotFoundError:
            try:
                await websocket.close(code=CLOSE_NOT_FOUND)
            except Exception as exc:
                _logger.warning(
                    "ws_close_failed",
                    session_id=session_id,
                    role_id=role_id,
                    reason="session_not_found",
                    error=str(exc),
                )
            return False
        role = session.role_by_id(role_id)
        if role is None or role.token_version != token_version:
            _logger.warning(
                "ws_role_authorization_revoked",
                session_id=session_id,
                role_id=role_id,
                upgrade_version=token_version,
                current_version=(role.token_version if role else None),
                role_present=role is not None,
            )
            try:
                await websocket.send_json(
                    {
                        "type": "error",
                        "scope": "auth",
                        "message": "your seat was removed by the facilitator",
                    }
                )
            except Exception as exc:
                _logger.warning(
                    "ws_revocation_send_failed",
                    session_id=session_id,
                    role_id=role_id,
                    error=str(exc),
                )
            try:
                await websocket.close(code=CLOSE_BAD_TOKEN)
            except Exception as exc:
                _logger.warning(
                    "ws_close_failed",
                    session_id=session_id,
                    role_id=role_id,
                    reason="token_revoked",
                    error=str(exc),
                )
            return False
        return True
    try:
        while True:
            try:
                payload = await websocket.receive_json()
            except WebSocketDisconnect:
                return
            event_type = payload.get("type")
            if event_type == "heartbeat":
                continue
            if event_type == "tab_focus":
                # Per-tab visibility signal. Updates this connection's
                # ``focused`` flag; broadcasts a ``presence`` frame with
                # the role-level aggregate so the creator's RolesPanel
                # can paint blue (any tab focused) vs yellow (all tabs
                # backgrounded) vs gray (no tabs). ``record=False``
                # because focus state is live signal, not history.
                #
                # Spectators are allowed to send this — they're already
                # connected and the focus signal is purely informational
                # (no mutation, no fan-out amplification beyond the one
                # ``presence`` frame this triggers).
                #
                # Strict ``isinstance`` check at the WS boundary: a naive
                # ``bool(payload.get("focused"))`` would coerce the
                # string ``"false"`` to ``True`` (non-empty string is
                # truthy in Python) and let a malformed client flip the
                # presence aggregate incorrectly. Reject anything that
                # isn't a real bool with a typed error frame so the
                # client can self-correct.
                raw_focused = payload.get("focused")
                if not isinstance(raw_focused, bool):
                    await websocket.send_json(
                        {
                            "type": "error",
                            "scope": "tab_focus",
                            "message": (
                                "tab_focus.focused must be a JSON boolean "
                                "(true/false), not "
                                f"{type(raw_focused).__name__}"
                            ),
                        }
                    )
                    continue
                focused_in = raw_focused
                changed = await connections.set_focus(conn, focused_in)
                # Debug-level boundary log so an operator investigating
                # "did the tab actually report blurred?" can grep the
                # bisection trail without prod-log spam. Logged on every
                # event (incl. no-op duplicates) so a flapping client
                # is visible too.
                _logger.debug(
                    "ws_tab_focus",
                    session_id=session_id,
                    role_id=role_id,
                    focused=focused_in,
                    changed=changed,
                )
                if changed:
                    role_focused = await connections.role_has_focused_connection(
                        session_id, role_id
                    )
                    conn_count = await connections.connection_count(session_id)
                    await connections.broadcast(
                        session_id,
                        {
                            "type": "presence",
                            "role_id": role_id,
                            "active": True,
                            "focused": role_focused,
                            "connection_count": conn_count,
                        },
                        record=False,
                    )
                continue
            # Mutating + presence events are participant-only. Spectators can
            # connect (read-only fan-out) but cannot emit typing indicators or
            # state-changing events. Letting spectators emit ``typing_start``
            # would (a) leak presence and (b) amplify a spectator into a
            # high-volume broadcaster against the session's connections.
            if event_type in (
                "submit_response",
                # ``set_ready`` is a mutating event — must run through
                # the same participant gate so spectators / stale
                # tokens can't reach ``manager.set_role_ready`` (where
                # they would otherwise receive stateful rejection
                # frames). Copilot review on PR #209.
                "set_ready",
                "request_force_advance",
                "request_end_session",
                "typing_start",
                "typing_stop",
                # Issue #98: notepad writes must be gated on
                # require_participant — spectators can read the
                # broadcast fan-out (the relay sends update events to
                # everyone) but they MUST NOT be able to mutate the
                # canonical Yjs doc. Without this gate a spectator
                # could rewrite the markdown that participants
                # subsequently re-serialize and push via /snapshot.
                "notepad_sync_request",
                "notepad_update",
                "notepad_awareness",
            ):
                try:
                    require_participant(token_payload)
                except AuthorizationError as exc:
                    await websocket.send_json(
                        {
                            "type": "error",
                            "scope": event_type,
                            "message": str(exc),
                        }
                    )
                    continue
                # Issue #127: every mutating event re-checks that the
                # role still exists with the version this socket was
                # upgraded with. ``disconnect_role`` is fire-and-forget
                # (the close lands milliseconds later); without this
                # gate a kicked player can squeeze a final
                # ``submit_response`` / ``force_advance`` / notepad
                # write through the race window. ``_role_still_authorized``
                # closes the socket on failure so subsequent buffered
                # frames are not processed.
                if not await _role_still_authorized():
                    return
            if event_type == "submit_response":
                # Validation / truncation / guardrail / submit live in
                # ``submission_pipeline`` so the dev-tools scenario
                # runner exercises the same checks. The handler's
                # remaining job is converting the structured outcome
                # into the WS info frames a connected client expects
                # (``submission_truncated`` / ``guardrail_blocked``)
                # plus dispatching the post-submission AI driver
                # (``run_play_turn`` if advanced; ``run_interject`` when
                # ``@facilitator`` is in the cleaned mentions list and
                # the AI is not paused — Wave 2).
                from ..sessions.submission_pipeline import (
                    FACILITATOR_MENTION_TOKEN,
                    EmptySubmissionError,
                    prepare_and_submit_player_response,
                )

                content = str(payload.get("content", ""))
                # Wave 2: the composer ships ``mentions`` as a structural
                # list of mention targets (real ``role_id`` values + the
                # literal ``"facilitator"`` token). The pipeline
                # validates / drops unknowns; the handler just hands off
                # the raw payload.
                #
                # Per CLAUDE.md "no backwards compat" — ``mentions`` is
                # a required wire field. Missing or non-list payloads
                # are a stale-client mismatch that surfaces as a clean
                # error frame rather than silently coercing to ``[]``
                # (which would hide a bug in the calling code, e.g. a
                # frontend that forgot to thread the marks). Empty
                # list ``[]`` IS valid — the player just didn't tag
                # anyone. Copilot review on PR #152.
                mentions_in = payload.get("mentions")
                if not isinstance(mentions_in, list):
                    await websocket.send_json(
                        {
                            "type": "error",
                            "scope": "submit_response",
                            "message": (
                                "mentions is required and must be a list "
                                "(empty list OK; non-list payloads are "
                                "rejected so a stale client surfaces "
                                "loudly instead of silently sending an "
                                "empty list)"
                            ),
                        }
                    )
                    continue
                try:
                    outcome = await prepare_and_submit_player_response(
                        manager=manager,
                        session_id=session_id,
                        role_id=role_id,
                        content=content,
                        expected_token_version=token_version,
                        mentions=mentions_in,
                    )
                except EmptySubmissionError:
                    await websocket.send_json(
                        {"type": "error", "scope": "submit_response", "message": "empty"}
                    )
                    continue
                except IllegalTransitionError as exc:
                    await websocket.send_json(
                        {"type": "error", "scope": "submit_response", "message": str(exc)}
                    )
                    continue
                if outcome.truncated:
                    cap = manager.settings().max_participant_submission_chars
                    await websocket.send_json(
                        {
                            "type": "submission_truncated",
                            "scope": "submit_response",
                            "cap": cap,
                            "original_len": outcome.original_len,
                            "message": (
                                f"Posted the first {cap} characters; "
                                f"{outcome.original_len - cap} more were dropped. "
                                "Your reply did go through."
                            ),
                        }
                    )
                if outcome.blocked:
                    await websocket.send_json(
                        {
                            "type": "guardrail_blocked",
                            "verdict": outcome.blocked_verdict,
                            "message": (
                                "Your message looked like a prompt-injection "
                                "attempt and was blocked. If that was a real "
                                "in-character reply, rephrase without "
                                "instructing the AI directly."
                            ),
                        }
                    )
                    continue
                # Submissions never advance the turn — only ``set_ready``
                # closes the quorum (handled in its own event branch
                # below). The remaining post-submission side effect is
                # the ``@facilitator`` interject mini-turn, which fires
                # on the same outcome regardless of whether the role
                # later marks ready.
                if FACILITATOR_MENTION_TOKEN in outcome.mentions:
                    # Wave 2: the composer is the single source of
                    # facilitator-routing intent. ``@facilitator`` (and
                    # the client-side aliases ``@ai`` / ``@gm`` resolved
                    # to this same token) fires a constrained AI mini-
                    # turn that answers the asking role first; plain
                    # ``@<role>`` mentions are player-to-player and have
                    # no AI side effect. The transcript-with-highlight
                    # is the entire affordance for those.
                    session = await manager.get_session(session_id)
                    if session.ai_paused:
                        # Wave 3 (issue #69) consumer: when an operator
                        # has paused the AI, ``@facilitator`` still
                        # lands in the transcript with the highlight
                        # but does NOT trigger ``run_interject``. The
                        # toggle UI / endpoint that flips the flag is
                        # not part of this PR — see ``Session.ai_paused``.
                        _logger.info(
                            "facilitator_mention_skipped_ai_paused",
                            session_id=session_id,
                            role_id=role_id,
                        )
                    else:
                        turn = session.current_turn
                        if turn is not None:
                            _logger.info(
                                "routed_via_facilitator_mention",
                                session_id=session_id,
                                role_id=role_id,
                                turn_id=turn.id,
                            )
                            await TurnDriver(manager=manager).run_interject(
                                session=session, turn=turn, for_role_id=role_id
                            )
            elif event_type == "request_force_advance":
                # Creator-only admin action (issue #215). The UI hides the
                # button on player views (PR #214); this gate enforces the
                # same contract on the wire so a player can't bypass via a
                # hand-crafted WS frame. The manager re-checks the same
                # invariant inside the lock as defense-in-depth.
                try:
                    require_creator(token_payload)
                except AuthorizationError as exc:
                    _logger.warning(
                        "ws_force_advance_unauthorized",
                        session_id=session_id,
                        by_role_id=role_id,
                        kind=token_payload["kind"],
                    )
                    await websocket.send_json(
                        {
                            "type": "error",
                            "scope": "force_advance",
                            "message": str(exc),
                        }
                    )
                    continue
                try:
                    await manager.force_advance(
                        session_id=session_id, by_role_id=role_id
                    )
                    session = await manager.get_session(session_id)
                    turn = session.current_turn
                    if turn is not None:
                        await TurnDriver(manager=manager).run_play_turn(
                            session=session, turn=turn
                        )
                except AuthorizationError as exc:
                    await websocket.send_json(
                        {"type": "error", "scope": "force_advance", "message": str(exc)}
                    )
                except IllegalTransitionError as exc:
                    await websocket.send_json(
                        {"type": "error", "scope": "force_advance", "message": str(exc)}
                    )
            elif event_type == "set_ready":
                # Decoupled-ready model: the composer no longer carries
                # an ``intent`` field. Players (or the creator on behalf
                # of an absent player) toggle ready via this event. The
                # quorum closes when every active role has ``ready=True``
                # in the snapshot — at which point we drive the next AI
                # turn here, mirroring the old submit-and-advance path.
                ready_raw = payload.get("ready")
                client_seq_raw = payload.get("client_seq")
                # ``isinstance(x, int)`` accepts ``True``/``False`` since
                # bool is a subclass of int in Python; reject those
                # explicitly so the server never echoes a nonsensical
                # seq back. Copilot review on PR #209.
                if (
                    not isinstance(ready_raw, bool)
                    or type(client_seq_raw) is not int
                ):
                    await websocket.send_json(
                        {
                            "type": "error",
                            "scope": "set_ready",
                            "message": (
                                "set_ready requires { ready: bool, "
                                "client_seq: int }"
                            ),
                        }
                    )
                    continue
                # Subject defaults to actor (player toggles own state).
                # When the actor is the creator, an explicit
                # ``subject_role_id`` may be supplied to impersonate
                # another role's toggle (mirrors ``proxy_submit_as``).
                subject_role_id = (
                    str(payload.get("subject_role_id") or role_id)
                )
                ready_outcome = await manager.set_role_ready(
                    session_id=session_id,
                    actor_role_id=role_id,
                    subject_role_id=subject_role_id,
                    ready=ready_raw,
                    client_seq=client_seq_raw,
                )
                if not ready_outcome.accepted:
                    # Directed rejection frame — the actor's optimistic
                    # UI reverts and announces the reason. Other clients
                    # see no ``ready_changed`` so their state is
                    # unaffected.
                    await websocket.send_json(
                        {
                            "type": "set_ready_rejected",
                            "scope": "set_ready",
                            "reason": ready_outcome.reason,
                            "client_seq": ready_outcome.client_seq,
                        }
                    )
                    continue
                # Directed ack frame — sent on EVERY accepted toggle
                # regardless of whether the manager broadcast a
                # ``ready_changed`` event (the idempotent re-mark and
                # the 250ms debounce drop the broadcast silently).
                # Without this the client can't reconcile its
                # ``client_seq`` against an ack on those silent-accept
                # paths and the optimistic flip never resolves.
                # Copilot review on PR #209.
                await websocket.send_json(
                    {
                        "type": "set_ready_ack",
                        "scope": "set_ready",
                        "client_seq": ready_outcome.client_seq,
                        "ready_to_advance": ready_outcome.ready_to_advance,
                    }
                )
                # Quorum closed → drive the next AI turn. Mirrors the
                # old submit-and-advance dispatch site.
                if ready_outcome.ready_to_advance:
                    session = await manager.get_session(session_id)
                    turn = session.current_turn
                    if turn is not None:
                        await TurnDriver(manager=manager).run_play_turn(
                            session=session, turn=turn
                        )
            elif event_type == "request_end_session":
                try:
                    await manager.end_session(
                        session_id=session_id,
                        by_role_id=role_id,
                        reason=str(payload.get("reason") or "ended by creator"),
                    )
                except IllegalTransitionError as exc:
                    # Surface the rejection to the operator's logs as
                    # well as to the client. Manager-level log already
                    # fires for the creator-only gate (issue #81); this
                    # second line captures other transition errors
                    # (e.g. already-ended) that arrive over WS so a
                    # silent swallow can't mask a stuck-session report.
                    _logger.warning(
                        "ws_end_session_rejected",
                        session_id=session_id,
                        event_type=event_type,
                        by_role_id=role_id,
                        reason=str(exc),
                    )
                    await websocket.send_json(
                        {"type": "error", "scope": "end_session", "message": str(exc)}
                    )
            elif event_type in ("typing_start", "typing_stop"):
                # Relay to other connections only (not the sender). Lightweight
                # — no server-side state, the client expires its own typing
                # roster after ~3s of silence.
                await _broadcast_typing(
                    manager=manager,
                    session_id=session_id,
                    role_id=role_id,
                    typing=event_type == "typing_start",
                )
            elif event_type in (
                "notepad_sync_request",
                "notepad_update",
                "notepad_awareness",
            ):
                # Shared markdown notepad (issue #98). The notepad service
                # acts as an opaque CRDT relay (path C of the approved plan):
                # the server applies binary updates without parsing them and
                # encodes its current state for reconnecting clients.
                # ``record=False`` for both — Yjs updates are not idempotent
                # against the 256-event replay buffer; reconnecting clients
                # explicitly request the current state via
                # ``notepad_sync_request``.
                try:
                    await _handle_notepad_event(
                        websocket=websocket,
                        manager=manager,
                        session_id=session_id,
                        role_id=role_id,
                        event_type=event_type,
                        payload=payload,
                    )
                except Exception as exc:
                    _logger.exception(
                        "ws_notepad_error",
                        session_id=session_id,
                        role_id=role_id,
                        event_type=event_type,
                        error=str(exc),
                    )
                    await websocket.send_json(
                        {
                            "type": "error",
                            "scope": "notepad",
                            "message": "notepad event failed",
                        }
                    )
            else:
                await websocket.send_json(
                    {"type": "error", "scope": "ws", "message": f"unknown event type: {event_type}"}
                )
    except Exception as exc:  # surface and close
        _logger.exception("ws_client_pump_error", error=str(exc))
        try:
            await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
        except RuntimeError:
            pass
