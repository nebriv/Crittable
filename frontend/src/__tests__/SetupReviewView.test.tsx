import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SetupReviewView } from "../components/setup/SetupReviewView";
import type { ScenarioPlan, RoleView } from "../api/client";

/**
 * Lock the review-screen contract added with the presence-aware AI fix:
 *   1. When some non-creator seats haven't joined, the launch sidecar
 *      shows a warning explaining the AI will treat them as
 *      ``not_joined``. Without the warning the creator pulls the
 *      trigger and is then surprised when the AI never directly
 *      addresses their CISO ("why is the AI ignoring Ben?").
 *   2. The "← BACK TO LOBBY" affordance only renders when the parent
 *      wires ``onBackToLobby`` AND fires the supplied callback on
 *      click. Without this affordance the wizard's auto-advance to
 *      step 6 traps the creator on the launch screen with no way to
 *      hop back to share an invite link.
 *   3. The warning is informational, not a gate — START SESSION
 *      stays clickable even with unjoined seats (covers the solo /
 *      proxy-testing case where the creator launches alone).
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
    title: "Vendor portal ransomware",
    executive_summary: "Vendor leak; lateral movement underway.",
    key_objectives: ["Contain", "Decide notification"],
    guardrails: [],
    success_criteria: [],
    out_of_scope: [],
    narrative_arc: [],
    injects: [
      { trigger: "T+10", type: "info", summary: "Auth log oddity" },
      { trigger: "T+20", type: "critical", summary: "Slack leak" },
    ],
  };
}

describe("SetupReviewView — presence-aware launch warning", () => {
  it("everyone joined: no warning, no extra noise", () => {
    const ciso = role({ id: "r-ciso", label: "CISO", is_creator: true });
    const ic = role({ id: "r-ic", label: "Incident Commander" });
    render(
      <SetupReviewView
        roles={[ciso, ic]}
        plan={fakePlan()}
        playerCount={2}
        connectedRoleIds={new Set(["r-ciso", "r-ic"])}
        busy={false}
        onStart={vi.fn()}
      />,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/hasn['’]t opened the join link/i),
    ).not.toBeInTheDocument();
  });

  it("one invitee unjoined: warning surfaces with not_joined enum + count", () => {
    // Creator joined, 1 unjoined invitee. Warning copy must:
    //   - call out the count (1 of 1 unjoined invitees),
    //   - name the AI-side ``not_joined`` enum so the creator can
    //     correlate the warning with what they'll see in any prompt /
    //     diagnostic dump,
    //   - encourage the creator to either launch + proxy or hop back.
    const ciso = role({ id: "r-ciso", label: "CISO", is_creator: true });
    const ic = role({ id: "r-ic", label: "Incident Commander" });
    render(
      <SetupReviewView
        roles={[ciso, ic]}
        plan={fakePlan()}
        playerCount={2}
        connectedRoleIds={new Set(["r-ciso"])}
        busy={false}
        onStart={vi.fn()}
      />,
    );
    const warning = screen.getByRole("status");
    expect(warning).toHaveTextContent(/1 of 1 invitee/);
    expect(warning).toHaveTextContent(/hasn['’]t opened the join link/i);
    expect(warning).toHaveTextContent(/not_joined/);
    // Singular-verb regression net: "haven't" vs "hasn't" — pluralised
    // count needs the matching verb. Test catches a copy edit that
    // forgets the verb branch.
    expect(warning).not.toHaveTextContent(/haven['’]t/i);
  });

  it("two unjoined out of three invitees: count is plural", () => {
    // Pluralization regression net — "1 invitees" / "2 invitee" both
    // look amateur on a launch screen the creator will screenshot to
    // share. This test fails if a future copy edit drops the count
    // logic.
    const ciso = role({ id: "r-ciso", label: "CISO", is_creator: true });
    const ic = role({ id: "r-ic", label: "Incident Commander" });
    const soc = role({ id: "r-soc", label: "SOC" });
    const legal = role({ id: "r-legal", label: "Legal" });
    render(
      <SetupReviewView
        roles={[ciso, ic, soc, legal]}
        plan={fakePlan()}
        playerCount={4}
        connectedRoleIds={new Set(["r-ciso", "r-soc"])}
        busy={false}
        onStart={vi.fn()}
      />,
    );
    const warning = screen.getByRole("status");
    expect(warning).toHaveTextContent(/2 of 3 invitees/);
    // Plural verb agreement — must be "haven't" not "hasn't" when the
    // count is plural. UI/UX review HIGH#1 caught the original bug
    // where pluralization toggled the noun but left the verb alone.
    expect(warning).toHaveTextContent(/haven['’]t opened the join link/i);
  });

  it("warning is informational: START SESSION stays enabled with unjoined seats", () => {
    // The solo-test / proxy case — the creator must always be able
    // to launch alone (they'll proxy_submit_as for missing seats).
    // A regression that gated START on full presence would silently
    // break solo testing.
    const onStart = vi.fn();
    const ciso = role({ id: "r-ciso", label: "CISO", is_creator: true });
    const ic = role({ id: "r-ic", label: "IC" });
    render(
      <SetupReviewView
        roles={[ciso, ic]}
        plan={fakePlan()}
        playerCount={2}
        connectedRoleIds={new Set(["r-ciso"])}
        busy={false}
        onStart={onStart}
      />,
    );
    const launch = screen.getByRole("button", { name: /START SESSION/i });
    expect(launch).not.toBeDisabled();
    fireEvent.click(launch);
    expect(onStart).toHaveBeenCalledOnce();
  });
});

describe("SetupReviewView — back-to-lobby affordance", () => {
  it("renders the BACK TO LOBBY button when onBackToLobby is supplied", () => {
    const onBackToLobby = vi.fn();
    const ciso = role({ id: "r-ciso", label: "CISO", is_creator: true });
    const ic = role({ id: "r-ic", label: "IC" });
    render(
      <SetupReviewView
        roles={[ciso, ic]}
        plan={fakePlan()}
        playerCount={2}
        connectedRoleIds={new Set(["r-ciso", "r-ic"])}
        busy={false}
        onStart={vi.fn()}
        onBackToLobby={onBackToLobby}
      />,
    );
    const back = screen.getByRole("button", { name: /BACK TO LOBBY/i });
    fireEvent.click(back);
    expect(onBackToLobby).toHaveBeenCalledOnce();
  });

  it("hides the affordance when the parent did not wire onBackToLobby", () => {
    // Storybook / isolated previews / older parent surfaces don't
    // get a stranded button with no behavior wired up.
    render(
      <SetupReviewView
        roles={[role({ is_creator: true })]}
        plan={fakePlan()}
        playerCount={1}
        connectedRoleIds={new Set()}
        busy={false}
        onStart={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /BACK TO LOBBY/i }),
    ).not.toBeInTheDocument();
  });

  it("disables BACK TO LOBBY while busy so the user can't double-trigger nav", () => {
    // The launch handler may be in-flight; a second click on the
    // back button mid-launch would be a confusing race. Match the
    // disabled cadence of the primary CTA.
    const ciso = role({ id: "r-ciso", label: "CISO", is_creator: true });
    render(
      <SetupReviewView
        roles={[ciso]}
        plan={fakePlan()}
        playerCount={1}
        connectedRoleIds={new Set(["r-ciso"])}
        busy={true}
        onStart={vi.fn()}
        onBackToLobby={vi.fn()}
      />,
    );
    const back = screen.getByRole("button", { name: /BACK TO LOBBY/i });
    expect(back).toBeDisabled();
  });
});
