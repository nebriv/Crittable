/**
 * Single source of truth for "is this share_data dump substantial?".
 *
 * Three sites used to keep their own copy of this threshold and
 * drift was inevitable:
 *   - ``Timeline.tsx`` decides whether a ``share_data`` call earns a
 *     "Data brief" rail pin.
 *   - ``ArtifactsRail.tsx`` decides whether a ``share_data`` call
 *     earns an artifact card.
 *   - ``Transcript.tsx`` decides whether to collapse the chat
 *     bubble to a one-line summary by default.
 *
 * All three answer the same question — "is this dump big enough
 * that a re-find affordance / dedicated treatment is warranted?" —
 * so they share one constant. A future tweak (raising or lowering
 * the threshold) updates this file and propagates everywhere.
 *
 * Picked at 300 chars: empirically the AI emits 60-120 char
 * one-liners for routine telemetry shares (no need for special
 * treatment) and multi-paragraph dumps for substantial briefs
 * (worth pinning + collapsing). 300 is the knee.
 */
export const SHARE_DATA_MIN_CHARS = 300;
