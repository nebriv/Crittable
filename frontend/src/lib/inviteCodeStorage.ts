/**
 * Storage helpers for the soft anti-strangers invite gate.
 *
 * Kept in a separate module from the <InviteGate/> component so
 * React's fast-refresh plugin can hot-reload the gate without
 * tripping the "only export components" rule. Two callers:
 *
 * - <InviteGate/> reads / writes the code as the user enters it.
 * - <Facilitator/> reads at mount and clears on a stale-code 403.
 */

export const INVITE_CODE_STORAGE_KEY = "crittable.invite_code";

export function readStoredInviteCode(): string | null {
  try {
    const v = window.localStorage.getItem(INVITE_CODE_STORAGE_KEY);
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function writeStoredInviteCode(code: string): void {
  try {
    window.localStorage.setItem(INVITE_CODE_STORAGE_KEY, code);
  } catch {
    // localStorage may be disabled (private mode, strict CSP). The
    // user is re-prompted next visit; no functional break this
    // session.
  }
}

export function clearStoredInviteCode(): void {
  try {
    window.localStorage.removeItem(INVITE_CODE_STORAGE_KEY);
  } catch {
    /* best-effort */
  }
}
