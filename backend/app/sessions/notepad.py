"""Shared markdown notepad service (issue #98).

The notepad is a per-session collaborative markdown surface that:

* Players + creator edit live (TipTap on the frontend, Yjs CRDT for merge).
* The server holds a canonical ``pycrdt.Doc`` and acts as a **relay** —
  it never parses the doc shape. See the path-C spike result in the
  approved plan: TipTap stores rich content as Yjs XmlFragment, which
  pycrdt cannot conveniently walk; instead, clients push a markdown
  serialization on every meaningful edit (debounced) and we keep that
  text in :class:`Session.notepad.markdown_snapshot`.
* The AI never sees the notepad during play / setup / interject /
  guardrail prompts. Only the AAR pipeline reads the snapshot.

All public methods must be called while the per-session lock from
:class:`SessionManager` is held — pycrdt ``Doc`` is not safe for
concurrent mutation.
"""

from __future__ import annotations

import re
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from pycrdt import Doc

from app.logging_setup import get_logger
from app.sessions.models import NotepadState, Session

_logger = get_logger(__name__)

# Defense-in-depth caps. Tuned generously so normal typing is uncapped.
_MAX_UPDATE_BYTES = 64 * 1024  # single Yjs binary update
_MAX_MARKDOWN_BYTES = 1 * 1024 * 1024  # aggregate snapshot ceiling
_RATE_WINDOW_SECONDS = 5.0
_RATE_MAX_UPDATES = 30
_PIN_RATE_WINDOW_SECONDS = 10.0
# Shared bucket across the {pin, aar_mark} affordances added by
# issue #117 — the per-role ceiling is 6 unique pin requests / 10s in
# total, NOT 6 per affordance. A user can spend their budget on either
# action; the dedupe key is per (action, source_message_id) but the
# rate counter is action-blind on purpose. Splitting per-action would
# let a panic-clicker double the effective ceiling without any UX win.
_PIN_RATE_MAX = 6


class NotepadError(Exception):
    """Base for service-side rejects we want WS / HTTP layers to surface."""


class NotepadLockedError(NotepadError):
    """The notepad has been locked (session ended); writes are rejected."""


class NotepadOversizedError(NotepadError):
    """Update or snapshot exceeds the configured cap."""


class NotepadRateLimitedError(NotepadError):
    """Caller exceeded the per-role rate window."""


class NotepadRoleNotAllowedError(NotepadError):
    """Caller's role_id is not in the active session roster."""


@dataclass
class _DocEntry:
    """Per-session in-memory state: the Yjs Doc plus rate-limit windows.

    ``Doc`` is generic in pycrdt 0.12+; we don't define a model schema
    server-side (the relay is opaque per path C), so the type arg is
    ``Any``.
    """

    doc: Doc[Any]
    update_timestamps: dict[str, deque[float]] = field(default_factory=dict)
    pin_timestamps: dict[str, deque[float]] = field(default_factory=dict)


