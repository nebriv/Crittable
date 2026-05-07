"""Chat-declutter polish tests (iter-4 final).

Coverage:
* Manual workstream override:
  - 200 + audit + WS event for creator and message-author paths;
  - rejection for a third-party role;
  - rejection for unknown workstream id;
  - idempotent re-tag (no audit / no broadcast on a no-op).
* Operator-facing markdown exports (creator-only):
  - ``/exports/timeline.md`` — sections render correctly;
  - ``/exports/full-record.md`` — chronological grouping + per-row flags;
  - visibility-list filter respected (defense in depth).
* Feature-flag default — ``WORKSTREAMS_ENABLED`` is now True.
* AAR isolation: workstream-blind regardless of the flag (plan §6.9).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.auth.audit import AuditLog
from app.config import get_settings, reset_settings_cache
from app.llm.export import _strip_workstream_keys, _user_payload
from app.sessions.exports import (
    SHARE_DATA_PIN_MIN_CHARS,
    full_record_filename,
    render_full_record_markdown,
    render_timeline_markdown,
    timeline_filename,
)
from app.sessions.manager import SessionManager
from app.sessions.models import (
    Message,
    MessageKind,
    Role,
    ScenarioBeat,
    ScenarioInject,
    ScenarioPlan,
    Session,
    SessionState,
    Workstream,
)
from app.sessions.repository import InMemoryRepository
from app.sessions.turn_engine import IllegalTransitionError

# ----------------------------------------------------------------------
# No-op collaborator stubs (mirrors test_session_manager_emit.py)


class _NoopConnections:
    def __init__(self) -> None:
        self.broadcasts: list[tuple[str, dict]] = []
        self.role_sends: list[tuple[str, str, dict]] = []

    async def broadcast(self, session_id: str, event: dict, *, record: bool = True) -> None:
        self.broadcasts.append((session_id, event))

    async def send_to_role(self, session_id: str, role_id: str, event: dict) -> None:
        self.role_sends.append((session_id, role_id, event))


class _Noop:
    pass


def _make_manager(repo: InMemoryRepository, audit: AuditLog) -> tuple[SessionManager, _NoopConnections]:
    reset_settings_cache()
    settings = get_settings()
    conns = _NoopConnections()
    mgr = SessionManager(
        settings=settings,
        repository=repo,
        connections=conns,  # type: ignore[arg-type]
        audit=audit,
        llm=_Noop(),  # type: ignore[arg-type]
        guardrail=_Noop(),  # type: ignore[arg-type]
        tool_dispatcher=_Noop(),  # type: ignore[arg-type]
        extension_registry=_Noop(),  # type: ignore[arg-type]
        authn=_Noop(),  # type: ignore[arg-type]
    )
    return mgr, conns


# ----------------------------------------------------------------------
# Session/message factories


def _make_session(*, with_workstreams: bool = True) -> tuple[Session, Role, Role]:
    creator = Role(label="CISO", display_name="Alex", is_creator=True)
    author = Role(label="IR Lead", display_name="Sam")
    workstreams = (
        [
            Workstream(id="containment", label="Containment"),
            Workstream(id="comms", label="Comms"),
        ]
        if with_workstreams
        else []
    )
    plan = ScenarioPlan(
        title="Ransomware via vendor portal",
        key_objectives=["Contain"],
        narrative_arc=[ScenarioBeat(beat=1, label="Detection", expected_actors=["IR"])],
        injects=[ScenarioInject(trigger="t", type="event", summary="s")],
        workstreams=workstreams,
    )
    session = Session(
        scenario_prompt="r",
        state=SessionState.AWAITING_PLAYERS,
        plan=plan,
        roles=[creator, author],
        creator_role_id=creator.id,
    )
    return session, creator, author


# ----------------------------------------------------------------------
# Manager override tests


@pytest.mark.asyncio
async def test_override_creator_can_move_any_message() -> None:
    session, creator, author = _make_session()
    msg = Message(
        kind=MessageKind.PLAYER, role_id=author.id, body="hello", workstream_id=None
    )
    session.messages.append(msg)

    repo = InMemoryRepository()
    await repo.create(session)
    audit = AuditLog()
    mgr, conns = _make_manager(repo, audit)
    out = await mgr.override_message_workstream(
        session_id=session.id,
        message_id=msg.id,
        workstream_id="containment",
        by_role_id=creator.id,
        is_creator=True,
    )
    assert out.workstream_id == "containment"
    audit_kinds = [e.kind for e in audit.dump(session.id)]
    assert "workstream_override" in audit_kinds
    # Fan-out went to peer tabs
    assert any(
        evt.get("type") == "message_workstream_changed"
        and evt.get("message_id") == msg.id
        and evt.get("workstream_id") == "containment"
        for _sid, evt in conns.broadcasts
    )


@pytest.mark.asyncio
async def test_override_author_can_move_own_message() -> None:
    session, _, author = _make_session()
    msg = Message(
        kind=MessageKind.PLAYER, role_id=author.id, body="hi", workstream_id="comms"
    )
    session.messages.append(msg)

    repo = InMemoryRepository()
    await repo.create(session)
    audit = AuditLog()
    mgr, _ = _make_manager(repo, audit)
    out = await mgr.override_message_workstream(
        session_id=session.id,
        message_id=msg.id,
        workstream_id=None,  # back to #main
        by_role_id=author.id,
        is_creator=False,
    )
    assert out.workstream_id is None


@pytest.mark.asyncio
async def test_override_third_party_role_rejected() -> None:
    session, _, author = _make_session()
    other = Role(label="Comms")
    session.roles.append(other)
    msg = Message(
        kind=MessageKind.PLAYER, role_id=author.id, body="hi", workstream_id=None
    )
    session.messages.append(msg)

    repo = InMemoryRepository()
    await repo.create(session)
    mgr, _ = _make_manager(repo, AuditLog())
    with pytest.raises(IllegalTransitionError, match="message's author or the creator"):
        await mgr.override_message_workstream(
            session_id=session.id,
            message_id=msg.id,
            workstream_id="containment",
            by_role_id=other.id,
            is_creator=False,
        )


@pytest.mark.asyncio
async def test_override_unknown_workstream_rejected() -> None:
    session, creator, author = _make_session()
    msg = Message(kind=MessageKind.PLAYER, role_id=author.id, body="hi")
    session.messages.append(msg)

    repo = InMemoryRepository()
    await repo.create(session)
    mgr, _ = _make_manager(repo, AuditLog())
    with pytest.raises(IllegalTransitionError, match="not declared"):
        await mgr.override_message_workstream(
            session_id=session.id,
            message_id=msg.id,
            workstream_id="vendor_management",  # not in declared set
            by_role_id=creator.id,
            is_creator=True,
        )


@pytest.mark.asyncio
async def test_override_unknown_message_rejected() -> None:
    session, creator, _ = _make_session()
    repo = InMemoryRepository()
    await repo.create(session)
    mgr, _ = _make_manager(repo, AuditLog())
    with pytest.raises(IllegalTransitionError, match="message not found"):
        await mgr.override_message_workstream(
            session_id=session.id,
            message_id="ghost-id",
            workstream_id=None,
            by_role_id=creator.id,
            is_creator=True,
        )


@pytest.mark.asyncio
async def test_override_idempotent_no_op() -> None:
    """Re-applying the same workstream emits no audit / no broadcast."""

    session, creator, author = _make_session()
    msg = Message(
        kind=MessageKind.PLAYER, role_id=author.id, body="hi", workstream_id="comms"
    )
    session.messages.append(msg)
    audit = AuditLog()
    repo = InMemoryRepository()
    await repo.create(session)
    mgr, conns = _make_manager(repo, audit)
    await mgr.override_message_workstream(
        session_id=session.id,
        message_id=msg.id,
        workstream_id="comms",  # already this value
        by_role_id=creator.id,
        is_creator=True,
    )
    assert all(e.kind != "workstream_override" for e in audit.dump(session.id))
    assert all(
        evt.get("type") != "message_workstream_changed"
        for _sid, evt in conns.broadcasts
    )


# ----------------------------------------------------------------------
# Markdown export tests


def _seed_messages(session: Session, author_id: str) -> None:
    base = datetime(2026, 5, 4, 14, 30, 0, tzinfo=UTC)
    session.messages.extend(
        [
            Message(
                ts=base,
                kind=MessageKind.AI_TEXT,
                body="Welcome team — initial briefing.",
                tool_name="broadcast",
                workstream_id=None,
            ),
            Message(
                ts=base + timedelta(minutes=2),
                kind=MessageKind.PLAYER,
                role_id=author_id,
                body="Acknowledged, kicking off containment.",
                workstream_id="containment",
            ),
            Message(
                ts=base + timedelta(minutes=3),
                kind=MessageKind.AI_TEXT,
                body="Comms thread spinning up.",
                tool_name="address_role",
                workstream_id="comms",
            ),
            Message(
                ts=base + timedelta(minutes=5),
                kind=MessageKind.CRITICAL_INJECT,
                body="Domain controller compromise detected.",
                tool_name="inject_critical_event",
                tool_args={
                    "headline": "DC compromise",
                    "severity": "high",
                    "body": "Domain controller compromise detected.",
                },
                workstream_id="containment",
            ),
            Message(
                ts=base + timedelta(minutes=7),
                kind=MessageKind.AI_TEXT,
                body="Logs (large dump): " + "X" * (SHARE_DATA_PIN_MIN_CHARS + 50),
                tool_name="share_data",
                tool_args={
                    "label": "EDR alert table",
                    "data": "X" * (SHARE_DATA_PIN_MIN_CHARS + 50),
                },
                workstream_id="containment",
            ),
            Message(
                ts=base + timedelta(minutes=8),
                kind=MessageKind.AI_TEXT,
                body="tiny share",
                tool_name="share_data",
                tool_args={"label": "ping", "data": "tiny"},
                workstream_id="comms",
            ),
        ]
    )


def test_render_timeline_markdown_includes_all_sections() -> None:
    session, creator, author = _make_session()
    _seed_messages(session, author.id)
    md = render_timeline_markdown(session, viewer_role_id=creator.id)
    assert "# Ransomware via vendor portal — Timeline" in md
    assert "## Track lifecycle" in md
    assert "#Containment" in md
    assert "#Comms" in md
    assert "opened by IR Lead (Sam)" in md
    assert "## Critical events" in md
    assert "DC compromise" in md
    assert "high" in md
    assert "## Pinned artifacts" in md
    assert "EDR alert table" in md
    # The tiny share_data is below the pin threshold.
    assert "ping" not in md


def test_render_timeline_markdown_handles_empty_session() -> None:
    session, creator, _ = _make_session(with_workstreams=False)
    md = render_timeline_markdown(session, viewer_role_id=creator.id)
    assert "# Ransomware via vendor portal — Timeline" in md
    # When there's nothing to surface, we render the empty-state hint.
    assert "No timeline-worthy events yet" in md


def test_render_full_record_markdown_chronological_with_flags() -> None:
    session, creator, author = _make_session()
    _seed_messages(session, author.id)
    md = render_full_record_markdown(session, viewer_role_id=creator.id)
    assert "# Ransomware via vendor portal — Full record" in md
    assert "### 14:30" in md
    assert "### 14:35" in md
    assert "[INJECT" in md
    assert "tool:share_data" in md
    assert "#Containment" in md
    assert "#main" in md  # the very first AI broadcast had workstream_id=None


def test_filenames_use_plan_title_slug() -> None:
    session, _, _ = _make_session()
    assert "ransomware-via-vendor-portal" in timeline_filename(session)
    assert "ransomware-via-vendor-portal" in full_record_filename(session)
    assert timeline_filename(session).endswith("-timeline.md")
    assert full_record_filename(session).endswith("-full-record.md")


def test_export_visibility_filter_respected() -> None:
    """Renderers honor each message's visibility list. Defense in depth —
    catches a future caller that invokes the renderer directly with a
    non-creator role.
    """

    session, creator, author = _make_session()
    base = datetime(2026, 5, 4, 14, 30, 0, tzinfo=UTC)
    session.messages.append(
        Message(
            ts=base,
            kind=MessageKind.AI_TEXT,
            body="Restricted whisper to author only.",
            visibility=[author.id],
            workstream_id="comms",
        )
    )
    other = Role(label="Comms")
    session.roles.append(other)
    md_other = render_full_record_markdown(session, viewer_role_id=other.id)
    assert "Restricted whisper" not in md_other
    md_creator = render_full_record_markdown(session, viewer_role_id=creator.id)
    assert "Restricted whisper" in md_creator


# ----------------------------------------------------------------------
# Feature flag default + AAR isolation


def test_workstreams_enabled_default_is_true(monkeypatch) -> None:
    monkeypatch.delenv("WORKSTREAMS_ENABLED", raising=False)
    reset_settings_cache()
    s = get_settings()
    assert s.workstreams_enabled is True


def test_aar_user_payload_strips_workstream_data_with_flag_on() -> None:
    """Plan §6.9 falsification: the AAR pipeline is workstream-blind even
    after the polish PR flips ``WORKSTREAMS_ENABLED`` to True. A
    multi-track session's payload must show no ``workstream_id`` /
    ``workstreams`` keys.
    """

    session, _, author = _make_session()
    _seed_messages(session, author.id)
    audit = AuditLog()
    payload = _user_payload(session, audit)
    # The transcript is rendered body/kind/role_id-only — no workstream
    # keys leak through. Defensive predicate: the literal field-name
    # tokens must not appear in the user payload regardless of the flag.
    assert '"workstream_id"' not in payload
    # Sanity: the payload still includes ordinary transcript content.
    assert "Domain controller compromise" in payload


def test_strip_workstream_keys_helper_drops_workstream_id_and_mentions() -> None:
    """Direct unit test for the AAR audit-payload sanitizer. ``workstream_id``
    and ``mentions`` are stripped; non-workstream keys pass through.
    Matches the published contract in ``_strip_workstream_keys`` — the
    helper does NOT touch a top-level ``workstreams`` list because the
    AAR boundary serializes audit events as JSONL strings, not the
    snapshot-shaped dict that contains ``workstreams``.
    """

    cleaned = _strip_workstream_keys(
        {
            "workstream_id": "containment",
            "mentions": ["facilitator"],
            "args_keys": ["role_id", "workstream_id"],
            "keep": "yes",
        }
    )
    assert cleaned == {"args_keys": ["role_id"], "keep": "yes"}


# ----------------------------------------------------------------------
# HTTP-layer integration (QA review MEDIUM — make 4xx mapping +
# Content-Type + Content-Disposition assertable, not just visible-in-code).


@pytest.fixture
def http_client(monkeypatch: pytest.MonkeyPatch) -> Any:
    """In-process FastAPI client with a benign LLM mock. Mirrors the
    fixture in ``test_api_routes_gaps.py`` so the two suites can share
    seating helpers without coupling on the import surface."""

    from fastapi.testclient import TestClient

    from app.main import create_app
    from tests.mock_anthropic import MockAnthropic

    monkeypatch.setenv("ANTHROPIC_MODEL_PLAY", "mock-play")
    monkeypatch.setenv("ANTHROPIC_MODEL_SETUP", "mock-setup")
    monkeypatch.setenv("ANTHROPIC_MODEL_AAR", "mock-aar")
    monkeypatch.setenv("ANTHROPIC_MODEL_GUARDRAIL", "mock-guardrail")
    monkeypatch.setenv("SESSION_SECRET", "x" * 32)
    monkeypatch.setenv("INPUT_GUARDRAIL_ENABLED", "false")
    monkeypatch.setenv("DUPLICATE_SUBMISSION_WINDOW_SECONDS", "0")
    monkeypatch.setenv("WORKSTREAMS_ENABLED", "true")
    reset_settings_cache()
    app = create_app()
    with TestClient(app) as c:
        c.app.state.llm.set_transport(MockAnthropic({}).messages)
        yield c


def _seed_ai_message_sync(client: Any, session_id: str) -> str:
    """Append an AI-authored play message directly via the manager's
    in-memory repository so the override / export tests have a real
    message to operate on without driving a full play turn through
    the mock LLM. Returns the new message id.

    The repository's interface is async, but ``InMemoryRepository``'s
    operations are pure dict mutations under an asyncio.Lock — we
    don't need to actually await them in test setup. We poke the
    private dict directly to avoid bringing up an event loop here
    (relying on ``asyncio.get_event_loop()`` is deprecated in 3.13
    and breaks under shared-process suite runs).
    """

    manager = client.app.state.manager
    repo = manager._repo  # type: ignore[attr-defined]
    sessions = repo._sessions  # type: ignore[attr-defined]
    session = sessions[session_id]
    msg = Message(
        kind=MessageKind.AI_TEXT,
        body="seeded test message for polish integration",
        tool_name="broadcast",
    )
    session.messages.append(msg)
    return msg.id


def _http_seat(client: Any) -> dict[str, str]:
    """Create a session, add a player, seed one AI message, return
    ids + tokens. ``skip_setup=True`` lands in READY; we seed a play
    message manually because the e2e drive path is overkill for
    verifying route mapping."""

    r = client.post(
        "/api/sessions",
        json={
            "scenario_prompt": "Ransomware",
            "creator_label": "CISO",
            "creator_display_name": "Alex",
            "skip_setup": True,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    sid = body["session_id"]
    ctok = body["creator_token"]
    cid = body["creator_role_id"]
    r2 = client.post(
        f"/api/sessions/{sid}/roles?token={ctok}",
        json={"label": "SOC", "display_name": "Bo"},
    )
    assert r2.status_code == 200, r2.text
    other = r2.json()
    seeded_msg_id = _seed_ai_message_sync(client, sid)
    return {
        "sid": sid,
        "ctok": ctok,
        "cid": cid,
        "ptok": other["token"],
        "pid": other["role_id"],
        "seeded_msg_id": seeded_msg_id,
    }


def test_export_timeline_md_returns_markdown_content_type(http_client: Any) -> None:
    """Mandate: both export endpoints must return
    ``Content-Type: text/markdown; charset=utf-8``. Asserted by HTTP
    response, not by inspection."""

    seats = _http_seat(http_client)
    r = http_client.get(
        f"/api/sessions/{seats['sid']}/exports/timeline.md?token={seats['ctok']}"
    )
    assert r.status_code == 200, r.text
    ct = r.headers.get("content-type", "")
    assert "text/markdown" in ct
    assert "charset=utf-8" in ct.lower()
    cd = r.headers.get("content-disposition", "")
    assert "attachment" in cd
    assert "-timeline.md" in cd


def test_export_full_record_md_returns_markdown_content_type(http_client: Any) -> None:
    seats = _http_seat(http_client)
    r = http_client.get(
        f"/api/sessions/{seats['sid']}/exports/full-record.md?token={seats['ctok']}"
    )
    assert r.status_code == 200, r.text
    ct = r.headers.get("content-type", "")
    assert "text/markdown" in ct
    assert "charset=utf-8" in ct.lower()
    cd = r.headers.get("content-disposition", "")
    assert "-full-record.md" in cd


def test_exports_reject_non_creator(http_client: Any) -> None:
    """Both export endpoints are creator-only — a player token returns 403."""

    seats = _http_seat(http_client)
    r1 = http_client.get(
        f"/api/sessions/{seats['sid']}/exports/timeline.md?token={seats['ptok']}"
    )
    assert r1.status_code == 403
    r2 = http_client.get(
        f"/api/sessions/{seats['sid']}/exports/full-record.md?token={seats['ptok']}"
    )
    assert r2.status_code == 403


def test_override_workstream_404_for_unknown_message(http_client: Any) -> None:
    seats = _http_seat(http_client)
    r = http_client.post(
        f"/api/sessions/{seats['sid']}/messages/missing-id/workstream?token={seats['ctok']}",
        json={"workstream_id": None},
    )
    assert r.status_code == 404


def test_override_workstream_400_for_undeclared_target(http_client: Any) -> None:
    """No workstreams declared on this session (skip_setup path leaves
    the plan's workstream list empty), so any non-null target is
    rejected with 400. Verifies the route's IllegalTransitionError →
    400 mapping for the "not declared" branch."""

    seats = _http_seat(http_client)
    r = http_client.post(
        f"/api/sessions/{seats['sid']}/messages/{seats['seeded_msg_id']}/workstream?token={seats['ctok']}",
        json={"workstream_id": "vendor_management"},
    )
    assert r.status_code == 400


def test_override_workstream_403_for_third_party_role(http_client: Any) -> None:
    """A non-creator non-author player must not be able to override
    someone else's message. Mandate authz contract; verifies the
    route's IllegalTransitionError → 403 mapping for the
    "only the message's author or the creator" branch.

    The seeded message is AI-authored (``role_id=None``); the player
    is neither the author nor the creator, so the override must 403.
    """

    seats = _http_seat(http_client)
    r = http_client.post(
        f"/api/sessions/{seats['sid']}/messages/{seats['seeded_msg_id']}/workstream?token={seats['ptok']}",
        json={"workstream_id": None},
    )
    assert r.status_code == 403


def test_override_workstream_empty_string_normalised_to_null(
    http_client: Any,
) -> None:
    """Security review LOW #2: ``""`` in the JSON body is normalized
    to ``None`` (the #main bucket). A creator submitting
    ``{"workstream_id": ""}`` gets a 200 OK (idempotent no-op when the
    message is already in #main) rather than a confusing 400 about
    an undeclared id.
    """

    seats = _http_seat(http_client)
    r = http_client.post(
        f"/api/sessions/{seats['sid']}/messages/{seats['seeded_msg_id']}/workstream?token={seats['ctok']}",
        json={"workstream_id": ""},
    )
    assert r.status_code == 200
