"""Operator-facing markdown exports (chat-declutter polish).

Two complementary surfaces, both creator-only and both AAR-independent:

* :func:`render_timeline_markdown` — curated subset: track lifecycle
  (which workstreams opened, by whom, when) + critical injects + pinned
  artifacts (long ``share_data`` calls + persistence findings).
  Chronological, grouped by minute. Useful as an at-a-glance debrief
  the operator can paste into a follow-up ticket without scrolling
  through 200 chat lines.

* :func:`render_full_record_markdown` — every visible message in
  chronological order with ``track + role + ts + flags`` per row. The
  raw transcript dump.

These are NOT the AAR. The AAR pipeline stays workstream-blind per
plan §6.9; these exports are the live-exercise companion artifacts
the iter-4 mockup added to the creator's management column.

Visibility rules (defense in depth — the route also enforces creator-
only): when rendering for a non-creator caller we still respect each
message's ``visibility`` list. Both call sites currently pass the
creator role id, so the visibility filter is a cheap belt-and-braces
against a future caller forgetting the authz check.

Both functions are pure: they take a snapshot-reference :class:`Session`
and return a markdown string. No I/O, no LLM calls, safe to invoke
under the per-session lock.
"""

from __future__ import annotations

from collections import defaultdict

from .models import Message, MessageKind, Session

# Same threshold the frontend Timeline uses for ``share_data`` pinning
# — short shares clutter the rail, only substantial dumps deserve a pin.
# Lifted into the export so the creator's "what's pinworthy?" view is
# consistent with what the right-rail UI flags as a Data brief.
SHARE_DATA_PIN_MIN_CHARS = 300


def _filename_slug(title: str | None, *, max_len: int = 40) -> str:
    """ASCII-only, dash-separated filename slug used in
    ``Content-Disposition``. Mirrors the helper in routes.py but
    duplicated here so the exports module stays standalone for tests.
    """

    import re

    base = (title or "exercise").lower()
    slug = re.sub(r"[^a-z0-9]+", "-", base).strip("-")
    return slug[:max_len].strip("-") or "exercise"


def _role_label(session: Session, role_id: str | None) -> str:
    if role_id is None:
        return "AI Facilitator"
    role = session.role_by_id(role_id)
    if role is None:
        return f"role-{role_id[:6]}"
    if role.display_name:
        return f"{role.label} ({role.display_name})"
    return role.label


def _ws_label(session: Session, ws_id: str | None) -> str:
    """Resolve a workstream id to a human label.

    Returns ``"#main"`` for ``None`` (synthetic unscoped bucket) and
    falls back to the literal id for an unknown value (the override
    endpoint validates against the declared set, so this branch only
    fires if a session is mid-flight when a workstream is renamed —
    which Phase B disallows; defensive only).
    """

    if ws_id is None:
        return "#main"
    if session.plan is None:
        return f"#{ws_id}"
    label = next(
        (ws.label for ws in session.plan.workstreams if ws.id == ws_id), None
    )
    return f"#{label}" if label else f"#{ws_id}"


def _minute_bucket(msg: Message) -> str:
    """Group key for the full-record export. Wall-clock minute in UTC,
    e.g. ``"14:32"``. Same shape the frontend's sticky minute anchor
    uses, so the two surfaces read identically."""

    return msg.ts.strftime("%H:%M")


def _format_ts(msg: Message) -> str:
    """ISO-8601-with-seconds. Operator-voice consistency: every
    timestamp in these exports is the same shape so ctrl-F works."""

    return msg.ts.isoformat(timespec="seconds")


def _is_pinworthy_share_data(msg: Message) -> bool:
    if msg.tool_name != "share_data":
        return False
    return len(msg.body or "") >= SHARE_DATA_PIN_MIN_CHARS


def _flatten_one_line(text: str) -> str:
    """Collapse a body to a single line for compact rows. Preserves
    information-bearing punctuation but kills the formatting (newlines,
    runs of whitespace) that would break the bullet list."""

    return " ".join((text or "").split())


