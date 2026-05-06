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

describe("WaitingChip — issue #88 + Wave 1 (issue #134, ready-quorum)", () => {
  it("renders nothing when every active role is ready", () => {
    const { container } = render(
      <WaitingChip
        activeRoleIds={["r-soc"]}
        submittedRoleIds={["r-soc"]}
        readyRoleIds={["r-soc"]}
        roles={ROSTER}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("1 pending → 'Waiting on X (display_name) to mark ready.'", () => {
    render(
      <WaitingChip
        activeRoleIds={["r-soc", "r-legal"]}
        submittedRoleIds={["r-legal"]}
        readyRoleIds={["r-legal"]}
        roles={ROSTER}
      />,
    );
    expect(
      screen.getByText(/Waiting on SOC Analyst \(Bridget\) to mark ready\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/\(1 of 2 ready\)/)).toBeInTheDocument();
  });

  it("2 pending → 'Waiting on A and B to mark ready.'", () => {
    render(
      <WaitingChip
        activeRoleIds={["r-soc", "r-legal"]}
        submittedRoleIds={[]}
        readyRoleIds={[]}
        roles={ROSTER}
      />,
    );
    expect(
      screen.getByText(
        /Waiting on SOC Analyst \(Bridget\) and Legal \(Marcus\) to mark ready\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/\(0 of 2 ready\)/)).toBeInTheDocument();
  });

  it("3+ pending → 'Waiting on A, B and N more to mark ready.'", () => {
    render(
      <WaitingChip
        activeRoleIds={["r-soc", "r-legal", "r-comms", "r-ir"]}
        submittedRoleIds={[]}
        readyRoleIds={[]}
        roles={ROSTER}
      />,
    );
    expect(
      screen.getByText(
        /Waiting on SOC Analyst \(Bridget\), Legal \(Marcus\) and 2 more to mark ready\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/\(0 of 4 ready\)/)).toBeInTheDocument();
  });

  it("submitted-but-not-ready surfaces a 'discussing' suffix", () => {
    render(
      <WaitingChip
        activeRoleIds={["r-soc", "r-legal"]}
        submittedRoleIds={["r-soc"]}
        readyRoleIds={[]}
        roles={ROSTER}
      />,
    );
    // SOC Analyst submitted (so a discussion message landed) but
    // hasn't signaled ready — annotated "discussing".
    expect(
      screen.getByText(
        /Waiting on SOC Analyst \(Bridget\) — discussing and Legal \(Marcus\) to mark ready\./,
      ),
    ).toBeInTheDocument();
  });

  it("does not render any Copy invite button (issue #88 — duplicative with Roles panel)", () => {
    render(
      <WaitingChip
        activeRoleIds={["r-soc", "r-legal"]}
        submittedRoleIds={[]}
        readyRoleIds={[]}
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
        readyRoleIds={[]}
        roles={ROSTER}
      />,
    );
    expect(
      screen.getByText(/Waiting on Comms to mark ready\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\(\)/)).toBeNull();
  });

  it("multi-pending mix: display_name where present, label-only otherwise, no empty parens", () => {
    render(
      <WaitingChip
        activeRoleIds={["r-soc", "r-comms"]}
        submittedRoleIds={[]}
        readyRoleIds={[]}
        roles={ROSTER}
      />,
    );
    expect(
      screen.getByText(
        /Waiting on SOC Analyst \(Bridget\) and Comms to mark ready\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Comms \(\)/)).toBeNull();
  });

  it("exposes role=status with aria-live=polite (assistive tech contract)", () => {
    render(
      <WaitingChip
        activeRoleIds={["r-soc"]}
        submittedRoleIds={[]}
        readyRoleIds={[]}
        roles={ROSTER}
      />,
    );
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });
});
