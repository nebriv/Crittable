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

import { pinToNotepad } from "./notepad";

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
}

const pinToNotepadAction: HighlightAction = {
  id: "pin-to-notepad",
  label: "Add to notes",
  glyph: "+",
  onSelect: ({ sessionId, token, text, sourceMessageId }) =>
    pinToNotepad(sessionId, token, text, sourceMessageId),
};

/**
 * Default registry. Read-only at module load — copy and append in
 * tests if you need to inject a stub action.
 */
export const defaultHighlightActions: readonly HighlightAction[] = [
  pinToNotepadAction,
];
