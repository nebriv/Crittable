import { describe, expect, it } from "vitest";
import {
  buildImpersonateOptions,
  countUnjoinedImpersonateOptions,
  isMidSessionJoiner,
} from "../lib/proxy";
import type { RoleView } from "../api/client";

// Issue #80 helpers — both extracted as pure functions so the
// proxy-respond filter logic and the mid-session-joiner predicate
// can be tested without spinning up a Facilitator/Play render
// scaffold.

function role(
  id: string,
  label: string,
  opts: {
    is_creator?: boolean;
    display_name?: string | null;
    kind?: "player" | "spectator";
  } = {},
): RoleView {
  return {
    id,
    label,
    kind: opts.kind ?? "player",
    is_creator: opts.is_creator ?? false,
    display_name: opts.display_name ?? null,
  } as RoleView;
}

describe("buildImpersonateOptions — issue #80 (dropdown roster source)", () => {
  it("excludes the creator's own seat", () => {
    const roles = [
      role("r-creator", "Facilitator", { is_creator: true }),
      role("r-soc", "SOC Analyst"),
    ];
    const options = buildImpersonateOptions({
      roles,
      activeRoleIds: ["r-creator", "r-soc"],
      submittedRoleIds: [],
    });
    expect(options.map((o) => o.id)).toEqual(["r-soc"]);
  });

  it("excludes spectators (backend rejects spectator proxy submits)", () => {
    const roles = [
      role("r-creator", "Facilitator", { is_creator: true }),
      role("r-soc", "SOC Analyst"),
      role("r-watcher", "Auditor", { kind: "spectator" }),
    ];
    const options = buildImpersonateOptions({
      roles,
      activeRoleIds: ["r-soc", "r-watcher"],
      submittedRoleIds: [],
    });
    expect(options.map((o) => o.id)).toEqual(["r-soc"]);
  });

  it("excludes roles that already submitted on the current turn", () => {
    const roles = [
      role("r-creator", "Facilitator", { is_creator: true }),
      role("r-soc", "SOC Analyst"),
      role("r-legal", "Legal"),
    ];
    const options = buildImpersonateOptions({
      roles,
      activeRoleIds: ["r-soc", "r-legal"],
      submittedRoleIds: ["r-soc"],
    });
    expect(options.map((o) => o.id)).toEqual(["r-legal"]);
  });

  it("on-turn roles return offTurn=false with a plain label", () => {
    const roles = [
      role("r-creator", "Facilitator", { is_creator: true }),
      role("r-soc", "SOC Analyst"),
    ];
    const options = buildImpersonateOptions({
      roles,
      activeRoleIds: ["r-soc"],
      submittedRoleIds: [],
    });
    expect(options).toEqual([
      { id: "r-soc", label: "SOC Analyst", offTurn: false },
    ]);
  });

  it("off-turn roles return offTurn=true with the bare label", () => {
    // Issue #80 core scenario: "Legal" added mid-turn, isn't on the
    // running turn's active_role_ids, but should surface in the
    // dropdown. The Composer renders the (sidebar) suffix from the
    // structured ``offTurn`` flag — pre-fix the suffix was inlined
    // into the label and collided with Composer's own " (proxy)"
    // append, producing "Legal (off-turn) (proxy)".
    const roles = [
      role("r-creator", "Facilitator", { is_creator: true }),
      role("r-soc", "SOC Analyst"),
      role("r-legal", "Legal"),
    ];
    const options = buildImpersonateOptions({
      roles,
      activeRoleIds: ["r-soc"], // legal NOT in active set
      submittedRoleIds: [],
    });
    expect(options).toEqual([
      { id: "r-soc", label: "SOC Analyst", offTurn: false },
      { id: "r-legal", label: "Legal", offTurn: true },
    ]);
  });

  it("preserves snapshot.roles ordering", () => {
    const roles = [
      role("r-creator", "Facilitator", { is_creator: true }),
      role("r-c", "Comms"),
      role("r-a", "IR Lead"),
      role("r-b", "Legal"),
    ];
    const options = buildImpersonateOptions({
      roles,
      activeRoleIds: ["r-a", "r-b", "r-c"],
      submittedRoleIds: [],
    });
    expect(options.map((o) => o.id)).toEqual(["r-c", "r-a", "r-b"]);
  });

  it("returns an empty array when only the creator remains unsubmitted", () => {
    const roles = [role("r-creator", "Facilitator", { is_creator: true })];
    expect(
      buildImpersonateOptions({
        roles,
        activeRoleIds: ["r-creator"],
        submittedRoleIds: [],
      }),
    ).toEqual([]);
  });

  it("returns an empty array when the only non-creator is a spectator", () => {
    const roles = [
      role("r-creator", "Facilitator", { is_creator: true }),
      role("r-watcher", "Auditor", { kind: "spectator" }),
    ];
    expect(
      buildImpersonateOptions({
        roles,
        activeRoleIds: ["r-watcher"],
        submittedRoleIds: [],
      }),
    ).toEqual([]);
  });
});

