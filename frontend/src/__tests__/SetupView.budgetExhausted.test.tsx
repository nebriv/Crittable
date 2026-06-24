import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SetupView } from "../pages/Facilitator";
import {
  DEFAULT_SESSION_FEATURES,
  type ScenarioPlan,
  type SessionSnapshot,
} from "../api/client";

/**
 * Signal 3 — setup-budget-exhausted prompt.
 *
 * When the ``setup/reply`` response reports the setup-turn budget is
 * spent, SetupView surfaces a clear "finalize or skip" prompt while
 * keeping the existing Finalize (Looks ready / Approve) and Skip
 * affordances reachable.
 */

function fakeSnapshot(plan: ScenarioPlan | null): SessionSnapshot {
  return {
    id: "session_test",
    state: "SETUP",
    created_at: "2026-06-24T00:00:00Z",
    scenario_prompt: "test scenario",
    plan_title: plan?.title ?? null,
    plan_summary: plan?.executive_summary ?? null,
    settings: {
      difficulty: "standard",
      duration_minutes: 60,
      features: { ...DEFAULT_SESSION_FEATURES },
    },
    plan,
    roles: [],
    current_turn: null,
    messages: [],
    setup_notes: [
      {
        ts: "2026-06-24T00:00:01Z",
        speaker: "ai",
        content: "What's your industry?",
        topic: null,
        options: null,
      },
    ],
    cost: null,
    workstreams: [],
  };
}

function fakePlan(): ScenarioPlan {
  return {
    title: "Operation Budget Wall",
    executive_summary: "A ransomware exercise.",
    key_objectives: ["Identify patient zero"],
    guardrails: ["No real exploit code"],
    success_criteria: ["Containment documented"],
    out_of_scope: ["Insurance"],
    narrative_arc: [{ beat: 1, label: "Detection", expected_actors: ["IR"] }],
    injects: [{ trigger: "T+10", type: "info", summary: "ping" }],
  };
}

function baseProps() {
  return {
    setupReply: "",
    setSetupReply: vi.fn(),
    onSubmit: vi.fn((e: React.FormEvent) => e.preventDefault()),
    onLooksReady: vi.fn(),
    onApprovePlan: vi.fn(),
    onSkipSetup: vi.fn(),
    onPickOption: vi.fn(),
    busy: false,
    busyMessage: null,
    draftingPlan: false,
  };
}

describe("SetupView — setup budget exhausted prompt", () => {
  it("does NOT render the prompt by default", () => {
    render(<SetupView snapshot={fakeSnapshot(null)} {...baseProps()} />);
    expect(
      screen.queryByTestId("setup-budget-exhausted"),
    ).not.toBeInTheDocument();
  });

  it("renders the prompt when budgetExhausted is true (no plan yet)", () => {
    render(
      <SetupView
        snapshot={fakeSnapshot(null)}
        {...baseProps()}
        budgetExhausted
      />,
    );
    const prompt = screen.getByTestId("setup-budget-exhausted");
    expect(prompt).toBeInTheDocument();
    expect(prompt).toHaveTextContent(/reached the setup limit/i);
    // The two ways out are named: finalize the plan (Looks ready) or skip.
    expect(prompt).toHaveTextContent(/Looks ready/i);
    expect(prompt).toHaveTextContent(/skip setup/i);
  });

  it("keeps the Finalize/Skip affordances reachable (no plan)", () => {
    render(
      <SetupView
        snapshot={fakeSnapshot(null)}
        {...baseProps()}
        budgetExhausted
      />,
    );
    // LOOKS READY (drafts the plan to finalize) + SKIP SETUP are both
    // present and not disabled (busy=false).
    const looksReady = screen.getByRole("button", {
      name: /LOOKS READY — PROPOSE THE PLAN/i,
    });
    expect(looksReady).toBeEnabled();
    const skip = screen.getByRole("button", { name: /SKIP SETUP/i });
    expect(skip).toBeEnabled();
  });

  it("with a plan present, the prompt points to Approve + the Approve button stays reachable", () => {
    render(
      <SetupView
        snapshot={fakeSnapshot(fakePlan())}
        {...baseProps()}
        budgetExhausted
      />,
    );
    const prompt = screen.getByTestId("setup-budget-exhausted");
    expect(prompt).toHaveTextContent(/approve it on the panel/i);
    // The plan-panel Approve button is still reachable.
    expect(
      screen.getByRole("button", { name: /APPROVE & START LOBBY/i }),
    ).toBeInTheDocument();
  });

  it("uses role=status (a state nudge, not an error)", () => {
    render(
      <SetupView
        snapshot={fakeSnapshot(null)}
        {...baseProps()}
        budgetExhausted
      />,
    );
    const prompt = screen.getByTestId("setup-budget-exhausted");
    expect(prompt).toHaveAttribute("role", "status");
  });
});
