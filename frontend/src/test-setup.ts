import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach } from "vitest";

// jsdom's Range implementation has no getBoundingClientRect; the
// HighlightActionPopover (issue #98) calls it from a selectionchange
// handler that fires from inside jsdom's own delayed Selection-impl
// timers — meaning the missing method shows up as an *uncaught* jsdom
// error after a test has otherwise succeeded, and vitest --run exits
// non-zero. Stub a fixed rect globally so the handler doesn't throw.
// Tests that need precise positioning can override per-test.
if (
  typeof Range !== "undefined" &&
  typeof Range.prototype.getBoundingClientRect !== "function"
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Range.prototype as any).getBoundingClientRect = () => ({
    top: 100,
    left: 100,
    bottom: 116,
    right: 200,
    width: 100,
    height: 16,
    x: 100,
    y: 100,
    toJSON: () => ({}),
  });
}

// jsdom's localStorage / sessionStorage persist across tests in the
// same file unless explicitly cleared. The wizard's draft persistence
// (lib/sessionDraftStorage.ts) writes to sessionStorage every time
// the operator touches a field, which would otherwise let one test's
// draft restore on the next test's mount — e.g. tests advancing past
// step 1 would land subsequent tests on step 2 or 3 instead of the
// expected fresh-start step 1. Wipe both per-test so every render
// starts from defaults; individual tests can re-seed storage in their
// own setup if they need to.
beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

afterEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});
