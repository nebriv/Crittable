import type { RoleView } from "../api/client";

/**
 * One row in the creator's "Respond as" dropdown.
 *
 * ``offTurn`` is broken out as a structured flag so the renderer (the
 * Composer) can decorate the row + the "Submitting as …" banner
 * differently for off-turn proxy submissions without needing to
 * string-match a "(off-turn)" suffix. Pre-fix the suffix was inlined
 * into ``label`` and collided with Composer's own " (proxy)" suffix,
 * producing "Legal (off-turn) (proxy)" — confusing on the option and
 * worse in the running banner.
 */
export interface ImpersonateOption {
  id: string;
  label: string;
  offTurn: boolean;
}

/**
 * Build the creator's "Respond as" dropdown options (issue #80).
 *
 * Sources from the full session roster, not the current turn's active
 * set, so a role added mid-turn (``api.addRole``) shows up in the
 * dropdown immediately. Roles flagged ``offTurn`` lead to interjection
 * (sidebar) submissions rather than turn answers — matching the
 * existing out-of-turn participant submit semantics; the Composer
 * decorates the option and the running banner accordingly.
 *
 * Filters:
 * - ``is_creator`` — the creator's own seat is the implicit default.
 * - ``kind === "spectator"`` — the backend rejects spectator proxy
 *   attempts (``proxy_submit_as`` raises "role X is not a player
 *   role"); excluding them client-side avoids the dead 409 path.
 * - already-submitted roles for the current turn — can't be
 *   double-submitted.
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
    .filter((r) => r.kind === "player")
    .filter((r) => !submittedSet.has(r.id))
    .map((r) => ({
      id: r.id,
      label: r.label,
      offTurn: !activeSet.has(r.id),
    }));
}

/**
 * Issue #80 bonus: predicate for the "Just joined? You'll be brought
 * into the next turn" chip in the participant Play view.
 *
 * Fires when ALL of:
 * - the session is mid-PLAY (``AI_PROCESSING`` or ``AWAITING_PLAYERS``);
 * - the local participant is **not** in the current turn's active
 *   set (so the AI hasn't called on them yet);
 * - the local participant is a **player** (spectators get their own
 *   read-only intro and never get called on, so a chip promising
 *   "you'll be brought in" is a false promise for them);
 * - the local participant is **not the creator** (the creator's seat
 *   is the session author, not a "just joined" guest);
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
  selfRoleKind,
  selfIsCreator,
}: {
  sessionState: string;
  iAmActive: boolean;
  messages: ReadonlyArray<{ kind: string; role_id?: string | null }>;
  selfRoleId: string | null;
  selfRoleKind?: "player" | "spectator";
  selfIsCreator?: boolean;
}): boolean {
  if (iAmActive) return false;
  if (selfIsCreator) return false;
  if (selfRoleKind === "spectator") return false;
  if (sessionState !== "AI_PROCESSING" && sessionState !== "AWAITING_PLAYERS") {
    return false;
  }
  if (!selfRoleId) return false;
  const iHavePosted = messages.some(
    (m) => m.kind === "player" && m.role_id === selfRoleId,
  );
  return !iHavePosted;
}
