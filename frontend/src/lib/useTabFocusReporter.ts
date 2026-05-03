import { useEffect, useRef } from "react";
import { WsClient } from "./ws";

/**
 * Push the current tab's visibility / focus state to the backend so the
 * creator's RolesPanel can render a tri-state status dot per role:
 *
 * - **grey** — not joined (no WS tabs open for this role)
 * - **blue** — joined and *this tab is focused* (the player is actively
 *   on the exercise window)
 * - **yellow** — joined but every tab is backgrounded (player has
 *   alt-tabbed away to email, Slack, etc.)
 *
 * We listen to ``visibilitychange`` (the canonical "tab in foreground"
 * signal — covers tab switches, minimised windows, and locked screens)
 * plus ``focus`` / ``blur`` so an OS-level window switch is reflected
 * even when the browser keeps the document "visible".
 *
 * The hook fires once on mount with the initial state, then again
 * whenever the OS / browser fires either event. Sends are guarded
 * against duplicate state to avoid flooding the WS with no-op frames
 * on rapid focus/blur cycles (e.g. clicking through DevTools).
 *
 * Pre-condition: the WebSocket must already be connected — the hook
 * silently no-ops while ``wsRef.current`` is null or the socket is in
 * any non-OPEN state. This matches the rest of the WS-send call
 * sites in this codebase.
 */
export function useTabFocusReporter(
  wsRef: React.MutableRefObject<WsClient | null>,
  enabled: boolean,
  /**
   * Optional WebSocket status. When this flips to "open" the hook
   * re-sends the current focus state, so a tab that was backgrounded
   * before a transient disconnect doesn't appear focused after the
   * reconnect (the server defaults a fresh connection to focused=true).
   * If omitted, the hook only sends on visibility/focus events plus
   * the initial mount.
   */
  wsStatus?:
    | "connecting"
    | "open"
    | "closed"
    | "error"
    | "kicked"
    | "rejected"
    | "session-gone",
): void {
  const lastSentRef = useRef<boolean | null>(null);

  useEffect(() => {
    if (!enabled) {
      // Reset so a re-enable (e.g. JoinIntro → main view) re-sends the
      // current state — the previous send may be stale by then.
      lastSentRef.current = null;
      return;
    }
    if (wsStatus === "open") {
      // Force a resend after (re)connect: the server treated the new
      // connection as focused, but our last-sent cache may have a
      // stale "true" for what's now a backgrounded tab.
      lastSentRef.current = null;
    }

    function isFocused(): boolean {
      // ``document.visibilityState`` is the broader signal: it's
      // "hidden" both for tab switches and when the entire window is
      // minimised. ``document.hasFocus()`` catches the case where the
      // tab is still visible but another OS window is in front (the
      // browser keeps the document "visible" but the user can't see
      // it). Either condition suffices for "focused" in our tri-state.
      const visible = document.visibilityState === "visible";
      const hasFocus =
        typeof document.hasFocus === "function" ? document.hasFocus() : true;
      return visible && hasFocus;
    }

    function send(focused: boolean) {
      const ws = wsRef.current;
      if (!ws) return;
      if (lastSentRef.current === focused) return;
      try {
        ws.send({ type: "tab_focus", focused });
        lastSentRef.current = focused;
        console.debug("[ws] tab_focus", { focused });
      } catch (err) {
        // WS not yet open or already closed — fine to swallow; the
        // visibility state will be re-sent the next time an event
        // fires (or the WS reconnects and the open-handler below
        // re-fires the initial send).
        console.debug("[ws] tab_focus send dropped", {
          focused,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    function onChange() {
      send(isFocused());
    }

    // Fire once on mount so the server starts from the actual state
    // rather than the assumed-true default. Wrapped in a microtask
    // delay so the WS open-event has a chance to land first when the
    // hook mounts in the same tick as the WsClient is created.
    queueMicrotask(onChange);

    document.addEventListener("visibilitychange", onChange);
    window.addEventListener("focus", onChange);
    window.addEventListener("blur", onChange);
    return () => {
      document.removeEventListener("visibilitychange", onChange);
      window.removeEventListener("focus", onChange);
      window.removeEventListener("blur", onChange);
    };
  }, [enabled, wsRef, wsStatus]);
}
