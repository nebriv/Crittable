/**
 * Snapshot-error → terminal-status classifier (issue #127, Copilot
 * review on PR #131).
 *
 * ``api.getSession`` errors flow through ``request()`` which throws
 * ``new Error(json.detail)`` — so the only signal we get is the
 * backend's ``HTTPException.detail`` string (or the stringified
 * status code when the JSON body parse failed). Map every backend
 * message the player can hit at the snapshot boundary onto a
 * dead-end-view bucket; ``null`` falls through to the page's
 * generic transient-error path.
 *
 * - ``"kicked"``: the seat was revoked / removed. Backend emits
 *   "token has been revoked" (token-version mismatch) or "role
 *   no longer exists" (DELETE /roles/{rid}); the api-client
 *   fallback is a bare "401".
 * - ``"session-gone"``: the session itself is gone. Backend emits
 *   "session not found" (GC reaper / never existed) or 410 (AAR
 *   path); the api-client fallback is a bare "404" / "410".
 * - ``null``: anything else (5xx, network blip, unparseable JSON);
 *   the page surfaces it as a transient snapshot error.
 *
 * Lives in ``lib/`` rather than alongside ``Play.tsx`` so the
 * file-level fast-refresh boundary stays component-only and so
 * other surfaces (Facilitator's snapshot path, future CreatorJoin
 * path) can reuse it without circular imports.
 */
export type SnapshotErrorKind = "kicked" | "session-gone" | null;

export function classifySnapshotError(message: string): SnapshotErrorKind {
  if (
    /\b401\b/.test(message) ||
    /revoked/i.test(message) ||
    /no longer exists/i.test(message)
  ) {
    return "kicked";
  }
  if (
    /\b404\b/.test(message) ||
    /\b410\b/.test(message) ||
    /session not found/i.test(message) ||
    /session.*expired/i.test(message)
  ) {
    return "session-gone";
  }
  return null;
}
