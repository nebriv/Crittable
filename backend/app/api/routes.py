"""REST endpoints — see ``docs/PLAN.md`` § REST API."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, FastAPI, HTTPException, Request, status
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel, ConfigDict, Field

from ..auth.authn import HMACAuthenticator, InvalidTokenError, JoinTokenPayload
from ..auth.authz import (
    AuthorizationError,
    require_creator,
    require_participant,
)
from ..extensions.registry import FrozenRegistry
from ..llm.export import AARGenerator
from ..sessions.manager import SessionManager
from ..sessions.models import ParticipantKind, ScenarioPlan, SessionState
from ..sessions.repository import SessionNotFoundError
from ..sessions.turn_driver import TurnDriver
from ..sessions.turn_engine import IllegalTransitionError


class CreateSessionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scenario_prompt: str = Field(min_length=1, max_length=4000)
    creator_label: str = Field(min_length=1, max_length=64)
    creator_display_name: str = Field(min_length=1, max_length=64)


class AddRoleBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: str = Field(min_length=1, max_length=64)
    display_name: str | None = Field(default=None, max_length=64)
    kind: ParticipantKind = "player"


class EndBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: str | None = None


class PlanEditBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    field: str
    value: Any


class SetupReplyBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: str = Field(min_length=1, max_length=4000)


def register_api_routes(app: FastAPI) -> None:
    router = APIRouter(prefix="/api")

    # ---------------------------------------------------- helpers
    def _manager(req: Request) -> SessionManager:
        return req.app.state.manager  # type: ignore[no-any-return]

    def _authn(req: Request) -> HMACAuthenticator:
        return req.app.state.authn  # type: ignore[no-any-return]

    def _registry(req: Request) -> FrozenRegistry:
        return req.app.state.registry  # type: ignore[no-any-return]

    def _verify_token(authn: HMACAuthenticator, token: str | None) -> JoinTokenPayload:
        if not token:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "token required")
        try:
            return authn.verify(token)
        except InvalidTokenError as exc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc

    def _bind_token(req: Request, session_id: str) -> JoinTokenPayload:
        token = req.query_params.get("token")
        payload = _verify_token(_authn(req), token)
        if payload["session_id"] != session_id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "token / session mismatch")
        return payload

    # ---------------------------------------------------- routes
    @router.post("/sessions")
    async def create_session(body: CreateSessionBody, request: Request) -> dict[str, Any]:
        manager = _manager(request)
        try:
            session, token = await manager.create_session(
                scenario_prompt=body.scenario_prompt,
                creator_label=body.creator_label,
                creator_display_name=body.creator_display_name,
            )
        except (RuntimeError, ValueError) as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        return {
            "session_id": session.id,
            "creator_role_id": session.creator_role_id,
            "creator_token": token,
            "creator_join_url": f"/play/{token}",
        }

    @router.post("/sessions/{session_id}/roles")
    async def add_role(
        session_id: str, body: AddRoleBody, request: Request
    ) -> dict[str, Any]:
        manager = _manager(request)
        token = _bind_token(request, session_id)
        try:
            require_creator(token)
            role, role_token = await manager.add_role(
                session_id=session_id,
                label=body.label,
                display_name=body.display_name,
                kind=body.kind,
            )
        except AuthorizationError as exc:
            raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc)) from exc
        except IllegalTransitionError as exc:
            raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
        except SessionNotFoundError as exc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "session not found") from exc
        return {
            "role_id": role.id,
            "label": role.label,
            "display_name": role.display_name,
            "kind": role.kind,
            "token": role_token,
            "join_url": f"/play/{role_token}",
        }

    @router.get("/sessions/{session_id}")
    async def get_session(session_id: str, request: Request) -> dict[str, Any]:
        manager = _manager(request)
        token = _bind_token(request, session_id)
        try:
            session = await manager.get_session(session_id)
        except SessionNotFoundError as exc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "session not found") from exc
        require_participant(token)
        is_creator = token["role_id"] == session.creator_role_id
        return {
            "id": session.id,
            "state": session.state.value,
            "scenario_prompt": session.scenario_prompt,
            "plan": session.plan.model_dump() if (session.plan and is_creator) else None,
            "roles": [
                {
                    "id": r.id,
                    "label": r.label,
                    "display_name": r.display_name,
                    "kind": r.kind,
                    "is_creator": r.is_creator,
                }
                for r in session.roles
            ],
            "current_turn": (
                {
                    "index": session.current_turn.index,
                    "active_role_ids": session.current_turn.active_role_ids,
                    "status": session.current_turn.status,
                }
                if session.current_turn
                else None
            ),
            "messages": [
                {
                    "id": m.id,
                    "ts": m.ts.isoformat(),
                    "role_id": m.role_id,
                    "kind": m.kind.value,
                    "body": m.body,
                    "tool_name": m.tool_name,
                }
                for m in session.visible_messages(token["role_id"])
            ],
            "cost": session.cost.model_dump() if is_creator else None,
        }

    @router.post("/sessions/{session_id}/start")
    async def start_session(session_id: str, request: Request) -> dict[str, Any]:
        manager = _manager(request)
        token = _bind_token(request, session_id)
        try:
            require_creator(token)
            await manager.start_session(session_id=session_id)
        except AuthorizationError as exc:
            raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc)) from exc
        except IllegalTransitionError as exc:
            raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc

        # Kick the briefing turn off in the background.
        driver = TurnDriver(manager=manager)
        session = await manager.get_session(session_id)
        if session.current_turn is None:
            # Open turn 0 with whatever first beat the AI says — start with no
            # active role; the AI's first call should be set_active_roles.
            from ..sessions.models import Turn

            session.turns.append(Turn(index=0, active_role_ids=[], status="processing"))
        turn = session.current_turn
        assert turn is not None
        await driver.run_play_turn(session=session, turn=turn)
        return {"ok": True}

    @router.post("/sessions/{session_id}/setup/reply")
    async def setup_reply(
        session_id: str, body: SetupReplyBody, request: Request
    ) -> dict[str, Any]:
        manager = _manager(request)
        token = _bind_token(request, session_id)
        try:
            require_creator(token)
        except AuthorizationError as exc:
            raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc)) from exc

        await manager.append_setup_message(
            session_id=session_id, speaker="creator", content=body.content
        )
        driver = TurnDriver(manager=manager)
        session = await manager.get_session(session_id)
        if session.state != SessionState.SETUP:
            return {"ok": True, "state": session.state.value}
        await driver.run_setup_turn(session=session)
        await manager.get_session(session_id)
        return {"ok": True}

    @router.post("/sessions/{session_id}/setup/finalize")
    async def setup_finalize(
        session_id: str, plan: dict[str, Any], request: Request
    ) -> dict[str, Any]:
        """Creator-clicks-Approve flow when the AI has already proposed a plan
        but the creator wants to commit verbatim without another model call."""

        manager = _manager(request)
        token = _bind_token(request, session_id)
        try:
            require_creator(token)
            scenario_plan = ScenarioPlan.model_validate(plan)
            await manager.finalize_setup(session_id=session_id, plan=scenario_plan)
        except AuthorizationError as exc:
            raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc)) from exc
        except IllegalTransitionError as exc:
            raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
        return {"ok": True}

    @router.post("/sessions/{session_id}/force-advance")
    async def force_advance(session_id: str, request: Request) -> dict[str, Any]:
        manager = _manager(request)
        token = _bind_token(request, session_id)
        try:
            require_participant(token)
            await manager.force_advance(session_id=session_id, by_role_id=token["role_id"])
        except AuthorizationError as exc:
            raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc)) from exc
        except IllegalTransitionError as exc:
            raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc

        # Drive the AI turn now that the player gate is open.
        session = await manager.get_session(session_id)
        if session.current_turn is not None:
            await TurnDriver(manager=manager).run_play_turn(
                session=session, turn=session.current_turn
            )
        return {"ok": True}

    @router.post("/sessions/{session_id}/end")
    async def end_session(
        session_id: str, body: EndBody, request: Request
    ) -> dict[str, Any]:
        manager = _manager(request)
        token = _bind_token(request, session_id)
        try:
            require_participant(token)
            await manager.end_session(
                session_id=session_id,
                by_role_id=token["role_id"],
                reason=(body.reason or "ended"),
            )
        except AuthorizationError as exc:
            raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc)) from exc
        except IllegalTransitionError as exc:
            raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
        return {"ok": True}

    @router.post("/sessions/{session_id}/plan")
    async def edit_plan(
        session_id: str, body: PlanEditBody, request: Request
    ) -> dict[str, Any]:
        manager = _manager(request)
        token = _bind_token(request, session_id)
        try:
            require_creator(token)
            await manager.edit_plan_field(
                session_id=session_id,
                role_id=token["role_id"],
                field=body.field,
                value=body.value,
            )
        except AuthorizationError as exc:
            raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc)) from exc
        except IllegalTransitionError as exc:
            raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
        return {"ok": True}

    @router.get("/sessions/{session_id}/export.md", response_class=PlainTextResponse)
    async def export_md(session_id: str, request: Request) -> Response:
        manager = _manager(request)
        token = _bind_token(request, session_id)
        try:
            require_participant(token)
            session = await manager.get_session(session_id)
        except AuthorizationError as exc:
            raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc)) from exc
        except SessionNotFoundError as exc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "session not found") from exc

        if session.state != SessionState.ENDED:
            raise HTTPException(status.HTTP_425_TOO_EARLY, "session not yet ended")

        if session.aar_markdown is None:
            generator = AARGenerator(llm=manager.llm(), audit=manager.audit())
            session.aar_markdown = await generator.generate(session)
            await manager._repo.save(session)

        filename_slug = (session.plan.title if session.plan else "exercise")
        filename_slug = "-".join(filename_slug.lower().split())[:40] or "exercise"
        return PlainTextResponse(
            content=session.aar_markdown,
            media_type="text/markdown",
            headers={"Content-Disposition": f'attachment; filename="{filename_slug}-aar.md"'},
        )

    @router.get("/extensions")
    async def list_extensions(request: Request) -> dict[str, Any]:
        registry = _registry(request)
        return {
            "tools": [
                {"name": t.name, "description": t.description}
                for t in registry.tools.values()
            ],
            "resources": [
                {"name": r.name, "description": r.description}
                for r in registry.resources.values()
            ],
            "prompts": [
                {"name": p.name, "description": p.description, "scope": p.scope}
                for p in registry.prompts.values()
            ],
        }

    app.include_router(router)