describe("countUnjoinedImpersonateOptions — issue #103 (tip gating)", () => {
  it("counts only options whose roles are absent from the presence set", () => {
    const options = [
      { id: "r-soc", label: "SOC Analyst", offTurn: false },
      { id: "r-legal", label: "Legal", offTurn: false },
      { id: "r-comms", label: "Comms", offTurn: true },
    ];
    // soc + comms have tabs open, legal hasn't joined
    const presence = new Set(["r-soc", "r-comms"]);
    expect(countUnjoinedImpersonateOptions(options, presence)).toBe(1);
  });

  it("returns 0 when every option's role is currently connected", () => {
    // Pre-fix scenario: all roles joined and active, but none has
    // submitted on this turn yet — the tip used to lie that they
    // hadn't joined. The helper now correctly suppresses it.
    const options = [
      { id: "r-soc", label: "SOC Analyst", offTurn: false },
      { id: "r-legal", label: "Legal", offTurn: false },
    ];
    const presence = new Set(["r-soc", "r-legal", "r-creator"]);
    expect(countUnjoinedImpersonateOptions(options, presence)).toBe(0);
  });

  it("returns the full length when presence is empty (solo-testing)", () => {
    const options = [
      { id: "r-soc", label: "SOC Analyst", offTurn: false },
      { id: "r-legal", label: "Legal", offTurn: true },
    ];
    expect(countUnjoinedImpersonateOptions(options, new Set())).toBe(2);
  });

  it("returns 0 for an empty option list", () => {
    expect(
      countUnjoinedImpersonateOptions([], new Set(["r-soc"])),
    ).toBe(0);
  });
});

describe("isMidSessionJoiner — issue #80 bonus chip predicate", () => {
  const baseMessages: { kind: string; role_id?: string | null }[] = [
    { kind: "ai_text" },
    { kind: "player", role_id: "r-soc" },
    { kind: "system" },
  ];

  it("true when joining mid-PLAY, not in active set, no prior posts", () => {
    expect(
      isMidSessionJoiner({
        sessionState: "AI_PROCESSING",
        iAmActive: false,
        messages: baseMessages,
        selfRoleId: "r-legal",
      }),
    ).toBe(true);
  });

  it("true also during AWAITING_PLAYERS for the new joiner", () => {
    expect(
      isMidSessionJoiner({
        sessionState: "AWAITING_PLAYERS",
        iAmActive: false,
        messages: baseMessages,
        selfRoleId: "r-legal",
      }),
    ).toBe(true);
  });

  it("false during SETUP / READY / BRIEFING (handled by JoinIntro waiting variant)", () => {
    for (const state of ["SETUP", "READY", "BRIEFING"]) {
      expect(
        isMidSessionJoiner({
          sessionState: state,
          iAmActive: false,
          messages: baseMessages,
          selfRoleId: "r-legal",
        }),
      ).toBe(false);
    }
  });

  it("false during ENDED", () => {
    expect(
      isMidSessionJoiner({
        sessionState: "ENDED",
        iAmActive: false,
        messages: baseMessages,
        selfRoleId: "r-legal",
      }),
    ).toBe(false);
  });

  it("false when the participant is in the current turn's active set", () => {
    expect(
      isMidSessionJoiner({
        sessionState: "AI_PROCESSING",
        iAmActive: true,
        messages: baseMessages,
        selfRoleId: "r-legal",
      }),
    ).toBe(false);
  });

  it("false once the participant has posted at least one PLAYER message", () => {
    expect(
      isMidSessionJoiner({
        sessionState: "AI_PROCESSING",
        iAmActive: false,
        messages: [
          ...baseMessages,
          { kind: "player", role_id: "r-legal" },
        ],
        selfRoleId: "r-legal",
      }),
    ).toBe(false);
  });

  it("false when selfRoleId is null (token rehydration not done)", () => {
    expect(
      isMidSessionJoiner({
        sessionState: "AI_PROCESSING",
        iAmActive: false,
        messages: baseMessages,
        selfRoleId: null,
      }),
    ).toBe(false);
  });

  it("false for spectators (chip would be a false promise — engine never adds them)", () => {
    expect(
      isMidSessionJoiner({
        sessionState: "AI_PROCESSING",
        iAmActive: false,
        messages: baseMessages,
        selfRoleId: "r-watcher",
        selfRoleKind: "spectator",
      }),
    ).toBe(false);
  });

  it("false for the creator's own seat (creator authored the session)", () => {
    expect(
      isMidSessionJoiner({
        sessionState: "AI_PROCESSING",
        iAmActive: false,
        messages: baseMessages,
        selfRoleId: "r-creator",
        selfRoleKind: "player",
        selfIsCreator: true,
      }),
    ).toBe(false);
  });

  it("still true for a player non-creator with no selfRoleKind passed (back-compat)", () => {
    // Defensive: callers that don't yet pass selfRoleKind/selfIsCreator
    // (older test scaffolds) should still get the historical truth
    // table. Both new gates are opt-in, false-only-when-set.
    expect(
      isMidSessionJoiner({
        sessionState: "AI_PROCESSING",
        iAmActive: false,
        messages: baseMessages,
        selfRoleId: "r-legal",
      }),
    ).toBe(true);
  });
});
