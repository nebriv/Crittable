import { useEffect } from "react";

/**
 * The product brand name. Mirrors ``frontend/index.html``'s ``<title>``
 * so a remount or unmount restores exactly what the static markup
 * shipped with — no flash of "Crittable - Crittable" on hot-reload.
 */
export const DEFAULT_TITLE = "Crittable";

/**
 * Marker prepended to the tab title when the viewer's input is what's
 * holding the exercise up. Reads as a notification dot when the tab is
 * backgrounded — the operator can alt-tab away to email and still see
 * "● Your turn — Crittable" in the OS tab strip without needing sound
 * or browser notifications.
 *
 * U+25CF (BLACK CIRCLE) renders consistently across platform fonts and
 * doesn't fall back to a tofu glyph the way decorative symbols do.
 */
export const PENDING_MARKER = "●";

export interface SessionTitleOpts {
  /** True when the user must take an action (their turn, AI awaits reply). */
  pending: boolean;
  /** Short status label, e.g. "Your turn", "Setup", "Ended". Optional. */
  state?: string | null;
}

/**
 * Compose the tab title from a pending flag + optional state label.
 * Pure function so render-equality tests can assert on the exact string
 * without standing up a DOM.
 *
 * Examples:
 *   {pending: true,  state: "Your turn"} → "● Your turn — Crittable"
 *   {pending: false, state: "AI thinking"} → "AI thinking — Crittable"
 *   {pending: false, state: null}        → "Crittable"
 *   {pending: true,  state: null}        → "● Crittable"
 */
export function buildSessionTitle({ pending, state }: SessionTitleOpts): string {
  const marker = pending ? `${PENDING_MARKER} ` : "";
  if (!state) return `${marker}${DEFAULT_TITLE}`;
  return `${marker}${state} — ${DEFAULT_TITLE}`;
}

/**
 * Drives ``document.title`` from session state. The pending marker is
 * the primary signal — a backgrounded tab still surfaces "you're being
 * waited on" via the OS tab strip. The state label adds context for
 * the foregrounded case ("Setup", "Briefing", "Ended").
 *
 * On unmount the title resets to ``DEFAULT_TITLE`` so a route change
 * (Play → Home) doesn't leave a stale "● Your turn" hanging in the
 * tab.
 *
 * Logs every title change at ``debug`` so a "tab title is stuck"
 * report has a transcript trail; the prefix is greppable per the
 * project's logging convention.
 */
export function useSessionTitle(opts: SessionTitleOpts): void {
  const title = buildSessionTitle(opts);
  useEffect(() => {
    console.debug("[title]", { title, pending: opts.pending, state: opts.state ?? null });
    document.title = title;
  }, [title, opts.pending, opts.state]);
  useEffect(() => {
    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, []);
}
