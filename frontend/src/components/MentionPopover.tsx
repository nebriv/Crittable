import { useEffect, useMemo, useRef } from "react";
import {
  MentionRosterEntry,
  filterMentionRoster,
  optionIdFor,
} from "./mentionPopoverUtils";

/**
 * Wave 2 (composer mentions + facilitator routing).
 *
 * Renders a roster popover that filters by typeahead while the player
 * types after an ``@`` keystroke in the composer. Two key invariants
 * the parent component relies on:
 *
 *  1. **Mark/resolve, not regex.** The popover is the only place the
 *     ``role_id`` for a typed token is resolved. Once the user picks
 *     an item the parent records ``{ start, end, target }`` against the
 *     visible text; rendering / submission read from the marks, never
 *     from the body text. Plan §5.1 / §6.6 of
 *     ``docs/plans/chat-decluttering.md``.
 *
 *  2. **Synthetic ``@facilitator`` entry.** The list always starts with
 *     a special ``"facilitator"`` row that resolves to the literal
 *     token ``"facilitator"`` (not a real role_id). Aliases ``@ai`` /
 *     ``@gm`` resolve client-side to the same insertion. The server
 *     branches on ``"facilitator" in mentions`` to fire the AI
 *     interject — see ``backend/app/ws/routes.py``.
 *
 * Keyboard contract (handled by the consumer's keydown handler, NOT
 * here — the textarea owns focus and dispatches the events):
 *   * ArrowDown / ArrowUp — move highlight, wrap at edges.
 *   * Enter / Tab — commit the highlighted item.
 *   * Escape — dismiss without inserting.
 *
 * ARIA contract:
 *   * Popover root has ``role="listbox"`` with a stable ``id`` so the
 *     textarea can carry ``aria-activedescendant`` to it; consumer
 *     wires both pieces of state.
 *   * Each row has ``role="option"``, ``aria-selected`` on the
 *     highlighted row, and a stable ``id`` derived from the listbox
 *     id + the row's resolution target.
 *
 * Layout: anchor is rendered absolutely against the parent's relative
 * container — the consumer composes the popover inside that container
 * so the popover can position itself near the caret without scroll
 * misalignment when the textarea grows.
 */

interface Props {
  /** Substring the user has typed since the ``@`` (without the ``@``).
   * Empty string is valid — the popover should still render the full
   * roster. */
  query: string;
  /** Roster the parent passes in — usually ``snapshot.roles`` minus
   * the local participant's own role + spectators (a player should
   * never need to ``@`` themselves). The synthetic facilitator entry
   * is rendered automatically; do NOT include it here. */
  roster: MentionRosterEntry[];
  /** Stable ``id`` for ARIA wiring. The consumer mirrors this on the
   * textarea's ``aria-controls`` + ``aria-activedescendant``. */
  listboxId: string;
  onSelect: (entry: MentionRosterEntry) => void;
  onDismiss: () => void;
  /** Highlighted index — owned by the consumer so keyboard navigation
   * can be driven from the textarea's keydown handler. */
  highlightedIndex: number;
  setHighlightedIndex: (next: number) => void;
  /** When True, anchor the popover ABOVE the textarea (``bottom-full``)
   * instead of below (``top-full``). Used when the composer sits near
   * the bottom of the viewport and a downward popover would clip
   * behind the BottomActionBar. The consumer measures the textarea's
   * available space and picks. UI/UX review BLOCK B1. */
  openUpward?: boolean;
}

