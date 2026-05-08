import { describe, expect, it } from "vitest";
import {
  friendlyRejectionMessage,
  type SetReadyRejectionReason,
} from "../lib/setReadyRejection";

// Decoupled-ready (PR #209 follow-up). Locks the contract that
// every documented ``set_ready_rejected.reason`` token from
// ``backend/app/sessions/manager.py::SetReadyOutcome`` maps to
// readable copy on both the player and creator sides — and that
// the unknown-reason path falls through cleanly. QA review BLOCK
// on the frontend follow-up: a typo in a reason string would
// otherwise silently land in the default branch and surface raw
// "Mark Ready rejected: typo_reason" to the user.

const KNOWN_REASONS: SetReadyRejectionReason[] = [
  "not_awaiting_players",
  "turn_already_advanced",
  "not_active_role",
  "not_authorized",
  "flip_cap_exceeded",
  "role_not_found",
  "no_current_turn",
];

describe("friendlyRejectionMessage", () => {
  describe.each(["player", "creator"] as const)("perspective: %s", (perspective) => {
    it.each(KNOWN_REASONS)(
      "%s → does not surface the raw token to the user",
      (reason) => {
        const msg = friendlyRejectionMessage(reason, perspective);
        // No raw snake_case token leaks to the user; copy is
        // human-readable English. The pattern guards against the
        // default-branch fallback (which interpolates the token).
        expect(msg).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
        expect(msg.length).toBeGreaterThan(20);
      },
    );
  });

  it("not_active_role reads differently for player vs creator (impersonation context)", () => {
    const player = friendlyRejectionMessage("not_active_role", "player");
    const creator = friendlyRejectionMessage("not_active_role", "creator");
    expect(player).not.toBe(creator);
    // Player copy refers to "you"; creator copy refers to "that role".
    expect(player.toLowerCase()).toMatch(/active|bring you back/);
    expect(creator.toLowerCase()).toMatch(/that role/);
  });

  it("flip_cap_exceeded names the cause without using the word 'flip'", () => {
    // User-persona review HIGH H5: "flip" is internal jargon. The
    // friendly copy paraphrases as "toggled ready too many times"
    // for players and "too many ready flips" for the creator (who
    // has more context); BOTH should give the user a path forward.
    const player = friendlyRejectionMessage("flip_cap_exceeded", "player");
    const creator = friendlyRejectionMessage("flip_cap_exceeded", "creator");
    expect(player).toMatch(/toggled|too many/i);
    expect(player).toMatch(/wait/i);
    expect(creator).toMatch(/wait/i);
  });

  it("not_authorized warns about creator-only impersonation", () => {
    const msg = friendlyRejectionMessage("not_authorized", "player");
    expect(msg).toMatch(/creator/i);
    expect(msg).toMatch(/behalf/i);
  });

  it("turn_already_advanced is brief — 'too late'", () => {
    const msg = friendlyRejectionMessage("turn_already_advanced", "player");
    expect(msg.toLowerCase()).toMatch(/too late|advanced/);
  });

  it("not_awaiting_players names the AI as the reason", () => {
    const msg = friendlyRejectionMessage("not_awaiting_players", "player");
    expect(msg).toMatch(/AI/);
  });

  it("unknown / unmapped reason falls through with the raw token visible", () => {
    // The default branch is the last-resort fallback: a backend
    // that ships a new reason without a frontend mapping should
    // make the bug visible in the UI rather than silently swallow
    // it. Tied to ``test_prompt_tool_consistency``-style hygiene
    // — frontends and backends must agree on the contract.
    const msg = friendlyRejectionMessage("brand_new_reason_we_dont_know", "player");
    expect(msg).toMatch(/brand_new_reason_we_dont_know/);
  });

  it("non-string-coerced 'unknown' falls through cleanly (defensive guard at call site)", () => {
    // Both call sites coerce ``evt.reason`` to ``"unknown"`` when
    // the wire payload isn't a string (Security review LOW). This
    // helper sees the coerced "unknown" and falls through.
    const msg = friendlyRejectionMessage("unknown", "player");
    expect(msg).toMatch(/unknown/);
  });
});
