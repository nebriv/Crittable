"""Notepad starter-template registry (issue #98).

Three opt-in templates the creator can apply on the empty notepad:

* ``generic_ir`` — a minimal scaffold for any incident.
* ``ransomware`` — pre-seeded timeline beats and decisions for ransomware.
* ``data_breach`` — regulatory clocks (GDPR/CCPA/HIPAA) and notification
  scaffolding.

The contents are static markdown shipped in this directory. The first
client (typically the creator's editor) reads the chosen template via
GET /api/sessions/{id}/notepad/templates/{id}, applies it as a Yjs edit
to the empty doc, and the change flows to other clients via the normal
notepad_update channel — keeps the server out of the XmlFragment-walking
business per path C.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

_TEMPLATE_DIR = Path(__file__).parent / "notepad"


@dataclass(frozen=True)
class NotepadTemplate:
    id: str
    label: str
    description: str
    content: str


_TEMPLATE_DEFS: tuple[tuple[str, str, str], ...] = (
    (
        "generic_ir",
        "Generic incident response",
        "A minimal scaffold — timeline, action items, decisions, open questions. Good when you don't know what kind of incident you're running yet.",
    ),
    (
        "ransomware",
        "Ransomware",
        "Pre-seeded timeline beats (detection → isolation → ransom call → recovery), targeted action items, and open questions about backups + exfiltration.",
    ),
    (
        "data_breach",
        "Data breach (notification-driven)",
        "Regulatory clock items (GDPR 72h, CCPA, HIPAA), legal + comms coordination, customer-notification scaffolding.",
    ),
)


def _load() -> dict[str, NotepadTemplate]:
    out: dict[str, NotepadTemplate] = {}
    for tid, label, description in _TEMPLATE_DEFS:
        path = _TEMPLATE_DIR / f"{tid}.md"
        out[tid] = NotepadTemplate(
            id=tid,
            label=label,
            description=description,
            content=path.read_text(encoding="utf-8"),
        )
    return out


_TEMPLATES: dict[str, NotepadTemplate] = _load()


def list_templates() -> list[NotepadTemplate]:
    """Templates surfaced in the empty-state picker, in display order."""
    return list(_TEMPLATES.values())


def get_template(template_id: str) -> NotepadTemplate | None:
    """Look up a template by id. Returns ``None`` for unknown ids — the
    HTTP handler raises 404 in that case."""
    return _TEMPLATES.get(template_id)


__all__ = ["NotepadTemplate", "get_template", "list_templates"]
