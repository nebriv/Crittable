import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TurnLimitApproachingChip,
  TURN_LIMIT_NOTICE_TTL_MS,
} from "../components/TurnLimitApproachingChip";

/**
 * One-time ``turn_limit_approaching`` soft-warning chip (cost/abuse C2).
 *
 * Pins: renders nothing before the first event, surfaces a "N turns left"
 * notice on a fresh nonce, is non-blocking (pointer-events:none), and
 * self-expires after the TTL.
 */

describe("TurnLimitApproachingChip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("renders nothing before any event (nonce 0)", () => {
    render(<TurnLimitApproachingChip turnsRemaining={8} nonce={0} />);
    expect(
      screen.queryByTestId("turn-limit-approaching-chip"),
    ).not.toBeInTheDocument();
  });

  it("shows 'N turns left' when an event arrives (nonce > 0)", () => {
    render(<TurnLimitApproachingChip turnsRemaining={8} nonce={1} />);
    const chip = screen.getByTestId("turn-limit-approaching-chip");
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent(/8 TURNS LEFT/);
    expect(chip).toHaveTextContent(/Start wrapping up/);
    // Non-blocking: never swallows a click meant for a control beneath it.
    expect(chip).toHaveStyle({ pointerEvents: "none" });
  });

  it("uses the singular label when one turn remains", () => {
    render(<TurnLimitApproachingChip turnsRemaining={1} nonce={1} />);
    const chip = screen.getByTestId("turn-limit-approaching-chip");
    expect(chip).toHaveTextContent(/1 TURN LEFT/);
  });

  it("self-expires after the TTL", () => {
    render(<TurnLimitApproachingChip turnsRemaining={5} nonce={1} />);
    expect(
      screen.getByTestId("turn-limit-approaching-chip"),
    ).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(TURN_LIMIT_NOTICE_TTL_MS + 50);
    });
    expect(
      screen.queryByTestId("turn-limit-approaching-chip"),
    ).not.toBeInTheDocument();
  });
});
