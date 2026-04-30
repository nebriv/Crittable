import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Facilitator, TopBar, SetupView, PlanView } from "../pages/Facilitator";
import { api, type ScenarioPlan, type SessionSnapshot } from "../api/client";

// The intro page renders both an `<ol>` ("What to expect") and the chip
// list in the fieldset, so a bare `getByRole("list")` is ambiguous.
// Scope every chip-list query to the fieldset group via its legend.
function getChipList(): HTMLElement {
  const fieldset = screen.getByRole("group", { name: /Roles to invite/i });
  return within(fieldset).getByRole("list");
}

describe("Facilitator intro — Roles to invite (issue #61)", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("seeds three default invitee chips", () => {
    render(<Facilitator />);
    const list = getChipList();
    expect(within(list).getByText("IR Lead")).toBeInTheDocument();
    expect(within(list).getByText("Legal")).toBeInTheDocument();
    expect(within(list).getByText("Comms")).toBeInTheDocument();
  });

  it("adds a new role via the Add role button", () => {
    render(<Facilitator />);
    const draft = screen.getByLabelText("New role label") as HTMLInputElement;
    fireEvent.change(draft, { target: { value: "SOC Analyst" } });
    fireEvent.click(screen.getByRole("button", { name: "Add role" }));
    expect(within(getChipList()).getByText("SOC Analyst")).toBeInTheDocument();
    expect(draft.value).toBe("");
  });

  it("adds a new role via the Enter key without submitting the form", () => {
    const createSpy = vi.spyOn(api, "createSession");
    render(<Facilitator />);
    const draft = screen.getByLabelText("New role label") as HTMLInputElement;
    fireEvent.change(draft, { target: { value: "Threat Intel" } });
    fireEvent.keyDown(draft, { key: "Enter" });
    expect(within(getChipList()).getByText("Threat Intel")).toBeInTheDocument();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("rejects duplicates case-insensitively without altering the chip list", () => {
    render(<Facilitator />);
    const draft = screen.getByLabelText("New role label") as HTMLInputElement;
    fireEvent.change(draft, { target: { value: "legal" } });
    fireEvent.click(screen.getByRole("button", { name: "Add role" }));
    expect(within(getChipList()).getAllByText(/legal/i)).toHaveLength(1);
    expect(draft.value).toBe("");
  });

  it("ignores blank / whitespace-only role labels", () => {
    render(<Facilitator />);
    const before = getChipList().children.length;
    const draft = screen.getByLabelText("New role label") as HTMLInputElement;
    const addButton = screen.getByRole("button", { name: "Add role" });
    expect(addButton).toBeDisabled();
    fireEvent.change(draft, { target: { value: "   " } });
    fireEvent.click(addButton);
    fireEvent.keyDown(draft, { key: "Enter" });
    expect(getChipList().children.length).toBe(before);
  });

  it("removes a chip when the X button is clicked", () => {
    render(<Facilitator />);
    fireEvent.click(screen.getByLabelText("Remove Legal"));
    const list = getChipList();
    expect(within(list).queryByText("Legal")).not.toBeInTheDocument();
    expect(within(list).getByText("IR Lead")).toBeInTheDocument();
  });

  it("Clear all empties the chip list and shows the empty state", () => {
    render(<Facilitator />);
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    const fieldset = screen.getByRole("group", { name: /Roles to invite/i });
    expect(within(fieldset).queryByRole("list")).not.toBeInTheDocument();
    expect(
      within(fieldset).getByText(/No invitee roles yet/i),
    ).toBeInTheDocument();
  });

  it("Reset to defaults restores IR Lead/Legal/Comms after clearing", () => {
    render(<Facilitator />);
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    const list = getChipList();
    expect(within(list).getByText("IR Lead")).toBeInTheDocument();
    expect(within(list).getByText("Legal")).toBeInTheDocument();
    expect(within(list).getByText("Comms")).toBeInTheDocument();
  });

  it("warns when the creator label collides with an invitee chip", () => {
    render(<Facilitator />);
    const labelInput = screen.getByPlaceholderText(
      /Your role label/i,
    ) as HTMLInputElement;
    fireEvent.change(labelInput, { target: { value: "IR Lead" } });
    expect(
      screen.getByText(/won't be auto-added as a separate invitee/i),
    ).toBeInTheDocument();
  });
});

describe("TopBar (issue #62)", () => {
  const baseProps = {
    onStart: vi.fn(),
    onForceAdvance: vi.fn(),
    onEnd: vi.fn(),
    onNewSession: vi.fn(),
    onViewAar: vi.fn(),
    onToggleGodMode: vi.fn(),
    busy: false,
    backendState: "READY",
    wsStatus: "open" as const,
    godMode: false,
    // Round 3 telemetry props.
    turnIndex: null,
    rationaleCount: 0,
    connectionCount: null,
    lastEventAt: null,
    cost: null,
    messageCount: 0,
    // Round 4 — LLM tier chip (#9).
    activeTiers: [] as string[],
  };

  it("renders Start session disabled when plan not finalized", () => {
    render(
      <TopBar
        {...baseProps}
        phase="setup"
        playerCount={3}
        hasFinalizedPlan={false}
        aarStatus={null}
      />,
    );
    const btn = screen.getByRole("button", { name: "Start session" });
    expect(btn).toBeDisabled();
  });

  it("renders Start session disabled when fewer than 2 players", () => {
    render(
      <TopBar
        {...baseProps}
        phase="ready"
        playerCount={1}
        hasFinalizedPlan={true}
        aarStatus={null}
      />,
    );
    expect(screen.getByRole("button", { name: "Start session" })).toBeDisabled();
  });

  it("enables Start session when plan finalized and ≥2 players", () => {
    render(
      <TopBar
        {...baseProps}
        phase="ready"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
      />,
    );
    const btn = screen.getByRole("button", { name: "Start session" });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(baseProps.onStart).toHaveBeenCalled();
  });

  it("renders force-advance + end buttons during play", () => {
    render(
      <TopBar
        {...baseProps}
        phase="play"
        playerCount={3}
        hasFinalizedPlan={true}
        aarStatus={null}
      />,
    );
    expect(
      screen.getByRole("button", { name: "AI: take next beat" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "End session" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Start session" }),
    ).not.toBeInTheDocument();
  });

  it("renders View AAR when ended phase + AAR ready", () => {
    render(
      <TopBar
        {...baseProps}
        phase="ended"
        playerCount={3}
        hasFinalizedPlan={true}
        aarStatus="ready"
      />,
    );
    expect(
      screen.getByRole("button", { name: "View AAR" }),
    ).toBeInTheDocument();
  });

  it("renders AAR generating status when ended phase + AAR pending", () => {
    render(
      <TopBar
        {...baseProps}
        phase="ended"
        playerCount={3}
        hasFinalizedPlan={true}
        aarStatus="pending"
      />,
    );
    expect(screen.getByText(/AAR generating/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "View AAR" }),
    ).not.toBeInTheDocument();
  });

  it("surfaces turn / message / rationale / tabs / cost telemetry chips", () => {
    render(
      <TopBar
        {...baseProps}
        phase="play"
        playerCount={3}
        hasFinalizedPlan={true}
        aarStatus={null}
        turnIndex={4}
        messageCount={42}
        rationaleCount={7}
        connectionCount={5}
        cost={{
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_tokens: 200,
          cache_creation_tokens: 100,
          estimated_usd: 0.0234,
        }}
      />,
    );
    expect(screen.getByText("T#4")).toBeInTheDocument();
    expect(screen.getByText("42 msgs")).toBeInTheDocument();
    expect(screen.getByText("Rationale: 7")).toBeInTheDocument();
    expect(screen.getByText("Tabs: 5")).toBeInTheDocument();
    expect(screen.getByText("Cost: $0.0234")).toBeInTheDocument();
  });

  it("renders dash placeholders when telemetry is null", () => {
    render(
      <TopBar
        {...baseProps}
        phase="setup"
        playerCount={1}
        hasFinalizedPlan={false}
        aarStatus={null}
      />,
    );
    expect(screen.getByText("T#—")).toBeInTheDocument();
    expect(screen.getByText("Tabs: —")).toBeInTheDocument();
    expect(screen.getByText("Cost: $—")).toBeInTheDocument();
    expect(screen.getByText("Last: —")).toBeInTheDocument();
  });

  it("renders 'Last: <Ns ago' once a lastEventAt timestamp is set", () => {
    const fiveSecondsAgo = Date.now() - 5_500;
    render(
      <TopBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
        lastEventAt={fiveSecondsAgo}
      />,
    );
    expect(screen.getByText(/Last: 5s ago/)).toBeInTheDocument();
  });

  it("renders 'LLM: idle' when no LLM calls are in flight", () => {
    render(
      <TopBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
      />,
    );
    expect(screen.getByText("LLM: idle")).toBeInTheDocument();
  });

  it("renders 'LLM: <tier>' when a single tier is active", () => {
    render(
      <TopBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
        activeTiers={["play"]}
      />,
    );
    expect(screen.getByText("LLM: play")).toBeInTheDocument();
    expect(screen.queryByText("LLM: idle")).not.toBeInTheDocument();
  });

  it("joins multiple concurrent tiers with '+' (e.g. guardrail + play)", () => {
    render(
      <TopBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
        activeTiers={["guardrail", "play"]}
      />,
    );
    expect(screen.getByText("LLM: guardrail+play")).toBeInTheDocument();
  });

  it("expands the cost chip to show the token breakdown", () => {
    render(
      <TopBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
        cost={{
          input_tokens: 12345,
          output_tokens: 6789,
          cache_read_tokens: 100,
          cache_creation_tokens: 50,
          estimated_usd: 1.2345,
        }}
      />,
    );
    const summary = screen.getByText("Cost: $1.2345");
    fireEvent.click(summary);
    expect(screen.getByText("Cost — token breakdown")).toBeInTheDocument();
    expect(screen.getByText("12,345")).toBeInTheDocument();
    expect(screen.getByText("6,789")).toBeInTheDocument();
  });

  it("always renders 'Start a new session' regardless of phase", () => {
    for (const phase of ["setup", "ready", "play", "ended"] as const) {
      const { unmount } = render(
        <TopBar
          {...baseProps}
          phase={phase}
          playerCount={2}
          hasFinalizedPlan={true}
          aarStatus="ready"
        />,
      );
      expect(
        screen.getByRole("button", { name: "Start a new session" }),
      ).toBeInTheDocument();
      unmount();
    }
  });

  // Issue #36: hide debug-y chips behind God Mode so a fresh creator
  // doesn't see "ws: open · v 7a1862f" on first impression. The God Mode
  // toggle button itself stays visible — it's the only entry to debug
  // mode now and must remain reachable.
  it("hides ws-pill and build-SHA chip when God Mode is off (healthy connection)", () => {
    render(
      <TopBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
        godMode={false}
        wsStatus="open"
      />,
    );
    // ``state: ... · phase: ...`` chip stays — it carries user-facing meaning.
    expect(screen.getByText(/state: READY · phase: play/i)).toBeInTheDocument();
    // Debug-y chips are hidden until God Mode is on (when connection healthy).
    expect(screen.queryByTestId("ws-pill")).not.toBeInTheDocument();
    expect(screen.queryByTestId("build-sha-chip")).not.toBeInTheDocument();
    // God Mode toggle stays reachable — it's the only entry to debug mode.
    expect(screen.getByRole("button", { name: /God Mode/i })).toBeInTheDocument();
  });

  it("shows ws-pill and build-SHA chip when God Mode is on", () => {
    render(
      <TopBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
        godMode={true}
        wsStatus="open"
      />,
    );
    expect(screen.getByText(/state: READY · phase: play/i)).toBeInTheDocument();
    expect(screen.getByTestId("ws-pill")).toHaveTextContent(/ws: open/);
    expect(screen.getByTestId("build-sha-chip")).toHaveTextContent(/^v /);
  });

  // Resurfacing the WS pill on a degraded connection is the only "is the
  // app stuck?" signal a non-operator creator has — without it, hiding
  // the pill behind God Mode would leave them silently disconnected.
  it("resurfaces ws-pill on degraded connection even when God Mode is off", () => {
    render(
      <TopBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
        godMode={false}
        wsStatus="closed"
      />,
    );
    expect(screen.getByTestId("ws-pill")).toHaveTextContent(/ws: closed/);
    // Build-SHA chip stays God-Mode-only — it's bug-report ergonomics, not
    // user-facing connection health.
    expect(screen.queryByTestId("build-sha-chip")).not.toBeInTheDocument();
  });
});

// Issue #36: ``Skip setup (dev only)`` is gated on God Mode so first-time
// creators see only the two real CTAs ("Send reply" and "Looks ready").
describe("SetupView Skip-setup gating (issue #36)", () => {
  const baseSnapshot: SessionSnapshot = {
    id: "sess-1",
    state: "SETUP",
    scenario_prompt: "ransomware drill",
    plan: null,
    roles: [],
    current_turn: null,
    messages: [],
    setup_notes: null,
    cost: null,
    aar_status: null,
  };
  const baseProps = {
    snapshot: baseSnapshot,
    setupReply: "",
    setSetupReply: vi.fn(),
    onSubmit: vi.fn(),
    onLooksReady: vi.fn(),
    onApprovePlan: vi.fn(),
    onSkipSetup: vi.fn(),
    onPickOption: vi.fn(),
    busy: false,
    busyMessage: null,
  };

  it("hides Skip setup (dev only) when God Mode is off", () => {
    render(<SetupView {...baseProps} godMode={false} />);
    expect(
      screen.queryByRole("button", { name: /Skip setup \(dev only\)/i }),
    ).not.toBeInTheDocument();
    // Real CTAs still render.
    expect(screen.getByRole("button", { name: /Send reply/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Looks ready — propose the plan/i }),
    ).toBeInTheDocument();
  });

  it("shows Skip setup (dev only) when God Mode is on", () => {
    const onSkipSetup = vi.fn();
    render(<SetupView {...baseProps} godMode={true} onSkipSetup={onSkipSetup} />);
    const skip = screen.getByRole("button", { name: /Skip setup \(dev only\)/i });
    expect(skip).toBeInTheDocument();
    fireEvent.click(skip);
    expect(onSkipSetup).toHaveBeenCalledTimes(1);
  });
});

// Issue #36: spoiler toggle is now a stateful checkbox with a stable
// label ("Show injects (facilitator mode)") instead of a button whose
// label flipped between "Switch to participant mode" / "Switch to
// facilitator mode".
describe("PlanView spoiler checkbox (issue #36)", () => {
  const planFixture: ScenarioPlan = {
    title: "Ransomware drill",
    executive_summary: "Tabletop for an IR exercise.",
    key_objectives: ["Restore service"],
    narrative_arc: [
      { beat: 1, label: "Initial detection", expected_actors: ["IR Lead"] },
      { beat: 2, label: "Containment", expected_actors: ["IR Lead", "Comms"] },
    ],
    injects: [
      { trigger: "+5min", type: "media", summary: "Reporter calls for comment" },
    ],
    guardrails: [],
    success_criteria: [],
    out_of_scope: [],
  };

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("renders the stable label regardless of state", () => {
    render(<PlanView plan={planFixture} sessionId="s-1" />);
    // Default: hidden (participant mode).
    expect(screen.getByText(/Show injects \(facilitator mode\)/i)).toBeInTheDocument();
    // Click the checkbox to flip state.
    fireEvent.click(screen.getByTestId("plan-spoiler-checkbox"));
    // Label is unchanged — only the checkbox state flipped.
    expect(screen.getByText(/Show injects \(facilitator mode\)/i)).toBeInTheDocument();
  });

  it("hides narrative-arc / inject content by default and reveals on toggle", () => {
    render(<PlanView plan={planFixture} sessionId="s-1" />);
    // Default: spoiler hidden — the arc beat label and inject summary
    // should NOT be in the DOM.
    expect(screen.queryByText(/Initial detection/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Reporter calls for comment/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Participant mode\./i)).toBeInTheDocument();

    // Toggle the checkbox.
    const checkbox = screen.getByTestId("plan-spoiler-checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);

    // Arc + inject content now visible.
    expect(screen.getByText(/Initial detection/i)).toBeInTheDocument();
    expect(screen.getByText(/Reporter calls for comment/i)).toBeInTheDocument();
  });

  it("persists the reveal preference to localStorage scoped per session", () => {
    render(<PlanView plan={planFixture} sessionId="abc" />);
    fireEvent.click(screen.getByTestId("plan-spoiler-checkbox"));
    expect(window.localStorage.getItem("atf-plan-reveal:abc")).toBe("1");
    fireEvent.click(screen.getByTestId("plan-spoiler-checkbox"));
    expect(window.localStorage.getItem("atf-plan-reveal:abc")).toBe("0");
  });

  it("reads the previously-stored reveal preference on mount", () => {
    window.localStorage.setItem("atf-plan-reveal:abc", "1");
    render(<PlanView plan={planFixture} sessionId="abc" />);
    const checkbox = screen.getByTestId("plan-spoiler-checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(screen.getByText(/Initial detection/i)).toBeInTheDocument();
  });
});
