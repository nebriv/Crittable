import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupWizard, type SetupParts } from "../components/setup/SetupWizard";
import type { ScenarioPlan, SessionSnapshot } from "../api/client";

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

  it("ready + plan + ≥2 players: highlights step 06 (Review & launch)", () => {
    render(
      <SetupWizard
        phase="ready"
        {...baseProps()}
        snapshot={fakeSnapshot({ state: "READY", plan: fakePlan() })}
        playerCount={2}
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

describe("SetupWizard — lobby ↔ review back-nav (presence-aware launch)", () => {
  it("ready + lobbyOverride=true: pins step 5 even when launch gates are met", () => {
    // Plan finalized + 3 player roles → step 6 normally. Setting
    // lobbyOverride=true must drop the user back to step 5 so they
    // can manage the lobby (e.g. share an invite link with a missing
    // role) without abandoning the launch screen.
    render(
      <SetupWizard
        phase="ready"
        {...baseProps()}
        snapshot={fakeSnapshot({ state: "READY", plan: fakePlan() })}
        playerCount={3}
        lobbyOverride={true}
        setLobbyOverride={vi.fn()}
        postCreationContent={<div data-testid="lobby-slot">lobby</div>}
      />,
    );
    expect(screen.getByText(/step 05 · invite players/i)).toBeInTheDocument();
    expect(screen.getByTestId("lobby-slot")).toBeInTheDocument();
  });

  it("ready: clicking step 5 in the rail sets the lobby override", () => {
    const setLobbyOverride = vi.fn();
    render(
      <SetupWizard
        phase="ready"
        {...baseProps()}
        snapshot={fakeSnapshot({ state: "READY", plan: fakePlan() })}
        playerCount={2}
        lobbyOverride={false}
        setLobbyOverride={setLobbyOverride}
        postCreationContent={<div data-testid="review-slot">review</div>}
      />,
    );
    // Step 5 is in the "done" set when launch gates are met, so the
    // rail renders it as a button.
    const step5 = screen.getByRole("button", {
      name: /Step 5: Invite players/i,
    });
    fireEvent.click(step5);
    expect(setLobbyOverride).toHaveBeenCalledWith(true);
  });

  it("ready (override on): clicking step 6 in the rail clears the override", () => {
    const setLobbyOverride = vi.fn();
    render(
      <SetupWizard
        phase="ready"
        {...baseProps()}
        snapshot={fakeSnapshot({ state: "READY", plan: fakePlan() })}
        playerCount={2}
        lobbyOverride={true}
        setLobbyOverride={setLobbyOverride}
        postCreationContent={<div data-testid="lobby-slot">lobby</div>}
      />,
    );
    const step6 = screen.getByRole("button", {
      name: /Step 6: Review & launch/i,
    });
    fireEvent.click(step6);
    expect(setLobbyOverride).toHaveBeenCalledWith(false);
  });

  it("ready (override off, current=5, gates not met): clicking step 5 is a no-op", () => {
    // Copilot review on PR #187: clicking the *current* step rail
    // item used to fire ``setLobbyOverride(true)`` even when launch
    // gates weren't met yet. That accidentally pinned the wizard to
    // the lobby once gates DID get met and silently suppressed the
    // auto-advance to step 6. The handler now ignores clicks where
    // ``id === current``.
    const setLobbyOverride = vi.fn();
    render(
      <SetupWizard
        phase="ready"
        {...baseProps()}
        snapshot={fakeSnapshot({ state: "READY", plan: null })}
        playerCount={1}
        lobbyOverride={false}
        setLobbyOverride={setLobbyOverride}
        postCreationContent={<div data-testid="lobby-slot">lobby</div>}
      />,
    );
    // Step 5 is current here — it renders as a button (because
    // ``isCurrent`` makes it clickable per WizardRail), but the
    // click handler must short-circuit.
    const step5 = screen.getByRole("button", {
      name: /Step 5: Invite players/i,
    });
    fireEvent.click(step5);
    expect(setLobbyOverride).not.toHaveBeenCalled();
  });

  it("ready (no setLobbyOverride wired): rail steps are NOT clickable", () => {
    // Copilot review on PR #187: when the parent forgets to plumb
    // ``setLobbyOverride``, the rail used to render steps as
    // clickable buttons whose handlers were silent no-ops. Now we
    // skip wiring ``onJumpToStep`` in that case so the rail
    // renders the inert <div> branch — no dead-affordance clicks
    // in Storybook / isolated tests.
    render(
      <SetupWizard
        phase="ready"
        {...baseProps()}
        snapshot={fakeSnapshot({ state: "READY", plan: fakePlan() })}
        playerCount={2}
        lobbyOverride={false}
        // setLobbyOverride intentionally omitted
        postCreationContent={<div data-testid="review-slot">review</div>}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Step 5: Invite players/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Step 6: Review & launch/i }),
    ).not.toBeInTheDocument();
  });

  it("ready (gates not met): step 6 is NOT clickable from the lobby override view", () => {
    // Even with override on, if the launch gates aren't met (e.g. only
    // 1 player role), step 6 stays inert — clicking it would land the
    // user on a half-rendered review screen they can't actually launch
    // from. Step 5 stays current (and ineligible to click → not a
    // button), step 6 stays inert (also not a button).
    const setLobbyOverride = vi.fn();
    render(
      <SetupWizard
        phase="ready"
        {...baseProps()}
        snapshot={fakeSnapshot({ state: "READY", plan: fakePlan() })}
        playerCount={1}
        lobbyOverride={true}
        setLobbyOverride={setLobbyOverride}
        postCreationContent={null}
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
