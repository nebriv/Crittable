"""Dev-tools REST surface — scenario list / play / record / download.

Mounted only when ``settings.dev_tools_enabled`` or ``settings.test_mode``
is true. The router itself is created unconditionally so the routes
exist; a single ``_require_dev_tools`` gate at the top of every
handler 404s the request when the flag is off, so a deployed instance
with the flag flipped off never reveals scenario filenames.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, FastAPI, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field

from ..auth.authn import HMACAuthenticator, InvalidTokenError, JoinTokenPayload
from ..auth.authz import AuthorizationError, require_creator
from ..config import Settings
from ..logging_setup import get_logger
from ..sessions.manager import SessionManager
from ..sessions.repository import SessionNotFoundError
from .recorder import SessionRecorder
from .runner import ScenarioRunner
from .scenario import Scenario

_logger = get_logger("devtools.api")


class RecordBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=128)
    description: str = Field(default="", max_length=2000)
    tags: list[str] = Field(default_factory=list)


def _settings(req: Request) -> Settings:
    return req.app.state.settings  # type: ignore[no-any-return]


def _manager(req: Request) -> SessionManager:
    return req.app.state.manager  # type: ignore[no-any-return]


def _authn(req: Request) -> HMACAuthenticator:
    return req.app.state.authn  # type: ignore[no-any-return]


def _require_dev_tools(req: Request) -> None:
    """404 unless dev tools are enabled. 404 (not 403) so a probing client
    can't tell whether the gate is closed or the route doesn't exist.
    """

    s = _settings(req)
    if not (s.dev_tools_enabled or s.test_mode):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not found")


async def _verify_creator(
    req: Request, session_id: str | None = None
) -> JoinTokenPayload:
    """Mirror ``api.routes._bind_token`` semantics: signature, session
    binding, role-version check, AND ``require_creator``. The token-
    version check is what makes "kick / revoke" effective for the
    dev-tools record endpoint — without it a revoked creator token
    can still dump session state.
    """

    from ..sessions.repository import SessionNotFoundError

    token = req.query_params.get("token")
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "token required")
    try:
        payload = _authn(req).verify(token)
    except InvalidTokenError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc
    if session_id is not None:
        if payload["session_id"] != session_id:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "token / session mismatch"
            )
        try:
            session = await _manager(req).get_session(session_id)
        except SessionNotFoundError as exc:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "session not found"
            ) from exc
        role = session.role_by_id(payload["role_id"])
        if role is None:
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED, "role no longer exists"
            )
        if int(payload.get("v", 0)) != role.token_version:
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED, "token has been revoked"
            )
    try:
        require_creator(payload)
    except AuthorizationError as exc:
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc)) from exc
    return payload


def register_devtools_routes(app: FastAPI) -> None:
    router = APIRouter(prefix="/api/dev")

    def _resolved_scenarios_path(req: Request) -> Path:
        """Resolve ``DEV_SCENARIOS_PATH`` to a canonical absolute path
        once per request. The resolved root is then used as the
        symlink-escape check below so a malicious or typo-ridden config
        can't turn the loader into an arbitrary-file-read primitive.
        """

        return Path(_settings(req).dev_scenarios_path).resolve()

    def _safe_load_scenarios(req: Request) -> dict[str, Any]:
        """Load scenarios from the resolved path with two defences:

        * Symlinks whose realpath escapes the resolved root are
          skipped (``WARNING`` audit line) — stops the loader from
          following a planted ``ssh-key.json -> /root/.ssh/id_rsa``.
        * Files larger than 1 MB are skipped — stops a 50 MB JSON from
          starving the request handler. The ``RecordedMessage.body``
          length cap (64 KB) means a normal scenario fits comfortably
          inside this ceiling.

        Bad files log + skip rather than 500 the whole list — a single
        corrupt scenario shouldn't break the picker.
        """

        from .scenario import load_scenario_file

        root = _resolved_scenarios_path(req)
        if not root.is_dir():
            return {}
        out: dict[str, Any] = {}
        for path in sorted(root.glob("*.json")):
            try:
                if path.is_symlink():
                    real = path.resolve()
                    try:
                        real.relative_to(root)
                    except ValueError:
                        _logger.warning(
                            "scenario_symlink_escape",
                            path=str(path),
                            target=str(real),
                        )
                        continue
                if path.stat().st_size > 1_048_576:
                    _logger.warning(
                        "scenario_file_too_large",
                        path=str(path),
                        size=path.stat().st_size,
                    )
                    continue
                out[path.stem] = load_scenario_file(path)
            except Exception as exc:
                _logger.warning(
                    "scenario_load_failed",
                    path=str(path),
                    error=str(exc),
                )
        return out

    @router.get("/scenarios")
    async def list_scenarios(request: Request) -> dict[str, Any]:
        """List available scenarios. Public-ish (still gated on dev tools);
        no token required because the response is just metadata names that
        the dev wrote themselves. The play endpoint is creator-token-gated.
        """

        _require_dev_tools(request)
        scenarios = _safe_load_scenarios(request)
        path = _resolved_scenarios_path(request)
        return {
            "path": str(path),
            "scenarios": [
                {
                    "id": sid,
                    "name": sc.meta.name,
                    "description": sc.meta.description,
                    "tags": sc.meta.tags,
                    "roster_size": len(sc.roster) + 1,  # +1 creator
                    "play_turns": len(sc.play_turns),
                    "skip_setup": sc.skip_setup,
                }
                for sid, sc in scenarios.items()
            ],
        }

    @router.post("/scenarios/{scenario_id}/play")
    async def play_scenario(scenario_id: str, request: Request) -> dict[str, Any]:
        """Replay a scenario in a NEW session.

        Returns the new session id, the creator's join token, and the
        per-role join URLs so the dev can open each role's tab in
        parallel and watch the run unfold. The runner is awaited
        synchronously — a 5-minute scenario will hold the request that
        long, which is fine for solo-dev work but would be bad for
        production. The dev-tools gate keeps this safe.

        Auth: requires a valid signed token (any role, any session).
        Combined with ``DEV_TOOLS_ENABLED``, this stops an unauth'd
        caller on a misconfigured ``TEST_MODE=true`` instance from
        spinning up sessions and harvesting role tokens. The token is
        not bound to the *new* session (one is being created); we
        only check that the caller already has a valid token
        somewhere on this instance.
        """

        _require_dev_tools(request)
        token = request.query_params.get("token")
        if not token:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "token required")
        try:
            _authn(request).verify(token)
        except InvalidTokenError as exc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc
        scenarios = _safe_load_scenarios(request)
        scenario = scenarios.get(scenario_id)
        if scenario is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, f"unknown scenario {scenario_id!r}"
            )
        runner = ScenarioRunner(_manager(request), scenario)
        progress = await runner.run()
        return {
            "ok": progress.error is None,
            "session_id": progress.session_id,
            "error": progress.error,
            "log": progress.log,
            "role_tokens": runner.role_tokens,
            "role_label_to_id": runner.role_label_to_id,
        }

    @router.post("/sessions/{session_id}/record")
    async def record_session(
        session_id: str, body: RecordBody, request: Request
    ) -> dict[str, Any]:
        """Dump a session as a Scenario JSON. Creator-token gated.

        Returns the full Scenario JSON in the response body — caller is
        expected to save it to ``backend/scenarios/{id}.json`` if they
        want it to show up in the picker. We deliberately don't write
        the file ourselves: the runtime cwd may not be the repo root,
        and silently writing into the project tree would surprise a
        non-dev operator.
        """

        _require_dev_tools(request)
        await _verify_creator(request, session_id=session_id)
        try:
            session = await _manager(request).get_session(session_id)
        except SessionNotFoundError as exc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "session not found") from exc
        scenario: Scenario = SessionRecorder.to_scenario(
            session,
            name=body.name,
            description=body.description,
            tags=body.tags or ["recorded"],
        )
        return {
            "ok": True,
            "scenario_json": scenario.model_dump(mode="json"),
            "stats": {
                "roster_size": len(scenario.roster) + 1,
                "setup_replies": len(scenario.setup_replies),
                "play_turns": len(scenario.play_turns),
            },
        }

    app.include_router(router)
