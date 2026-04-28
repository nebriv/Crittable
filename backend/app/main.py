"""FastAPI app factory.

Phase 1 scaffolding: only health probes and a placeholder static mount. Real
session, WebSocket, and LLM wiring lands in Phase 2 (see docs/PLAN.md).
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles


def create_app() -> FastAPI:
    app = FastAPI(title="AI Cybersecurity Tabletop Facilitator", version="0.0.1")

    @app.get("/healthz")
    async def healthz() -> JSONResponse:
        return JSONResponse({"status": "ok"})

    @app.get("/readyz")
    async def readyz() -> JSONResponse:
        return JSONResponse({"status": "ready"})

    static_dir = Path(__file__).parent / "static"
    if static_dir.is_dir():
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")

    return app


app = create_app()
