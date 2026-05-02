import type { MouseEvent } from "react";

/**
 * Click-guard for the lockup `<a href="/">` rendered inside an
 * active session. The lockup-as-home-link is brand convention but
 * mid-session navigating to ``/`` (the marketing home) drops the
 * operator's chat view and any in-flight reply they were composing.
 * The session itself keeps running on the server; the loss is only
 * the local React state.
 *
 * Applied to: Facilitator's TopBar lockup, the AAR-popup header
 * lockup, and Play.tsx's player TopBar lockup. NOT applied to the
 * Home page or to JoinIntro's pre-session lockups — there's no
 * session state to lose there.
 */
export function confirmLeaveSession(e: MouseEvent<HTMLAnchorElement>): void {
  // ``window.confirm`` is intentional — a native modal blocks
  // navigation synchronously and works without any React state for
  // the warning surface. Replace with a styled <dialog> if/when we
  // want a brand-aligned confirmation; the contract (`return false`
  // → cancel) is the same.
  const ok = window.confirm(
    "Leave this session?\n\n" +
      "The session keeps running on the server, but this view " +
      "isn't saved — close this tab and you'll have to keep your " +
      "invite link to rejoin.\n\nLeave anyway?",
  );
  if (!ok) {
    e.preventDefault();
  }
}
