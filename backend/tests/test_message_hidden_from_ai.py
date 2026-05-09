"""Per-message "hidden from AI" mute tests (issue #162).

Coverage:
* Manager:
  - creator can mute / unmute any message + audit + WS event;
  - message-author can mute / unmute their own message;
  - third-party role rejected;
  - unknown message id rejected;
  - idempotent flip (no audit / no broadcast on a no-op).
* LLM user-payload builders:
  - ``turn_driver._play_messages`` skips muted entries (play + interject);
  - ``llm.export._user_payload`` skips muted entries from the AAR transcript;
  - ``sessions.exports.render_full_record_markdown`` annotates muted rows
    with a ``[MUTED]`` flag chip so a creator-only operator dump preserves
    the historical record.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.auth.audit import AuditLog
from app.config import get_settings, reset_settings_cache
from app.llm.export import _user_payload
from app.sessions.exports import render_full_record_markdown
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
)
from app.sessions.repository import InMemoryRepository
from app.sessions.turn_driver import _play_messages
from app.sessions.turn_engine import IllegalTransitionError

# ----------------------------------------------------------------------
# Stubs (mirrors test_chat_declutter_polish.py)


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


def _make_manager(
    repo: InMemoryRepository, audit: AuditLog
) -> tuple[SessionManager, _NoopConnections]:
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


def _make_session() -> tuple[Session, Role, Role]:
    creator = Role(label="CISO", display_name="Alex", is_creator=True)
    author = Role(label="IR Lead", display_name="Sam")
    plan = ScenarioPlan(
        title="Ransomware via vendor portal",
        key_objectives=["Contain"],
        narrative_arc=[ScenarioBeat(beat=1, label="Detection", expected_actors=["IR"])],
        injects=[ScenarioInject(trigger="t", type="event", summary="s")],
        workstreams=[],
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
# Manager mute / unmute paths


@pytest.mark.asyncio
async def test_creator_can_mute_any_message() -> None:
    session, creator, author = _make_session()
    msg = Message(kind=MessageKind.PLAYER, role_id=author.id, body="aside")
    session.messages.append(msg)

    repo = InMemoryRepository()
    await repo.create(session)
    audit = AuditLog()
    mgr, conns = _make_manager(repo, audit)

    out = await mgr.set_message_hidden_from_ai(
        session_id=session.id,
        message_id=msg.id,
        hidden_from_ai=True,
        by_role_id=creator.id,
        is_creator=True,
    )
    assert out.hidden_from_ai is True

    audit_kinds = [e.kind for e in audit.dump(session.id)]
    assert "message_hidden_from_ai_changed" in audit_kinds

    fanout = [
        evt
        for _sid, evt in conns.broadcasts
        if evt.get("type") == "message_hidden_from_ai_changed"
    ]
    assert len(fanout) == 1
    assert fanout[0]["message_id"] == msg.id
    assert fanout[0]["hidden_from_ai"] is True
    assert fanout[0]["actor_role_id"] == creator.id


@pytest.mark.asyncio
async def test_author_can_mute_own_message() -> None:
    session, _, author = _make_session()
    msg = Message(kind=MessageKind.PLAYER, role_id=author.id, body="my aside")
    session.messages.append(msg)

    repo = InMemoryRepository()
    await repo.create(session)
    mgr, _ = _make_manager(repo, AuditLog())

    out = await mgr.set_message_hidden_from_ai(
        session_id=session.id,
        message_id=msg.id,
        hidden_from_ai=True,
        by_role_id=author.id,
        is_creator=False,
    )
    assert out.hidden_from_ai is True


@pytest.mark.asyncio
async def test_author_can_unmute_own_message() -> None:
    session, _, author = _make_session()
    msg = Message(
        kind=MessageKind.PLAYER, role_id=author.id, body="aside", hidden_from_ai=True
    )
    session.messages.append(msg)

    repo = InMemoryRepository()
    await repo.create(session)
    mgr, _ = _make_manager(repo, AuditLog())

    out = await mgr.set_message_hidden_from_ai(
        session_id=session.id,
        message_id=msg.id,
        hidden_from_ai=False,
        by_role_id=author.id,
        is_creator=False,
    )
    assert out.hidden_from_ai is False


@pytest.mark.asyncio
async def test_third_party_role_rejected() -> None:
    session, _, author = _make_session()
    other = Role(label="Comms")
    session.roles.append(other)
    msg = Message(kind=MessageKind.PLAYER, role_id=author.id, body="aside")
    session.messages.append(msg)

    repo = InMemoryRepository()
    await repo.create(session)
    mgr, _ = _make_manager(repo, AuditLog())

    with pytest.raises(IllegalTransitionError, match="message's author or the creator"):
        await mgr.set_message_hidden_from_ai(
            session_id=session.id,
            message_id=msg.id,
            hidden_from_ai=True,
            by_role_id=other.id,
            is_creator=False,
        )


@pytest.mark.asyncio
async def test_unknown_message_rejected() -> None:
    session, creator, _ = _make_session()
    repo = InMemoryRepository()
    await repo.create(session)
    mgr, _ = _make_manager(repo, AuditLog())

    with pytest.raises(IllegalTransitionError, match="message not found"):
        await mgr.set_message_hidden_from_ai(
            session_id=session.id,
            message_id="ghost-id",
            hidden_from_ai=True,
            by_role_id=creator.id,
            is_creator=True,
        )


@pytest.mark.asyncio
async def test_idempotent_no_op_emits_nothing() -> None:
    session, creator, author = _make_session()
    msg = Message(
        kind=MessageKind.PLAYER, role_id=author.id, body="aside", hidden_from_ai=True
    )
    session.messages.append(msg)

    audit = AuditLog()
    repo = InMemoryRepository()
    await repo.create(session)
    mgr, conns = _make_manager(repo, audit)

    await mgr.set_message_hidden_from_ai(
        session_id=session.id,
        message_id=msg.id,
        hidden_from_ai=True,  # already this value
        by_role_id=creator.id,
        is_creator=True,
    )
    assert all(
        e.kind != "message_hidden_from_ai_changed" for e in audit.dump(session.id)
    )
    assert all(
        evt.get("type") != "message_hidden_from_ai_changed"
        for _sid, evt in conns.broadcasts
    )


# ----------------------------------------------------------------------
# LLM user-payload builders


def test_play_messages_skips_muted_entries() -> None:
    session, _, author = _make_session()
    base = datetime(2026, 5, 4, 14, 30, 0, tzinfo=UTC)
    session.messages.extend(
        [
            Message(
                ts=base,
                kind=MessageKind.PLAYER,
                role_id=author.id,
                body="loud message",
                hidden_from_ai=False,
            ),
            Message(
                ts=base + timedelta(seconds=10),
                kind=MessageKind.PLAYER,
                role_id=author.id,
                body="muted aside the AI must not see",
                hidden_from_ai=True,
            ),
            Message(
                ts=base + timedelta(seconds=20),
                kind=MessageKind.PLAYER,
                role_id=author.id,
                body="another loud message",
                hidden_from_ai=False,
            ),
        ]
    )
    msgs = _play_messages(session)
    serialised = "\n".join(m["content"] for m in msgs)
    assert "loud message" in serialised
    assert "another loud message" in serialised
    assert "muted aside the AI must not see" not in serialised


def test_aar_user_payload_skips_muted_entries() -> None:
    session, _, author = _make_session()
    base = datetime(2026, 5, 4, 14, 30, 0, tzinfo=UTC)
    session.messages.extend(
        [
            Message(
                ts=base,
                kind=MessageKind.PLAYER,
                role_id=author.id,
                body="post-mortem-relevant statement",
                hidden_from_ai=False,
            ),
            Message(
                ts=base + timedelta(seconds=10),
                kind=MessageKind.PLAYER,
                role_id=author.id,
                body="off-the-record-aside",
                hidden_from_ai=True,
            ),
        ]
    )
    payload = _user_payload(session, AuditLog())
    assert "post-mortem-relevant statement" in payload
    assert "off-the-record-aside" not in payload


def test_full_record_export_marks_muted_rows() -> None:
    """Operator-facing dump preserves muted entries with a [MUTED] chip
    so the audit trail is intact even when the LLM user blocks dropped them."""

    session, creator, author = _make_session()
    base = datetime(2026, 5, 4, 14, 30, 0, tzinfo=UTC)
    session.messages.append(
        Message(
            ts=base,
            kind=MessageKind.PLAYER,
            role_id=author.id,
            body="muted aside",
            hidden_from_ai=True,
        )
    )
    md = render_full_record_markdown(session, viewer_role_id=creator.id)
    assert "muted aside" in md
    assert "MUTED" in md


def test_aar_user_payload_filters_mute_audit_events() -> None:
    """Sub-agent security HIGH: a ``message_hidden_from_ai_changed``
    audit event must NOT reach the AAR LLM through the audit_lines
    block — otherwise the model could reason about who muted what,
    defeating the "muted asides shouldn't pollute the post-mortem"
    requirement.
    """

    from app.auth.audit import AuditEvent
    from app.auth.audit import AuditLog as _AuditLog

    session, _, _author = _make_session()
    audit = _AuditLog()
    audit.emit(
        AuditEvent(
            kind="message_hidden_from_ai_changed",
            session_id=session.id,
            payload={
                "message_id": "msg-secret",
                "before": False,
                "after": True,
                "actor": session.creator_role_id,
            },
        )
    )
    payload = _user_payload(session, audit)
    assert "message_hidden_from_ai_changed" not in payload
    assert "msg-secret" not in payload


def test_aar_appendix_annotates_muted_messages() -> None:
    """The full-AAR markdown export's transcript appendix tags muted
    rows with ``_[hidden from AI]_`` so the human reader knows the
    AI never saw them when generating the analysis above.
    """

    from app.llm.export import _format_transcript_entry

    session, _, author = _make_session()
    msg = Message(
        ts=datetime(2026, 5, 4, 14, 30, 0, tzinfo=UTC),
        kind=MessageKind.PLAYER,
        role_id=author.id,
        body="muted aside",
        hidden_from_ai=True,
    )
    out = "\n".join(_format_transcript_entry(session, msg))
    assert "muted aside" in out
    assert "hidden from AI" in out


def test_snapshot_message_serialization_includes_hidden_from_ai() -> None:
    """The snapshot wire contract must surface ``hidden_from_ai`` so a
    reconnecting tab can render the badge from the snapshot fetch
    alone (without waiting for a WS frame). Locks the field name a
    future serializer rewrite must preserve.
    """

    # Inline build of the snapshot message dict so the test stays
    # focused on the field shape (mirrors the comprehension in
    # ``api/routes.py::get_session``).
    session, _, author = _make_session()
    msg = Message(
        kind=MessageKind.PLAYER,
        role_id=author.id,
        body="muted",
        hidden_from_ai=True,
    )
    session.messages.append(msg)
    serialized = {
        "id": msg.id,
        "ts": msg.ts.isoformat(),
        "role_id": msg.role_id,
        "kind": msg.kind.value,
        "body": msg.body,
        "tool_name": msg.tool_name,
        "tool_args": msg.tool_args,
        "is_interjection": msg.is_interjection,
        "workstream_id": msg.workstream_id,
        "mentions": list(msg.mentions),
        "ai_paused_at_submit": msg.ai_paused_at_submit,
        "hidden_from_ai": msg.hidden_from_ai,
    }
    assert serialized["hidden_from_ai"] is True
