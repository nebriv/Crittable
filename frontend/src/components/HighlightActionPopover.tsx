/**
 * HighlightActionPopover — floating menu that appears when the user
 * selects text inside any element marked ``data-highlightable``
 * (issue #98).
 *
 * v1 hosts a single action ("Add to notes" / pin-to-notepad), but the
 * component is built around the ``HighlightAction`` registry so new
 * actions plug in without UI rework. See ``../lib/highlightActions.ts``.
 *
 * Mount once at the page level. The component uses the document's
 * ``selectionchange`` event and walks the anchor node up to the
 * nearest ``data-highlightable`` ancestor; if it finds one, it pulls
 * the selected text + the bubble's ``data-message-id`` /
 * ``data-message-kind`` and renders a tiny floating menu near the
 * selection rectangle.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  defaultHighlightActions,
  type HighlightAction,
  type HighlightContext,
  type HighlightSourceKind,
} from "../lib/highlightActions";

interface Props {
  sessionId: string;
  roleId: string;
  token: string;
  /** Defaults to ``defaultHighlightActions``. Override for tests. */
  actions?: readonly HighlightAction[];
}

interface PopoverState {
  rect: DOMRect;
  ctx: HighlightContext;
}

function findHighlightable(node: Node | null): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur.nodeType !== Node.ELEMENT_NODE) cur = cur.parentNode;
  let el = cur as HTMLElement | null;
  while (el) {
    if (el.dataset?.highlightable === "true") return el;
    el = el.parentElement;
  }
  return null;
}

function asSourceKind(raw: string | null | undefined): HighlightSourceKind {
  if (raw === "chat" || raw === "ai" || raw === "system") return raw;
  return "chat";
}

export function HighlightActionPopover({
  sessionId,
  roleId,
  token,
  actions = defaultHighlightActions,
}: Props) {
  const [state, setState] = useState<PopoverState | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const dismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Selection → popover state.
  useEffect(() => {
    function onChange(): void {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        setState(null);
        return;
      }
      const text = sel.toString().trim();
      if (text.length < 2) {
        setState(null);
        return;
      }
      const anchorEl = findHighlightable(sel.anchorNode);
      if (!anchorEl) {
        setState(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const sourceMessageId = anchorEl.dataset?.messageId ?? null;
      const sourceKind = asSourceKind(anchorEl.dataset?.messageKind);
      setState({
        rect,
        ctx: {
          text,
          sourceMessageId,
          sourceKind,
          roleId,
          sessionId,
          token,
        },
      });
    }
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, [sessionId, roleId, token]);

  // Auto-dismiss the toast.
  useEffect(() => {
    if (!toast) return;
    if (dismissRef.current) clearTimeout(dismissRef.current);
    dismissRef.current = setTimeout(() => setToast(null), 2400);
    return () => {
      if (dismissRef.current) clearTimeout(dismissRef.current);
    };
  }, [toast]);

  const onClick = useCallback(
    async (action: HighlightAction) => {
      if (!state) return;
      setPending(action.id);
      try {
        await action.onSelect(state.ctx);
        setToast(`${action.label}: pinned to Timeline.`);
        // Clear the selection so the popover hides cleanly.
        window.getSelection()?.removeAllRanges();
        setState(null);
      } catch (err) {
        const detail = err instanceof Error ? err.message : "failed";
        console.warn("[notepad] highlight action failed", action.id, detail);
        setToast(`${action.label} failed: ${detail}`);
      } finally {
        setPending(null);
      }
    },
    [state],
  );

  if (!state) {
    return toast ? (
      <div
        className="fixed bottom-4 right-4 rounded-r-2 border border-ink-500 bg-ink-900 px-3 py-2 text-[12px] text-ink-100 shadow-md"
        role="status"
      >
        {toast}
      </div>
    ) : null;
  }

  const visibleActions = actions.filter(
    (a) => !a.isAvailable || a.isAvailable(state.ctx),
  );
  if (visibleActions.length === 0) return null;

  // Anchor the menu just above the selection rectangle. window.scroll*
  // accounts for the page being scrolled; we want viewport-relative
  // pixels because the menu uses ``position: fixed``.
  const top = Math.max(8, state.rect.top - 36);
  const left = Math.max(8, state.rect.left + state.rect.width / 2 - 60);

  return (
    <div
      role="menu"
      aria-label="Highlight actions"
      className="fixed z-50 flex items-center gap-1 rounded-r-2 border border-ink-500 bg-ink-900 px-1 py-1 shadow-lg"
      style={{ top, left }}
      // Don't let clicking the menu collapse the selection mid-click.
      onMouseDown={(e) => e.preventDefault()}
    >
      {visibleActions.map((action) => (
        <button
          key={action.id}
          type="button"
          role="menuitem"
          disabled={pending === action.id}
          onClick={() => onClick(action)}
          className="mono rounded-r-1 border border-transparent bg-ink-850 px-2 py-1 text-[11px] uppercase tracking-[0.12em] text-ink-100 hover:border-signal-deep disabled:opacity-50"
        >
          {action.glyph ? <span className="mr-1">{action.glyph}</span> : null}
          {action.label}
        </button>
      ))}
    </div>
  );
}

export default HighlightActionPopover;
