import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WaitingChip } from "../pages/Facilitator";
import type { RoleView } from "../api/client";

function role(id: string, label: string, displayName: string | null = null): RoleView {
  return {
    id,
    label,
    kind: "player",
    is_creator: false,
    display_name: displayName,
  } as RoleView;
}

const ROSTER = [
  role("r-soc", "SOC Analyst", "Bridget"),
  role("r-legal", "Legal", "Marcus"),
  role("r-comms", "Comms"),
  role("r-ir", "IR Lead", "Pat"),
];

describe("WaitingChip — issue #88 (slate tone, no Copy invite, actor-led copy)", () => {
  it("renders nothing when no roles are pending", () => {
    const { container } = render(
      <WaitingChip
        activeRoleIds={["r-soc"]}
        submittedRoleIds={["r-soc"]}
        roles={ROSTER}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("1 pending → 'Waiting on X (display_name) to respond.'", () => {
    render(
      <WaitingChip
        activeRoleIds={["r-soc", "r-legal"]}
        submittedRoleIds={["r-legal"]}
        roles={ROSTER}
      />,
    );
    expect(
      screen.getByText(/Waiting on SOC Analyst \(Bridget\) to respond\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/\(1 of 2\)/)).toBeInTheDocument();
  });

  it("2 pending → 'Waiting on A and B.'", () => {
    render(
      <WaitingChip
        activeRoleIds={["r-soc", "r-legal"]}
        submittedRoleIds={[]}
        roles={ROSTER}
      />,
    );
    expect(
      screen.getByText(
        /Waiting on SOC Analyst \(Bridget\) and Legal \(Marcus\)\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/\(2 of 2\)/)).toBeInTheDocument();
  });

  it("3+ pending → 'Waiting on A, B and N more.'", () => {
    render(
      <WaitingChip
        activeRoleIds={["r-soc", "r-legal", "r-comms", "r-ir"]}
        submittedRoleIds={[]}
        roles={ROSTER}
      />,
    );
    expect(
      screen.getByText(
        /Waiting on SOC Analyst \(Bridget\), Legal \(Marcus\) and 2 more\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/\(4 of 4\)/)).toBeInTheDocument();
  });

  it("does not render any Copy invite button (issue #88 — duplicative with Roles panel)", () => {
    render(
      <WaitingChip
        activeRoleIds={["r-soc", "r-legal"]}
        submittedRoleIds={[]}
        roles={ROSTER}
      />,
    );
    expect(screen.queryByRole("button", { name: /Copy invite/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Copy link/i })).toBeNull();
  });

  it("falls back to label when display_name is missing", () => {
    render(
      <WaitingChip
        activeRoleIds={["r-comms"]}
        submittedRoleIds={[]}
        roles={ROSTER}
      />,
    );
    expect(screen.getByText(/Waiting on Comms to respond\./)).toBeInTheDocument();
    expect(screen.queryByText(/\(\)/)).toBeNull();
  });
});
