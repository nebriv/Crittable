"""Tests for the shared markdown notepad service + AAR ingestion (issue #98).

Companion to ``test_prompt_notepad_isolation.py`` (the negative net that
the notepad must NOT leak into play / setup / interject / guardrail
prompts). This file covers:

* :class:`NotepadService` rate-limits, locks, role guards, and
  three-peer convergence via path-C (opaque CRDT relay).
* The positive AAR-ingestion path: ``_user_payload`` includes the
  ``<player_notepad>`` block AND extracts checkbox-style action items
  into ``<player_action_items_verbatim>`` per the persona-review must-fix
  ("every line MUST appear in recommendations unmodified").
* End-of-session locks the notepad and rejects further writes.
"""

from __future__ import annotations

import pytest
from pycrdt import Doc, Text

from app.auth.audit import AuditLog
from app.llm.export import _extract_action_items_verbatim, _user_payload
from app.sessions.models import (
    Role,
    ScenarioBeat,
    ScenarioInject,
    ScenarioPlan,
    Session,
    SessionState,
)
from app.sessions.notepad import (
    NotepadLockedError,
    NotepadOversizedError,
    NotepadRateLimitedError,
    NotepadRoleNotAllowedError,
    NotepadService,
)


def _session() -> Session:
    return Session(
        scenario_prompt="ransomware",
        state=SessionState.AI_PROCESSING,
        plan=ScenarioPlan(
            title="Ransomware",
            executive_summary="exercise",
            key_objectives=["contain"],
            narrative_arc=[
                ScenarioBeat(beat=1, label="Detection", expected_actors=["SOC"]),
            ],
            injects=[ScenarioInject(trigger="T+0", type="event", summary="beacon")],
        ),
        roles=[
            Role(label="CISO", id="r_ciso", is_creator=True),
            Role(label="IR Lead", id="r_ir"),
        ],
        creator_role_id="r_ciso",
    )


# ---------------------------------------------------------------- service


def test_set_markdown_snapshot_round_trip() -> None:
    s = _session()
    svc = NotepadService()
    svc.set_markdown_snapshot(s, "r_ciso", "## Timeline\nT+1 detection\n")
    assert "Timeline" in s.notepad.markdown_snapshot
    assert "r_ciso" in s.notepad.contributor_role_ids


def test_lock_rejects_subsequent_writes() -> None:
    s = _session()
    svc = NotepadService()
    svc.set_markdown_snapshot(s, "r_ciso", "before lock")
    svc.lock(s)
    assert s.notepad.locked is True
    with pytest.raises(NotepadLockedError):
        svc.set_markdown_snapshot(s, "r_ciso", "after lock")


def test_role_guard_drops_non_roster_caller() -> None:
    s = _session()
    svc = NotepadService()
    with pytest.raises(NotepadRoleNotAllowedError):
        svc.set_markdown_snapshot(s, "r_ghost", "spectator content")


def test_oversized_snapshot_rejected() -> None:
    s = _session()
    svc = NotepadService()
    too_big = "x" * (1024 * 1024 + 1)
    with pytest.raises(NotepadOversizedError):
        svc.set_markdown_snapshot(s, "r_ciso", too_big)


def test_oversized_update_rejected() -> None:
    s = _session()
    svc = NotepadService()
    too_big = b"\x00" * (64 * 1024 + 1)
    with pytest.raises(NotepadOversizedError):
        svc.apply_update(s, "r_ciso", too_big)


def test_apply_update_rate_limit_per_role() -> None:
    s = _session()
    svc = NotepadService()
    # Build 30 valid micro-updates from a real Doc, then assert the 31st
    # within the same window is rejected.
    src = Doc()
    src["body"] = Text()
    valid_updates: list[bytes] = []
    for i in range(31):
        src["body"] += "x"
        valid_updates.append(src.get_update())

    for update in valid_updates[:30]:
        svc.apply_update(s, "r_ir", update)
    with pytest.raises(NotepadRateLimitedError):
        svc.apply_update(s, "r_ir", valid_updates[30])


