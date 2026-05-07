import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupWizard, type SetupParts } from "../components/setup/SetupWizard";
import {
  DEFAULT_SESSION_FEATURES,
  type ScenarioPlan,
  type SessionSnapshot,
} from "../api/client";

/**
 * Unit-level coverage for the wizard's phase routing — fixes the
 * "QA HIGH: no integration test for the new setup/ready branch"
 * finding from PR review on issue #113. The Facilitator owns all
 * the stateful machinery (snapshot, ws, presence); the wizard
 * itself is presentational + a local introStep state. Testing the
 * wizard directly with mocked snapshots covers the load-bearing
 * step 4↔5↔6 routing without needing to mock the full api/ws
 * surface.
 */

const EMPTY_PARTS: SetupParts = {
  scenario: "",
  team: "",
  environment: "",
  constraints: "",
};

function fakeSnapshot(overrides: {
  state: string;
  plan?: ScenarioPlan | null;
  playerCount?: number;
}): SessionSnapshot {
  return {
    id: "session_test",
    state: overrides.state,
    created_at: "2026-05-05T00:00:00Z",
    scenario_prompt: "test scenario",
    plan_title: overrides.plan?.title ?? null,
    plan_summary: overrides.plan?.executive_summary ?? null,
    settings: {
      difficulty: "standard",
      duration_minutes: 60,
      features: { ...DEFAULT_SESSION_FEATURES },
    },
    plan: overrides.plan ?? null,
    roles: [],
    current_turn: null,
    messages: [],
    setup_notes: [],
    cost: null,
    workstreams: [],
  };
}

function fakePlan(): ScenarioPlan {
  return {
    title: "Test plan",
    executive_summary: "summary",
    key_objectives: ["obj 1"],
    guardrails: [],
    success_criteria: [],
    out_of_scope: [],
    narrative_arc: [],
    injects: [{ trigger: "T+10", type: "info", summary: "ping" }],
  };
}

