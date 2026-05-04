/**
 * Wave 2 (composer mentions + facilitator routing).
 *
 * Pure helpers backing the ``MentionPopover`` component and its
 * consumer ``Composer``. Lives in its own file so:
 *   * Vite Fast Refresh can keep the component file as
 *     components-only (its own lint rule).
 *   * Unit tests can exercise the helpers without rendering.
 *
 * The whole point of these helpers is the **mark/resolve, not
 * regex** invariant from ``docs/plans/chat-decluttering.md`` §5.1
 * and §6.6. The composer's mention state is a list of marks
 * ``{start, end, target}``; helpers here translate textarea events
 * into "open the popover with this query at this anchor" or "this
 * picked entry resolves to this target" — never to "find the
 * mentions by regex-scanning the body".
 */

/** Roster entry the popover offers as an option. */
export interface MentionRosterEntry {
  /** Real role_id; the synthetic facilitator entry uses the literal
   * string ``"facilitator"``. */
  target: string;
  /** Visible label inserted into the body (e.g. ``"CISO"``,
   * ``"facilitator"``). The composer wraps it in a leading ``@`` so
   * the body reads ``@CISO`` after insertion. */
  insertLabel: string;
  /** Display label rendered in the popover row. May differ from
   * ``insertLabel`` (e.g. show ``"CISO · Alex"`` in the row but
   * insert just ``CISO``). */
  displayLabel: string;
  /** Optional secondary line — currently used to surface display name
   * for real roles + the alias hint for the facilitator entry. */
  secondary?: string;
  /** True for the synthetic ``@facilitator`` row. Drives the visual
   * separator + the alias copy. */
  isFacilitator?: boolean;
}

/**
 * Canonical token the server reads as "fire ``run_interject``" when
 * present in ``mentions[]``. Aliases (``@ai`` / ``@gm``) resolve to
 * this same string client-side; the wire payload only ever carries
 * the canonical token, never the alias.
 */
export const FACILITATOR_TARGET = "facilitator" as const;

/**
 * Synthetic facilitator entry the popover renders at the top of the
 * suggestion list. Built once + frozen so React reference-equality
 * checks on the popover's option array stay stable across renders.
 */
const FACILITATOR_ENTRY: MentionRosterEntry = {
  target: FACILITATOR_TARGET,
  insertLabel: FACILITATOR_TARGET,
  displayLabel: FACILITATOR_TARGET,
  secondary: "AI · aliases @ai / @gm",
  isFacilitator: true,
};

/**
 * Substrings the user can type after an ``@`` to surface the
 * synthetic facilitator entry. Three aliases all collapse to the
 * canonical ``"facilitator"`` token on insertion — kept here so the
 * popover, the composer, and any future surface (e.g. the AAR
 * "tell the facilitator" button) all agree.
 */
const FACILITATOR_ALIASES = [FACILITATOR_TARGET, "ai", "gm"];

/**
 * Build the list of strings the typeahead matches a roster entry
 * against. We match on:
 *   * The full ``insertLabel`` (e.g. "CISO", "IR Lead").
 *   * The full ``secondary`` line if present (e.g. "Diana Vance" — so
 *     ``@Vance`` filters down to the matching role even though
 *     "Vance" isn't the first word).
 *   * Each whitespace-separated token of the display name (so
 *     ``@Vance`` and ``@Diana`` both work, and matches against an
 *     intermediate token like ``@Carlos`` for "Maria Carlos
 *     Hernandez").
 *
 * Returned lowercased so the caller can do a single
 * ``startsWith`` / ``includes`` pass without re-lowering.
 */
function _matchableStrings(entry: MentionRosterEntry): string[] {
  const out = [entry.insertLabel.toLowerCase()];
  if (entry.secondary) {
    const lower = entry.secondary.toLowerCase();
    out.push(lower);
    for (const tok of lower.split(/\s+/)) {
      if (tok && !out.includes(tok)) out.push(tok);
    }
  }
  return out;
}

/**
 * Filter the roster by typeahead. Case-insensitive substring match
 * against the role's ``insertLabel`` AND any token of the
 * ``secondary`` line (full display name, first name, last name —
 * see ``_matchableStrings``). So a user who knows a player by
 * first name, last name, OR role label all converge on the same
 * popover row.
 *
 * The synthetic facilitator entry is always shown when the query
 * matches any of its aliases (``facilitator`` / ``ai`` / ``gm``)
 * OR when the query is empty (so the player sees the affordance
 * even before they type anything past ``@``).
 *
 * Order is: facilitator first (when matched), then roster entries
 * in their declared order. Roster entries that arrive in the input
 * with ``target === "facilitator"`` are intentionally dropped — the
 * synthetic entry is the canonical one and we never want it
 * surfaced twice.
 */
