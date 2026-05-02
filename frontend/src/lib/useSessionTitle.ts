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

/**
 * Favicon variants. The SVG ``link[rel=icon][type="image/svg+xml"]`` is
 * the master — modern browsers (Chrome/Firefox/Safari/Edge) prefer it
 * over the PNG fallbacks so swapping just the SVG is enough for the
 * tab-strip badge to fire on every browser that surfaces favicons
 * prominently. Older browsers that fall back to ``favicon-*.png`` /
 * ``.ico`` won't see the badge — acceptable trade-off vs. shipping
 * eight PNG variants of the pending mark.
 *
 * The pending variant adds an amber corner dot (``--warn`` per
 * ``design/handoff/BRAND.md`` — "medium severity / pending"). Crit-red
 * is intentionally NOT used here so the badge doesn't dilute the
 * meaning of ``inject_critical_event`` surfaces.
 */
export const FAVICON_DEFAULT_HREF = "/favicon/favicon.svg";
export const FAVICON_PENDING_HREF = "/favicon/favicon-pending.svg";

/**
 * Swap the SVG favicon's ``href`` on the live ``<link>`` element. Modern
 * browsers re-fetch + re-render the favicon as soon as the attribute
 * changes; no DOM rebuild needed.
 *
 * No-ops if the element doesn't exist (test environment without the
 * static index.html, SSR pre-hydrate, etc.) and if the href is already
 * the requested value — saves a redundant browser repaint when state
 * thrashes.
 */
export function setFaviconPending(pending: boolean): void {
  const href = pending ? FAVICON_PENDING_HREF : FAVICON_DEFAULT_HREF;
  const link = document.querySelector<HTMLLinkElement>(
    'link[rel="icon"][type="image/svg+xml"]',
  );
  if (!link) return;
  if (link.href.endsWith(href)) return;
  link.href = href;
}

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
 * Drives ``document.title`` AND the favicon from session state. The
 * pending marker (title) + amber favicon badge are the primary signals
 * — a backgrounded tab still surfaces "you're being waited on" via the
 * OS tab strip even when the title is truncated to just the favicon
 * (the Slack/Gmail pattern). The state label adds context for the
 * foregrounded case ("Setup", "Briefing", "Ended").
 *
 * On unmount the title resets to ``DEFAULT_TITLE`` and the favicon
 * resets to the default mark so a route change (Play → Home) doesn't
 * leave a stale "● Your turn" or amber badge hanging in the tab.
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
    setFaviconPending(opts.pending);
  }, [title, opts.pending, opts.state]);
  useEffect(() => {
    return () => {
      document.title = DEFAULT_TITLE;
      setFaviconPending(false);
    };
  }, []);
}
