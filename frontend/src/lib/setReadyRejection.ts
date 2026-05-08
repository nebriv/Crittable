/**
 * Decoupled-ready (PR #209 follow-up): map a server-side
 * ``set_ready_rejected.reason`` to the user-facing banner copy.
 *
 * Extracted from Play.tsx + Facilitator.tsx so a parameterized
 * regression test can pin the seven documented reasons + the
 * unknown-reason fallback in a single place. Two consumers share
 * this helper; if they ever diverge in copy, do the divergence in
 * the call site (rare — only the ``not_active_role`` case might
 * read differently for a player vs the creator) and pass a
 * ``perspective`` argument.
 *
 * The reasons themselves come from
 * ``backend/app/sessions/manager.py::SetReadyOutcome.reason`` —
 * keep this list in sync with that one. A new reason added on the
 * backend without a matching branch here falls through to the
 * default which inlines the raw token (visible to the user, but
 * not pretty).
 */

export type SetReadyRejectionReason =
  | "not_awaiting_players"
  | "turn_already_advanced"
  | "not_active_role"
  | "not_authorized"
  | "flip_cap_exceeded"
  | "role_not_found"
  | "no_current_turn";

export type RejectionPerspective = "player" | "creator";

export function friendlyRejectionMessage(
  reason: string,
  perspective: RejectionPerspective = "player",
): string {
  switch (reason) {
    case "not_awaiting_players":
      return "Can't mark ready right now — the AI is responding.";
    case "turn_already_advanced":
      return "Too late — the turn already advanced.";
    case "not_active_role":
      // The creator's view talks about a different role's seat
      // because the creator can target other roles via the
      // impersonation rail; the player's view is always about
      // themself.
      return perspective === "creator"
        ? "That role isn't on the active set this beat."
        : "Only active roles for this beat can mark ready. The AI will bring you back in soon.";
    case "not_authorized":
      return "Only the creator can mark ready on another role's behalf.";
    case "flip_cap_exceeded":
      return perspective === "creator"
        ? "Too many ready flips on this turn — wait for the AI to advance."
        : "You've toggled ready too many times on this turn — wait for the AI to advance.";
    case "role_not_found":
      return "That role isn't in the session any more.";
    case "no_current_turn":
      return "No active turn to mark ready on.";
    default:
      return `Mark Ready rejected: ${reason}`;
  }
}
