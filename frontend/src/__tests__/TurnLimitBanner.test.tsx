import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TurnLimitBanner } from "../components/TurnLimitBanner";

/**
 * Signal 2 — broadcast ``turn_limit_reached`` banner.
 *
 * Both creator and player see the banner; only the creator gets the
 * prominent END SESSION action (the creator is who can end). Pins the
 * copy, the max-turns surfacing, and the creator-only End affordance.
 */

describe("TurnLimitBanner", () => {
  it("renders the turn-limit headline and the configured max", () => {
    render(<TurnLimitBanner maxTurns={12} isCreator={false} />);
    const banner = screen.getByTestId("turn-limit-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(/Turn limit reached/i);
    expect(banner).toHaveTextContent(/12 TURNS/);
  });

  it("creator variant shows a prominent END SESSION button wired to onEnd", () => {
    const onEnd = vi.fn();
    render(<TurnLimitBanner maxTurns={8} isCreator onEnd={onEnd} />);
    const endBtn = screen.getByRole("button", { name: /END SESSION/i });
    expect(endBtn).toBeInTheDocument();
    fireEvent.click(endBtn);
    expect(onEnd).toHaveBeenCalledOnce();
    // Creator copy steers them to end the session.
    expect(screen.getByTestId("turn-limit-banner")).toHaveTextContent(
      /End the session to generate the after-action report/i,
    );
  });

  it("player variant has no End button and reads as informational", () => {
    render(<TurnLimitBanner maxTurns={8} isCreator={false} />);
    expect(
      screen.queryByRole("button", { name: /END SESSION/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("turn-limit-banner")).toHaveTextContent(
      /Your facilitator can end the session/i,
    );
  });

  it("announces assertively for accessibility", () => {
    render(<TurnLimitBanner maxTurns={8} isCreator={false} />);
    const banner = screen.getByTestId("turn-limit-banner");
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveAttribute("aria-live", "assertive");
  });
});
