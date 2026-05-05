"""FastAPI app factory and lifespan wiring.

The lifespan is the single place where Phase-2 components are constructed and
attached to ``app.state`` — every request handler reads them from there. This
matches the architecture-doc statement that *the registry is immutable after
lifespan startup*.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .api import register_api_routes
from .auth import HMACAuthenticator
from .auth.audit import AuditLog
from .config import Settings, get_settings
from .devtools.api import register_devtools_routes
from .extensions import EnvLoader, freeze_bundle
from .extensions.dispatch import ExtensionDispatcher
from .llm.client import LLMClient
from .llm.dispatch import ToolDispatcher
from .llm.guardrail import InputGuardrail
from .logging_setup import RequestContextMiddleware, configure_logging, get_logger
from .rate_limit import RateLimitMiddleware
from .sessions.gc import SessionGC
from .sessions.manager import SessionManager
from .sessions.repository import InMemoryRepository
from .ws import register_ws_routes
from .ws.connection_manager import ConnectionManager


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = get_settings()
    configure_logging(settings)
    logger = get_logger("startup")

    secret = settings.resolve_session_secret()
    authn = HMACAuthenticator(secret)
    audit = AuditLog(ring_size=settings.audit_ring_size)

    bundle = await EnvLoader(settings).load()
    registry = freeze_bundle(bundle)
    extension_dispatcher = ExtensionDispatcher(
        registry=registry,
        max_template_bytes=settings.extension_template_max_bytes,
        audit=audit,
    )

    repository = InMemoryRepository(max_sessions=settings.max_sessions)
    connections = ConnectionManager()
    llm = LLMClient(settings=settings)
    # Wire the connection manager into the LLM client so every LLM call
    # boundary (begin / end) fans out an ``ai_thinking`` WS event. Without
    # this, the participant + creator UIs only saw the indicator when
    # ``session.state == AI_PROCESSING``, which left interject / guardrail /
    # setup-tier / AAR-generation work invisible (issue #63).
    llm.set_connections(connections)
    guardrail = InputGuardrail(llm=llm, settings=settings)

    tool_dispatcher = ToolDispatcher(
        connections=connections,
        audit=audit,
        extension_dispatcher=extension_dispatcher,
        registry=registry,
        max_critical_injects_per_5_turns=settings.max_critical_injects_per_5_turns,
        workstreams_enabled=settings.workstreams_enabled,
    )

    manager = SessionManager(
        settings=settings,
        repository=repository,
        connections=connections,
        audit=audit,
        llm=llm,
        guardrail=guardrail,
        tool_dispatcher=tool_dispatcher,
        extension_registry=registry,
        authn=authn,
    )

    session_gc = SessionGC(
        settings=settings,
        repository=repository,
        audit=audit,
    )
    await session_gc.start()

    app.state.settings = settings
    app.state.authn = authn
    app.state.audit = audit
    app.state.repository = repository
    app.state.connections = connections
    app.state.manager = manager
    app.state.registry = registry
    app.state.llm = llm
    app.state.session_gc = session_gc

    from .config import ModelTier

    tiers: tuple[ModelTier, ...] = ("play", "setup", "aar", "guardrail")
    logger.info(
        "startup_complete",
        models={tier: settings.model_for(tier) for tier in tiers},
        extensions={
            "tools": list(registry.tools.keys()),
            "resources": list(registry.resources.keys()),
            "prompts": list(registry.prompts.keys()),
        },
    )

    # Operability: the legacy soft-drive carve-out kill-switch is
    # default-off because its predicate (``player @facilitator'd``)
    # matches the case where the AI MUST answer, not the case where
    # silent yields are appropriate. If an operator has flipped it on
    # for emergency rollback, surface a startup warning so future
    # incident responders see it in the boot log instead of having to
    # spelunk per-turn ``turn_validation`` warnings.
    if settings.llm_recovery_drive_soft_on_open_question:
        logger.warning(
            "legacy_carve_out_enabled",
            flag="LLM_RECOVERY_DRIVE_SOFT_ON_OPEN_QUESTION",
            value=True,
            note=(
                "Legacy soft-drive carve-out is ON. The AI may silently "
                "yield when a player ``@facilitator``s. Disable in "
                "production unless you've also added direction "
                "classification."
            ),
        )

    try:
        yield
    finally:
        await session_gc.stop()
        await manager.shutdown()
        await connections.shutdown()
        await llm.aclose()
        logger.info("shutdown_complete")


def create_app(
    settings: Settings | None = None,
    *,
    static_dir_override: Path | None = None,
) -> FastAPI:
    """Build the FastAPI app.

    ``static_dir_override`` is a test-only seam that points the SPA-fallback
    handler at a synthesised directory, so unit tests don't risk clobbering
    a developer's real ``backend/app/static`` build artifact.
    """

    if settings is not None:
        # Respect a caller-provided override (used by tests).
        from . import config as _cfg

        _cfg.get_settings.cache_clear()

    cfg = settings or get_settings()

    # Validate critical runtime config eagerly — at import time, before any
    # FastAPI machinery is constructed. Doing this in the lifespan instead
    # leaves uvicorn printing "Started server process", then swallowing the
    # lifespan traceback and exiting with code 0; under
    # ``docker compose restart: unless-stopped`` that produces a silent
    # restart loop (issue #118). Failing in ``create_app`` propagates as an
    # import-time exception so uvicorn never binds the port and exits
    # non-zero with a clear, single-line error.
    #
    # Configure logging here too so the gate emits a structured success line
    # (and any failure traceback is captured by structlog, not by stderr).
    # ``configure_logging`` is idempotent; the lifespan re-runs it harmlessly.
    configure_logging(cfg)
    _bootstrap_log = get_logger("startup")
    cfg.require_anthropic_key()
    _bootstrap_log.info("anthropic_api_key_present")
    if cfg.dev_tools_enabled:
        # Loud-on-startup so an accidental prod deploy with the dev
        # flag set shows up in operator log scans. The endpoints
        # accept unauthenticated session creation in this mode — see
        # ``backend/app/devtools/api.py::play_scenario`` for the
        # auth model.
        _bootstrap_log.warning(
            "dev_tools_enabled_unauth_path_active",
            note=(
                "DEV_TOOLS_ENABLED=true exposes /api/dev/scenarios/* "
                "to unauthenticated callers. /play returns a creator "
                "token in the response body. Never enable in production."
            ),
        )
    if cfg.aar_inline_on_end:
        _bootstrap_log.warning(
            "aar_inline_on_end_active",
            note=(
                "AAR_INLINE_ON_END=true blocks the POST /end request "
                "handler on the AAR pipeline (5–60 s). This is a "
                "tests-only convenience; never enable in production."
            ),
        )

    app = FastAPI(
        title="Crittable",
        version="0.0.2",
        lifespan=_lifespan,
    )

    # Order matters: request-id binding must wrap the CORS/route layer so the
    # ``request_id`` shows up in CORS-preflight log lines too.
    app.add_middleware(RequestContextMiddleware)

    cors = cfg.cors_origin_list()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors if cors != "*" else ["*"],
        allow_credentials=cors != "*",
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Rate-limit middleware. Off by default (settings.rate_limit_enabled);
    # the middleware itself short-circuits when disabled so adding it to the
    # stack is cheap.
    app.add_middleware(RateLimitMiddleware, settings=cfg)

    @app.get("/healthz")
    async def healthz() -> JSONResponse:
        return JSONResponse({"status": "ok"})

    @app.get("/readyz")
    async def readyz() -> JSONResponse:
        return JSONResponse({"status": "ready"})

    register_api_routes(app)
    register_ws_routes(app)
    # Dev-tools (scenario replay / record) — handlers self-gate on
    # ``settings.dev_tools_enabled`` so registering unconditionally is
    # safe; we still register every install for symmetry with the
    # other route blocks.
    register_devtools_routes(app)

    static_dir = static_dir_override or (Path(__file__).parent / "static")
    if static_dir.is_dir():
        # Serve hashed bundle assets from /assets/* directly. We deliberately
        # mount the assets subdir rather than the whole static dir at "/" —
        # the previous "/" mount swallowed every URL and returned 404 for
        # client-side SPA routes like /play/{sid}/{token} (the route handler
        # below now serves index.html as the SPA fallback).
        assets_dir = static_dir / "assets"
        if assets_dir.is_dir():
            app.mount(
                "/assets",
                StaticFiles(directory=assets_dir),
                name="assets",
            )

        # Serve top-level static files (favicon, etc) and the SPA fallback.
        # Anything that's not a real file in the build output falls through
        # to index.html so React Router / our own path-based router can take
        # over client-side.
        from fastapi.responses import FileResponse, Response

        @app.get("/{full_path:path}", include_in_schema=False)
        async def spa_fallback(full_path: str) -> Response:
            # /api/* and /ws/* are real backend prefixes; if they reach the
            # catch-all it means the path is not registered. Returning
            # index.html for those (HTTP 200) breaks API client error
            # handling and makes endpoint enumeration noisier. Surface a
            # real 404 instead.
            if full_path.startswith("api/") or full_path.startswith("ws/"):
                return Response(status_code=404, content="not found")

            # Don't serve dotfiles (.env, .DS_Store, .git/config, etc) even
            # if they accidentally land in the build output. Vite normally
            # doesn't emit them, but a hand-built deploy or a stray file
            # would otherwise be silently exposed to the public internet.
            if any(part.startswith(".") for part in Path(full_path).parts):
                index = static_dir / "index.html"
                return FileResponse(index) if index.is_file() else Response(status_code=404)

            # Path-traversal guard: resolve and verify the candidate is
            # still inside ``static_dir`` (catches ``../`` and symlinks).
            candidate = (static_dir / full_path).resolve()
            try:
                candidate.relative_to(static_dir.resolve())
            except ValueError:
                candidate = static_dir / "index.html"
            if candidate.is_file():
                return FileResponse(candidate)
            index = static_dir / "index.html"
            if index.is_file():
                return FileResponse(index)
            return Response(status_code=404, content="not built")

    return app


app = create_app()
