from __future__ import annotations

import pytest

from app.auth.audit import AuditEvent, AuditLog
from app.auth.authn import HMACAuthenticator, InvalidTokenError
from app.auth.authz import (
    AuthorizationError,
    require_active_role,
    require_creator,
    require_participant,
)


def test_token_round_trip() -> None:
    authn = HMACAuthenticator("x" * 32)
    token = authn.mint(session_id="s1", role_id="r1", kind="creator")
    payload = authn.verify(token)
    assert payload == {"session_id": "s1", "role_id": "r1", "kind": "creator", "v": 0}


def test_token_version_round_trip() -> None:
    authn = HMACAuthenticator("x" * 32)
    token = authn.mint(session_id="s1", role_id="r1", kind="player", version=3)
    payload = authn.verify(token)
    assert payload["v"] == 3


def test_token_tamper_rejected() -> None:
    authn = HMACAuthenticator("x" * 32)
    token = authn.mint(session_id="s1", role_id="r1", kind="player")
    bad = token + "garbage"
    with pytest.raises(InvalidTokenError):
        authn.verify(bad)


def test_token_wrong_secret_rejected() -> None:
    a = HMACAuthenticator("x" * 32)
    b = HMACAuthenticator("y" * 32)
    token = a.mint(session_id="s1", role_id="r1", kind="player")
    with pytest.raises(InvalidTokenError):
        b.verify(token)


def test_secret_too_short() -> None:
    with pytest.raises(ValueError):
        HMACAuthenticator("short")


def test_authz_creator() -> None:
    require_creator({"session_id": "s", "role_id": "r", "kind": "creator"})
    with pytest.raises(AuthorizationError):
        require_creator({"session_id": "s", "role_id": "r", "kind": "player"})


def test_authz_participant() -> None:
    require_participant({"session_id": "s", "role_id": "r", "kind": "creator"})
    require_participant({"session_id": "s", "role_id": "r", "kind": "player"})
    with pytest.raises(AuthorizationError):
        require_participant({"session_id": "s", "role_id": "r", "kind": "spectator"})


def test_authz_active_role() -> None:
    tok = {"session_id": "s", "role_id": "r1", "kind": "player"}
    require_active_role(tok, active_role_ids=["r1", "r2"])
    with pytest.raises(AuthorizationError):
        require_active_role(tok, active_role_ids=["r2"])


def test_audit_ring_buffer() -> None:
    log = AuditLog(ring_size=10)
    for i in range(15):
        log.emit(AuditEvent(kind="x", session_id="s", payload={"i": i}))
    dump = log.dump("s")
    assert len(dump) == 10
    assert dump[0].payload["i"] == 5
    assert dump[-1].payload["i"] == 14


def test_audit_isolation_per_session() -> None:
    log = AuditLog(ring_size=20)
    log.emit(AuditEvent(kind="a", session_id="s1"))
    log.emit(AuditEvent(kind="b", session_id="s2"))
    assert len(log.dump("s1")) == 1
    assert log.dump("s1")[0].kind == "a"
    assert log.dump("nope") == []


def test_audit_for_kinds_filters_to_requested_kinds() -> None:
    """Issue #70 (security review LOW): the polled ``/activity``
    rollup uses ``for_kinds`` to skip uninteresting events at
    iteration time instead of materializing the whole ring buffer.
    """

    log = AuditLog(ring_size=20)
    log.emit(AuditEvent(kind="tool_use", session_id="s", payload={"i": 1}))
    log.emit(AuditEvent(kind="turn_validation", session_id="s", payload={"i": 2}))
    log.emit(AuditEvent(kind="session_event", session_id="s", payload={"i": 3}))
    log.emit(
        AuditEvent(kind="turn_recovery_directive", session_id="s", payload={"i": 4})
    )
    out = log.for_kinds(
        "s", kinds=("turn_validation", "turn_recovery_directive")
    )
    assert [e.kind for e in out] == [
        "turn_validation",
        "turn_recovery_directive",
    ]
    # Oldest-first preserves chronological order — same as ``dump``.
    assert [e.payload["i"] for e in out] == [2, 4]
    # Empty session returns empty list (no error).
    assert log.for_kinds("nope", kinds=("turn_validation",)) == []
    # No matches in the buffer returns empty list.
    assert log.for_kinds("s", kinds=("nope",)) == []