def render_timeline_markdown(session: Session, *, viewer_role_id: str) -> str:
    """Curated chronological summary — track lifecycle + injects + pinned
    artifacts. The creator's "what just happened" debrief.

    Sections:
      1. Track lifecycle — one line per declared workstream + when its
         first message landed (the ``track_open`` landmark the frontend
         renders inline).
      2. Critical events — every ``critical_inject`` with headline +
         body preview.
      3. Pinned artifacts — substantial ``share_data`` calls, each with
         label + role + body preview.

    Visibility-respecting (only includes messages the viewer would have
    seen — for the creator that's everything; defense in depth against
    a future non-creator caller).
    """

    is_creator = viewer_role_id == session.creator_role_id
    visible = [
        m
        for m in session.messages
        if m.is_visible_to(viewer_role_id, is_creator=is_creator)
    ]

    title = session.plan.title if session.plan else "Tabletop exercise"
    started = session.created_at.isoformat(timespec="seconds")
    ended = session.ended_at.isoformat(timespec="seconds") if session.ended_at else None

    lines: list[str] = []
    lines.append(f"# {title} — Timeline")
    lines.append("")
    lines.append(f"- **Session:** `{session.id}`")
    lines.append(f"- **Started:** {started}")
    if ended:
        lines.append(f"- **Ended:** {ended}")
    lines.append(f"- **State:** {session.state.value}")
    lines.append("")

    # --- track lifecycle --------------------------------------------
    declared = (
        list(session.plan.workstreams) if session.plan is not None else []
    )
    if declared:
        lines.append("## Track lifecycle")
        lines.append("")
        # First message per workstream, in declaration order.
        first_seen: dict[str, Message] = {}
        for m in visible:
            if m.workstream_id and m.workstream_id not in first_seen:
                first_seen[m.workstream_id] = m
        if not first_seen:
            lines.append(
                "_No workstream-tagged messages yet — every message landed in "
                "the synthetic `#main` bucket._"
            )
        else:
            for ws in declared:
                msg = first_seen.get(ws.id)
                if msg is None:
                    lines.append(
                        f"- **#{ws.label}** — declared, no messages yet"
                    )
                    continue
                opener = _role_label(session, msg.role_id)
                lines.append(
                    f"- **#{ws.label}** — opened by {opener} at "
                    f"{_format_ts(msg)}"
                )
        lines.append("")

    # --- critical events --------------------------------------------
    crits = [m for m in visible if m.kind == MessageKind.CRITICAL_INJECT]
    if crits:
        lines.append("## Critical events")
        lines.append("")
        for m in crits:
            args = m.tool_args or {}
            headline = (
                args.get("headline") if isinstance(args.get("headline"), str) else None
            )
            severity = (
                args.get("severity") if isinstance(args.get("severity"), str) else None
            )
            ws_lbl = _ws_label(session, m.workstream_id)
            head = headline or "Critical event"
            sev = f" · {severity}" if severity else ""
            lines.append(
                f"- **{_format_ts(m)}** · {ws_lbl}{sev} — **{head}**"
            )
            preview = _flatten_one_line(m.body)
            if preview and preview != head:
                lines.append(f"  - {preview}")
        lines.append("")

    # --- pinned artifacts -------------------------------------------
    artifacts = [m for m in visible if _is_pinworthy_share_data(m)]
    if artifacts:
        lines.append("## Pinned artifacts")
        lines.append("")
        for m in artifacts:
            args = m.tool_args or {}
            label_value = args.get("label")
            label = label_value if isinstance(label_value, str) else "Data shared"
            ws_lbl = _ws_label(session, m.workstream_id)
            actor = _role_label(session, m.role_id)
            lines.append(
                f"- **{_format_ts(m)}** · {ws_lbl} · {actor} — **{label}**"
            )
            preview = _flatten_one_line(m.body)
            if preview:
                # Cap the preview so the timeline doesn't balloon when an
                # AI dropped a 4 kB log dump as a share_data body.
                if len(preview) > 280:
                    preview = preview[:277].rstrip() + "…"
                lines.append(f"  - {preview}")
        lines.append("")

    if not declared and not crits and not artifacts:
        lines.append(
            "_No timeline-worthy events yet (no declared workstreams, "
            "critical injects, or pinned artifacts)._"
        )
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def _flag_chips(msg: Message) -> str:
    """Render the per-row flag suffix for the full-record export.

    Operator wants a glance-readable indicator of the few
    interaction-driving properties: ``[INJECT]`` for criticals, ``[SIDEBAR]``
    for out-of-turn interjections, ``[@you-style]`` for messages mentioning
    a role (we list the count, not the specific ids — a name-list would
    blow up the row width).
    """

    flags: list[str] = []
    if msg.kind == MessageKind.CRITICAL_INJECT:
        flags.append("INJECT")
    if msg.is_interjection:
        flags.append("SIDEBAR")
    if msg.tool_name:
        flags.append(f"tool:{msg.tool_name}")
    if msg.mentions:
        flags.append(f"mentions:{len(msg.mentions)}")
    return f" [{' · '.join(flags)}]" if flags else ""


