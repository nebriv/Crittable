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
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

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

// Approximate menu width (mono labels + glyphs). Used for off-edge
// clamping; doesn't need to be exact, just within 30 px.
const MENU_APPROX_WIDTH = 160;
const MENU_APPROX_HEIGHT = 36;

export function HighlightActionPopover({
  sessionId,
  roleId,
  token,
  actions = defaultHighlightActions,
}: Props) {
  const [state, setState] = useState<PopoverState | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [focusedIdx, setFocusedIdx] = useState<number>(0);
  const dismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // ``true`` while the user has the mouse held down to drag-select.
  // Suppresses popover OPENING during the drag — the menu would
  // otherwise pop up under the cursor mid-selection, where the
  // ``onMouseDown={preventDefault}`` collapses the user's drag and
  // ends the selection a few characters in. ``mouseup`` clears it
  // and re-evaluates so the popover lands at the final rect. Tests
  // dispatch ``selectionchange`` directly without a mousedown, so
  // they bypass this gate naturally.
  const draggingRef = useRef(false);

  // Selection → popover state.
  useEffect(() => {
    function applySelection(): void {
      // Guard the entire handler — selection state can be invalid
      // (Range with no rect, jsdom Selection-impl emitting stray
      // selectionchange after a test teardown, etc.). Treat any
      // throw as "no selection" rather than crashing the listener
      // chain, which surfaces as an uncaught browser error in dev
      // and crashes vitest --run in CI.
      try {
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
        if (sel.rangeCount < 1) {
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
        setFocusedIdx(0);
      } catch (err) {
        console.debug("[notepad] selectionchange ignored", err);
        setState(null);
      }
    }
    function onChange(): void {
      if (draggingRef.current) {
        // Mid-drag: don't open the popover (see draggingRef comment).
        // Still allow the dismiss path so a collapsed selection clears
        // a stale menu, but never set a new rect/ctx here.
        try {
          const sel = window.getSelection();
          if (!sel || sel.isCollapsed || sel.toString().trim().length < 2) {
            setState(null);
          }
        } catch {
          setState(null);
        }
        return;
      }
      applySelection();
    }
    function onMouseDown(e: MouseEvent): void {
      // Clicks INSIDE the menu shouldn't be counted as a drag-select
      // start (the menu's ``onMouseDown={preventDefault}`` already
      // shields its own clicks). Anything else — including a fresh
      // mousedown on a chat bubble that starts a new drag — flips us
      // into drag mode until the matching mouseup.
      if (menuRef.current?.contains(e.target as Node)) return;
      draggingRef.current = true;
    }
    function onMouseUp(): void {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      // After the drag completes, render the popover at the final
      // selection rect. We DON'T just rely on the next selectionchange
      // here because Chrome doesn't always fire one if the mouseup
      // happens inside the same text run as the last selectionchange.
      applySelection();
    }
    function clearDragging(): void {
      // Defensive reset: if the OS swallows the matching mouseup
      // (window switch, context menu, drag-out-of-window, tab
      // background-throttle mid-drag), ``draggingRef`` would otherwise
      // stay ``true`` and suppress every subsequent popover open.
      // ``visibilitychange`` and ``blur`` cover the alt-tab path;
      // ``pointercancel`` covers touch / pen interactions where the
      // OS reroutes the gesture. Mirror state with the clean-slate.
      if (!draggingRef.current) return;
      draggingRef.current = false;
    }
    document.addEventListener("selectionchange", onChange);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("mouseup", onMouseUp, true);
    document.addEventListener("pointercancel", clearDragging, true);
    document.addEventListener("visibilitychange", clearDragging);
    window.addEventListener("blur", clearDragging);
    return () => {
      document.removeEventListener("selectionchange", onChange);
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("mouseup", onMouseUp, true);
      document.removeEventListener("pointercancel", clearDragging, true);
      document.removeEventListener("visibilitychange", clearDragging);
      window.removeEventListener("blur", clearDragging);
    };
  }, [sessionId, roleId, token]);

  // Dismiss on scroll (selection rectangles drift) and on Escape.
  // Per the ARIA APG menu pattern, Escape closes; arrow keys move
  // focus between items.
  useEffect(() => {
    if (!state) return;
    function onScroll(): void {
      // Hide the popover (its anchor rect is now stale) but DO NOT
      // call ``removeAllRanges()`` here. A scroll event fires when a
      // scrollable chat container auto-scrolls during a drag-select,
      // and clearing the range mid-drag terminates the user's
      // selection a few characters in — exactly the bug the user
      // reported. The selection itself stays valid; the next
      // selectionchange or mouseup will re-anchor the menu.
      setState(null);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        setState(null);
        window.getSelection()?.removeAllRanges();
      }
    }
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
      document.removeEventListener("keydown", onKey);
    };
  }, [state]);

  // Auto-dismiss the toast.
  useEffect(() => {
    if (!toast) return;
    if (dismissRef.current) clearTimeout(dismissRef.current);
    dismissRef.current = setTimeout(() => setToast(null), 2400);
    return () => {
      if (dismissRef.current) clearTimeout(dismissRef.current);
    };
  }, [toast]);

  // Move keyboard focus into the menu when it opens, and keep it on
  // the active item as the user navigates with arrow keys. Without
  // this, ``onKeyDown`` on the menu div never fires (the user's
  // focus is still in the chat selection) — the advertised
  // arrow-key/Enter contract per the ARIA APG menu pattern would
  // be a lie. Per Copilot review on PR #115.
  //
  // ``preventScroll: true`` is load-bearing: without it the browser
  // scrolls the focused button into view, which fires our scroll
  // handler, which hides the menu. The menu is already inside the
  // viewport (clamped below) so a scroll-into-view is always a no-op
  // visually; suppressing it just keeps the open/scroll cycle from
  // racing.
  useEffect(() => {
    if (!state || !menuRef.current) return;
    const items = menuRef.current.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]',
    );
    const target = items[focusedIdx] ?? items[0];
    target?.focus({ preventScroll: true });
  }, [state, focusedIdx]);

  const onClick = useCallback(
    async (action: HighlightAction) => {
      if (!state) return;
      setPending(action.id);
      try {
        await action.onSelect(state.ctx);
        // The previous wording "pinned to Timeline" surprised users —
        // the visible side effect of "Add to notes" is text appearing
        // in the team notepad, not in the right-rail Timeline widget.
        // Action authors can override per-action via ``successToast``;
        // the default names the panel that just changed.
        const success = action.successToast ?? `${action.label} — pinned.`;
        setToast(success);
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

  // Anchor the menu near the selection rectangle, clamped on all four
  // sides so it never renders off-screen or under viewport chrome.
  // Flip below the selection when there isn't room above (selection
  // near the top of the viewport).
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const flipBelow = state.rect.top < MENU_APPROX_HEIGHT + 8;
  const rawTop = flipBelow
    ? state.rect.bottom + 8
    : state.rect.top - MENU_APPROX_HEIGHT;
  const top = Math.max(8, Math.min(rawTop, vh - MENU_APPROX_HEIGHT - 8));
  const rawLeft = state.rect.left + state.rect.width / 2 - MENU_APPROX_WIDTH / 2;
  const left = Math.max(8, Math.min(rawLeft, vw - MENU_APPROX_WIDTH - 8));

  function handleMenuKey(e: ReactKeyboardEvent<HTMLDivElement>): void {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIdx((i) => (i + 1) % visibleActions.length);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIdx(
        (i) => (i - 1 + visibleActions.length) % visibleActions.length,
      );
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const action = visibleActions[focusedIdx];
      if (action) void onClick(action);
    }
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Highlight actions"
      className="fixed z-50 flex items-center gap-1 rounded-r-2 border border-ink-500 bg-ink-900 px-1 py-1 shadow-lg"
      style={{ top, left }}
      tabIndex={-1}
      onKeyDown={handleMenuKey}
      // Don't let clicking the menu collapse the selection mid-click.
      onMouseDown={(e) => e.preventDefault()}
    >
      {visibleActions.map((action, idx) => (
        <button
          key={action.id}
          type="button"
          role="menuitem"
          tabIndex={idx === focusedIdx ? 0 : -1}
          aria-keyshortcuts={idx === 0 ? "Enter" : undefined}
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
