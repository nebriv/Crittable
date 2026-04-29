from __future__ import annotations

import json

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_healthz() -> None:
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_readyz() -> None:
    response = client.get("/readyz")
    assert response.status_code == 200
    assert response.json() == {"status": "ready"}


def test_http_access_log_emits_per_request(capsys) -> None:
    """The new ``RequestContextMiddleware`` should emit one ``http_access``
    JSON line per non-health request, with method, scrubbed path, status,
    and duration_ms. Capturing stdout (which is where the structlog
    pipeline writes via ``PrintLoggerFactory``) is the most robust
    approach — reconfiguring structlog mid-test doesn't replace the
    middleware's already-bound logger reference."""

    with TestClient(app) as c:
        c.get("/healthz")  # must NOT emit access log
        c.get("/api/sessions/does-not-exist?token=secret")  # 401, must emit + scrub

    captured = capsys.readouterr()
    lines: list[dict] = []
    for raw in captured.out.splitlines():
        raw = raw.strip()
        if not raw or not raw.startswith("{"):
            continue
        try:
            lines.append(json.loads(raw))
        except Exception:
            continue
    access_lines = [e for e in lines if e.get("event") == "http_access"]
    assert access_lines, captured.out
    # /healthz must be filtered out (per middleware skip list).
    assert not any("/healthz" in e.get("path", "") for e in access_lines), access_lines
    # The 4xx route should have produced a warning-level entry with the
    # token redacted.
    bad = [e for e in access_lines if "/api/sessions/does-not-exist" in e.get("path", "")]
    assert bad, access_lines
    assert "token=secret" not in bad[0]["path"]
    assert "token=***" in bad[0]["path"]
    assert bad[0]["status"] >= 400
    assert "duration_ms" in bad[0]
