"""WebSocket endpoint."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, status

from ..auth.authn import HMACAuthenticator, InvalidTokenError, ParticipantKindLiteral
from ..auth.authz import AuthorizationError, require_participant
from ..config import Settings
from ..logging_setup import bind_session_context, clear_session_context, get_logger
from ..sessions.manager import SessionManager
from ..sessions.repository import SessionNotFoundError
from ..sessions.turn_driver import TurnDriver
from ..sessions.turn_engine import IllegalTransitionError
from .connection_manager import ConnectionManager

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
        # upgrades from any other origin. This is the post-token-leak defence:
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

        is_creator = payload["role_id"] == session.creator_role_id
        bind_session_context(session_id=session_id, role_id=payload["role_id"])
        await websocket.accept()

        conn = await connections.register(
            session_id=session_id,
            role_id=payload["role_id"],
            is_creator=is_creator,
        )
        _logger.info(
            "ws_connected",
            session_id=session_id,
            role_id=payload["role_id"],
            kind=payload["kind"],
            is_creator=is_creator,
        )

        recv_task = asyncio.create_task(
            _client_pump(
                websocket=websocket,
                manager=manager,
                session_id=session_id,
                role_id=payload["role_id"],
                kind=payload["kind"],
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
            clear_session_context()


async def _server_pump(
    websocket: WebSocket,
    conn: Any,
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
) -> None:
    # Mutating-event gate: spectators can connect (read-only fan-out) but
    # cannot submit, force-advance, or end the session. The REST layer enforces
    # the same rule via require_participant(); without this gate the WS path
    # was a back door.
    from ..auth.authn import JoinTokenPayload as _Payload

    token_payload: _Payload = {
        "session_id": session_id,
        "role_id": role_id,
        "kind": kind,
    }
    try:
        while True:
            try:
                payload = await websocket.receive_json()
            except WebSocketDisconnect:
                return
            event_type = payload.get("type")
            if event_type == "heartbeat":
                continue
            if event_type in (
                "submit_response",
                "request_force_advance",
                "request_end_session",
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
            if event_type == "submit_response":
                content = str(payload.get("content", ""))
                if not content.strip():
                    await websocket.send_json(
                        {"type": "error", "scope": "submit_response", "message": "empty"}
                    )
                    continue
                # Optional input-side guardrail
                verdict = await manager.guardrail().classify(message=content)
                if verdict in ("off_topic", "prompt_injection"):
                    await websocket.send_json(
                        {
                            "type": "guardrail_blocked",
                            "verdict": verdict,
                            "message": (
                                "Let's keep the focus on the exercise. "
                                "Try a response that addresses the current beat."
                            ),
                        }
                    )
                    continue
                try:
                    advanced = await manager.submit_response(
                        session_id=session_id, role_id=role_id, content=content
                    )
                except IllegalTransitionError as exc:
                    await websocket.send_json(
                        {"type": "error", "scope": "submit_response", "message": str(exc)}
                    )
                    continue
                if advanced:
                    session = await manager.get_session(session_id)
                    turn = session.current_turn
                    if turn is not None:
                        await TurnDriver(manager=manager).run_play_turn(
                            session=session, turn=turn
                        )
            elif event_type == "request_force_advance":
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
                except IllegalTransitionError as exc:
                    await websocket.send_json(
                        {"type": "error", "scope": "force_advance", "message": str(exc)}
                    )
            elif event_type == "request_end_session":
                try:
                    await manager.end_session(
                        session_id=session_id,
                        by_role_id=role_id,
                        reason=str(payload.get("reason") or "ended by participant"),
                    )
                except IllegalTransitionError as exc:
                    await websocket.send_json(
                        {"type": "error", "scope": "end_session", "message": str(exc)}
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
