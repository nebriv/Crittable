import { act, render, screen, within } from "@testing-library/react";
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
  planTitle: null,
  planSummary: null,
  snapshotLoaded: true,
  snapshotError: null,
  onRetry: () => undefined,
  onJoined: () => undefined,
};

describe("JoinIntro — issue #76 (joined, waiting for session start)", () => {
  beforeEach(() => {
    // Tip rotation uses setTimeout (length-aware dwell); fake timers
    // let us assert the carousel advances without a wall-clock wait.
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
      screen.getByText(/Waiting for facilitator to start/i),
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
      screen.queryByText(/Waiting for facilitator to start/i),
    ).toBeNull();
  });

  it("hasName=true, sessionState=READY → 'finalizing the lobby' copy variant", () => {
    // Plan is finalised, creator is gathering players in the lobby.
    // Pre-fix this state fell through to the chat view (sessionState
    // was not in the waiting list), so a player who joined here saw
    // a blank transcript with a disabled composer, then got yanked
    // BACK to the waiting screen the moment the creator hit Start
    // (state went READY → BRIEFING). Now we hold them on JoinIntro
    // for the full SETUP → READY → BRIEFING arc.
    render(
      <JoinIntro
        {...COMMON_PROPS}
        sessionState="READY"
        hasName
        joinedDisplayName="Bridget"
      />,
    );
    expect(screen.getByTestId("join-intro-waiting")).toBeInTheDocument();
    expect(
      screen.getByText(/finalizing the lobby/i),
    ).toBeInTheDocument();
    // BRIEFING-specific copy must NOT appear — the AI hasn't started
    // a brief yet during READY.
    expect(
      screen.queryByText(/AI is preparing the scenario brief/i),
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

    // Carousel dwell scales with tip length (UI/UX review HIGH —
    // 7s was borderline for the longest tips). 12s is enough for
    // every tip in the array, including the longest at ~140 chars
    // (which yields ~10s dwell).
    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    const next = screen.getByTestId("join-intro-tip").textContent;
    expect(next).not.toBe(initial);

    // Another rotation lands on a different tip again (or wraps).
    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    const third = screen.getByTestId("join-intro-tip").textContent;
    expect(third).not.toBe(next);
  });

  it("joinedSeatCount>0 surfaces an 'N other seats are connected' momentum cue", () => {
    render(
      <JoinIntro
        {...COMMON_PROPS}
        sessionState="SETUP"
        hasName
        joinedDisplayName="Bridget"
        joinedSeatCount={3}
      />,
    );
    // Copy shifted from "N seats joined" to "N other seats are
    // connected" (UI/UX review: pre-fix included the local
    // participant in the count, so "1 seat joined" was just *me*).
    expect(
      screen.getByText(/3 other seats connected/i),
    ).toBeInTheDocument();
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
    expect(
      screen.getByText(/1 other seat connected/i),
    ).toBeInTheDocument();
  });

  it("waiting panel exposes role=status; aria-live is scoped to the rotating tip only (UI/UX review)", () => {
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
    // Pre-fix the whole panel had aria-live=polite; the tip
    // rotation re-announced the headline + role + seat count
    // every 7-10s. Now aria-live lives only on the tip <p>.
    expect(panel.getAttribute("aria-live")).toBeNull();
    const tipPanel = screen.getByTestId("join-intro-tip");
    const liveTip = within(tipPanel).getByText(/.+/, {
      selector: "p[aria-live='polite']",
    });
    expect(liveTip).toBeInTheDocument();
  });

  it("personalised waiting headline names the seated participant", () => {
    render(
      <JoinIntro
        {...COMMON_PROPS}
        sessionState="SETUP"
        hasName
        joinedDisplayName="Bridget"
      />,
    );
    // Scope to the waiting panel — the surrounding "How to play"
    // section also has an h2.
    const panel = screen.getByTestId("join-intro-waiting");
    const heading = within(panel).getByRole("heading", { level: 2 });
    expect(heading.textContent).toMatch(/Bridget seated/);
  });

  it("auto-resolves when sessionState transitions out of SETUP/BRIEFING", () => {
    const { rerender } = render(
      <JoinIntro
        {...COMMON_PROPS}
        sessionState="SETUP"
        hasName
        joinedDisplayName="Bridget"
      />,
    );
    expect(screen.getByTestId("join-intro-waiting")).toBeInTheDocument();

    // Simulate the engine flipping to AWAITING_PLAYERS — JoinIntro
    // should swap back to the form variant (the gate in Play.tsx
    // would also unmount it; here we just confirm the variant
    // flip logic is keyed correctly off ``sessionState``).
    rerender(
      <JoinIntro
        {...COMMON_PROPS}
        sessionState="AWAITING_PLAYERS"
        hasName
        joinedDisplayName="Bridget"
      />,
    );
    expect(screen.queryByTestId("join-intro-waiting")).toBeNull();
  });

  it("tip carousel cycles through all WAITING_TIPS and wraps back", () => {
    render(
      <JoinIntro
        {...COMMON_PROPS}
        sessionState="SETUP"
        hasName
        joinedDisplayName="Bridget"
      />,
    );
    const seen = new Set<string>();
    seen.add(screen.getByTestId("join-intro-tip").textContent ?? "");
    // Advance through enough rotations to see every tip + wrap.
    // The carousel uses dwell scaled to length; advancing 12s per
    // beat is enough to clear even the longest tip.
    for (let i = 0; i < 8; i++) {
      act(() => {
        vi.advanceTimersByTime(12_000);
      });
      seen.add(screen.getByTestId("join-intro-tip").textContent ?? "");
    }
    // We've seen at least 4 distinct tip texts (5 tips total; the
    // textContent includes the "1 / 5" indicator so the strings
    // differ even if the carousel re-emits the same body text on
    // wrap).
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it("tip indicator shows current/total position", () => {
    render(
      <JoinIntro
        {...COMMON_PROPS}
        sessionState="SETUP"
        hasName
        joinedDisplayName="Bridget"
      />,
    );
    const tipPanel = screen.getByTestId("join-intro-tip");
    // Initial tip is index 0 → "1 / N"
    expect(tipPanel.textContent).toMatch(/1\s*\/\s*\d+/);
  });
});

describe("JoinIntro — SCENARIO BRIEF panel (plan_title / plan_summary)", () => {
  it("plan present → renders title + summary, no preparing placeholder", () => {
    render(
      <JoinIntro
        {...COMMON_PROPS}
        sessionState="READY"
        planTitle="Ransomware response under regulator scrutiny"
        planSummary="Multi-team incident with legal, comms, and technical decisions under time pressure."
      />,
    );
    expect(
      screen.getByRole("heading", { name: /SCENARIO BRIEF/i, level: 2 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Ransomware response under regulator scrutiny"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Multi-team incident/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/still preparing the scenario brief/i),
    ).toBeNull();
  });

  it("plan absent + pre-play → renders 'preparing' placeholder under SCENARIO BRIEF", () => {
    render(
      <JoinIntro
        {...COMMON_PROPS}
        sessionState="SETUP"
        planTitle={null}
        planSummary={null}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /SCENARIO BRIEF/i, level: 2 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/still preparing the scenario brief/i),
    ).toBeInTheDocument();
  });

  it("plan absent + ENDED → no SCENARIO BRIEF panel at all", () => {
    render(
      <JoinIntro
        {...COMMON_PROPS}
        sessionState="ENDED"
        planTitle={null}
        planSummary={null}
      />,
    );
    expect(
      screen.queryByRole("heading", { name: /SCENARIO BRIEF/i, level: 2 }),
    ).toBeNull();
  });

  it("empty-string title/summary collapse the panel cleanly (truthy gating)", () => {
    // ``ScenarioPlan.executive_summary`` defaults to ``""`` per Pydantic
    // and the model can emit ``""``; the panel must not render an empty
    // chrome with no content underneath.
    render(
      <JoinIntro
        {...COMMON_PROPS}
        sessionState="READY"
        planTitle=""
        planSummary=""
      />,
    );
    // Both empty → falls through to the pending placeholder (state is
    // not ENDED), which is fine — gives the user *something*.
    expect(
      screen.getByText(/still preparing the scenario brief/i),
    ).toBeInTheDocument();
  });

  it("only planTitle set → renders title without an empty summary p", () => {
    render(
      <JoinIntro
        {...COMMON_PROPS}
        sessionState="READY"
        planTitle="Office CPU spike investigation"
        planSummary={null}
      />,
    );
    expect(
      screen.getByText("Office CPU spike investigation"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/still preparing the scenario brief/i),
    ).toBeNull();
  });

  it("spectator role still sees the brief", () => {
    render(
      <JoinIntro
        {...COMMON_PROPS}
        roleKind="spectator"
        sessionState="READY"
        planTitle="Office CPU spike investigation"
        planSummary="Investigation under time pressure."
      />,
    );
    expect(
      screen.getByText("Office CPU spike investigation"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Investigation under time pressure."),
    ).toBeInTheDocument();
  });
});
