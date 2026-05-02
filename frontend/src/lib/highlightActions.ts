/**
 * Extensible "highlight a snippet → run an action on it" registry.
 *
 * v1 ships exactly one action — pin to the team notepad. The registry
 * shape is the load-bearing piece: future actions ("Mark for AAR",
 * "Flag as follow-up", "Quote in chat") plug in via a single registry
 * append, without touching the popover component or the chat-bubble
 * markup. Each surface that wants to be highlightable opts in by
 * adding ``data-highlightable="true"`` (+ ``data-message-id`` /
 * ``data-message-kind`` if applicable) to the container element.
 *
 * If you add a new action, also add it to ``defaultHighlightActions``
 * below. Use ``isAvailable`` to gate by ``ctx.sourceKind`` (e.g.
 * "Quote in chat" probably wants ``"ai" | "chat"`` but not "system").
 */
import type { ReactNode } from "react";

import { pinToNotepad, sanitizePinText } from "./notepad";

/**
 * Dispatched on ``window`` after a successful "Add to notes" POST.
 * SharedNotepad listens and inserts the snippet locally; Yjs collab
 * propagates to peers. Per-tab dispatch (rather than a server-side
 * broadcast) prevents double-insert when one user has two tabs open.
 */
export const NOTEPAD_PIN_EVENT = "crittable:notepad-pin";

export interface NotepadPinEventDetail {
  text: string;
  sourceMessageId: string | null;
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
}

const pinToNotepadAction: HighlightAction = {
  id: "pin-to-notepad",
  label: "Add to notes",
  glyph: "+",
  successToast: "Pinned to notepad.",
  onSelect: async ({ sessionId, token, text, sourceMessageId }) => {
    await pinToNotepad(sessionId, token, text, sourceMessageId);
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
];
