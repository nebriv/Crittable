/**
 * Phase B chat-declutter (docs/plans/chat-decluttering.md §4.7):
 * deterministic 6-slot color palette for declared workstreams.
 *
 * Assignment rule: workstreams are colored in declaration order
 * (slot 0 → slot 5). The 7th and 8th workstreams (the schema's hard
 * cap is 8 — see ``declare_workstreams.input_schema.maxItems``) wrap
 * back to slots 0–1; the operator iter-3 visual-noise feedback is
 * mitigated server-side by the soft cap of 5, so wrap-around is a
 * legitimate edge that doesn't deserve dedicated chrome.
 *
 * The synthetic ``#main`` (unscoped) bucket gets slate gray —
 * deliberately picked to read as "neutral / unassigned" rather than
 * one of the named tracks.
 *
 * Color values are inline oklch literals rather than design tokens
 * because the palette is a *runtime* allocation (slot N → declared
 * workstream N), not a brand role. The brand tokens (signal / crit /
 * warn / info) keep their reserved meanings; the workstream palette
 * is intentionally orthogonal so a "containment" stripe doesn't
 * collide with the critical-inject red bubble or the active-turn
 * amber ring.
 */

/** Slate gray for ``#main`` / unscoped messages. Reads as neutral. */
export const MAIN_TRACK_COLOR = "oklch(0.55 0.025 240)";

/**
 * Six declaration-order slots. Hues are picked to avoid collision
 * with the reserved brand tokens — UI/UX review HIGH H3 specifically
 * flagged that an earlier draft put slot 4 at hue 90 (mustard, ΔH=15
 * from ``--warn`` at 75), and a mustard-tracked message that also
 * mentioned the viewer rendered three amber signals on the same edge
 * (stripe + mention ring + ``@YOU`` badge). Hues here keep:
 *
 *   * ≥ 50 deg from ``--warn`` (75)  — slot 4 lands at olive 125.
 *   * ≥ 30 deg from ``--crit`` (25)  — slot 5 (rust 55) is the
 *     closest; the L/C envelope keeps it visually distinct.
 *   * ≥ 30 deg from ``--signal`` (245) — teal slot 0 at 195 is the
 *     closest, again the L/C delta keeps separation.
 *   * ≥ 30 deg from ``--info`` (232) — same teal/signal proximity is
 *     the binding constraint.
 *
 * Adding a 7th/8th slot wraps back to slot 0 (workstreams cap at 8;
 * the soft cap is 5, so wrap-around is rare).
 */
export const WORKSTREAM_PALETTE: readonly string[] = [
  "oklch(0.70 0.13 195)", // teal
  "oklch(0.70 0.18 295)", // violet
  "oklch(0.72 0.16 340)", // magenta
  "oklch(0.74 0.15 145)", // green
  "oklch(0.74 0.13 125)", // olive   (≥ 50 deg from --warn at 75)
  "oklch(0.66 0.16 55)",  // rust    (distinct from --crit at 25)
] as const;

/**
 * Resolve the stripe color for a message given the session's declared
 * workstream registry. ``null`` workstream_id ⇒ ``#main`` slate.
 *
 * Returns ``MAIN_TRACK_COLOR`` for unknown ids too — a stale id that
 * survived dispatch validation (e.g. a snapshot from before a flag
 * flip) shouldn't crash the renderer; falling back to neutral is the
 * safest visual.
 */
export function colorForWorkstream(
  workstreamId: string | null | undefined,
  declaredOrder: readonly string[],
): string {
  if (!workstreamId) return MAIN_TRACK_COLOR;
  const index = declaredOrder.indexOf(workstreamId);
  if (index < 0) return MAIN_TRACK_COLOR;
  return WORKSTREAM_PALETTE[index % WORKSTREAM_PALETTE.length];
}
