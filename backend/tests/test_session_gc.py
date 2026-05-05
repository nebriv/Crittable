"""Tests for the EXPORT_RETENTION_MIN session GC reaper (issue #17)."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.auth.audit import AuditEvent, AuditLog
from app.config import Settings, reset_settings_cache
from app.main import create_app
from app.sessions.gc import SessionGC
from app.sessions.models import Role, Session, SessionState
from app.sessions.repository import InMemoryRepository


def _make_session(
    *,
    state: SessionState,
    ended_at: datetime | None,
    aar_status: str = "ready",
) -> Session:
    role = Role(label="CISO", display_name="A", kind="player", is_creator=True)
    return Session(
        scenario_prompt="x",
        roles=[role],
        creator_role_id=role.id,
        state=state,
        ended_at=ended_at,
        # Default ``ready`` keeps the GC tests focused on the retention-clock
        # path. The "AAR-in-flight" test overrides this explicitly.
        aar_status=aar_status,  # type: ignore[arg-type]
    )


@pytest.mark.asyncio
async def test_gc_evicts_ended_session_past_retention() -> None:
    settings = Settings(EXPORT_RETENTION_MIN=1, SESSION_SECRET="x" * 32)
    repo = InMemoryRepository(max_sessions=10)
    audit = AuditLog(ring_size=64)
    gc = SessionGC(settings=settings, repository=repo, audit=audit, sweep_interval_s=10)

    fresh = _make_session(state=SessionState.ENDED, ended_at=datetime.now(UTC))
    expired = _make_session(
        state=SessionState.ENDED,
        ended_at=datetime.now(UTC) - timedelta(minutes=2),
    )
    live = _make_session(state=SessionState.AWAITING_PLAYERS, ended_at=None)
    for s in (fresh, expired, live):
        await repo.create(s)
    # Seed the per-session audit ring buffer so we can confirm it's dropped.
    audit.emit(AuditEvent(kind="probe", session_id=expired.id))

    evicted = await gc.sweep()

    assert evicted == [expired.id]
    assert gc.is_evicted(expired.id)
    assert not gc.is_evicted(fresh.id)
    assert not gc.is_evicted(live.id)
    # Repository: live + fresh remain, expired is gone.
    remaining = {s.id for s in await repo.list()}
    assert remaining == {fresh.id, live.id}
    # Audit ring buffer for the evicted session is dropped.
    assert audit.dump(expired.id) == []


@pytest.mark.asyncio
async def test_gc_ignores_non_ended_session_with_stale_ended_at() -> None:
    """Defense in depth: only ENDED sessions are eligible. If a future bug
    leaves ``ended_at`` populated on a live session, the reaper must not
    evict it."""

    settings = Settings(EXPORT_RETENTION_MIN=1, SESSION_SECRET="x" * 32)
    repo = InMemoryRepository(max_sessions=10)
    audit = AuditLog(ring_size=64)
    gc = SessionGC(settings=settings, repository=repo, audit=audit, sweep_interval_s=10)

    weird = _make_session(
        state=SessionState.AWAITING_PLAYERS,
        ended_at=datetime.now(UTC) - timedelta(minutes=10),
    )
    await repo.create(weird)

    evicted = await gc.sweep()

    assert evicted == []
    assert {s.id for s in await repo.list()} == {weird.id}


@pytest.mark.asyncio
async def test_gc_skips_session_with_aar_in_flight() -> None:
    """Security HIGH: ``end_session`` sets ``ended_at`` *before* the AAR
    background task starts. With an aggressive retention setting the reaper
    would otherwise delete the session out from under the generator."""

    settings = Settings(EXPORT_RETENTION_MIN=1, SESSION_SECRET="x" * 32)
    repo = InMemoryRepository(max_sessions=10)
    audit = AuditLog(ring_size=64)
    gc = SessionGC(settings=settings, repository=repo, audit=audit, sweep_interval_s=10)

    pending = _make_session(
        state=SessionState.ENDED,
        ended_at=datetime.now(UTC) - timedelta(minutes=2),
        aar_status="pending",
    )
    generating = _make_session(
        state=SessionState.ENDED,
        ended_at=datetime.now(UTC) - timedelta(minutes=2),
        aar_status="generating",
    )
    await repo.create(pending)
    await repo.create(generating)

    evicted = await gc.sweep()

    assert evicted == []
    remaining = {s.id for s in await repo.list()}
    assert remaining == {pending.id, generating.id}


@pytest.mark.asyncio
async def test_gc_skips_ended_without_ended_at_timestamp() -> None:
    """Defensive: an ENDED row missing ``ended_at`` (legacy / corrupt) is
    left alone rather than evicted on the next pass."""

    settings = Settings(EXPORT_RETENTION_MIN=1, SESSION_SECRET="x" * 32)
    repo = InMemoryRepository(max_sessions=10)
    audit = AuditLog(ring_size=64)
    gc = SessionGC(settings=settings, repository=repo, audit=audit, sweep_interval_s=10)

    weird = _make_session(state=SessionState.ENDED, ended_at=None)
    await repo.create(weird)

    evicted = await gc.sweep()

    assert evicted == []
    assert not gc.is_evicted(weird.id)
    assert {s.id for s in await repo.list()} == {weird.id}


@pytest.mark.asyncio
async def test_gc_tombstone_buffer_is_bounded() -> None:
    """The tombstone list caps so a long-running operator's process doesn't
    leak unbounded session ids."""

    settings = Settings(EXPORT_RETENTION_MIN=1, SESSION_SECRET="x" * 32)
    repo = InMemoryRepository(max_sessions=10)
    audit = AuditLog(ring_size=64)
    gc = SessionGC(
        settings=settings,
        repository=repo,
        audit=audit,
        sweep_interval_s=10,
        tombstone_cap=3,
    )

    ids: list[str] = []
    for _ in range(5):
        s = _make_session(
            state=SessionState.ENDED,
            ended_at=datetime.now(UTC) - timedelta(minutes=2),
        )
        await repo.create(s)
        ids.append(s.id)
    await gc.sweep()

    # First two evicted ids fall out of the tombstone ring; only the most
    # recent ``tombstone_cap`` (=3) remain queryable as ``is_evicted``.
    assert [gc.is_evicted(sid) for sid in ids] == [False, False, True, True, True]


@pytest.mark.asyncio
async def test_gc_emits_audit_event_before_dropping_buffer() -> None:
    """The ``session_evicted`` audit event must reach the durable JSONL
    stdout sink before the per-session ring buffer is dropped."""

    settings = Settings(EXPORT_RETENTION_MIN=1, SESSION_SECRET="x" * 32)
    repo = InMemoryRepository(max_sessions=10)

    seen: list[str] = []

    class _SpyAudit(AuditLog):
        def emit(self, event):  # type: ignore[override]
            seen.append(event.kind)
            super().emit(event)

    audit = _SpyAudit(ring_size=64)
    gc = SessionGC(settings=settings, repository=repo, audit=audit, sweep_interval_s=10)

    expired = _make_session(
        state=SessionState.ENDED,
        ended_at=datetime.now(UTC) - timedelta(minutes=2),
    )
    await repo.create(expired)

    await gc.sweep()

    assert "session_evicted" in seen


@pytest.mark.asyncio
async def test_gc_start_stop_runs_periodic_sweep(monkeypatch) -> None:
    """The reaper task wakes up, sweeps, and exits cleanly on stop."""

    settings = Settings(EXPORT_RETENTION_MIN=1, SESSION_SECRET="x" * 32)
    repo = InMemoryRepository(max_sessions=10)
    audit = AuditLog(ring_size=64)
    gc = SessionGC(
        settings=settings, repository=repo, audit=audit, sweep_interval_s=0.05
    )

    expired = _make_session(
        state=SessionState.ENDED,
        ended_at=datetime.now(UTC) - timedelta(minutes=2),
    )
    await repo.create(expired)

    await gc.start()
    # Give the reaper a few sweep cycles to pick up the expired session.
    for _ in range(40):
        if gc.is_evicted(expired.id):
            break
        await asyncio.sleep(0.05)
    await gc.stop()

    assert gc.is_evicted(expired.id)
    assert {s.id for s in await repo.list()} == set()


# ---------------------------------------------------------------- HTTP path


def _make_client(monkeypatch) -> TestClient:
    # Long retention so the lifespan-attached reaper doesn't fire during the
    # request flow; the test calls into the reaper directly.
    monkeypatch.setenv("SESSION_SECRET", "x" * 32)
    monkeypatch.setenv("INPUT_GUARDRAIL_ENABLED", "false")
    monkeypatch.setenv("EXPORT_RETENTION_MIN", "60")
    reset_settings_cache()
    app = create_app()
    return TestClient(app)


def test_export_md_returns_410_after_gc_eviction(monkeypatch) -> None:
    """Acceptance: retention timer evicts a session and a follow-up GET
    returns 410 Gone."""

    with _make_client(monkeypatch) as client:
        # Create a session.
        r = client.post(
            "/api/sessions",
            json={
                "scenario_prompt": "Test scenario",
                "creator_label": "CISO",
                "creator_display_name": "A",
                "skip_setup": True,
            },
        )
        assert r.status_code == 200, r.text
        sid = r.json()["session_id"]
        token = r.json()["creator_token"]

        # Drive the session to ENDED with a fixed ended_at well past
        # the retention threshold.
        async def _force_ended() -> None:
            session = await client.app.state.manager.get_session(sid)
            session.state = SessionState.ENDED
            session.ended_at = datetime.now(UTC) - timedelta(hours=2)
            session.aar_status = "ready"
            session.aar_markdown = "# AAR\nbody"
            await client.app.state.manager._repo.save(session)

        asyncio.run(_force_ended())

        # Run one reaper sweep directly (deterministic).
        gc = client.app.state.session_gc
        evicted = asyncio.run(gc.sweep())
        assert sid in evicted

        # The follow-up export request returns 410 Gone, not 404.
        r = client.get(f"/api/sessions/{sid}/export.md?token={token}")
        assert r.status_code == 410, r.text
        assert r.headers.get("X-AAR-Status") == "evicted"
