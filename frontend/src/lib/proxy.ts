import type { RoleView } from "../api/client";

export interface ImpersonateOption {
  id: string;
  label: string;
}

/**
 * Build the creator's "Respond as" dropdown options (issue #80).
 *
 * Sources from the full session roster, not the current turn's active
 * set, so a role added mid-turn (``api.addRole``) shows up in the
 * dropdown immediately. Roles that aren't on the current turn's
 * active set get an "(off-turn)" label suffix — submitting as them
 * lands as an interjection (sidebar comment) rather than a turn
 * answer, matching the existing out-of-turn participant submit
 * semantics. The creator's own seat is always excluded (the implicit
 * default), and roles that have already submitted on the current
 * turn are filtered out so they can't be double-submitted.
 *
 * Pre-fix the source was the engine's ``activeRoleIds`` (locked at
 * turn start), which left mid-session role-adds invisible to proxy
 * until the next turn rolled — see the issue thread.
 */
export function buildImpersonateOptions({
  roles,
  activeRoleIds,
  submittedRoleIds,
}: {
  roles: RoleView[];
  activeRoleIds: string[];
  submittedRoleIds: string[];
}): ImpersonateOption[] {
  const submittedSet = new Set(submittedRoleIds);
  const activeSet = new Set(activeRoleIds);
  return roles
    .filter((r) => !r.is_creator)
    .filter((r) => !submittedSet.has(r.id))
    .map((r) => {
      const offTurn = !activeSet.has(r.id);
      return {
        id: r.id,
        label: offTurn ? `${r.label} (off-turn)` : r.label,
      };
    });
}

/**
 * Issue #80 bonus: predicate for the "Just joined? You'll be brought
 * into the next turn" chip in the participant Play view.
 *
 * Fires when:
 * - the session is mid-PLAY (``AI_PROCESSING`` or ``AWAITING_PLAYERS``);
 * - the local participant is **not** in the current turn's active
 *   set (so the AI hasn't called on them yet); AND
 * - they have no prior PLAYER messages from their role_id (heuristic
 *   for "just joined this session", separating them from a
 *   passive-but-already-engaged participant).
 *
 * Once the next turn rolls them into the active set or they post a
 * message, the chip disappears naturally.
 */
export function isMidSessionJoiner({
  sessionState,
  iAmActive,
  messages,
  selfRoleId,
}: {
  sessionState: string;
  iAmActive: boolean;
  messages: ReadonlyArray<{ kind: string; role_id?: string | null }>;
  selfRoleId: string | null;
}): boolean {
  if (iAmActive) return false;
  if (sessionState !== "AI_PROCESSING" && sessionState !== "AWAITING_PLAYERS") {
    return false;
  }
  if (!selfRoleId) return false;
  const iHavePosted = messages.some(
    (m) => m.kind === "player" && m.role_id === selfRoleId,
  );
  return !iHavePosted;
}