function baseProps() {
  return {
    setupParts: { ...EMPTY_PARTS },
    setSetupParts: vi.fn(),
    creatorLabel: "CISO",
    setCreatorLabel: vi.fn(),
    creatorDisplayName: "Alice",
    setCreatorDisplayName: vi.fn(),
    setupRoleSlots: [
      {
        key: "IC",
        code: "IC",
        label: "Incident Commander",
        description: "Owns the response.",
        active: true,
        builtin: true,
      },
    ],
    setSetupRoleSlots: vi.fn(),
    setupRoleDraft: "",
    setSetupRoleDraft: vi.fn(),
    devMode: false,
    setDevMode: vi.fn(),
    busy: false,
    busyMessage: null,
    error: null,
    onSubmit: vi.fn((e) => e.preventDefault()),
    difficulty: "standard" as const,
    setDifficulty: vi.fn(),
    durationMinutes: 60,
    setDurationMinutes: vi.fn(),
    features: { ...DEFAULT_SESSION_FEATURES },
    setFeatures: vi.fn(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SetupWizard — phase routing (issue #113)", () => {
  it("intro: highlights step 01 and renders the intro form", () => {
    render(<SetupWizard phase="intro" {...baseProps()} />);
    // Rail + main panel should both reflect Step 1 (Scenario).
    expect(screen.getByText("01")).toBeInTheDocument();
    expect(screen.getByText("Scenario")).toBeInTheDocument();
    expect(screen.getByText(/Set the scene/i)).toBeInTheDocument();
  });

  it("setup: highlights step 04 (Injects & schedule) and renders the slot content", () => {
    render(
      <SetupWizard
        phase="setup"
        {...baseProps()}
        snapshot={fakeSnapshot({ state: "SETUP" })}
        playerCount={1}
        postCreationContent={<div data-testid="setup-slot">setup-slot</div>}
      />,
    );
    // Eyebrow lower-cased in PostCreationBody — match insensitively.
    expect(
      screen.getByText(/step 04 · injects & schedule/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/AI is drafting the plan/i)).toBeInTheDocument();
    expect(screen.getByTestId("setup-slot")).toBeInTheDocument();
  });

  it("ready + no plan: highlights step 05 (Invite players)", () => {
    render(
      <SetupWizard
        phase="ready"
        {...baseProps()}
        snapshot={fakeSnapshot({ state: "READY", plan: null })}
        playerCount={3}
        postCreationContent={<div data-testid="lobby-slot">lobby</div>}
      />,
    );
    expect(screen.getByText(/step 05 · invite players/i)).toBeInTheDocument();
    expect(screen.getByTestId("lobby-slot")).toBeInTheDocument();
  });

  it("ready + plan but <2 players: still step 05 (gate not met)", () => {
    render(
      <SetupWizard
        phase="ready"
        {...baseProps()}
        snapshot={fakeSnapshot({ state: "READY", plan: fakePlan() })}
        playerCount={1}
        postCreationContent={<div data-testid="lobby-slot">lobby</div>}
      />,
    );
    expect(screen.getByText(/step 05 · invite players/i)).toBeInTheDocument();
    expect(screen.queryByText(/step 06/i)).not.toBeInTheDocument();
  });

  it("ready + plan + ≥2 players (default): lands on step 05 — review only via explicit advance", () => {
    // After plan finalisation we land on step 5 (Invite players) so
    // the creator can share join links and confirm the lobby BEFORE
    // reviewing. Step 6 is only reached when ``advancedToReview`` is
    // explicitly true (rail click on step 6, or the lobby's "REVIEW
    // & LAUNCH" affordance).
    render(
      <SetupWizard
        phase="ready"
        {...baseProps()}
        snapshot={fakeSnapshot({ state: "READY", plan: fakePlan() })}
        playerCount={2}
        postCreationContent={<div data-testid="lobby-slot">lobby</div>}
      />,
    );
    expect(screen.getByText(/step 05 · invite players/i)).toBeInTheDocument();
    expect(screen.queryByText(/step 06 · review/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("lobby-slot")).toBeInTheDocument();
  });

  it("ready + plan + ≥2 players + advancedToReview=true: highlights step 06 (Review & launch)", () => {
    render(
      <SetupWizard
        phase="ready"
        {...baseProps()}
        snapshot={fakeSnapshot({ state: "READY", plan: fakePlan() })}
        playerCount={2}
        advancedToReview={true}
        setAdvancedToReview={vi.fn()}
        postCreationContent={<div data-testid="review-slot">review</div>}
      />,
    );
    expect(screen.getByText(/step 06 · review & launch/i)).toBeInTheDocument();
    expect(screen.getByTestId("review-slot")).toBeInTheDocument();
  });
});

describe("SetupWizard — rail back-nav (User HIGH#2)", () => {
  it("intro: completed steps are clickable buttons that jump back", () => {
    render(<SetupWizard phase="intro" {...baseProps()} />);
    // Advance to step 2 then step 3 by clicking NEXT.
    fireEvent.click(
      screen.getByRole("button", { name: /NEXT · ENVIRONMENT/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /NEXT · ROLES/i }));
    // Now on Step 3. Step 1 should be a button (completed → clickable).
    const step1 = screen.getByRole("button", { name: /Step 1: Scenario/i });
    expect(step1).toBeInTheDocument();
    fireEvent.click(step1);
    // After clicking Step 1, the body should re-render Step 1's
    // "Set the scene" header.
    expect(screen.getByText(/Set the scene/i)).toBeInTheDocument();
  });

  it("setup phase: rail steps are NOT clickable (AI is mid-draft, no rewind path)", () => {
    render(
      <SetupWizard
        phase="setup"
        {...baseProps()}
        snapshot={fakeSnapshot({ state: "SETUP" })}
        playerCount={1}
        postCreationContent={null}
      />,
    );
    // Step 1 / 2 / 3 are all "done" but rendered as inert <div>s,
    // not buttons, since the AI is drafting in step 4 and there's
    // no backwards transition path. Form-state steps remain frozen
    // at session creation.
    expect(
      screen.queryByRole("button", { name: /Step 1: Scenario/i }),
    ).not.toBeInTheDocument();
  });
});

describe("SetupWizard — lobby ↔ review nav (advancedToReview flag)", () => {
  it("ready + advancedToReview=false (default): pins step 5 even when launch gates are met", () => {
    // Plan finalized + 3 player roles. After plan finalisation the
    // wizard lands on step 5 by default so the creator can share
    // invite links before reviewing — they advance to step 6
    // explicitly via the rail or the lobby's "REVIEW & LAUNCH"
    // affordance.
    render(
      <SetupWizard
        phase="ready"
        {...baseProps()}
        snapshot={fakeSnapshot({ state: "READY", plan: fakePlan() })}
        playerCount={3}
        advancedToReview={false}
        setAdvancedToReview={vi.fn()}
        postCreationContent={<div data-testid="lobby-slot">lobby</div>}
      />,
    );
    expect(screen.getByText(/step 05 · invite players/i)).toBeInTheDocument();
    expect(screen.getByTestId("lobby-slot")).toBeInTheDocument();
  });

  it("ready + advancedToReview=true: rail shows step 6 (Review & launch)", () => {
    render(
      <SetupWizard
        phase="ready"
        {...baseProps()}
        snapshot={fakeSnapshot({ state: "READY", plan: fakePlan() })}
        playerCount={2}
        advancedToReview={true}
        setAdvancedToReview={vi.fn()}
        postCreationContent={<div data-testid="review-slot">review</div>}
      />,
    );
    expect(screen.getByText(/step 06 · review & launch/i)).toBeInTheDocument();
    expect(screen.getByTestId("review-slot")).toBeInTheDocument();
  });

  it("ready (current=5, advancedToReview=false): clicking step 6 advances when gates are met", () => {
    const setAdvancedToReview = vi.fn();
    render(
      <SetupWizard
        phase="ready"
        {...baseProps()}
        snapshot={fakeSnapshot({ state: "READY", plan: fakePlan() })}
        playerCount={2}
        advancedToReview={false}
        setAdvancedToReview={setAdvancedToReview}
        postCreationContent={<div data-testid="lobby-slot">lobby</div>}
      />,
    );
    const step6 = screen.getByRole("button", {
      name: /Step 6: Review & launch/i,
    });
    fireEvent.click(step6);
    expect(setAdvancedToReview).toHaveBeenCalledWith(true);
  });

  it("ready (current=6, advancedToReview=true): clicking step 5 hops back to lobby", () => {
    const setAdvancedToReview = vi.fn();
    render(
      <SetupWizard
        phase="ready"
        {...baseProps()}
        snapshot={fakeSnapshot({ state: "READY", plan: fakePlan() })}
        playerCount={2}
        advancedToReview={true}
        setAdvancedToReview={setAdvancedToReview}
        postCreationContent={<div data-testid="review-slot">review</div>}
      />,
    );
    const step5 = screen.getByRole("button", {
      name: /Step 5: Invite players/i,
    });
    fireEvent.click(step5);
    expect(setAdvancedToReview).toHaveBeenCalledWith(false);
  });

  it("ready (no setAdvancedToReview wired): rail steps are NOT clickable", () => {
    // When the parent forgets to plumb ``setAdvancedToReview``, the
    // rail's onJumpToStep is undefined and the rail renders the
    // inert <div> branch — no dead-affordance clicks in Storybook
    // / isolated tests.
    render(
      <SetupWizard
        phase="ready"
        {...baseProps()}
        snapshot={fakeSnapshot({ state: "READY", plan: fakePlan() })}
        playerCount={2}
        // setAdvancedToReview intentionally omitted
        postCreationContent={<div data-testid="lobby-slot">lobby</div>}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Step 5: Invite players/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Step 6: Review & launch/i }),
    ).not.toBeInTheDocument();
  });

  it("ready (gates not met): step 6 is NOT clickable", () => {
    // If the launch gates aren't met (e.g. only 1 player role),
    // step 6 stays inert — clicking it would land the user on a
    // half-rendered review screen they can't actually launch from.
    const setAdvancedToReview = vi.fn();
    render(
      <SetupWizard
        phase="ready"
        {...baseProps()}
        snapshot={fakeSnapshot({ state: "READY", plan: fakePlan() })}
        playerCount={1}
        advancedToReview={false}
        setAdvancedToReview={setAdvancedToReview}
        postCreationContent={<div data-testid="lobby-slot">lobby</div>}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Step 6: Review & launch/i }),
    ).not.toBeInTheDocument();
  });
});