class NotepadService:
    """Per-process registry of pycrdt ``Doc`` instances keyed by session id.

    The service is callable from the WS handler (for ``apply_update`` /
    ``state_as_update``) and from the HTTP route layer (for ``pin`` /
    ``set_markdown_snapshot`` / ``set_template_id`` / ``lock``). Both
    call sites must already hold the session's ``asyncio.Lock``.
    """

    def __init__(self) -> None:
        self._docs: dict[str, _DocEntry] = {}

    # ------------------------------------------------------------------ basics
    def get_or_create(self, session_id: str) -> Doc[Any]:
        entry = self._docs.get(session_id)
        if entry is None:
            entry = _DocEntry(doc=Doc())
            self._docs[session_id] = entry
        return entry.doc

    def discard(self, session_id: str) -> None:
        """Drop the in-memory Doc — call when a session is fully ended/GC'd."""
        self._docs.pop(session_id, None)

    # ------------------------------------------------------------- guards
    @staticmethod
    def _ensure_role_allowed(session: Session, role_id: str) -> None:
        if not any(r.id == role_id for r in session.roles):
            raise NotepadRoleNotAllowedError(role_id)

    @staticmethod
    def _ensure_unlocked(notepad: NotepadState) -> None:
        if notepad.locked:
            raise NotepadLockedError()

    def _ensure_rate(
        self,
        entry: _DocEntry,
        role_id: str,
        *,
        bucket: str,
    ) -> None:
        now = time.monotonic()
        if bucket == "update":
            window = _RATE_WINDOW_SECONDS
            cap = _RATE_MAX_UPDATES
            store = entry.update_timestamps
        else:
            window = _PIN_RATE_WINDOW_SECONDS
            cap = _PIN_RATE_MAX
            store = entry.pin_timestamps
        bucket_q = store.setdefault(role_id, deque())
        cutoff = now - window
        while bucket_q and bucket_q[0] < cutoff:
            bucket_q.popleft()
        if len(bucket_q) >= cap:
            raise NotepadRateLimitedError(role_id)
        bucket_q.append(now)

    # ---------------------------------------------------------- core actions
    def apply_update(
        self,
        session: Session,
        role_id: str,
        update_bytes: bytes,
    ) -> None:
        """Apply a Yjs binary update from a client to the canonical doc.

        Rejects:
        * locked notepad,
        * non-roster role (spectator-style connections),
        * oversized payload,
        * per-role rate excess.

        The service does **not** broadcast — the WS layer does that with
        the same bytes after a successful apply. Doing it here would
        couple the service to the connection manager.
        """
        self._ensure_unlocked(session.notepad)
        self._ensure_role_allowed(session, role_id)
        if len(update_bytes) > _MAX_UPDATE_BYTES:
            raise NotepadOversizedError(
                f"update {len(update_bytes)}B exceeds {_MAX_UPDATE_BYTES}B"
            )
        entry = self._docs.get(session.id) or _DocEntry(doc=Doc())
        if session.id not in self._docs:
            self._docs[session.id] = entry
        self._ensure_rate(entry, role_id, bucket="update")

        entry.doc.apply_update(update_bytes)
        session.notepad.edit_count += 1
        if role_id not in session.notepad.contributor_role_ids:
            session.notepad.contributor_role_ids.append(role_id)

    def state_as_update(self, session_id: str) -> bytes:
        """Encode the current Doc state as a single Yjs update.

        Sent to a reconnecting client so it converges without replaying
        every individual update.
        """
        return self.get_or_create(session_id).get_update()

    def set_markdown_snapshot(
        self,
        session: Session,
        role_id: str,
        markdown: str,
    ) -> None:
        """Store a client-pushed markdown serialization of the notepad.

        This is the AAR's source of truth — the server never parses Yjs
        XmlFragments. Path C of the approved plan. Rate-limited per
        role on the same bucket as ``apply_update`` because clients
        push a snapshot on every meaningful edit (debounced ~1s on the
        frontend) — a misbehaving client could otherwise hammer this
        endpoint at HTTP-handler speed.
        """
        self._ensure_unlocked(session.notepad)
        self._ensure_role_allowed(session, role_id)
        if len(markdown.encode("utf-8")) > _MAX_MARKDOWN_BYTES:
            raise NotepadOversizedError(
                f"markdown snapshot exceeds {_MAX_MARKDOWN_BYTES}B"
            )
        entry = self._docs.get(session.id) or _DocEntry(doc=Doc())
        if session.id not in self._docs:
            self._docs[session.id] = entry
        # Same per-role bucket as apply_update — both endpoints are
        # client-driven on every edit; a runaway client should hit
        # the same ceiling regardless of which path it spams.
        self._ensure_rate(entry, role_id, bucket="update")
        session.notepad.markdown_snapshot = markdown
        session.notepad.snapshot_updated_at = datetime.now(UTC)
        if role_id not in session.notepad.contributor_role_ids:
            session.notepad.contributor_role_ids.append(role_id)

    def set_template_id(self, session: Session, template_id: str) -> None:
        """Record which starter template was applied (or ``custom``).

        Idempotent w.r.t. the locked guard: rejected once locked. Does
        NOT seed the Doc — the client emits the template content as Yjs
        edits, which flow through ``apply_update`` like any other edit.
        """
        self._ensure_unlocked(session.notepad)
        session.notepad.template_id = template_id

    def lock(self, session: Session) -> None:
        if session.notepad.locked:
            return
        session.notepad.locked = True
        session.notepad.locked_at = datetime.now(UTC)

    # --------------------------------------------------------------- pinning
    _PIN_LINK_RE = re.compile(r"!?\[([^\]]*)\]\(([^)]*)\)")
    _PIN_HTML_RE = re.compile(r"<[^>]+>")
    _PIN_FENCE_RE = re.compile(r"```[^`]*```", re.DOTALL)
    _PIN_BACKTICK_RE = re.compile(r"`+")
    # ``re.MULTILINE`` so leading-marker stripping fires on every line,
    # not just the first. Without this a player can pin
    # ``\nsomething\n# Heading injected`` and the second line stays a
    # heading in the Timeline.
    _PIN_LEADING_RE = re.compile(r"^[\s>#\-*+]+", re.MULTILINE)

    @classmethod
    def sanitize_pin_text(cls, raw: str) -> str:
        """Strip markdown link/image/HTML, code fences, backticks, and
        leading list/blockquote/heading markers from text that came
        from a chat selection. Prevents a player from smuggling
        clickable links or formatting into the Timeline (which feeds
        into the AAR generation prompt). Each tag-stripping pass runs
        until fixed-point so nested markup like
        ``[![img](x)](http://evil.com)`` or ``<scr<script>ipt>``
        (which collapses to ``<script>`` after one pass) gets fully
        stripped — single-pass ``re.sub`` left residue that the
        client-side mirror in ``frontend/src/lib/notepad.ts`` was
        flagged for by CodeQL's incomplete-multi-character-
        sanitisation rule."""

        def _replace_until_stable(
            pattern: re.Pattern[str], replacement: str, source: str, *, limit: int = 8
        ) -> str:
            current = source
            for _ in range(limit):
                next_value = pattern.sub(replacement, current)
                if next_value == current:
                    return next_value
                current = next_value
            return current

        # Strip code fences first so backticks inside them don't escape
        # the fence-stripping pass.
        out = _replace_until_stable(cls._PIN_FENCE_RE, "", raw)
        out = _replace_until_stable(cls._PIN_LINK_RE, r"\1", out)
        out = _replace_until_stable(cls._PIN_HTML_RE, "", out)
        out = cls._PIN_BACKTICK_RE.sub("", out)
        out = cls._PIN_LEADING_RE.sub("", out)
        return out.strip()

    @staticmethod
    def _pin_key(action: str, source_message_id: str) -> str:
        """Compose the idempotency key for a pin. ``action`` is ``"pin"``
        (Add to notes) or ``"aar_mark"`` (Mark for AAR). Keying on the
        pair lets a user both pin AND aar-mark the same message without
        the second action being silently no-op'd."""
        return f"{action}:{source_message_id}"

    def can_pin(
        self,
        session: Session,
        role_id: str,
        source_message_id: str | None,
        *,
        action: str,
    ) -> bool:
        """Idempotency check before applying a pin. Returns False if this
        ``(action, source_message_id)`` pair was already pinned (so the
        caller short-circuits and returns 204 no-op). The same message
        can be pinned once per action — once for ``pin``, once for
        ``aar_mark`` — without colliding."""
        if source_message_id is None:
            return True
        return self._pin_key(action, source_message_id) not in session.notepad.pinned_message_keys

    def record_pin(
        self,
        session: Session,
        role_id: str,
        source_message_id: str | None,
        *,
        action: str,
    ) -> None:
        """Bookkeeping after a successful pin. Locks/role checks have
        already happened in ``apply_update`` upstream — this call only
        records idempotency and rate."""
        self._ensure_unlocked(session.notepad)
        self._ensure_role_allowed(session, role_id)
        entry = self._docs.get(session.id) or _DocEntry(doc=Doc())
        if session.id not in self._docs:
            self._docs[session.id] = entry
        self._ensure_rate(entry, role_id, bucket="pin")
        if source_message_id is not None:
            session.notepad.pinned_message_keys.append(
                self._pin_key(action, source_message_id)
            )
        if role_id not in session.notepad.contributor_role_ids:
            session.notepad.contributor_role_ids.append(role_id)


__all__ = [
    "NotepadError",
    "NotepadLockedError",
    "NotepadOversizedError",
    "NotepadRateLimitedError",
    "NotepadRoleNotAllowedError",
    "NotepadService",
]
