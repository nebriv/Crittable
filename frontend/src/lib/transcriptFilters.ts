/**
 * Phase B chat-declutter (docs/plans/chat-decluttering.md §4.7):
 * filtering helpers for ``TranscriptFilters`` + ``Transcript``.
 *
 * Filter contract:
 *   * Quality filter is single-valued: ``"all"`` | ``"me"`` | ``"critical"``.
 *   * Track filter is a Set of workstream ids; OR within the set,
 *     AND-combined with the quality pill.
 *   * Empty track filter = no track filtering active (does NOT mean
 *     "show only ``#main``" — there's no ``#main`` pill in this
 *     iteration; the ``#main`` bucket is implicit / unfiltered).
 *
 * Two pure helpers:
 *   * ``filterMessages`` — applies the active filter to the message
 *     list. Used to compute the messages handed to ``Transcript``.
 *   * ``countFilters`` — returns counts for each pill so the UI can
 *     render badges without re-iterating in the component itself.
 */

import type { MessageView } from "../api/client";

export type QualityFilter = "all" | "me" | "critical";

export interface FilterState {
  quality: QualityFilter;
  tracks: ReadonlySet<string>;
}

export const DEFAULT_FILTER: FilterState = {
  quality: "all",
  tracks: new Set<string>(),
};

export function isDefaultFilter(state: FilterState): boolean {
  return state.quality === "all" && state.tracks.size === 0;
}

function passesQuality(
  msg: MessageView,
  quality: QualityFilter,
  selfRoleId: string | null,
): boolean {
  if (quality === "all") return true;
  if (quality === "critical") return msg.kind === "critical_inject";
  // Plan §6.1 (and User-persona review H4): ``@Me`` is strictly
  // "messages aimed AT me" — i.e. ``mentions.includes(selfRoleId)``.
  // Earlier draft also matched ``msg.role_id === selfRoleId`` (my own
  // posts), but that diluted the count badge and confused the
  // semantic ("@Me" should mean "addressed to me", not "my thread").
  // The structural source of mentions is server-stamped at dispatch
  // time from the routing tools' role_id arg — never body-parsed.
  if (quality === "me") {
    if (selfRoleId == null) return false;
    return (msg.mentions ?? []).includes(selfRoleId);
  }
  return true;
}

function passesTrack(msg: MessageView, tracks: ReadonlySet<string>): boolean {
  if (tracks.size === 0) return true;
  // ``null`` workstream_id (the ``#main`` bucket) never matches a
  // track filter. Plan §4.7 calls out that selecting any track pill
  // hides ``#main`` — that's the whole point of "show me only the
  // Containment thread".
  return msg.workstream_id != null && tracks.has(msg.workstream_id);
}

export function filterMessages(
  messages: MessageView[],
  state: FilterState,
  selfRoleId: string | null,
): MessageView[] {
  if (isDefaultFilter(state)) return messages;
  return messages.filter(
    (m) =>
      passesQuality(m, state.quality, selfRoleId) &&
      passesTrack(m, state.tracks),
  );
}

export interface FilterCounts {
  all: number;
  me: number;
  critical: number;
  /** Per-workstream message counts; only populated for declared ids. */
  perTrack: Record<string, number>;
}

export function countFilters(
  messages: MessageView[],
  declaredTrackIds: readonly string[],
  selfRoleId: string | null,
): FilterCounts {
  const counts: FilterCounts = {
    all: messages.length,
    me: 0,
    critical: 0,
    perTrack: Object.fromEntries(declaredTrackIds.map((id) => [id, 0])),
  };
  for (const m of messages) {
    if (m.kind === "critical_inject") counts.critical += 1;
    // Plan §6.1: ``@Me`` count mirrors the filter — strictly
    // "messages addressed to me", i.e. ``mentions.includes(self)``.
    if (selfRoleId != null && (m.mentions ?? []).includes(selfRoleId)) {
      counts.me += 1;
    }
    // Object.prototype.hasOwnProperty guard (Security review LOW3):
    // ``in`` walks the prototype chain. While the AI-declared ids are
    // regex-constrained to ``^[a-z][a-z0-9_]*$`` (so ``toString`` /
    // ``constructor`` would slip through), defensive iteration via
    // ``hasOwnProperty.call`` makes the check stable against any
    // future schema relaxation.
    const wsId = m.workstream_id;
    if (
      wsId != null &&
      Object.prototype.hasOwnProperty.call(counts.perTrack, wsId)
    ) {
      counts.perTrack[wsId] += 1;
    }
  }
  return counts;
}

/**
 * How many ``mentions.includes(selfRoleId)`` messages does the active
 * filter currently hide? Drives the sky-blue "N @-mentions for you
 * hidden" banner above the transcript (plan §4.7).
 */
export function countHiddenMentions(
  messages: MessageView[],
  state: FilterState,
  selfRoleId: string | null,
): number {
  if (selfRoleId == null) return 0;
  if (isDefaultFilter(state)) return 0;
  let hidden = 0;
  for (const m of messages) {
    if (!(m.mentions ?? []).includes(selfRoleId)) continue;
    const passes =
      passesQuality(m, state.quality, selfRoleId) &&
      passesTrack(m, state.tracks);
    if (!passes) hidden += 1;
  }
  return hidden;
}
