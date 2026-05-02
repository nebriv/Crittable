import "@testing-library/jest-dom/vitest";

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
