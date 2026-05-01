import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JoinIntro } from "../pages/Play";

// Issue #76 — joined-but-waiting variant of JoinIntro. The Play page
// holds the participant on JoinIntro instead of bouncing them to a
// blank chat shell while the creator drafts the plan; the form is
// swapped for a spinner panel + tip carousel.

const COMMON_PROPS = {
  sessionId: "sess-123",
  token: "play-token",
  roleLabel: "SOC Analyst",
  roleKind: "player" as const,
  roleExistingDisplayName: null,
  snapshotLoaded: true,
  snapshotError: null,
  onRetry: () => undefined,
  onJoined: () => undefined,
};

describe("JoinIntro — issue #76 (joined, waiting for session start)", () => {
  beforeEach(() => {
    // Tip rotation uses setInterval; fake timers let us assert the
    // carousel advances without a 7s wall-clock wait.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hasName=false, sessionState=SETUP → renders the name form, not the waiting panel", () => {
    render(
      <JoinIntro {...COMMON_PROPS} sessionState="SETUP" hasName={false} />,
    );
    expect(screen.queryByTestId("join-intro-waiting")).toBeNull();
    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Begin/i }),
    ).toBeInTheDocument();
  });

  it("hasName=true, sessionState=SETUP → renders the waiting panel, not the form", () => {
    render(
      <JoinIntro
        {...COMMON_PROPS}
        sessionState="SETUP"
        hasName
        joinedDisplayName="Bridget"
      />,
    );
    expect(screen.getByTestId("join-intro-waiting")).toBeInTheDocument();
    expect(
      screen.getByText(/Waiting for your facilitator to start the scenario/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/seated as/i).textContent,
    ).toMatch(/SOC Analyst/);
    expect(
      screen.getByText(/seated as/i).textContent,
    ).toMatch(/Bridget/);
    // Form must be gone.
    expect(screen.queryByLabelText(/display name/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Begin/i })).toBeNull();
  });

  it("hasName=true, sessionState=BRIEFING → AI-preparing copy variant", () => {
    render(
      <JoinIntro
        {...COMMON_PROPS}
        sessionState="BRIEFING"
        hasName
        joinedDisplayName="Bridget"
      />,
    );
    expect(
      screen.getByText(/AI is preparing the scenario brief/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Waiting for your facilitator to start/i),
    ).toBeNull();
  });

  it("tip carousel rotates after the configured interval", () => {
    render(
      <JoinIntro
        {...COMMON_PROPS}
        sessionState="SETUP"
        hasName
        joinedDisplayName="Bridget"
      />,
    );
    const tipPanel = screen.getByTestId("join-intro-tip");
    const initial = tipPanel.textContent;
    expect(initial).toBeTruthy();

    // Advance past one rotation interval (carousel uses 7s).
    act(() => {
      vi.advanceTimersByTime(7100);
    });
    const next = screen.getByTestId("join-intro-tip").textContent;
    expect(next).not.toBe(initial);

    // Another rotation lands on a different tip again (or wraps).
    act(() => {
      vi.advanceTimersByTime(7100);
    });
    const third = screen.getByTestId("join-intro-tip").textContent;
    expect(third).not.toBe(next);
  });

  it("joinedSeatCount>0 surfaces a 'N seats joined' momentum cue", () => {
    render(
      <JoinIntro
        {...COMMON_PROPS}
        sessionState="SETUP"
        hasName
        joinedDisplayName="Bridget"
        joinedSeatCount={3}
      />,
    );
    expect(screen.getByText(/3 seats joined/i)).toBeInTheDocument();
  });

  it("joinedSeatCount=1 → singular form", () => {
    render(
      <JoinIntro
        {...COMMON_PROPS}
        sessionState="SETUP"
        hasName
        joinedDisplayName="Bridget"
        joinedSeatCount={1}
      />,
    );
    expect(screen.getByText(/1 seat joined/i)).toBeInTheDocument();
  });

  it("waiting panel exposes role=status with aria-live=polite", () => {
    render(
      <JoinIntro
        {...COMMON_PROPS}
        sessionState="SETUP"
        hasName
        joinedDisplayName="Bridget"
      />,
    );
    const panel = screen.getByTestId("join-intro-waiting");
    expect(panel.getAttribute("role")).toBe("status");
    expect(panel.getAttribute("aria-live")).toBe("polite");
  });
});
