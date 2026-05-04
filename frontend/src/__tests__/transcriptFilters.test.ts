import { describe, expect, it } from "vitest";
import { MessageView } from "../api/client";
import {
  DEFAULT_FILTER,
  countFilters,
  countHiddenMentions,
  filterMessages,
  isDefaultFilter,
} from "../lib/transcriptFilters";

const SELF = "role-soc";

function msg(
  partial: Partial<MessageView> & Pick<MessageView, "id" | "kind" | "ts">,
): MessageView {
  return {
    role_id: null,
    body: "",
    tool_name: null,
    tool_args: null,
    workstream_id: null,
    mentions: [],
    ...partial,
  };
}

const FIXTURES: MessageView[] = [
  // Containment beat — AI addresses SOC.
  msg({
    id: "m1",
    kind: "ai_text",
    ts: "2026-05-04T14:00:00Z",
    body: "@SOC: confirm isolation",
    workstream_id: "containment",
    mentions: ["role-soc"],
  }),
  // Containment beat — SOC reply.
  msg({
    id: "m2",
    kind: "player",
    ts: "2026-05-04T14:00:30Z",
    role_id: "role-soc",
    body: "Isolating now",
    workstream_id: "containment",
  }),
  // Comms beat — AI addresses Comms.
  msg({
    id: "m3",
    kind: "ai_text",
    ts: "2026-05-04T14:01:00Z",
    body: "@Comms: prepare statement",
    workstream_id: "comms",
    mentions: ["role-comms"],
  }),
  // Critical inject (no workstream).
  msg({
    id: "m4",
    kind: "critical_inject",
    ts: "2026-05-04T14:01:30Z",
    body: "Reporter call",
  }),
  // Unscoped broadcast (#main).
  msg({
    id: "m5",
    kind: "ai_text",
    ts: "2026-05-04T14:02:00Z",
    body: "Beat 2 starts now",
  }),
];

describe("isDefaultFilter", () => {
  it("returns true for the default filter and false otherwise", () => {
    expect(isDefaultFilter(DEFAULT_FILTER)).toBe(true);
    expect(isDefaultFilter({ quality: "me", tracks: new Set() })).toBe(false);
    expect(
      isDefaultFilter({ quality: "all", tracks: new Set(["containment"]) }),
    ).toBe(false);
  });
});

describe("filterMessages", () => {
  it("returns the input list unchanged on the default filter", () => {
    expect(filterMessages(FIXTURES, DEFAULT_FILTER, SELF)).toEqual(FIXTURES);
  });

  it("'me' keeps only mentions of self (NOT messages authored by self)", () => {
    // Plan §6.1: @Me is strictly "addressed to me". A self-authored
    // post (m2) is NOT a mention; only m1 (which mentions SOC via the
    // structural ``mentions[]`` list) qualifies. User-persona review
    // H4 confirmed this matches operator expectations.
    const filtered = filterMessages(
      FIXTURES,
      { quality: "me", tracks: new Set() },
      SELF,
    );
    expect(filtered.map((m) => m.id)).toEqual(["m1"]);
  });

  it("'critical' keeps only critical_inject", () => {
    const filtered = filterMessages(
      FIXTURES,
      { quality: "critical", tracks: new Set() },
      SELF,
    );
    expect(filtered.map((m) => m.id)).toEqual(["m4"]);
  });

  it("track filter is OR within the set", () => {
    const filtered = filterMessages(
      FIXTURES,
      { quality: "all", tracks: new Set(["containment", "comms"]) },
      SELF,
    );
    expect(filtered.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("track filter excludes #main / unscoped messages", () => {
    const filtered = filterMessages(
      FIXTURES,
      { quality: "all", tracks: new Set(["containment"]) },
      SELF,
    );
    // m4 (critical, unscoped) and m5 (broadcast, unscoped) drop out.
    expect(filtered.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("AND-combines quality with tracks", () => {
    // @Me ∩ #containment = the SOC-mentioned message in containment.
    // m2 (self-authored, no mention) drops out per the strict @Me
    // semantics.
    const filtered = filterMessages(
      FIXTURES,
      { quality: "me", tracks: new Set(["containment"]) },
      SELF,
    );
    expect(filtered.map((m) => m.id)).toEqual(["m1"]);
  });

  it("'me' is a no-op when selfRoleId is null", () => {
    expect(
      filterMessages(FIXTURES, { quality: "me", tracks: new Set() }, null),
    ).toEqual([]);
  });
});

describe("countFilters", () => {
  it("counts all/me/critical and per-track buckets", () => {
    const counts = countFilters(FIXTURES, ["containment", "comms"], SELF);
    expect(counts.all).toBe(5);
    // Strict @Me: only m1 mentions SOC; m2 is self-authored and not
    // counted.
    expect(counts.me).toBe(1);
    expect(counts.critical).toBe(1);
    expect(counts.perTrack).toEqual({ containment: 2, comms: 1 });
  });

  it("returns zero per-track when no workstreams declared", () => {
    const counts = countFilters(FIXTURES, [], SELF);
    expect(counts.perTrack).toEqual({});
    expect(counts.all).toBe(5);
  });
});

describe("countHiddenMentions", () => {
  it("returns 0 on the default filter", () => {
    expect(countHiddenMentions(FIXTURES, DEFAULT_FILTER, SELF)).toBe(0);
  });

  it("counts mention-of-self messages dropped by the active filter", () => {
    // 'critical' filter hides m1 (which mentions SOC) — that's the
    // hidden-mentions banner case from plan §4.7.
    expect(
      countHiddenMentions(
        FIXTURES,
        { quality: "critical", tracks: new Set() },
        SELF,
      ),
    ).toBe(1);
  });

  it("counts hidden mentions due to track filter", () => {
    // Filter only #comms — m1 (SOC-mention, containment) is hidden.
    expect(
      countHiddenMentions(
        FIXTURES,
        { quality: "all", tracks: new Set(["comms"]) },
        SELF,
      ),
    ).toBe(1);
  });

  it("returns 0 when selfRoleId is null", () => {
    expect(
      countHiddenMentions(
        FIXTURES,
        { quality: "critical", tracks: new Set() },
        null,
      ),
    ).toBe(0);
  });
});