export function filterMentionRoster(
  query: string,
  roster: MentionRosterEntry[],
): MentionRosterEntry[] {
  const q = query.trim().toLowerCase();
  const out: MentionRosterEntry[] = [];

  const facilitatorMatches =
    q === "" || FACILITATOR_ALIASES.some((a) => a.startsWith(q));
  if (facilitatorMatches) out.push(FACILITATOR_ENTRY);

  for (const r of roster) {
    if (r.target === FACILITATOR_TARGET) continue; // defensive: no dups
    if (q === "") {
      out.push(r);
      continue;
    }
    if (_matchableStrings(r).some((h) => h.includes(q))) out.push(r);
  }
  return out;
}

/**
 * Helper for the Composer's keydown handler — clamp & wrap an index
 * inside a list of ``size`` entries. Exposed so the composer can
 * navigate the popover without depending on the popover component
 * itself.
 */
export function nextHighlightIndex(
  current: number,
  delta: 1 | -1,
  size: number,
): number {
  if (size <= 0) return 0;
  return (current + delta + size) % size;
}

/**
 * Build the stable HTML ``id`` for a popover option, derived from the
 * listbox id + the entry's ``target``. The two call sites that need
 * this id MUST use the same derivation so the textarea's
 * ``aria-activedescendant`` always points at the option that's
 * actually rendered. UI/UX review HIGH H1.
 *
 * The sanitizer strips characters that aren't valid in an HTML id
 * fragment. Real ``role_id`` values are short alphanumerics; this
 * regex is defensive for the synthetic ``"facilitator"`` entry and
 * any future targets.
 */
export function optionIdFor(listboxId: string, target: string): string {
  return `${listboxId}-${target.replace(/[^a-z0-9_-]/gi, "_")}`;
}

/**
 * Resolve a single-word ``@<token>`` (without the leading ``@``) to
 * a canonical mention target. Used by the popover layer where the
 * typeahead query is by definition a single word (typing a space
 * closes the popover).
 *
 * Single-word match rules:
 *   * Aliases ``facilitator`` / ``ai`` / ``gm`` → the canonical
 *     ``FACILITATOR_TARGET``.
 *   * Roster ``insertLabel`` (case-insensitive equality) → the
 *     entry's ``target``. Multi-word labels like "IR Lead" are NOT
 *     matched here — use ``scanBodyForMentions`` for body-scan
 *     resolution that supports labels with spaces.
 *   * Any whitespace-separated token of the entry's ``secondary``
 *     line (typically the display name) → the entry's ``target``.
 *     So ``@Diana`` and ``@Vance`` both resolve to "Diana Vance"'s
 *     role.
 *
 * Returns ``null`` for anything else.
 */
export function resolveMentionToken(
  token: string,
  roster: MentionRosterEntry[],
): string | null {
  const t = token.toLowerCase();
  if (FACILITATOR_ALIASES.includes(t)) return FACILITATOR_TARGET;
  for (const r of roster) {
    if (r.insertLabel.toLowerCase() === t) return r.target;
    if (r.secondary) {
      for (const part of r.secondary.toLowerCase().split(/\s+/)) {
        if (part === t) return r.target;
      }
    }
  }
  return null;
}

/**
 * Build a longest-first list of (matchable string, target) pairs
 * for the body-scan to consume. Sorting longest-first lets the scan
 * pick "IR Lead" over "IR" when both could match at the same ``@``
 * position — without it, a roster with both "IR" and "IR Lead"
 * (which is a real possibility for a hand-typed multi-word label)
 * would resolve incorrectly.
 *
 * Each entry contributes:
 *   * Its ``insertLabel`` (the canonical visible token).
 *   * Its full ``secondary`` line if present (e.g. "Diana Vance").
 *   * Each whitespace-separated token of ``secondary`` (so
 *     ``@Vance`` resolves the same as ``@Diana``).
 *
 * Aliases are added at the top so they win over a roster entry that
 * happens to share their string (defensive — a creator naming a role
 * "AI" would otherwise collide with the alias).
 */
function _matchTable(
  roster: MentionRosterEntry[],
): Array<{ needle: string; target: string }> {
  const rows: Array<{ needle: string; target: string }> = [];
  for (const alias of FACILITATOR_ALIASES) {
    rows.push({ needle: alias, target: FACILITATOR_TARGET });
  }
  for (const r of roster) {
    if (r.target === FACILITATOR_TARGET) continue;
    rows.push({ needle: r.insertLabel.toLowerCase(), target: r.target });
    if (r.secondary) {
      const lower = r.secondary.toLowerCase();
      rows.push({ needle: lower, target: r.target });
      for (const tok of lower.split(/\s+/)) {
        if (tok) rows.push({ needle: tok, target: r.target });
      }
    }
  }
  // Longest first — "IR Lead" must match before "IR" at any given
  // ``@`` position.
  rows.sort((a, b) => b.needle.length - a.needle.length);
  return rows;
}

