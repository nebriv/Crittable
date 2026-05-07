import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SetupChat } from "../components/SetupChat";
import type { SetupNoteView } from "../api/client";

/**
 * Lock the auto-scroll contract added in May 2026 for the user-reported
 * bug "Step 04 transcript window doesn't auto-scroll." A future refactor
 * (someone extracts the chat into a sub-component, wraps it in a
 * virtualizer, etc.) without these tests would silently regress —
 * scrollTop stuck at 0 reads as "the chat is broken" but doesn't
 * throw.
 */

function note(overrides: Partial<SetupNoteView>): SetupNoteView {
  return {
    speaker: overrides.speaker ?? "ai",
    content: overrides.content ?? "Hi, what's the scenario?",
    topic: overrides.topic ?? null,
    options: overrides.options ?? null,
    ts: overrides.ts ?? "2026-05-07T00:00:00Z",
  };
}

describe("SetupChat — auto-scroll on note arrival", () => {
  it("does NOT clobber scrollTop when the user has scrolled up (User Agent HIGH)", () => {
    // User Agent review caught this as HIGH: pre-fix the auto-pin was
    // unconditional, which yanked an operator who'd scrolled up to
    // re-read a clarifying question right back to the bottom on every
    // WS event. The near-bottom gate (80px threshold) is the
    // canonical fix.
    const notesA = [
      note({ speaker: "ai", content: "Q1" }),
      note({ speaker: "creator", content: "A1" }),
      note({ speaker: "ai", content: "Q2" }),
    ];
    const { container, rerender } = render(<SetupChat notes={notesA} />);
    const log = container.querySelector("[role='log']") as HTMLDivElement;
    // Mock layout so the scroll handler can compute distance.
    Object.defineProperty(log, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(log, "clientHeight", {
      configurable: true,
      value: 400,
    });
    // Simulate the operator scrolling up: scrollTop = 0 means we're
    // at the top, ~600px from the bottom.
    log.scrollTop = 0;
    log.dispatchEvent(new Event("scroll"));
    // Add a new note. Pre-fix this would set scrollTop = 1000.
    const notesB = [...notesA, note({ speaker: "ai", content: "Q3" })];
    rerender(<SetupChat notes={notesB} />);
    // Expect scrollTop still 0 — the gate prevented the pin.
    expect(log.scrollTop).toBe(0);
  });

  it("DOES pin to the bottom when the user is near the bottom on a new note", () => {
    const notesA = [
      note({ speaker: "ai", content: "Q1" }),
      note({ speaker: "creator", content: "A1" }),
    ];
    const { container, rerender } = render(<SetupChat notes={notesA} />);
    const log = container.querySelector("[role='log']") as HTMLDivElement;
    Object.defineProperty(log, "scrollHeight", {
      configurable: true,
      value: 1000,
      writable: true,
    });
    Object.defineProperty(log, "clientHeight", {
      configurable: true,
      value: 400,
    });
    // Simulate the operator near the bottom: 1000 - 600 - 400 = 0px
    // distance from bottom (well within the 80px threshold).
    log.scrollTop = 600;
    log.dispatchEvent(new Event("scroll"));
    // New note arrives; scrollHeight grows.
    Object.defineProperty(log, "scrollHeight", {
      configurable: true,
      value: 1100,
      writable: true,
    });
    const notesB = [...notesA, note({ speaker: "ai", content: "Q3" })];
    rerender(<SetupChat notes={notesB} />);
    // Effect should have set scrollTop to scrollHeight (1100).
    expect(log.scrollTop).toBe(1100);
  });

  it("re-fires the pin when aiTyping flips on (operator near bottom)", () => {
    // The typing indicator renders an inline ChatIndicator that grows
    // the layout — auto-scroll keeps it visible.
    const notes = [note({ speaker: "ai", content: "Q1" })];
    const { container, rerender } = render(<SetupChat notes={notes} />);
    const log = container.querySelector("[role='log']") as HTMLDivElement;
    Object.defineProperty(log, "scrollHeight", {
      configurable: true,
      value: 600,
      writable: true,
    });
    Object.defineProperty(log, "clientHeight", {
      configurable: true,
      value: 600,
    });
    log.scrollTop = 0; // 600 - 0 - 600 = 0 → at bottom
    log.dispatchEvent(new Event("scroll"));
    Object.defineProperty(log, "scrollHeight", {
      configurable: true,
      value: 700,
      writable: true,
    });
    rerender(<SetupChat notes={notes} aiTyping />);
    expect(log.scrollTop).toBe(700);
  });

  it("renders the empty-state placeholder when no notes (no scroll target)", () => {
    const { queryByRole, getByText } = render(<SetupChat notes={[]} />);
    expect(queryByRole("log")).toBeNull();
    expect(getByText(/Setup hasn't started yet/i)).toBeInTheDocument();
  });

  // Sanity: make sure the option-chip handler still wires through —
  // the auto-scroll changes shouldn't have touched the chip path.
  it("calls onPickOption when an option chip is clicked", () => {
    const handler = vi.fn();
    const notes = [
      note({
        speaker: "ai",
        content: "Pick one",
        options: ["A", "B"],
      }),
    ];
    const { getByRole } = render(
      <SetupChat notes={notes} onPickOption={handler} />,
    );
    const btn = getByRole("button", { name: "A" });
    btn.click();
    expect(handler).toHaveBeenCalledWith("A");
  });
});
