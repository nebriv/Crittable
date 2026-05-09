import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RoleRoster } from "../components/RoleRoster";
import type { RoleView } from "../api/client";

// Player-side rail roster. PR #213 follow-up (Copilot review): the
// Mark Ready button must stay MOUNTED across page-level disable
// states (WS reconnect, AI_PROCESSING, off-active-set) so the
// affordance doesn't appear/disappear in a way that reads as a bug.
// Interactivity is driven by the explicit ``selfMarkReadyEnabled``
// prop + tooltip; visibility only ties to "is there an active turn?"

const ROLES: RoleView[] = [
  {
    id: "role-self",
    label: "CISO",
    kind: "player",
    is_creator: false,
    display_name: "Ben",
  } as RoleView,
  {
    id: "role-other",
    label: "SOC Analyst",
    kind: "player",
    is_creator: false,
    display_name: "Bo",
  } as RoleView,
];

describe("<RoleRoster/>", () => {
  it("renders the Mark Ready button when there's an active turn, even with no handler wired", () => {
    // Pre-fix the button only rendered when ``onSelfMarkReady`` was
    // truthy. A WS reconnect (where the handler was set to undefined)
    // hid the affordance entirely. Lock the new contract: visible +
    // disabled with the disabledReason as tooltip.
    render(
      <RoleRoster
        roles={ROLES}
        activeRoleIds={["role-self"]}
        selfRoleId="role-self"
        readyRoleIds={new Set()}
        // No onSelfMarkReady — simulates a legacy caller / a parent
        // that hasn't wired the handler yet.
        selfMarkReadyEnabled={false}
        selfMarkReadyDisabledReason="Reconnecting — Mark Ready re-opens once the connection is back."
      />,
    );
    const btn = screen.getByTestId("mark-ready");
    expect(btn).toBeInTheDocument();
    expect(btn).toBeDisabled();
    expect(btn.getAttribute("title")).toMatch(/Reconnecting/);
  });

  it("renders the button enabled when selfMarkReadyEnabled=true and onSelfMarkReady is wired", () => {
    const onToggle = vi.fn();
    render(
      <RoleRoster
        roles={ROLES}
        activeRoleIds={["role-self"]}
        selfRoleId="role-self"
        readyRoleIds={new Set()}
        onSelfMarkReady={onToggle}
        selfMarkReadyEnabled={true}
      />,
    );
    const btn = screen.getByTestId("mark-ready");
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("renders the button disabled (with tooltip) when selfMarkReadyEnabled=false", () => {
    const onToggle = vi.fn();
    render(
      <RoleRoster
        roles={ROLES}
        activeRoleIds={["role-self"]}
        selfRoleId="role-self"
        readyRoleIds={new Set()}
        onSelfMarkReady={onToggle}
        selfMarkReadyEnabled={false}
        selfMarkReadyDisabledReason="AI is responding to this beat — Mark Ready re-opens on the next turn."
      />,
    );
    const btn = screen.getByTestId("mark-ready");
    expect(btn).toBeDisabled();
    expect(btn.getAttribute("title")).toMatch(/AI is responding/);
    fireEvent.click(btn);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("hides the Mark Ready section when there's no active turn (active set empty)", () => {
    // No quorum to close → no affordance to render. Distinct from
    // the disabled-state path: an empty active set means the
    // session is between turns / in BRIEFING, not "your seat is
    // parked."
    render(
      <RoleRoster
        roles={ROLES}
        activeRoleIds={[]}
        selfRoleId="role-self"
        readyRoleIds={new Set()}
        selfMarkReadyEnabled={false}
      />,
    );
    expect(screen.queryByTestId("mark-ready")).toBeNull();
  });

  it("hides the Mark Ready section for spectators (no selfRoleId in the roster)", () => {
    render(
      <RoleRoster
        roles={ROLES}
        activeRoleIds={["role-self"]}
        selfRoleId={null}
        readyRoleIds={new Set()}
      />,
    );
    expect(screen.queryByTestId("mark-ready")).toBeNull();
  });

  it("surfaces the in-flight pulse when selfMarkReadyInFlight=true", () => {
    render(
      <RoleRoster
        roles={ROLES}
        activeRoleIds={["role-self"]}
        selfRoleId="role-self"
        readyRoleIds={new Set()}
        onSelfMarkReady={vi.fn()}
        selfMarkReadyEnabled={true}
        selfMarkReadyInFlight={true}
      />,
    );
    const btn = screen.getByTestId("mark-ready");
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(btn.className).toMatch(/animate-tt-pulse/);
  });

  it("falls back to row-level enabled if the parent omits selfMarkReadyEnabled (legacy caller)", () => {
    // A caller that hasn't wired the explicit page-level gate gets
    // the row-level gate alone — the button enables on
    // ``selfIsActive`` and disables otherwise. Doesn't crash.
    const onToggle = vi.fn();
    render(
      <RoleRoster
        roles={ROLES}
        activeRoleIds={["role-self"]}
        selfRoleId="role-self"
        readyRoleIds={new Set()}
        onSelfMarkReady={onToggle}
      />,
    );
    const btn = screen.getByTestId("mark-ready");
    // Self is active → enabled.
    expect(btn).not.toBeDisabled();
  });

  it("renders ready ✓ tag inline with role labels for active+ready roles", () => {
    render(
      <RoleRoster
        roles={ROLES}
        activeRoleIds={["role-self", "role-other"]}
        selfRoleId="role-self"
        readyRoleIds={new Set(["role-other"])}
      />,
    );
    // The other role's row carries the inline READY ✓ chip.
    expect(screen.getByText(/READY ✓/i)).toBeInTheDocument();
  });

  it("shows NOT YOUR TURN on the disabled button when self isn't on the active set", () => {
    // Pre-fix the off-active-set viewer saw a greyed-out
    // "MARK READY →" face that read as broken. The plain-English
    // override label tells them at a glance that the affordance
    // isn't theirs to act on this beat — the tooltip still names
    // the why, but touch users who can't hover get the signal too.
    render(
      <RoleRoster
        roles={ROLES}
        activeRoleIds={["role-other"]}
        selfRoleId="role-self"
        readyRoleIds={new Set()}
        onSelfMarkReady={vi.fn()}
        selfMarkReadyEnabled={false}
      />,
    );
    const btn = screen.getByTestId("mark-ready");
    expect(btn).toBeDisabled();
    expect(btn.textContent).toMatch(/NOT YOUR TURN/);
    expect(btn.textContent).not.toMatch(/MARK READY/);
  });
});