// End-of-token characters: a needle match only counts when the
// character immediately after the matched span is whitespace,
// punctuation, or end-of-string. Without this gate, ``@CISOlater``
// would resolve to CISO (the bare ``CISO`` matches, the trailing
// ``later`` is ignored). Keep narrow — letters / digits / underscore
// extend the token; anything else terminates it.
const _TOKEN_TERMINATOR = /[^A-Za-z0-9_]/;

/**
 * Scan a message body for ``@<token>`` patterns and resolve each
 * one to a mention target. Used by the Composer at submit time so a
 * user who types ``@facilitator`` (or ``@CISO``, or ``@IR Lead``,
 * or ``@Diana Vance``) literally — without picking from the popover
 * — still produces the same structural ``mentions[]`` payload as a
 * popover-driven submission.
 *
 * Multi-word match support: each ``@`` position tries every needle
 * in ``_matchTable`` longest-first; the first matching needle whose
 * post-span character is a token terminator wins. So ``@IR Lead``
 * resolves to the IR Lead role even though the visible token has a
 * space — without this, a user who types the role label from
 * memory (or pastes it in) would get a silent no-op.
 *
 * The scan is bounded by:
 *   * Word-boundary check at the ``@`` (only ``@`` at start-of-
 *     string or after whitespace counts; ``foo@bar.com`` does not
 *     match).
 *   * The session roster + the closed alias set (no arbitrary text
 *     matches; the resolver is closed).
 *   * Token-terminator check on the trailing edge so ``@CISOlater``
 *     does not match.
 *
 * This is the only place the composer reads the body to derive
 * mentions. The ``marks`` list remains the source of truth for
 * popover-picked tokens; this function only adds tokens that have
 * NO mark — popover-picked entries already produce a mark whose
 * target is recorded directly. (See ``Composer.tsx::submit``.)
 *
 * Returns the de-duplicated list, in the order the matches appear
 * (first appearance wins on duplicates).
 */
export function scanBodyForMentions(
  body: string,
  roster: MentionRosterEntry[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const table = _matchTable(roster);
  const lower = body.toLowerCase();
  let i = 0;
  while (i < body.length) {
    if (body[i] !== "@") {
      i += 1;
      continue;
    }
    // Word-boundary on the leading edge.
    if (i > 0 && !/\s/.test(body[i - 1])) {
      i += 1;
      continue;
    }
    const after = i + 1;
    // Try each needle longest-first; the first whose match ends on
    // a token terminator (or end-of-string) wins.
    let matched: { needle: string; target: string } | null = null;
    for (const row of table) {
      if (after + row.needle.length > body.length) continue;
      if (lower.slice(after, after + row.needle.length) !== row.needle) continue;
      const next = body[after + row.needle.length];
      if (next !== undefined && !_TOKEN_TERMINATOR.test(next)) continue;
      matched = row;
      break;
    }
    if (matched) {
      if (!seen.has(matched.target)) {
        seen.add(matched.target);
        out.push(matched.target);
      }
      i = after + matched.needle.length;
    } else {
      i += 1;
    }
  }
  return out;
}

/**
 * Translate a (text, caret) snapshot into the active mention
 * trigger context, or ``null`` when the caret isn't inside a valid
 * ``@<query>`` token. The composer calls this on every keystroke
 * to decide whether to open / refresh / close the popover.
 *
 * "Valid" means:
 *   * The ``@`` is at the start of the line OR follows whitespace
 *     (so ``foo@bar.com`` does NOT trigger the popover).
 *   * No whitespace appears between the ``@`` and the caret (typing
 *     a space implicitly commits or abandons).
 *   * The query length is bounded (32 chars) — anything longer
 *     reads as pasted prose, not a typeahead refinement.
 */
export function readMentionContext(
  text: string,
  caretPos: number,
): { atIndex: number; query: string } | null {
  if (caretPos < 0 || caretPos > text.length) return null;
  for (let i = caretPos - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "@") {
      if (i > 0) {
        const prev = text[i - 1];
        if (!/\s/.test(prev)) return null;
      }
      const query = text.slice(i + 1, caretPos);
      if (query.length > 32) return null;
      if (/\s/.test(query)) return null;
      return { atIndex: i, query };
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}