describe("SetupWizard — ABANDON SESSION placement (UI/UX BLOCK#2)", () => {
  it("intro: no ABANDON button (no session to abandon)", () => {
    render(<SetupWizard phase="intro" {...baseProps()} />);
    expect(
      screen.queryByRole("button", { name: /ABANDON SESSION/i }),
    ).not.toBeInTheDocument();
  });

  it("post-creation with handler: ABANDON renders inside the rail (not the panel)", () => {
    const onAbandon = vi.fn();
    render(
      <SetupWizard
        phase="ready"
        {...baseProps()}
        snapshot={fakeSnapshot({ state: "READY", plan: fakePlan() })}
        playerCount={2}
        postCreationContent={null}
        onAbandonSession={onAbandon}
      />,
    );
    const rail = screen.getByRole("complementary", { name: /Setup steps/i });
    const abandon = within(rail).getByRole("button", {
      name: /ABANDON SESSION/i,
    });
    fireEvent.click(abandon);
    expect(onAbandon).toHaveBeenCalledOnce();
  });
});

describe("SetupWizard — error display (UI/UX HIGH#3)", () => {
  it("post-creation: surfaces page-level error inside the panel", () => {
    render(
      <SetupWizard
        phase="ready"
        {...baseProps()}
        error="failed to copy join link"
        snapshot={fakeSnapshot({ state: "READY" })}
        playerCount={1}
        postCreationContent={null}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/failed to copy join link/i);
  });
});
