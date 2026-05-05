/**
 * Extensible "highlight a snippet → run an action on it" registry.
 *
 * v1 shipped one action — pin to the team notepad. v2 (issue #117)
 * adds Mark-for-AAR, which reuses the same scaffolding: same popover,
 * same server pin endpoint, same Yjs-collab insertion path — only the
 * target notepad section differs. The registry shape is the load-
 * bearing piece: future actions ("Flag as follow-up", "Quote in chat")
 * plug in via a single registry append, without touching the popover
 * component or the chat-bubble markup. Each surface that wants to be
 * highlightable opts in by adding ``data-highlightable="true"`` (+
 * ``data-message-id`` / ``data-message-kind`` if applicable) to the
 * container element.
 *
 * If you add a new action, also add it to ``defaultHighlightActions``
 * below. Use ``isAvailable`` to gate by ``ctx.sourceKind`` (e.g.
 * "Quote in chat" probably wants ``"ai" | "chat"`` but not "system").
 */
import type { ReactNode } from "react";

import { pinToNotepad, sanitizePinText } from "./notepad";
import type { PinSection } from "./notepadEditor";

/**
 * Dispatched on ``window`` after a successful pin POST.
 * SharedNotepad listens and inserts the snippet locally; Yjs collab
 * propagates to peers. Per-tab dispatch (rather than a server-side
 * broadcast) prevents double-insert when one user has two tabs open.
 *
 * ``section`` selects which notepad section the snippet lands under
 * (``timeline`` for "Add to notes", ``aar_review`` for "Mark for AAR")
 * — the ``SharedNotepad`` handler routes through the shared
 * ``appendPinToEditor`` helper so both flows share insertion code.
 */
export const NOTEPAD_PIN_EVENT = "crittable:notepad-pin";

export interface NotepadPinEventDetail {
  text: string;
  sourceMessageId: string | null;
  section: PinSection;
}

/**
 * Source surfaces the highlight popover may activate over. Keep the
 * union narrow; add a new value when a new surface opts in.
 */
export type HighlightSourceKind = "chat" | "ai" | "system";

export interface HighlightContext {
  text: string;
  sourceMessageId: string | null;
  sourceKind: HighlightSourceKind;
  roleId: string;
  sessionId: string;
  token: string;
}

export interface HighlightAction {
  id: string;
  label: string;
  /** Optional inline glyph; small unicode is fine. Avoid emoji. */
  glyph?: ReactNode;
  /** Hidden when this returns false. Default: always available. */
  isAvailable?: (ctx: HighlightContext) => boolean;
  /** Returned promise resolves on success; rejects to surface a toast. */
  onSelect: (ctx: HighlightContext) => Promise<void>;
  /** Optional override for the success toast. Default: "{label} — pinned." */
  successToast?: string;
  /**
   * Hover/focus tooltip explaining the action's effect — surfaced via
   * the button's ``title`` attribute. With multiple registered actions
   * (issue #117), users need a way to differentiate them at the moment
   * of decision; the tooltip is the cheapest disambiguator.
   */
  description?: string;
}

const pinToNotepadAction: HighlightAction = {
  id: "pin-to-notepad",
  label: "Add to notes",
  glyph: "+",
  successToast: "Pinned to notepad.",
  description:
    "Pin the highlighted text under the team notepad's Timeline section. Visible to teammates immediately; the AI reads the whole notepad at end-of-session for the AAR.",
  onSelect: async ({ sessionId, token, text, sourceMessageId }) => {
    await pinToNotepad(sessionId, token, text, sourceMessageId, "pin");
    // Sanitize before dispatch so the editor receives the same shape
    // the server stores in ``session.notepad.markdown_snapshot``.
    // Without this, an unsanitized ``# heading injected`` round-trips
    // through the next ``pushSnapshot`` and ends up feeding the AAR.
    // Mirrors ``backend/app/sessions/notepad.py::sanitize_pin_text``.
    const safe = sanitizePinText(text).slice(0, 280);
    if (!safe) return;
    // The Yjs doc is untouched server-side — inserting the snippet is
    // the originating tab's job. Yjs collab propagates the resulting
    // transaction to peers via the regular ``notepad_update`` flow.
    const detail: NotepadPinEventDetail = {
      text: safe,
      sourceMessageId,
      section: "timeline",
    };
    window.dispatchEvent(new CustomEvent(NOTEPAD_PIN_EVENT, { detail }));
  },
};

/**
 * Mark-for-AAR action (issue #117). Same scaffolding as
 * ``pinToNotepadAction`` — same server endpoint, same Yjs-collab
 * insertion via the shared ``crittable:notepad-pin`` event — but
 * routes the snippet to the ``## AAR Review`` section instead of
 * ``## Timeline`` and uses a distinct server idempotency key
 * (``aar_mark:msg_x`` vs ``pin:msg_x``) so a user can both pin AND
 * AAR-mark the same chat message.
 *
 * The AAR pipeline reads the full notepad markdown verbatim at end-of-
 * session, so any text under ``## AAR Review`` rides into the
 * ``<player_notepad>`` block with the section heading intact —
 * giving the AAR LLM a clearly-grouped pool of player-curated review
 * material to weight when writing recommendations / decisions.
 */
const markForAarReviewAction: HighlightAction = {
  id: "mark-for-aar",
  label: "Mark for AAR",
  // ▶ — single tactical Unicode glyph, matches the ``+`` pattern from
  // pin-to-notepad. Not an emoji; brand-safe per BRAND.md ("no emoji
  // as decoration").
  glyph: "▶",
  successToast: "Flagged for AAR review.",
  description:
    "Flag the highlighted text as a pivotal moment for the post-mortem report. Lands under the notepad's AAR Review section; the AI weights flagged content as a priority signal when writing the AAR.",
  onSelect: async ({ sessionId, token, text, sourceMessageId }) => {
    await pinToNotepad(sessionId, token, text, sourceMessageId, "aar_mark");
    const safe = sanitizePinText(text).slice(0, 280);
    if (!safe) return;
    const detail: NotepadPinEventDetail = {
      text: safe,
      sourceMessageId,
      section: "aar_review",
    };
    window.dispatchEvent(new CustomEvent(NOTEPAD_PIN_EVENT, { detail }));
  },
};

/**
 * Default registry. Read-only at module load — copy and append in
 * tests if you need to inject a stub action.
 */
export const defaultHighlightActions: readonly HighlightAction[] = [
  pinToNotepadAction,
  markForAarReviewAction,
];
