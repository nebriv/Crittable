import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../components/Composer";

// Issue #77 — heartbeat-mode typing indicator. The sender now
// re-emits ``typing_start`` once per ~1 s while the user is
// actively typing (and has hit a key since the last beat); the
// receiver TTL fades the chip if the heartbeat stops. A 500 ms
// start-delay gate keeps a single fat-finger keystroke from
// surfacing the indicator (UI/UX review BLOCK B-1).

const START_DELAY_MS = 500;
const HEARTBEAT_MS = 1000;
const STOP_AFTER_IDLE_MS = 2500;

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

function trueCallCount(fn: ReturnType<typeof vi.fn>): number {
  return fn.mock.calls.filter((c) => c[0] === true).length;
}
function falseCallCount(fn: ReturnType<typeof vi.fn>): number {
  return fn.mock.calls.filter((c) => c[0] === false).length;
}

describe("Composer typing indicator (issue #77, heartbeat mode)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does NOT broadcast typing on a single keystroke that's then cleared", () => {
    // UI/UX review BLOCK B-1 / issue #53: a single fat-finger
    // keystroke should not surface a ghost indicator on every
    // peer. The 500 ms gate gives the user time to abandon
    // before we start broadcasting.
    const { textarea, onTypingChange } = setup();
    fireEvent.change(textarea, { target: { value: "h" } });
    // 400 ms < START_DELAY_MS — no start fires.
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(trueCallCount(onTypingChange)).toBe(0);
    // The user clears the textarea before the gate fires;
    // the timer is still pending — clearing should cancel it.
    fireEvent.change(textarea, { target: { value: "" } });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(trueCallCount(onTypingChange)).toBe(0);
    expect(falseCallCount(onTypingChange)).toBe(0);
  });

  it("does NOT broadcast typing on a single keystroke even if textarea is NOT cleared", () => {
    // Copilot review on PR #99: pre-fix the gate-timer fired
    // typing_start unconditionally after 500 ms regardless of
    // whether the user kept typing. A single keystroke that
    // sat in the textarea would still surface a ghost
    // indicator. The fix counts keystrokes in the gate window
    // and skips the broadcast if <2.
    const { textarea, onTypingChange } = setup();
    fireEvent.change(textarea, { target: { value: "h" } });
    // Wait past the gate AND the idle window. No follow-up
    // keystroke; textarea still has "h". Expect no broadcasts.
    act(() => {
      vi.advanceTimersByTime(START_DELAY_MS + STOP_AFTER_IDLE_MS + 100);
    });
    expect(trueCallCount(onTypingChange)).toBe(0);
    expect(falseCallCount(onTypingChange)).toBe(0);
  });

  it("emits typing_start exactly once after ≥2 keystrokes inside the gate window", () => {
    const { textarea, onTypingChange } = setup();
    fireEvent.change(textarea, { target: { value: "h" } });
    fireEvent.change(textarea, { target: { value: "hi" } });
    act(() => {
      vi.advanceTimersByTime(START_DELAY_MS + 50);
    });
    expect(trueCallCount(onTypingChange)).toBe(1);
  });

  it("re-emits typing_start at the 1 Hz heartbeat cadence (exact lower + upper bound)", () => {
    const { textarea, onTypingChange } = setup();
    // Two keystrokes inside the 500 ms gate window so the gate
    // fires + emits start. One alone would fall below the ≥2
    // threshold and not broadcast.
    fireEvent.change(textarea, { target: { value: "h" } });
    fireEvent.change(textarea, { target: { value: "hi" } });
    act(() => {
      vi.advanceTimersByTime(START_DELAY_MS + 50);
    });
    expect(trueCallCount(onTypingChange)).toBe(1);
    // Continuous typing for 3.2 s post-start: keystroke every
    // 300 ms. Heartbeat fires at +1000, +2000, +3000 ms (3
    // beats). No spurious stop.
    for (let t = 300; t <= 3200; t += 300) {
      fireEvent.change(textarea, { target: { value: `h-${t}` } });
      act(() => {
        vi.advanceTimersByTime(300);
      });
    }
    const trueCalls = trueCallCount(onTypingChange);
    // QA review HIGH: cadence must be locked to 1 Hz, not just
    // ">= floor". Floor 4 (start + 3 beats), ceiling 5 in case
    // of a boundary tick crossing. A regression to 200 ms
    // heartbeat would put this in the 15-17 range — caught.
    expect(trueCalls).toBeGreaterThanOrEqual(4);
    expect(trueCalls).toBeLessThanOrEqual(5);
    expect(falseCallCount(onTypingChange)).toBe(0);
  });

  it("skips the heartbeat tick when no keystroke happened since the last beat (dirtySinceBeat gate)", () => {
    const { textarea, onTypingChange } = setup();
    // Two keystrokes to clear the ≥2-in-gate threshold.
    fireEvent.change(textarea, { target: { value: "h" } });
    fireEvent.change(textarea, { target: { value: "hi" } });
    act(() => {
      vi.advanceTimersByTime(START_DELAY_MS + 50);
    });
    expect(trueCallCount(onTypingChange)).toBe(1);
    // 1.4 s pause inside the idle window — heartbeat tick fires
    // at +1000, sees dirtySinceBeat=false, skips. No additional
    // start emitted.
    act(() => {
      vi.advanceTimersByTime(1400);
    });
    expect(trueCallCount(onTypingChange)).toBe(1);
    expect(falseCallCount(onTypingChange)).toBe(0);
  });

  it("heartbeat-skip then resume keystroke: refresh fires on next beat tick", () => {
    // QA review HIGH: gap not covered before. Type → pause
    // through one beat (skipped) → keystroke → next beat fires.
    const { textarea, onTypingChange } = setup();
    fireEvent.change(textarea, { target: { value: "h" } });
    fireEvent.change(textarea, { target: { value: "hi" } });
    act(() => {
      vi.advanceTimersByTime(START_DELAY_MS + 50);
    });
    expect(trueCallCount(onTypingChange)).toBe(1);
    // Pause 1.1 s — heartbeat at +1000 ms sees dirtySinceBeat
    // false and skips.
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(trueCallCount(onTypingChange)).toBe(1);
    // Resume typing — marks dirty. Use a different value so
    // React's setState bail-on-same-value doesn't skip the
    // re-render (test was flaky when "hi" appeared twice).
    fireEvent.change(textarea, { target: { value: "his" } });
    // Advance to the next heartbeat tick (~1000 ms later).
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    // Next heartbeat fires the refresh.
    expect(trueCallCount(onTypingChange)).toBeGreaterThanOrEqual(2);
    expect(falseCallCount(onTypingChange)).toBe(0);
  });

  it("2.4 s pause then keystroke does NOT fire a spurious typing_stop", () => {
    // QA review MEDIUM: idle-boundary protection. The user
    // pauses 2.4 s after their last keystroke (just under
    // STOP_AFTER_IDLE_MS = 2500), then resumes — idle must
    // NOT have fired and resume must NOT trigger a false
    // start/stop pair.
    const { textarea, onTypingChange } = setup();
    fireEvent.change(textarea, { target: { value: "h" } });
    fireEvent.change(textarea, { target: { value: "hi" } });
    // Pause 2.4 s from the last keystroke. The 500 ms gate
    // fires typing_start mid-pause; idle is scheduled for the
    // last-keystroke + 2500.
    act(() => {
      vi.advanceTimersByTime(2400);
    });
    expect(falseCallCount(onTypingChange)).toBe(0);
    // Resume typing — idle timer is refreshed.
    fireEvent.change(textarea, { target: { value: "hi!" } });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(falseCallCount(onTypingChange)).toBe(0);
  });

  it("emits typing_stop after STOP_AFTER_IDLE_MS of idle", () => {
    const { textarea, onTypingChange } = setup();
    // Two keystrokes to clear the ≥2 gate threshold.
    fireEvent.change(textarea, { target: { value: "h" } });
    fireEvent.change(textarea, { target: { value: "he" } });
    act(() => {
      vi.advanceTimersByTime(START_DELAY_MS + STOP_AFTER_IDLE_MS + 100);
    });
    expect(onTypingChange).toHaveBeenLastCalledWith(false);
  });

  it("re-emits typing_start on the next keystroke after a stop (via the gate)", () => {
    const { textarea, onTypingChange } = setup();
    fireEvent.change(textarea, { target: { value: "h" } });
    fireEvent.change(textarea, { target: { value: "hi" } });
    act(() => {
      vi.advanceTimersByTime(START_DELAY_MS + STOP_AFTER_IDLE_MS + 100);
    });
    expect(onTypingChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(textarea, { target: { value: "hi a" } });
    fireEvent.change(textarea, { target: { value: "hi ag" } });
    // ≥2 keystrokes inside the new gate window — start fires.
    act(() => {
      vi.advanceTimersByTime(START_DELAY_MS + 50);
    });
    expect(onTypingChange).toHaveBeenLastCalledWith(true);
  });

  it("emits typing_stop on submit AND a fresh keystroke afterward fires a new start", () => {
    const { textarea, onTypingChange, onSubmit } = setup();
    fireEvent.change(textarea, { target: { value: "a" } });
    fireEvent.change(textarea, { target: { value: "answer" } });
    act(() => {
      vi.advanceTimersByTime(START_DELAY_MS + 50);
    });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("answer", undefined);
    expect(onTypingChange).toHaveBeenLastCalledWith(false);
    // QA review MEDIUM: post-submit re-typing fires start again.
    fireEvent.change(textarea, { target: { value: "n" } });
    fireEvent.change(textarea, { target: { value: "next" } });
    act(() => {
      vi.advanceTimersByTime(START_DELAY_MS + 50);
    });
    expect(onTypingChange).toHaveBeenLastCalledWith(true);
  });

  it("Shift+Enter inserts a newline without submitting and counts as a keystroke", () => {
    // QA review MEDIUM: Shift+Enter newline path was untested.
    const { textarea, onTypingChange, onSubmit } = setup();
    fireEvent.change(textarea, { target: { value: "f" } });
    fireEvent.change(textarea, { target: { value: "first" } });
    act(() => {
      vi.advanceTimersByTime(START_DELAY_MS + 50);
    });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    fireEvent.change(textarea, { target: { value: "first\n" } });
    expect(onSubmit).not.toHaveBeenCalled();
    // The newline keystroke marks dirty; advance to the next
    // heartbeat tick and confirm it fires.
    act(() => {
      vi.advanceTimersByTime(HEARTBEAT_MS + 50);
    });
    expect(trueCallCount(onTypingChange)).toBeGreaterThanOrEqual(2);
  });

  it("emits typing_stop when the textarea is cleared mid-typing", () => {
    const { textarea, onTypingChange } = setup();
    fireEvent.change(textarea, { target: { value: "h" } });
    fireEvent.change(textarea, { target: { value: "hi" } });
    act(() => {
      vi.advanceTimersByTime(START_DELAY_MS + 50);
    });
    expect(onTypingChange).toHaveBeenLastCalledWith(true);
    fireEvent.change(textarea, { target: { value: "" } });
    expect(onTypingChange).toHaveBeenLastCalledWith(false);
  });

  it("emits typing_stop when the composer becomes disabled mid-typing", () => {
    const { textarea, onTypingChange, rerender } = setup();
    fireEvent.change(textarea, { target: { value: "h" } });
    fireEvent.change(textarea, { target: { value: "hi" } });
    act(() => {
      vi.advanceTimersByTime(START_DELAY_MS + 50);
    });
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
    fireEvent.change(textarea, { target: { value: "h" } });
    fireEvent.change(textarea, { target: { value: "hi" } });
    act(() => {
      vi.advanceTimersByTime(START_DELAY_MS + 50);
    });
    expect(onTypingChange).toHaveBeenLastCalledWith(true);
    unmount();
    expect(onTypingChange).toHaveBeenLastCalledWith(false);
  });

  it("rerender with new onTypingChange ref does NOT kill a live typing session (issue #77 regression)", () => {
    // Root-cause regression: Composer's ``useEffect([onTypingChange])``
    // cleanup fires whenever ``onTypingChange`` changes identity. In
    // Play/Facilitator the function was recreated on every render
    // (WS events, presence pings, etc.), so the cleanup cancelled
    // ``pendingStartTimer`` mid-gate and left its ref as a stale
    // truthy integer — permanently blocking new typing sessions.
    //
    // With the ``useCallback(fn, [])`` fix in Play/Facilitator the
    // function reference is stable, so this effect never fires mid-
    // session. The test verifies the *observable contract*: after a
    // rerender with a new onTypingChange prop, the current typing
    // session continues uninterrupted AND a second burst after the
    // rerender fires its own start.
    const onTypingChange1 = vi.fn();
    const onSubmit = vi.fn();
    const { rerender } = render(
      <Composer
        enabled={true}
        placeholder="Type something"
        label="Your message"
        onSubmit={onSubmit}
        onTypingChange={onTypingChange1}
      />,
    );
    const textarea = screen.getByPlaceholderText("Type something") as HTMLTextAreaElement;

    // First burst — 2+ keystrokes inside gate window.
    fireEvent.change(textarea, { target: { value: "h" } });
    fireEvent.change(textarea, { target: { value: "hi" } });
    act(() => {
      vi.advanceTimersByTime(START_DELAY_MS + 50);
    });
    expect(onTypingChange1).toHaveBeenLastCalledWith(true);

    // Simulate a WS-event re-render with a *new* onTypingChange
    // reference (this is what Play.tsx does on every state_changed /
    // presence / ai_thinking event when handleTypingChange is NOT
    // wrapped in useCallback).
    const onTypingChange2 = vi.fn();
    rerender(
      <Composer
        enabled={true}
        placeholder="Type something"
        label="Your message"
        onSubmit={onSubmit}
        onTypingChange={onTypingChange2}
      />,
    );
    // Re-query after rerender so we have a live DOM element.
    const textarea2 = screen.getByPlaceholderText("Type something") as HTMLTextAreaElement;

    // The rerender might trigger the useEffect([onTypingChange]) cleanup,
    // which calls teardownTypingTimers(). The critical invariant is that
    // teardownTypingTimers *nulls* every ref — particularly
    // ``pendingStartTimer.current``. Without nulling (old bug: just
    // ``clearTimeout`` without null-assignment), the ref held a stale
    // truthy timer ID, so the gate check ``if (!pendingStartTimer.current)``
    // would always short-circuit and a new typing session could never start.

    // After the rerender the user keeps typing. A second burst should
    // fire typing_start on the new onTypingChange2 ref. (If the stale-
    // timer bug is present, pendingStartTimer.current holds a cancelled-
    // but-truthy ID and the gate never re-schedules.)
    act(() => {
      // Let the idle timer from the first burst expire (simulates
      // a natural pause between sessions).
      vi.advanceTimersByTime(STOP_AFTER_IDLE_MS + 100);
    });
    // Now type a second burst.
    fireEvent.change(textarea2, { target: { value: "hello" } });
    fireEvent.change(textarea2, { target: { value: "hello w" } });
    act(() => {
      vi.advanceTimersByTime(START_DELAY_MS + 50);
    });
    expect(onTypingChange2).toHaveBeenLastCalledWith(true);
  });
});
