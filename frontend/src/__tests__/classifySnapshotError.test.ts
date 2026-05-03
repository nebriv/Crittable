/**
 * Pin the snapshot-error → terminal-status mapping (issue #127, Copilot
 * review on PR #131).
 *
 * The backend's ``HTTPException.detail`` is the only signal a returning
 * kicked / orphaned player gets when their localStorage was cleared and
 * the WebSocket is still gated on ``displayName``. Without a tight
 * regex set, the player either falls through to JoinIntro (the bug
 * Copilot flagged) or sees a generic snapshot error inside the intro
 * card and never reaches the dead-end view. Pin every detail message
 * the backend emits today AND the bare ``\d{3}`` status fallbacks the
 * api client uses when the JSON-body parse fails.
 */
import { describe, expect, it } from "vitest";

import { classifySnapshotError } from "../lib/snapshotError";

describe("classifySnapshotError — kicked", () => {
  it.each([
    "token has been revoked",
    "role no longer exists",
    "401",
    "401 Unauthorized",
    "401: token has been revoked",
  ])("maps %p to 'kicked'", (msg) => {
    expect(classifySnapshotError(msg)).toBe("kicked");
  });
});

describe("classifySnapshotError — session-gone", () => {
  it.each([
    "session not found",
    "Session not found",
    "404",
    "404 Not Found",
    "410",
    "session has expired",
  ])("maps %p to 'session-gone'", (msg) => {
    expect(classifySnapshotError(msg)).toBe("session-gone");
  });
});

describe("classifySnapshotError — transient", () => {
  it.each([
    "network error",
    "Failed to fetch",
    "500",
    "Internal Server Error",
    "",
  ])("returns null for %p", (msg) => {
    expect(classifySnapshotError(msg)).toBeNull();
  });
});

describe("classifySnapshotError — kicked precedence", () => {
  it("prefers kicked when a message matches both buckets", () => {
    // A pathological backend rewording could in theory hit both
    // regex sets at once. Pin the precedence: a revoked-token signal
    // wins over a session-gone signal so the player sees the more
    // actionable "ask for a new join link" copy.
    expect(
      classifySnapshotError("token revoked; session not found"),
    ).toBe("kicked");
  });
});
