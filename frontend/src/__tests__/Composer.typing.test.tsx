import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../components/Composer";

// Issue #77 — heartbeat-mode typing indicator. The sender now
// re-emits ``typing_start`` once per ~1 s while the user is
// actively typing (and has hit a key since the last beat); the
// receiver TTL fades the chip if the heartbeat stops. Replaces
// the prior one-shot transition model.

function setup(opts: { enabled?: boolean } = {}) {
  const onTypingChange = vi.fn();
  const onSubmit = vi.fn();
  const utils = render(
    <Composer
      enabled={opts.enabled ?? true}
      placeholder="Type something"
      label="Your message"
      onSubmit={onSubmit}
      onTypingChange={onTypingChange}
    />,
  );
  const textarea = screen.getByPlaceholderText("Type something") as HTMLTextAreaElement;
  return { ...utils, textarea, onTypingChange, onSubmit };
}

describe("Composer typing indicator (issue #77, heartbeat mode)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("emits typing_start immediately on the first keystroke", () => {
    const { textarea, onTypingChange } = setup();
    fireEvent.change(textarea, { target: { value: "h" } });
    expect(onTypingChange).toHaveBeenCalledWith(true);
    // Pre-fix the start was deferred 1.5 s. The new model fires
    // on the first non-empty keystroke and lets the receiver TTL
    // absorb single-character flicker.
    expect(onTypingChange.mock.calls.filter((c) => c[0] === true)).toHaveLength(1);
  });

  it("re-emits typing_start every ~1 s while the user keeps typing", () => {
    const { textarea, onTypingChange } = setup();
    fireEvent.change(textarea, { target: { value: "h" } });
    expect(onTypingChange.mock.calls.filter((c) => c[0] === true)).toHaveLength(1);

    // Simulate continuous typing: keystroke every 300 ms for 3 s.
    for (let t = 300; t <= 3000; t += 300) {
      fireEvent.change(textarea, { target: { value: `h-${t}` } });
      act(() => {
        vi.advanceTimersByTime(300);
      });
    }
    // Expect a heartbeat each second while typing — at least 3
    // additional ``typing_start`` calls beyond the immediate one.
    const trueCalls = onTypingChange.mock.calls.filter((c) => c[0] === true).length;
    expect(trueCalls).toBeGreaterThanOrEqual(4);
    // No spurious ``typing_stop`` while typing was still active.
    const falseCalls = onTypingChange.mock.calls.filter((c) => c[0] === false).length;
    expect(falseCalls).toBe(0);
  });

  it("does NOT keep firing heartbeats during a long pause inside the idle window", () => {
    const { textarea, onTypingChange } = setup();
    fireEvent.change(textarea, { target: { value: "h" } });
    // 1.4 s pause — under STOP_AFTER_IDLE_MS (2.5 s) — no
    // additional keystroke means dirtySinceBeat is false, so the
    // 1 s heartbeat tick should NOT send a refresh.
    act(() => {
      vi.advanceTimersByTime(1400);
    });
    const trueCalls = onTypingChange.mock.calls.filter((c) => c[0] === true).length;
    expect(trueCalls).toBe(1);
  });

  it("emits typing_stop after STOP_AFTER_IDLE_MS of idle", () => {
    const { textarea, onTypingChange } = setup();
    fireEvent.change(textarea, { target: { value: "hello" } });
    expect(onTypingChange).toHaveBeenLastCalledWith(true);
    // Advance past the idle threshold (2.5 s) without further
    // keystrokes — idle timer should fire typing_stop.
    act(() => {
      vi.advanceTimersByTime(2600);
    });
    expect(onTypingChange).toHaveBeenLastCalledWith(false);
  });

  it("re-emits typing_start on the next keystroke after a stop", () => {
    const { textarea, onTypingChange } = setup();
    fireEvent.change(textarea, { target: { value: "hi" } });
    act(() => {
      vi.advanceTimersByTime(2600);
    });
    expect(onTypingChange).toHaveBeenLastCalledWith(false);

    // User starts typing again 1 s later — should re-fire start
    // immediately, not wait the old 1.5 s start delay.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    fireEvent.change(textarea, { target: { value: "hi again" } });
    expect(onTypingChange).toHaveBeenLastCalledWith(true);
  });

  it("emits typing_stop on submit", () => {
    const { textarea, onTypingChange, onSubmit } = setup();
    fireEvent.change(textarea, { target: { value: "answer" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("answer", undefined);
    expect(onTypingChange).toHaveBeenLastCalledWith(false);
  });

  it("emits typing_stop when the textarea is cleared", () => {
    const { textarea, onTypingChange } = setup();
    fireEvent.change(textarea, { target: { value: "hi" } });
    expect(onTypingChange).toHaveBeenLastCalledWith(true);
    fireEvent.change(textarea, { target: { value: "" } });
    expect(onTypingChange).toHaveBeenLastCalledWith(false);
  });

  it("emits typing_stop when the composer becomes disabled mid-typing", () => {
    const { textarea, onTypingChange, rerender } = setup();
    fireEvent.change(textarea, { target: { value: "hi" } });
    expect(onTypingChange).toHaveBeenLastCalledWith(true);
    rerender(
      <Composer
        enabled={false}
        placeholder="Type something"
        label="Your message"
        onSubmit={vi.fn()}
        onTypingChange={onTypingChange}
      />,
    );
    expect(onTypingChange).toHaveBeenLastCalledWith(false);
  });

  it("emits typing_stop on unmount", () => {
    const { textarea, onTypingChange, unmount } = setup();
    fireEvent.change(textarea, { target: { value: "hi" } });
    expect(onTypingChange).toHaveBeenLastCalledWith(true);
    unmount();
    expect(onTypingChange).toHaveBeenLastCalledWith(false);
  });
});
