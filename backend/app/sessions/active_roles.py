"""Server-side ``set_active_roles`` narrower.

The play-tier model historically yielded to roles it did not actually
address — e.g. broadcast "Ben — what's your call?" then
``set_active_roles([ben.id, engineer.id])``. That stalls the turn: the
engine waits for an engineer reply that's never coming, and a creator
has to force-advance to unstick. Prompt-only enforcement is fragile;
this module is the load-bearing safety net.

Contract: given the AI's ``set_active_roles`` output and the
player-facing tool calls it emitted on the same turn, drop role_ids
whose canonical name is *not addressed* in the text (and that aren't
the explicit ``role_id`` argument of an addressing tool). Returns the
kept set + the dropped set so the caller can audit.

Heuristic — what counts as "addressed":

1. **Explicit tool target**: any role_id that appears in
   ``address_role.role_id`` / ``pose_choice.role_id`` /
   ``request_artifact.role_id`` is unconditionally addressed. These
   are zero-ambiguity signals.

2. **Clause-start name match**: the role's canonical ``label`` OR
   ``display_name`` appears at the *start* of a clause, immediately
   followed by an addressing separator (em-dash, comma, or colon)
   and at least one more character. Clause start = beginning of
   text, OR after ``.``, ``?``, ``!``, ``—``, or newline + whitespace.

   This deliberately rejects mere references — "check with Mike",
   "loop in Legal", "Mike Benedetto is not yet notified" — none of
   those are addressing patterns. Only the imperative "Mike — …" /
   "Mike, …" / "Mike: …" style counts.

Conservative fallback: if the heuristic would drop **every** role in
the input set AND no explicit tool target exists, we keep the AI's
original set unchanged. This protects against the legitimate
generic-team broadcast case ("Team — what do we do?") where no role
name appears at all.

The narrower is **idempotent and side-effect-free**. The caller is
responsible for emitting the audit log line + the creator-visible
note.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .models import Message, Role

# Tool names whose ``tool_args["role_id"]`` is an unambiguous "this is
# the addressee" signal. Adding to this list expands the explicit-target
# set the matcher will honor without any text inspection.
_EXPLICIT_ADDRESS_TOOLS: frozenset[str] = frozenset(
    {"address_role", "pose_choice", "request_artifact"}
)

# Tool names whose body text is read into the player-facing surface
# the matcher scans for clause-start addressing patterns.
# ``share_data`` is intentionally NOT included: its body is a synthetic
# data dump (logs / IOCs / packet captures) where role names appearing
# in column headers, sample IPs, or fictional log lines would
# constantly false-positive as "addressing". A turn that genuinely
# wants to ask a role about the data should pair ``share_data`` with
# a separate ``broadcast`` / ``address_role`` whose body addresses the
# role at clause-start. ``request_artifact`` is also excluded for the
# same reason — its ``instructions`` field is brief-style content and
# its addressee comes through the explicit ``role_id`` tool arg
# (``_EXPLICIT_ADDRESS_TOOLS`` below), not text matching.
_PLAYER_FACING_TOOLS: frozenset[str] = frozenset(
    {"broadcast", "address_role", "pose_choice"}
)

# Clause-start prefix: anchored to the start of the text, OR following
# an end-of-sentence character (.!?) / em-dash / newline + optional
# whitespace. Em-dash is treated as a clause delimiter because the
# model uses it freely as a soft-break ("Ben — yes. Engineer — pull
# logs.").
_CLAUSE_START = r"(?:^|(?<=[\.\?\!—\n])\s*)"

# Addressing separator: em-dash, comma, or colon, followed by
# whitespace and at least one more character. Bare em-dashes with
# nothing after them ("Ben —") at the very tail of a string are
# uncommon and don't read as addressing anyway.
_ADDRESS_SEP = r"\s*[—,:]\s+\S"


@dataclass(frozen=True)
class NarrowResult:
    """Outcome of ``narrow_active_roles``.

    * ``kept`` — role_ids preserved from the AI's set.
    * ``dropped`` — role_ids removed (un-addressed in the same-turn text).
    * ``addressed_role_ids`` — full set of roles the matcher considered
      addressed (whether or not the AI included them in its yield).
      Useful for diagnostics: a role appearing here but NOT in the AI's
      original set means the AI under-yielded.
    * ``narrowed`` — convenience flag: ``True`` iff at least one role
      was dropped.
    * ``reason`` — short tag the audit logger / system note can render.
    """

    kept: list[str]
    dropped: list[str]
    addressed_role_ids: set[str]
    narrowed: bool
    reason: str


def narrow_active_roles(
    *,
    roles: list[Role],
    appended_messages: list[Message],
    ai_set: list[str],
) -> NarrowResult:
    """Drop role_ids from ``ai_set`` not addressed in the same-turn text.

    See module docstring for the heuristic. Pure function; the caller
    handles audit + transcript surfacing.
    """

    role_by_id: dict[str, Role] = {r.id: r for r in roles}

    # Phase 1: collect explicit tool-arg targets + the player-facing text
    # body. The two are gathered in one pass over ``appended_messages``
    # so we don't iterate the list twice.
    explicit_targets: set[str] = set()
    text_parts: list[str] = []
    for msg in appended_messages:
        if msg.tool_name in _EXPLICIT_ADDRESS_TOOLS and msg.tool_args:
            tgt = msg.tool_args.get("role_id")
            if isinstance(tgt, str) and tgt in role_by_id:
                explicit_targets.add(tgt)
        if msg.tool_name in _PLAYER_FACING_TOOLS:
            if msg.body:
                text_parts.append(msg.body)
    text = "\n".join(text_parts)

    # Phase 2: find which roles' canonical names appear in addressing
    # position within the concatenated text. Both ``label`` and
    # ``display_name`` are tried; either match counts.
    addressed_in_text: set[str] = set()
    for role in roles:
        names: list[str] = []
        if role.label.strip():
            names.append(role.label.strip())
        if role.display_name and role.display_name.strip():
            names.append(role.display_name.strip())
        for name in names:
            pattern = _CLAUSE_START + r"\b" + re.escape(name) + r"\b" + _ADDRESS_SEP
            if re.search(pattern, text, flags=re.IGNORECASE):
                addressed_in_text.add(role.id)
                break

    addressed = explicit_targets | addressed_in_text

    # Phase 3: decide. If the AI's set has no overlap with the addressed
    # set AND the addressed set is empty (no names at clause-start, no
    # explicit tool targets), this is a generic team broadcast. Keep
    # the AI's set unchanged so we don't accidentally narrow to empty
    # on legitimate "Team — your move?" turns.
    if not addressed:
        return NarrowResult(
            kept=list(ai_set),
            dropped=[],
            addressed_role_ids=set(),
            narrowed=False,
            reason="no_addressed_roles_no_narrowing",
        )

    keep_set = addressed
    kept = [rid for rid in ai_set if rid in keep_set]
    dropped = [rid for rid in ai_set if rid not in keep_set]

    # Safety: never narrow to empty. If the heuristic would drop
    # everyone the AI yielded to, bail out and keep the original. This
    # covers the rare case where the matcher misses every name (e.g.
    # the model used a nickname not in the roster) and the AI's set
    # is at least directionally sensible.
    if not kept:
        return NarrowResult(
            kept=list(ai_set),
            dropped=[],
            addressed_role_ids=addressed,
            narrowed=False,
            reason="would_narrow_to_empty_kept_original",
        )

    if not dropped:
        return NarrowResult(
            kept=kept,
            dropped=[],
            addressed_role_ids=addressed,
            narrowed=False,
            reason="ai_set_already_matches_addressed",
        )

    return NarrowResult(
        kept=kept,
        dropped=dropped,
        addressed_role_ids=addressed,
        narrowed=True,
        reason="dropped_unaddressed_roles",
    )


__all__ = ["NarrowResult", "narrow_active_roles"]