def test_three_peer_convergence_via_relay() -> None:
    """Path-C verification: server is an opaque relay, two clients
    converge after the server merges their concurrent updates."""
    s = _session()
    svc = NotepadService()
    server_doc = svc.get_or_create(s.id)

    a, b = Doc(), Doc()
    for d in (server_doc, a, b):
        if "body" not in d:
            d["body"] = Text()

    # A edits.
    a["body"] += "alpha\n"
    svc.apply_update(s, "r_ciso", a.get_update())

    # Server hands B the merged state.
    b.apply_update(server_doc.get_update())
    assert "alpha" in str(b["body"])

    # Concurrent edits by A and B.
    a["body"] += "from-a\n"
    b["body"] += "from-b\n"
    svc.apply_update(s, "r_ciso", a.get_update())
    svc.apply_update(s, "r_ir", b.get_update())

    merged = svc.state_as_update(s.id)
    a.apply_update(merged)
    b.apply_update(merged)
    assert str(a["body"]) == str(b["body"]) == str(server_doc["body"])
    assert "from-a" in str(a["body"]) and "from-b" in str(a["body"])


def test_pin_idempotency_per_message_id() -> None:
    s = _session()
    svc = NotepadService()
    assert svc.can_pin(s, "r_ciso", "msg_42") is True
    svc.record_pin(s, "r_ciso", "msg_42")
    assert svc.can_pin(s, "r_ciso", "msg_42") is False
    # Different message id is not blocked.
    assert svc.can_pin(s, "r_ciso", "msg_43") is True


def test_pin_rate_limit() -> None:
    s = _session()
    svc = NotepadService()
    for i in range(6):
        svc.record_pin(s, "r_ir", f"msg_{i}")
    with pytest.raises(NotepadRateLimitedError):
        svc.record_pin(s, "r_ir", "msg_overflow")


def test_sanitize_pin_text_strips_markdown_html_and_leading_markers() -> None:
    raw = "  ## hello [click](https://evil.com) ![img](x.png) <script>alert(1)</script> world "
    out = NotepadService.sanitize_pin_text(raw)
    assert "evil.com" not in out
    assert "<script>" not in out and "alert(1)" in out  # text kept, tags stripped
    assert not out.startswith(("#", "-", ">", " "))


# ----------------------------------------------------------- AAR ingestion


def test_user_payload_includes_player_notepad_block() -> None:
    s = _session()
    s.notepad.markdown_snapshot = (
        "## Timeline\nT+02:14 — incident declared\n\n"
        "## Action Items\n- [ ] Notify regulator within 72h — @legal\n"
        "- [ ] Roll signing keys — @ir\n"
    )
    payload = _user_payload(s, AuditLog())
    assert "<player_notepad>" in payload
    assert "incident declared" in payload
    assert "</player_notepad>" in payload


def test_user_payload_extracts_action_items_verbatim() -> None:
    s = _session()
    s.notepad.markdown_snapshot = (
        "## Action Items\n- [ ] Notify regulator within 72h — @legal\n"
        "- [x] Roll signing keys — @ir\n"
        "- [ ] Notify regulator within 72h — @legal\n"  # duplicate
        "Some prose.\n"
        "- [ ] Brief board\n"
    )
    payload = _user_payload(s, AuditLog())
    assert "<player_action_items_verbatim>" in payload
    # All three unique items appear; duplicate is deduped while preserving order.
    expected_block = (
        "<player_action_items_verbatim>\n"
        "- Notify regulator within 72h — @legal\n"
        "- Roll signing keys — @ir\n"
        "- Brief board\n"
        "</player_action_items_verbatim>"
    )
    assert expected_block in payload


def test_extract_action_items_verbatim_handles_empty() -> None:
    assert _extract_action_items_verbatim("") == []
    assert _extract_action_items_verbatim("just prose, no checkboxes") == []


def test_user_payload_empty_notepad_marker() -> None:
    s = _session()
    payload = _user_payload(s, AuditLog())
    assert "(notepad empty)" in payload
    assert "(no checkbox-style action items in the notepad)" in payload
