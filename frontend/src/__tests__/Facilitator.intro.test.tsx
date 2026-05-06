import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Facilitator, TopBar } from "../pages/Facilitator";
import { BottomActionBar } from "../components/brand/BottomActionBar";
import { api } from "../api/client";

// Setup wizard splits the form across 3 steps (Scenario → Environment
// → Roles). Roles live on step 3, so every Roles assertion needs the
// wizard advanced two NEXT clicks. ``advanceToRoles`` runs the
// navigation; the creator-label-collision test sets the label on
// step 1 first, then advances.
function advanceToRoles() {
  fireEvent.click(
    screen.getByRole("button", { name: /NEXT · ENVIRONMENT/i }),
  );
  fireEvent.click(screen.getByRole("button", { name: /NEXT · ROLES/i }));
}

function getRolesFieldset(): HTMLElement {
  return screen.getByRole("group", { name: /Roles to invite/i });
}

describe("Facilitator intro — Roles step (issue #61, redesign)", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("seeds the 5 mockup-defined builtin role slots", () => {
    render(<Facilitator />);
    advanceToRoles();
    const fs = getRolesFieldset();
    // All 5 builtin labels must render as rows regardless of toggle state.
    expect(within(fs).getByText("Incident Commander")).toBeInTheDocument();
    expect(within(fs).getByText("Cybersecurity Manager")).toBeInTheDocument();
    expect(within(fs).getByText("Cybersecurity Engineer")).toBeInTheDocument();
    expect(within(fs).getByText("Comms / Legal")).toBeInTheDocument();
    expect(within(fs).getByText("Executive Sponsor")).toBeInTheDocument();
  });

  it("first 3 builtin roles default to ACTIVE; COM/EXE default to OFF", () => {
    render(<Facilitator />);
    advanceToRoles();
    // ACTIVE pill on a default-active row is pressed; OFF pill on a
    // default-off row is pressed. Tests the binary state directly.
    const icActive = screen.getByRole("button", {
      name: /Incident Commander active/i,
    });
    expect(icActive).toHaveAttribute("aria-pressed", "true");
    const exeOff = screen.getByRole("button", {
      name: /Executive Sponsor off/i,
    });
    expect(exeOff).toHaveAttribute("aria-pressed", "true");
  });

  it("toggling OFF on an active builtin row flips the pill state", () => {
    render(<Facilitator />);
    advanceToRoles();
    const offBtn = screen.getByRole("button", {
      name: /Incident Commander off/i,
    });
    fireEvent.click(offBtn);
    expect(offBtn).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: /Incident Commander active/i }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("adds a custom role row via the Add role button", () => {
    render(<Facilitator />);
    advanceToRoles();
    const draft = screen.getByLabelText("New role label") as HTMLInputElement;
    fireEvent.change(draft, { target: { value: "Threat Intel" } });
    fireEvent.click(screen.getByRole("button", { name: "Add role" }));
    expect(
      within(getRolesFieldset()).getByText("Threat Intel"),
    ).toBeInTheDocument();
    expect(draft.value).toBe("");
  });

  it("adds via Enter without submitting the form", () => {
    const createSpy = vi.spyOn(api, "createSession");
    render(<Facilitator />);
    advanceToRoles();
    const draft = screen.getByLabelText("New role label") as HTMLInputElement;
    fireEvent.change(draft, { target: { value: "Threat Intel" } });
    fireEvent.keyDown(draft, { key: "Enter" });
    expect(
      within(getRolesFieldset()).getByText("Threat Intel"),
    ).toBeInTheDocument();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("typing an existing label re-activates the existing slot instead of duplicating", () => {
    render(<Facilitator />);
    advanceToRoles();
    // Toggle OFF, then add the same label via the form — should flip
    // back to ACTIVE on the same row, no duplicate row.
    fireEvent.click(
      screen.getByRole("button", { name: /Incident Commander off/i }),
    );
    const draft = screen.getByLabelText("New role label") as HTMLInputElement;
    fireEvent.change(draft, { target: { value: "incident commander" } });
    fireEvent.click(screen.getByRole("button", { name: "Add role" }));
    expect(
      within(getRolesFieldset()).getAllByText(/Incident Commander/i),
    ).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: /Incident Commander active/i }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("ignores blank / whitespace-only role labels", () => {
    render(<Facilitator />);
    advanceToRoles();
    const draft = screen.getByLabelText("New role label") as HTMLInputElement;
    const addButton = screen.getByRole("button", { name: "Add role" });
    expect(addButton).toBeDisabled();
    fireEvent.change(draft, { target: { value: "   " } });
    fireEvent.keyDown(draft, { key: "Enter" });
    // Still only the 5 builtin rows.
    expect(
      within(getRolesFieldset()).queryByText(/^\s+$/),
    ).not.toBeInTheDocument();
  });

  it("removes a custom row via the × button (builtin rows have no remove)", () => {
    render(<Facilitator />);
    advanceToRoles();
    const draft = screen.getByLabelText("New role label") as HTMLInputElement;
    fireEvent.change(draft, { target: { value: "Threat Intel" } });
    fireEvent.click(screen.getByRole("button", { name: "Add role" }));
    fireEvent.click(screen.getByLabelText("Remove Threat Intel"));
    expect(
      within(getRolesFieldset()).queryByText("Threat Intel"),
    ).not.toBeInTheDocument();
    // Builtin rows are not removable: no Remove control for them.
    expect(
      screen.queryByLabelText("Remove Incident Commander"),
    ).not.toBeInTheDocument();
  });

  it("warns when the creator label collides with an active invitee row", () => {
    render(<Facilitator />);
    advanceToRoles();
    const labelInput = screen.getByPlaceholderText(
      /Your role label/i,
    ) as HTMLInputElement;
    // Incident Commander is ACTIVE by default — collide with it.
    fireEvent.change(labelInput, { target: { value: "Incident Commander" } });
    expect(
      screen.getByText(/won't be auto-added as a separate invitee/i),
    ).toBeInTheDocument();
  });

  it("collision warning clears when the colliding row is toggled OFF", () => {
    render(<Facilitator />);
    advanceToRoles();
    const labelInput = screen.getByPlaceholderText(
      /Your role label/i,
    ) as HTMLInputElement;
    fireEvent.change(labelInput, { target: { value: "Incident Commander" } });
    expect(
      screen.getByText(/won't be auto-added as a separate invitee/i),
    ).toBeInTheDocument();
    // Toggle the row OFF — the collision check only flags ACTIVE rows.
    fireEvent.click(
      screen.getByRole("button", { name: /Incident Commander off/i }),
    );
    expect(
      screen.queryByText(/won't be auto-added as a separate invitee/i),
    ).not.toBeInTheDocument();
  });
});

// Post-redesign: most operator telemetry + phase CTAs moved out of
// the top bar (which is now brand chrome) into a sticky bottom action
// bar. The TopBar still renders STATE/PHASE/PLAYERS/AAR-status pills;
// every "Start session", "End session", "View AAR" button + every
// dense telemetry chip (T#, msgs, rationale, tabs, last event, LLM,
// cost, build SHA, God Mode, "+ NEW SESSION") lives in BottomActionBar.
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
  turnIndex: null,
  rationaleCount: 0,
  connectionCount: null,
  lastEventAt: null,
  cost: null,
  messageCount: 0,
  activeTiers: [] as string[],
  // Issue #70: multi-state LLM chip needs ai_paused + recoveryStatus + turnErrored.
  aiPaused: false,
  recoveryStatus: null as { kind: string; attempt?: number; budget?: number } | null,
  turnErrored: false,
  buildSha: "abcdef0",
  buildTs: "2026-05-01T00:00:00Z",
};

describe("BottomActionBar — phase CTAs (issue #62)", () => {
  it("renders START SESSION disabled when plan not finalized", () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="setup"
        playerCount={3}
        hasFinalizedPlan={false}
        aarStatus={null}
      />,
    );
    const btn = screen.getByRole("button", { name: /START SESSION/i });
    expect(btn).toBeDisabled();
  });

  it("renders START SESSION disabled when fewer than 2 players", () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="ready"
        playerCount={1}
        hasFinalizedPlan={true}
        aarStatus={null}
      />,
    );
    expect(
      screen.getByRole("button", { name: /START SESSION/i }),
    ).toBeDisabled();
  });

  it("enables START SESSION when plan finalized and ≥2 players", () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="ready"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
      />,
    );
    const btn = screen.getByRole("button", { name: /START SESSION/i });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(baseProps.onStart).toHaveBeenCalled();
  });

  it("renders FORCE-ADVANCE + END SESSION buttons during play", () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="play"
        playerCount={3}
        hasFinalizedPlan={true}
        aarStatus={null}
      />,
    );
    expect(
      screen.getByRole("button", { name: /FORCE-ADVANCE/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /END SESSION/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /START SESSION/i }),
    ).not.toBeInTheDocument();
  });

  it("renders VIEW AAR when ended phase + AAR ready", () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="ended"
        playerCount={3}
        hasFinalizedPlan={true}
        aarStatus="ready"
      />,
    );
    expect(
      screen.getByRole("button", { name: /VIEW AAR/i }),
    ).toBeInTheDocument();
  });

  it("surfaces turn / message / rationale / tabs / cost telemetry chips", () => {
    render(
      <BottomActionBar
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
      <BottomActionBar
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
    expect(screen.getByText(/Last: —/)).toBeInTheDocument();
  });

  it("renders 'Last: <Ns' once a lastEventAt timestamp is set", () => {
    const fiveSecondsAgo = Date.now() - 5_500;
    render(
      <BottomActionBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
        lastEventAt={fiveSecondsAgo}
      />,
    );
    expect(screen.getByText(/Last: 5s/)).toBeInTheDocument();
  });

  it("renders 'LLM: idle' when no LLM calls are in flight", () => {
    render(
      <BottomActionBar
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
      <BottomActionBar
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
      <BottomActionBar
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

  // Issue #70: multi-state LLM chip — distinguish recovering / paused
  // / waiting-for-players / recovery-failed from the legacy binary
  // "thinking-or-idle" chip. Each branch is the cure for an
  // operationally-distinct state that used to read as "LLM: idle"
  // and was the diagnostic gap behind the silent-yield 5-hour log
  // dive.
  it("renders 'LLM: idle (paused)' when the AI is paused with no calls in flight", () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
        aiPaused={true}
      />,
    );
    expect(screen.getByText("LLM: idle (paused)")).toBeInTheDocument();
  });

  it("renders 'LLM: waiting for players' on AWAITING_PLAYERS with no calls in flight", () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
        backendState="AWAITING_PLAYERS"
      />,
    );
    expect(
      screen.getByText("LLM: waiting for players"),
    ).toBeInTheDocument();
  });

  it("renders 'LLM: recovering N/M (kind)' during a recovery cascade", () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
        recoveryStatus={{
          kind: "missing_drive",
          attempt: 2,
          budget: 3,
        }}
      />,
    );
    // Check substring rather than full string so "last attempt" cue
    // is verified separately in its own case.
    expect(
      screen.getByText(/LLM: recovering 2\/3.*missing drive/),
    ).toBeInTheDocument();
  });

  it("appends 'last attempt' when recovery hits the budget (UI/UX HIGH #2)", () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
        recoveryStatus={{
          kind: "missing_yield",
          attempt: 3,
          budget: 3,
        }}
      />,
    );
    expect(
      screen.getByText(/LLM: recovering 3\/3 — last attempt/),
    ).toBeInTheDocument();
  });

  it("appends '· paused' to the in-flight chip when paused mid-recovery (User Agent MEDIUM #6)", () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
        aiPaused={true}
        recoveryStatus={{
          kind: "missing_drive",
          attempt: 2,
          budget: 3,
        }}
      />,
    );
    expect(
      screen.getByText(/LLM: recovering 2\/3.*missing drive.*· paused/),
    ).toBeInTheDocument();
  });

  it("renders crit 'LLM: recovery FAILED' when the current turn errored (User Agent HIGH #3)", () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
        turnErrored={true}
      />,
    );
    expect(screen.getByText("LLM: recovery FAILED")).toBeInTheDocument();
    // Even with concurrent recovery + active tiers, the errored
    // signal wins the chip because it's the operator's call to act
    // on. Without this, the silent-yield class of bug stays hidden
    // the moment the strict-retry loop exits.
  });

  it("turnErrored wins over recoveryStatus + activeTiers (priority order)", () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
        turnErrored={true}
        recoveryStatus={{ kind: "missing_yield", attempt: 3, budget: 3 }}
        activeTiers={["play"]}
      />,
    );
    expect(screen.getByText("LLM: recovery FAILED")).toBeInTheDocument();
    expect(screen.queryByText(/recovering/)).not.toBeInTheDocument();
    expect(screen.queryByText("LLM: play")).not.toBeInTheDocument();
  });

  it("expands the cost chip to show the token breakdown", () => {
    render(
      <BottomActionBar
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

  it("always renders '+ NEW SESSION' regardless of phase", () => {
    for (const phase of ["setup", "ready", "play", "ended"] as const) {
      const { unmount } = render(
        <BottomActionBar
          {...baseProps}
          phase={phase}
          playerCount={2}
          hasFinalizedPlan={true}
          aarStatus="ready"
        />,
      );
      expect(
        screen.getByRole("button", { name: /NEW SESSION/i }),
      ).toBeInTheDocument();
      unmount();
    }
  });
});

describe("TopBar — brand chrome (post-redesign)", () => {
  const minimalProps = { ...baseProps };

  it("renders the AAR-generating status when ended phase + AAR pending", () => {
    render(
      <TopBar
        {...minimalProps}
        phase="ended"
        playerCount={3}
        hasFinalizedPlan={true}
        aarStatus="pending"
      />,
    );
    expect(screen.getByText(/AAR GENERATING/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /VIEW AAR/i }),
    ).not.toBeInTheDocument();
  });

  it("renders the VIEW AAR button when ended phase + AAR ready", () => {
    render(
      <TopBar
        {...minimalProps}
        phase="ended"
        playerCount={3}
        hasFinalizedPlan={true}
        aarStatus="ready"
      />,
    );
    expect(
      screen.getByRole("button", { name: /VIEW AAR/i }),
    ).toBeInTheDocument();
  });
});