export function MentionPopover({
  query,
  roster,
  listboxId,
  onSelect,
  onDismiss,
  highlightedIndex,
  setHighlightedIndex,
  openUpward = false,
}: Props) {
  // Anchor side picks the absolute-positioning rule + the visual
  // gap. Default ``top-full mt-1`` (open downward) preserves the
  // historical render; ``bottom-full mb-1`` flips to opening above
  // the textarea, which is the right default for a bottom-anchored
  // composer (BottomActionBar would otherwise clip the dropdown).
  const anchorClass = openUpward
    ? "absolute z-30 bottom-full mb-1 max-h-56 w-64 overflow-auto rounded-r-1 border border-ink-500 bg-ink-900 p-1 shadow-lg"
    : "absolute z-30 mt-1 max-h-56 w-64 overflow-auto rounded-r-1 border border-ink-500 bg-ink-900 p-1 shadow-lg";
  const items = useMemo(() => filterMentionRoster(query, roster), [query, roster]);
  // Click-outside detection uses the wrapper div rather than the
  // listbox itself so the no-matches branch (which wraps a status
  // message alongside an empty listbox) shares the same root.
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Clamp highlight to the visible slice. The consumer's keyboard
  // handler also clamps when navigating, but the filter result can
  // shrink mid-typing (e.g. user types one more letter and the
  // current highlight falls out of the slice).
  useEffect(() => {
    if (items.length === 0) return;
    if (highlightedIndex < 0) {
      setHighlightedIndex(0);
    } else if (highlightedIndex >= items.length) {
      setHighlightedIndex(items.length - 1);
    }
  }, [items.length, highlightedIndex, setHighlightedIndex]);

  // Click-outside dismiss. We use mousedown (not click) so the
  // textarea regains focus before the popover closes — clicking a
  // popover item still fires onSelect because the item's onMouseDown
  // runs before the document listener (event order).
  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      const root = containerRef.current;
      if (!root) return;
      if (e.target instanceof Node && root.contains(e.target)) return;
      onDismiss();
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [onDismiss]);

  if (items.length === 0) {
    // Empty filter result — render an explicit "no matches" message
    // so the popover's chrome doesn't disappear on the user. UI/UX
    // review HIGH H2: the message is rendered as ``role="status"``
    // (a separate live region) rather than a ``role="option"`` so
    // screen readers don't announce a dimmed-but-pickable choice.
    // The empty listbox is kept in the DOM with the same id so the
    // textarea's ``aria-controls`` doesn't dangle.
    return (
      <div ref={containerRef} className={anchorClass}>
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Mention suggestions"
          className="m-0 p-0 list-none"
        />
        <p
          role="status"
          aria-live="polite"
          className="mono px-2 py-1 text-[11px] uppercase tracking-[0.06em] text-ink-400"
        >
          No matches
        </p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className={anchorClass}>
      <ul
        id={listboxId}
        role="listbox"
        aria-label="Mention suggestions"
        className="m-0 p-0 list-none"
      >
        {items.map((item, idx) => {
          const isHighlighted = idx === highlightedIndex;
          const optionId = optionIdFor(listboxId, item.target);
          return (
            <li key={item.target}>
              <button
                type="button"
                id={optionId}
                role="option"
                aria-selected={isHighlighted}
                // Screen readers should announce the facilitator
                // entry as "AI assistant" rather than "facilitator,
                // middle-dot, AI" — UI/UX review MEDIUM. The label
                // here is for assistive tech only; the visible text
                // remains the canonical token.
                aria-label={
                  item.isFacilitator
                    ? "@facilitator (AI assistant; aliases at-ai or at-gm)"
                    : `@${item.displayLabel}${
                        item.secondary ? ` (${item.secondary})` : ""
                      }`
                }
                title={item.displayLabel}
                onMouseDown={(e) => {
                  // Prevent the textarea from losing focus before
                  // onSelect fires. Without this, the textarea blurs
                  // and the click-outside handler dismisses the
                  // popover before our onClick can run.
                  e.preventDefault();
                  e.stopPropagation();
                  onSelect(item);
                }}
                onMouseEnter={() => setHighlightedIndex(idx)}
                className={`mono flex w-full flex-col gap-0.5 rounded-r-1 px-2 py-1 text-left text-[12px] focus:outline-none ${
                  isHighlighted
                    ? "bg-signal-deep text-ink-900"
                    : "text-ink-100 hover:bg-ink-800"
                } ${item.isFacilitator ? "border-b border-ink-700 mb-1 pb-2" : ""}`}
              >
                <span className="block truncate font-bold uppercase tracking-[0.04em]">
                  @{item.displayLabel}
                </span>
                {item.secondary ? (
                  <span
                    className={`block truncate text-[10px] uppercase tracking-[0.04em] ${
                      isHighlighted ? "text-ink-900/80" : "text-ink-400"
                    }`}
                  >
                    {item.secondary}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Helper utilities live in ``mentionPopoverUtils.ts`` to satisfy
// the ``react-refresh/only-export-components`` lint rule (Vite Fast
// Refresh requires component files to export only components).
// Consumers import the helpers + the ``MentionRosterEntry`` type
// directly from that file.