def render_full_record_markdown(
    session: Session, *, viewer_role_id: str
) -> str:
    """Every visible message, chronological, grouped by minute.

    Each row carries ``track · role · ts · flags`` so an operator can
    grep the dump for ``#containment`` or ``[INJECT]`` and find the
    whole sequence.

    Visibility-respecting like ``render_timeline_markdown``.
    """

    is_creator = viewer_role_id == session.creator_role_id
    visible = [
        m
        for m in session.messages
        if m.is_visible_to(viewer_role_id, is_creator=is_creator)
    ]

    title = session.plan.title if session.plan else "Tabletop exercise"
    started = session.created_at.isoformat(timespec="seconds")
    ended = session.ended_at.isoformat(timespec="seconds") if session.ended_at else None

    lines: list[str] = []
    lines.append(f"# {title} — Full record")
    lines.append("")
    lines.append(f"- **Session:** `{session.id}`")
    lines.append(f"- **Started:** {started}")
    if ended:
        lines.append(f"- **Ended:** {ended}")
    lines.append(f"- **State:** {session.state.value}")
    lines.append(f"- **Messages:** {len(visible)}")
    lines.append("")

    if not visible:
        lines.append("_No messages yet._")
        lines.append("")
        return "\n".join(lines).rstrip() + "\n"

    # Group by HH:MM so a long exercise doesn't render as a wall of
    # rows. Mirrors the sticky minute-anchor in the live transcript.
    grouped: dict[str, list[Message]] = defaultdict(list)
    order: list[str] = []
    for m in visible:
        bucket = _minute_bucket(m)
        if bucket not in grouped:
            order.append(bucket)
        grouped[bucket].append(m)

    for bucket in order:
        lines.append(f"### {bucket}")
        lines.append("")
        for m in grouped[bucket]:
            ws_lbl = _ws_label(session, m.workstream_id)
            actor = _role_label(session, m.role_id)
            flags = _flag_chips(m)
            preview = _flatten_one_line(m.body) or "_(empty)_"
            if len(preview) > 500:
                preview = preview[:497].rstrip() + "…"
            lines.append(
                f"- **{_format_ts(m)}** · {ws_lbl} · {actor}{flags}: {preview}"
            )
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def timeline_filename(session: Session) -> str:
    title = session.plan.title if session.plan else None
    return f"{_filename_slug(title)}-timeline.md"


def full_record_filename(session: Session) -> str:
    title = session.plan.title if session.plan else None
    return f"{_filename_slug(title)}-full-record.md"


__all__ = [
    "full_record_filename",
    "render_full_record_markdown",
    "render_timeline_markdown",
    "timeline_filename",
]
