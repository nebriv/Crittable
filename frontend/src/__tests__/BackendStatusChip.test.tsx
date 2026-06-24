import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BackendStatusChip,
  BACKEND_STATUS_TTL_MS,
} from "../components/BackendStatusChip";

/**
 * Signal 1 — creator-only ``backend_status`` degraded chip.
 *
 * Pins the load-bearing behaviors: renders the message subtly, is
 * non-blocking (pointer-events:none), self-expires after the TTL, and
 * re-arms its timer on a fresh nonce even when the message repeats.
 */

describe("BackendStatusChip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("renders nothing before any event (nonce 0, null message)", () => {
    render(<BackendStatusChip message={null} nonce={0} />);
    expect(screen.queryByTestId("backend-status-chip")).not.toBeInTheDocument();
  });

  it("shows the message when an event arrives (nonce > 0)", () => {
    render(
      <BackendStatusChip
        message="Heavy load — responses may be delayed."
        nonce={1}
      />,
    );
    const chip = screen.getByTestId("backend-status-chip");
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent(/Heavy load — responses may be delayed\./);
    // Label reads "SYSTEM" (not "BACKEND" — that read like infra-down).
    expect(chip).toHaveTextContent(/SYSTEM/);
    expect(chip).not.toHaveTextContent(/BACKEND/);
  });

  it("is non-blocking — pointer events pass through the chip", () => {
    render(<BackendStatusChip message="Degraded." nonce={1} />);
    const chip = screen.getByTestId("backend-status-chip");
    expect(chip).toHaveStyle({ pointerEvents: "none" });
  });

  it("self-expires after the TTL", () => {
    render(<BackendStatusChip message="Degraded." nonce={1} />);
    expect(screen.getByTestId("backend-status-chip")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(BACKEND_STATUS_TTL_MS + 50);
    });
    expect(screen.queryByTestId("backend-status-chip")).not.toBeInTheDocument();
  });

  it("re-arms the auto-clear on a fresh nonce even with the same message", () => {
    const { rerender } = render(
      <BackendStatusChip message="Degraded." nonce={1} />,
    );
    // Let most of the first window elapse, then a new (identical-text)
    // frame lands with a bumped nonce.
    act(() => {
      vi.advanceTimersByTime(BACKEND_STATUS_TTL_MS - 1000);
    });
    rerender(<BackendStatusChip message="Degraded." nonce={2} />);
    // Past the ORIGINAL deadline — still visible because the nonce
    // re-armed the timer.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId("backend-status-chip")).toBeInTheDocument();
    // Past the NEW deadline — now gone.
    act(() => {
      vi.advanceTimersByTime(BACKEND_STATUS_TTL_MS);
    });
    expect(screen.queryByTestId("backend-status-chip")).not.toBeInTheDocument();
  });

  it("honors a custom ttlMs override", () => {
    render(<BackendStatusChip message="Degraded." nonce={1} ttlMs={500} />);
    expect(screen.getByTestId("backend-status-chip")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByTestId("backend-status-chip")).not.toBeInTheDocument();
  });
});
