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
from .extensions import EnvLoader, freeze_bundle
from .extensions.dispatch import ExtensionDispatcher
from .llm.client import LLMClient
from .llm.dispatch import ToolDispatcher
from .llm.guardrail import InputGuardrail
from .logging_setup import RequestContextMiddleware, configure_logging, get_logger
from .rate_limit import RateLimitMiddleware
from .sessions.manager import SessionManager
from .sessions.repository import InMemoryRepository
from .ws import register_ws_routes
from .ws.connection_manager import ConnectionManager


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = get_settings()
    configure_logging(settings)
    logger = get_logger("startup")

    if not settings.test_mode:
        # Validates ``ANTHROPIC_API_KEY`` is present in production-ish runs.
        settings.require_anthropic_key()

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
    guardrail = InputGuardrail(llm=llm, settings=settings)

    tool_dispatcher = ToolDispatcher(
        connections=connections,
        audit=audit,
        extension_dispatcher=extension_dispatcher,
        registry=registry,
        max_critical_injects_per_5_turns=settings.max_critical_injects_per_5_turns,
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

    app.state.settings = settings
    app.state.authn = authn
    app.state.audit = audit
    app.state.repository = repository
    app.state.connections = connections
    app.state.manager = manager
    app.state.registry = registry
    app.state.llm = llm

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

    try:
        yield
    finally:
        await manager.shutdown()
        await connections.shutdown()
        await llm.aclose()
        logger.info("shutdown_complete")


def create_app(settings: Settings | None = None) -> FastAPI:
    if settings is not None:
        # Respect a caller-provided override (used by tests).
        from . import config as _cfg

        _cfg.get_settings.cache_clear()

    app = FastAPI(
        title="AI Cybersecurity Tabletop Facilitator",
        version="0.0.2",
        lifespan=_lifespan,
    )

    # Order matters: request-id binding must wrap the CORS/route layer so the
    # ``request_id`` shows up in CORS-preflight log lines too.
    app.add_middleware(RequestContextMiddleware)

    cfg = settings or get_settings()
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

    static_dir = Path(__file__).parent / "static"
    if static_dir.is_dir():
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")

    return app


app = create_app()
