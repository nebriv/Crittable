import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SetupLobbyView } from "../components/setup/SetupLobbyView";
import type { ScenarioPlan, RoleView } from "../api/client";

/**
 * Lock the lobby-side launch / advance CTAs added in May 2026.
 *
 * Pre-fix the wizard auto-advanced to step 6 (Review) the moment the
 * plan was finalised, bypassing the lobby entirely. The fix lands
 * the creator on step 5 (Invite players) by default, so the lobby
 * itself owns the primary launch CTA — and a secondary "REVIEW &
 * LAUNCH →" affordance is exposed for creators who want a
 * presence-aware confirmation screen.
 *
 * Both CTAs are gated on the launch readiness criteria (plan
 * finalised + ≥ 2 player roles) AND on the parent wiring the
 * corresponding handler — so an unmet gate hides the button
 * entirely (sidecar status copy explains why).
 */

function role(overrides: Partial<RoleView>): RoleView {
  return {
    id: overrides.id ?? "r-test",
    label: overrides.label ?? "Player",
    display_name: overrides.display_name ?? null,
    kind: overrides.kind ?? "player",
    is_creator: overrides.is_creator ?? false,
    token_version: overrides.token_version ?? 0,
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

const COMMON_PROPS = {
  sessionId: "sess-1",
  creatorToken: "creator-token",
  busy: false,
  connectedRoleIds: new Set<string>(),
  onRoleAdded: vi.fn(),
  onRoleChanged: vi.fn(),
  onError: vi.fn(),
};

describe("SetupLobbyView — CTAs (lobby-as-launch-surface)", () => {
  it("plan + ≥2 players + onLaunchSession wired: START SESSION CTA renders and fires", () => {
    const ciso = role({ id: "r-ciso", label: "CISO", is_creator: true });
    const ic = role({ id: "r-ic", label: "IC" });
    const onLaunch = vi.fn();
    render(
      <SetupLobbyView
        {...COMMON_PROPS}
        roles={[ciso, ic]}
        plan={fakePlan()}
        playerCount={2}
        onLaunchSession={onLaunch}
      />,
    );
    const btn = screen.getByRole("button", { name: /start session/i });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onLaunch).toHaveBeenCalledTimes(1);
  });

  it("no plan: START SESSION CTA suppressed, sidecar status reads 'Plan not finalized'", () => {
    const ciso = role({ id: "r-ciso", label: "CISO", is_creator: true });
    const ic = role({ id: "r-ic", label: "IC" });
    render(
      <SetupLobbyView
        {...COMMON_PROPS}
        roles={[ciso, ic]}
        plan={null}
        playerCount={2}
        onLaunchSession={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /start session/i }),
    ).toBeNull();
    expect(
      screen.getByText(/plan not finalized yet/i),
    ).toBeInTheDocument();
  });

  it("only 1 player role: START SESSION suppressed, sidecar status reads 'Need at least 2'", () => {
    const ciso = role({ id: "r-ciso", label: "CISO", is_creator: true });
    render(
      <SetupLobbyView
        {...COMMON_PROPS}
        roles={[ciso]}
        plan={fakePlan()}
        playerCount={1}
        onLaunchSession={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /start session/i }),
    ).toBeNull();
    expect(
      screen.getByText(/need at least 2 player roles/i),
    ).toBeInTheDocument();
  });

  it("onLaunchSession not wired: START SESSION CTA suppressed even when gates met", () => {
    // Defensive: parent must explicitly opt in by wiring the handler.
    // Pre-fix the wizard auto-advanced to step 6 in this case, so a
    // "gates met but no handler" was unreachable. Now it's possible
    // (e.g. parent forgot to wire) and the CTA stays hidden — the
    // sidecar status copy still explains the state.
    const ciso = role({ id: "r-ciso", label: "CISO", is_creator: true });
    const ic = role({ id: "r-ic", label: "IC" });
    render(
      <SetupLobbyView
        {...COMMON_PROPS}
        roles={[ciso, ic]}
        plan={fakePlan()}
        playerCount={2}
        // onLaunchSession intentionally omitted
      />,
    );
    expect(
      screen.queryByRole("button", { name: /start session/i }),
    ).toBeNull();
  });

  it("plan + ≥2 players + onAdvanceToReview wired: REVIEW & LAUNCH affordance renders and fires", () => {
    // Secondary affordance for creators who want a presence-aware
    // confirmation before launch. Distinct from the rail click (also
    // valid) because the affordance lives in the natural reading
    // path of the sidecar.
    const ciso = role({ id: "r-ciso", label: "CISO", is_creator: true });
    const ic = role({ id: "r-ic", label: "IC" });
    const onAdvance = vi.fn();
    render(
      <SetupLobbyView
        {...COMMON_PROPS}
        roles={[ciso, ic]}
        plan={fakePlan()}
        playerCount={2}
        onLaunchSession={vi.fn()}
        onAdvanceToReview={onAdvance}
      />,
    );
    const btn = screen.getByRole("button", {
      name: /advance to step 6/i,
    });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it("REVIEW & LAUNCH suppressed when launch gates not met", () => {
    const ciso = role({ id: "r-ciso", label: "CISO", is_creator: true });
    render(
      <SetupLobbyView
        {...COMMON_PROPS}
        roles={[ciso]}
        plan={fakePlan()}
        playerCount={1}
        onAdvanceToReview={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /advance to step 6/i }),
    ).toBeNull();
  });

  it("REVIEW & LAUNCH suppressed when handler not wired (parent opt-in)", () => {
    const ciso = role({ id: "r-ciso", label: "CISO", is_creator: true });
    const ic = role({ id: "r-ic", label: "IC" });
    render(
      <SetupLobbyView
        {...COMMON_PROPS}
        roles={[ciso, ic]}
        plan={fakePlan()}
        playerCount={2}
        onLaunchSession={vi.fn()}
        // onAdvanceToReview intentionally omitted
      />,
    );
    expect(
      screen.queryByRole("button", { name: /advance to step 6/i }),
    ).toBeNull();
  });

  it("busy: both CTAs disabled but still rendered (so a dropped network response can't strand the user)", () => {
    const ciso = role({ id: "r-ciso", label: "CISO", is_creator: true });
    const ic = role({ id: "r-ic", label: "IC" });
    render(
      <SetupLobbyView
        {...COMMON_PROPS}
        busy={true}
        roles={[ciso, ic]}
        plan={fakePlan()}
        playerCount={2}
        onLaunchSession={vi.fn()}
        onAdvanceToReview={vi.fn()}
      />,
    );
    const start = screen.getByRole("button", { name: /STARTING…/i });
    expect(start).toBeDisabled();
    const advance = screen.getByRole("button", {
      name: /advance to step 6/i,
    });
    expect(advance).toBeDisabled();
  });

  it("ready-state sidecar copy invites the user to share invite links + launch", () => {
    // Pre-fix the sidecar said "Ready — advance to step 06 to review
    // and launch." Now the lobby IS the launch surface, so the copy
    // points to the action that matters: share invites then launch.
    const ciso = role({ id: "r-ciso", label: "CISO", is_creator: true });
    const ic = role({ id: "r-ic", label: "IC" });
    render(
      <SetupLobbyView
        {...COMMON_PROPS}
        roles={[ciso, ic]}
        plan={fakePlan()}
        playerCount={2}
        onLaunchSession={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/share invite links and launch/i),
    ).toBeInTheDocument();
  });

  // Per docs/PLAN.md line 215 ("the finalized plan is … surfaced to
  // the creator … as a collapsible reference panel"): once the plan
  // is finalized, the lobby has to expose the full content (not just
  // the SidecarStat counts), otherwise an operator who needs to re-
  // read an objective or inject during invite-link sharing has no
  // way back. The wizard rail explicitly blocks step-5 → step-4
  // back-nav (SetupWizard.tsx:259-262, "step 4 is AI work they can't
  // rewind"), so the lobby is the reachable surface for re-read.
  // Implemented as a <details> disclosure so it doesn't dominate the
  // role-list view.
  it("renders a collapsible plan recap on the role-list column when plan exists", () => {
    const ciso = role({ id: "r-ciso", label: "CISO", is_creator: true });
    const ic = role({ id: "r-ic", label: "IC" });
    render(
      <SetupLobbyView
        {...COMMON_PROPS}
        roles={[ciso, ic]}
        plan={fakePlan()}
        playerCount={2}
        onLaunchSession={vi.fn()}
      />,
    );
    const recap = screen.getByTestId("lobby-plan-recap");
    expect(recap).toBeInTheDocument();
    // Plan title shows in the summary so the operator can identify
    // the right section without expanding it.
    expect(recap.textContent).toMatch(/Test plan/i);
    // Default-collapsed: PlanView's body content (e.g. "Key
    // objectives" header) is in the DOM under the <details> but
    // hidden until expanded. We assert it exists, which is what
    // the operator needs (one click to reveal).
    expect(recap.querySelector("h4")).toBeTruthy();
  });

  it("does NOT render the plan recap when plan is null", () => {
    const ciso = role({ id: "r-ciso", label: "CISO", is_creator: true });
    render(
      <SetupLobbyView
        {...COMMON_PROPS}
        roles={[ciso]}
        plan={null}
        playerCount={1}
      />,
    );
    expect(screen.queryByTestId("lobby-plan-recap")).toBeNull();
  });
});
