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
    advanceToRoles();
    const list = getChipList();
    expect(within(list).getByText("IR Lead")).toBeInTheDocument();
    expect(within(list).getByText("Legal")).toBeInTheDocument();
    expect(within(list).getByText("Comms")).toBeInTheDocument();
  });

  it("adds a new role via the Add role button", () => {
    render(<Facilitator />);
    advanceToRoles();
    const draft = screen.getByLabelText("New role label") as HTMLInputElement;
    fireEvent.change(draft, { target: { value: "SOC Analyst" } });
    fireEvent.click(screen.getByRole("button", { name: "Add role" }));
    expect(within(getChipList()).getByText("SOC Analyst")).toBeInTheDocument();
    expect(draft.value).toBe("");
  });

  it("adds a new role via the Enter key without submitting the form", () => {
    const createSpy = vi.spyOn(api, "createSession");
    render(<Facilitator />);
    advanceToRoles();
    const draft = screen.getByLabelText("New role label") as HTMLInputElement;
    fireEvent.change(draft, { target: { value: "Threat Intel" } });
    fireEvent.keyDown(draft, { key: "Enter" });
    expect(within(getChipList()).getByText("Threat Intel")).toBeInTheDocument();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("rejects duplicates case-insensitively without altering the chip list", () => {
    render(<Facilitator />);
    advanceToRoles();
    const draft = screen.getByLabelText("New role label") as HTMLInputElement;
    fireEvent.change(draft, { target: { value: "legal" } });
    fireEvent.click(screen.getByRole("button", { name: "Add role" }));
    expect(within(getChipList()).getAllByText(/legal/i)).toHaveLength(1);
    expect(draft.value).toBe("");
  });

  it("ignores blank / whitespace-only role labels", () => {
    render(<Facilitator />);
    advanceToRoles();
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
    advanceToRoles();
    fireEvent.click(screen.getByLabelText("Remove Legal"));
    const list = getChipList();
    expect(within(list).queryByText("Legal")).not.toBeInTheDocument();
    expect(within(list).getByText("IR Lead")).toBeInTheDocument();
  });

  it("Clear all empties the chip list and shows the empty state", () => {
    render(<Facilitator />);
    advanceToRoles();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    const fieldset = screen.getByRole("group", { name: /Roles to invite/i });
    expect(within(fieldset).queryByRole("list")).not.toBeInTheDocument();
    expect(
      within(fieldset).getByText(/No invitee roles yet/i),
    ).toBeInTheDocument();
  });

  it("Reset to defaults restores IR Lead/Legal/Comms after clearing", () => {
    render(<Facilitator />);
    advanceToRoles();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    const list = getChipList();
    expect(within(list).getByText("IR Lead")).toBeInTheDocument();
    expect(within(list).getByText("Legal")).toBeInTheDocument();
    expect(within(list).getByText("Comms")).toBeInTheDocument();
  });

  it("warns when the creator label collides with an invitee chip", () => {
    render(<Facilitator />);
    // Creator role lives on step 1; collision warning shows on step 3.
    // Pre-fill the label, then advance to roles.
    const labelInput = screen.getByPlaceholderText(
      /Your role label/i,
    ) as HTMLInputElement;
    fireEvent.change(labelInput, { target: { value: "IR Lead" } });
    advanceToRoles();
    expect(
      screen.getByText(/won't be auto-added as a separate invitee/i),
    ).toBeInTheDocument();
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
