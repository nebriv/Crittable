import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SetupView } from "../pages/Facilitator";
import type { ScenarioPlan, SessionSnapshot } from "../api/client";

/**
 * Coverage for the plan-panel side-rail refactor (this PR). The user's
 * complaint was that the AI-proposed plan rendered *below* the chat
 * reply form, so the Approve button sat in the form's button row
 * instead of next to the artifact it commits. The fix: 2-column
 * layout at xl+, plan in an aside on the right with its own Approve
 * button at the bottom.
 *
 * These tests guard the two structural branches (no-plan, with-plan)
 * and the load-bearing copy / aria-label / placeholder details. They
 * don't exercise sticky-positioning behaviour (jsdom has no layout)
 * — that piece is covered by manual smoke at xl viewports per the
 * CLAUDE.md "for UI changes, drive the dev server in a browser" rule.
 */

function fakeSnapshot(plan: ScenarioPlan | null): SessionSnapshot {
  return {
    id: "session_test",
    state: plan ? "SETUP" : "SETUP",
    created_at: "2026-05-05T00:00:00Z",
    scenario_prompt: "test scenario",
    plan,
    roles: [],
    current_turn: null,
    messages: [],
    setup_notes: [
      {
        ts: "2026-05-05T00:00:01Z",
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
    title: "Operation Chalk Dust",
    executive_summary: "A ransomware exercise in a K-12 environment.",
    key_objectives: ["Identify patient zero by beat 3"],
    guardrails: ["No real exploit code"],
    success_criteria: ["Containment decision documented"],
    out_of_scope: ["Insurance specifics"],
    narrative_arc: [{ beat: 1, label: "Detection", expected_actors: ["IR Lead"] }],
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
  };
}

describe("SetupView — no plan branch", () => {
  it("renders single-column conversation with LOOKS READY and no plan aside", () => {
    render(<SetupView snapshot={fakeSnapshot(null)} {...baseProps()} />);

    // No aside is rendered when hasPlan is false.
    expect(
      screen.queryByRole("complementary", { name: /Proposed plan/i }),
    ).not.toBeInTheDocument();

    // LOOKS READY button is visible (the nudge to draft the plan).
    expect(
      screen.getByRole("button", { name: /LOOKS READY — PROPOSE THE PLAN/i }),
    ).toBeInTheDocument();

    // APPROVE & START LOBBY is NOT in the form (it lives only in the
    // panel which doesn't exist yet).
    expect(
      screen.queryByRole("button", { name: /APPROVE & START LOBBY/i }),
    ).not.toBeInTheDocument();
  });

  it("uses neutral helper copy that doesn't reference the absent panel", () => {
    render(<SetupView snapshot={fakeSnapshot(null)} {...baseProps()} />);
    // Pre-plan copy: the helper paragraph emphasises the LOOKS READY
    // action via an <em> tag (matching the conditional branch in
    // SetupView). This selector pins it to the paragraph copy, not
    // the button label, which would also match the regex.
    expect(
      screen.getByText(/Looks ready — propose the plan/i, { selector: "em" }),
    ).toBeInTheDocument();
    // Must NOT mention the panel that doesn't exist yet.
    expect(screen.queryByText(/proposed-plan panel/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/on the right/i)).not.toBeInTheDocument();
  });

  it("uses the default placeholder on the reply textarea", () => {
    render(<SetupView snapshot={fakeSnapshot(null)} {...baseProps()} />);
    expect(
      screen.getByPlaceholderText(/Type your reply to the AI/i),
    ).toBeInTheDocument();
  });
});

describe("SetupView — with-plan branch", () => {
  it("renders the plan inside an aside labelled 'Proposed plan'", () => {
    render(<SetupView snapshot={fakeSnapshot(fakePlan())} {...baseProps()} />);
    const aside = screen.getByRole("complementary", { name: /Proposed plan/i });
    expect(aside).toBeInTheDocument();
    // Plan title appears in the panel header (not just buried inside
    // PlanView's body) so the operator keeps context after scrolling.
    expect(
      within(aside).getByText(/PROPOSED PLAN — Operation Chalk Dust/i),
    ).toBeInTheDocument();
  });

  it("places APPROVE & START LOBBY inside the panel, not in the form", () => {
    render(<SetupView snapshot={fakeSnapshot(fakePlan())} {...baseProps()} />);
    const aside = screen.getByRole("complementary", { name: /Proposed plan/i });
    const approve = within(aside).getByRole("button", {
      name: /APPROVE & START LOBBY/i,
    });
    expect(approve).toBeInTheDocument();

    // It must NOT also appear in the conversation form (no duplicate).
    const allApproves = screen.getAllByRole("button", {
      name: /APPROVE & START LOBBY/i,
    });
    expect(allApproves).toHaveLength(1);
  });

  it("hides LOOKS READY once a plan exists (Approve is the next step)", () => {
    render(<SetupView snapshot={fakeSnapshot(fakePlan())} {...baseProps()} />);
    expect(
      screen.queryByRole("button", { name: /LOOKS READY — PROPOSE THE PLAN/i }),
    ).not.toBeInTheDocument();
  });

  it("invokes onApprovePlan when the panel's Approve button is clicked", () => {
    const props = baseProps();
    render(<SetupView snapshot={fakeSnapshot(fakePlan())} {...props} />);
    const aside = screen.getByRole("complementary", { name: /Proposed plan/i });
    fireEvent.click(
      within(aside).getByRole("button", { name: /APPROVE & START LOBBY/i }),
    );
    expect(props.onApprovePlan).toHaveBeenCalledOnce();
  });

  it("uses revision-oriented placeholder + helper copy that aligns with the panel button", () => {
    render(<SetupView snapshot={fakeSnapshot(fakePlan())} {...baseProps()} />);
    expect(
      screen.getByPlaceholderText(/Want changes\? Tell the AI what to revise/i),
    ).toBeInTheDocument();
    // Helper copy must use the actual button label ("Approve & start
    // lobby") so a first-time creator scanning for the action finds
    // the matching button immediately. The pre-fix copy said
    // "Approve plan" which mismatched the rendered label.
    expect(
      screen.getByText(/Approve & start lobby/i, { selector: "em" }),
    ).toBeInTheDocument();
  });

  it("disables Approve while busy", () => {
    render(
      <SetupView snapshot={fakeSnapshot(fakePlan())} {...baseProps()} busy />,
    );
    const aside = screen.getByRole("complementary", { name: /Proposed plan/i });
    const approve = within(aside).getByRole("button", {
      name: /APPROVE & START LOBBY/i,
    });
    expect(approve).toBeDisabled();
  });
});
