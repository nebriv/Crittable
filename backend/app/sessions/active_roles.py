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
    """Outcome of ``narrow_active_role_groups``.

    * ``kept_groups`` — groups preserved from the AI's yield. Each
      group is filtered to only the role_ids actually addressed in the
      same-turn text; groups that empty out are removed entirely.
    * ``dropped`` — flat list of role_ids removed across all groups
      (un-addressed in the same-turn text).
    * ``addressed_role_ids`` — full set of roles the matcher considered
      addressed (whether or not the AI included them in its yield).
      Useful for diagnostics: a role appearing here but NOT in any of
      the AI's groups means the AI under-yielded.
    * ``narrowed`` — convenience flag: ``True`` iff at least one role
      was dropped or a group was elided.
    * ``reason`` — short tag the audit logger / system note can render.
    """

    kept_groups: list[list[str]]
    dropped: list[str]
    addressed_role_ids: set[str]
    narrowed: bool
    reason: str

    @property
    def kept(self) -> list[str]:
        """Flat de-duped union of ``kept_groups`` for legacy diagnostics."""

        seen: set[str] = set()
        flat: list[str] = []
        for group in self.kept_groups:
            for rid in group:
                if rid not in seen:
                    seen.add(rid)
                    flat.append(rid)
        return flat


def narrow_active_role_groups(
    *,
    roles: list[Role],
    appended_messages: list[Message],
    ai_groups: list[list[str]],
) -> NarrowResult:
    """Drop role_ids from each group in ``ai_groups`` that aren't
    addressed in the same-turn text. Groups that become empty are
    elided entirely.

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
    #
    # Issue #168: extend the matcher so a chain like "Paul and
    # Lawrence — who's filing?" / "CISO, IR Lead — your call?" /
    # "Paul or Lawrence: respond" addresses *every* name in the chain,
    # not just the first one at clause-start. Chains MUST terminate
    # in an em-dash or colon (the chain pass deliberately rejects a
    # bare-comma terminator like "Paul, Lawrence, do X" — the
    # last "Lawrence," has no addressing separator after it, so it
    # reads as an enumeration, not an ask). The single-name pass
    # below still picks up "Paul, do X" (single addressee, comma-
    # terminated). Pre-#168 the matcher only fired on each name's
    # own clause-start match, so chained asks shrank to either the
    # head (single-name regex hit on the first name + comma) or a
    # tail member (its own clause-start match never matched mid-
    # string), losing the others.
    #
    # Two passes:
    #
    # 1. **Single-name address** (legacy shape): a name at clause-
    #    start immediately followed by `[—,:]` + content. Catches
    #    "Paul — Q", "Paul, do X", "Paul: status please".
    # 2. **Chain address**: a clause-start chain of names linked by
    #    comma / "and" / "or" / "/", terminated by `[—:]` + content.
    #    Catches "Paul, Lawrence — Q", "Paul and Lawrence —", "X, Y,
    #    and Z: status?" — every name in the chain is treated as
    #    addressed.
    addressed_in_text: set[str] = set()

    # Pass 1 — single-name addressing. Same shape as the pre-#168
    # matcher; preserves the exact backwards-compatible semantics for
    # cases that don't involve a chain.
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

    # Pass 2 — chain addressing. Capture an entire chain prefix
    # (one or more names linked by comma / "and" / "or" / "/") that
    # terminates in `[—:]` + content. We allow comma INSIDE the chain
    # (so "Paul, Lawrence — …" is one chain), but we still require
    # the *terminator* to be `—` or `:` so a single bare comma
    # ("Paul, do X") falls through to pass 1's single-name shape
    # and doesn't get misread as a 1-element chain.
    _CHAIN_PREFIX = re.compile(
        r"(?:^|(?<=[\.\?\!—\n]))"
        r"\s*"
        # Capture the chain. Allow letters / spaces / commas / slashes
        # / "and" / "or" — but NOT em-dash / colon / period / question
        # / exclamation / newline (those would terminate or invalidate
        # the chain). Length-bounded so a runaway sentence can't turn
        # into a fake chain.
        r"([A-Za-z][A-Za-z\s,/]{1,200}?)"
        # Terminator: em-dash or colon followed by whitespace + content.
        r"\s*[—:]\s+\S",
        re.IGNORECASE,
    )

    for match in _CHAIN_PREFIX.finditer(text):
        prefix = match.group(1).strip()
        # Split the prefix on chain separators (comma / "and" / "or" /
        # "/") to get the candidate names. Filter empty pieces.
        pieces = re.split(
            r"\s*(?:,|/|\band\b|\bor\b)\s*",
            prefix,
            flags=re.IGNORECASE,
        )
        candidate_names = {p.strip().lower() for p in pieces if p.strip()}
        if not candidate_names:
            continue
        for role in roles:
            for name_field in (role.label, role.display_name):
                if not name_field:
                    continue
                if name_field.strip().lower() in candidate_names:
                    addressed_in_text.add(role.id)
                    break

    addressed = explicit_targets | addressed_in_text

    # Phase 3: decide. If the AI's set has no overlap with the addressed
    # set AND the addressed set is empty (no names at clause-start, no
    # explicit tool targets), this is a generic team broadcast. Keep
    # the AI's groups unchanged so we don't accidentally narrow to
    # empty on legitimate "Team — your move?" turns.
    if not addressed:
        return NarrowResult(
            kept_groups=[list(g) for g in ai_groups],
            dropped=[],
            addressed_role_ids=set(),
            narrowed=False,
            reason="no_addressed_roles_no_narrowing",
        )

    keep_set = addressed
    kept_groups: list[list[str]] = []
    dropped: list[str] = []
    for group in ai_groups:
        kept_in_group = [rid for rid in group if rid in keep_set]
        for rid in group:
            if rid not in keep_set:
                dropped.append(rid)
        if kept_in_group:
            kept_groups.append(kept_in_group)

    # Safety: never narrow to empty. If the heuristic would drop
    # every group the AI yielded to, bail out and keep the original.
    # This covers the rare case where the matcher misses every name
    # (e.g. the model used a nickname not in the roster) and the AI's
    # groups are at least directionally sensible.
    if not kept_groups:
        return NarrowResult(
            kept_groups=[list(g) for g in ai_groups],
            dropped=[],
            addressed_role_ids=addressed,
            narrowed=False,
            reason="would_narrow_to_empty_kept_original",
        )

    if not dropped:
        return NarrowResult(
            kept_groups=kept_groups,
            dropped=[],
            addressed_role_ids=addressed,
            narrowed=False,
            reason="ai_set_already_matches_addressed",
        )

    return NarrowResult(
        kept_groups=kept_groups,
        dropped=dropped,
        addressed_role_ids=addressed,
        narrowed=True,
        reason="dropped_unaddressed_roles",
    )


__all__ = ["NarrowResult", "narrow_active_role_groups"]
