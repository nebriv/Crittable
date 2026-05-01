import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RoleView } from "../api/client";
import { Transcript } from "../components/Transcript";

// Issue #77 — Transcript multi-typer aggregation. Pre-fix any
// 3+ typers collapsed to "X, Y and N more"; the new spec names
// exactly three when there are three (avoiding the awkward
// "X, Y and 1 more"), and at ≥4 collapses to a playful catch-
// all so the indicator doesn't grow unboundedly.

function role(id: string, label: string, displayName: string | null = null): RoleView {
  return {
    id,
    label,
    display_name: displayName,
    kind: "player",
    token_version: 0,
    is_creator: false,
  };
}

const FOUR_ROLES: RoleView[] = [
  role("r-soc", "SOC Analyst", "Bridget"),
  role("r-legal", "Legal", "Marcus"),
  role("r-comms", "Comms", "Pat"),
  role("r-ir", "IR Lead"),
];

describe("Transcript typing label (issue #77)", () => {
  it("0 typers → no indicator", () => {
    render(
      <Transcript messages={[]} roles={FOUR_ROLES} typingRoleIds={[]} />,
    );
    expect(screen.queryByText(/typing…/i)).toBeNull();
    expect(
      screen.queryByText(/Everyone is hammering/i),
    ).toBeNull();
  });

  it("1 typer → 'X is typing…'", () => {
    render(
      <Transcript
        messages={[]}
        roles={FOUR_ROLES}
        typingRoleIds={["r-soc"]}
      />,
    );
    expect(
      screen.getByText(/SOC Analyst · Bridget is typing…/),
    ).toBeInTheDocument();
  });

  it("2 typers → 'X and Y are typing…'", () => {
    render(
      <Transcript
        messages={[]}
        roles={FOUR_ROLES}
        typingRoleIds={["r-soc", "r-legal"]}
      />,
    );
    expect(
      screen.getByText(
        /SOC Analyst · Bridget and Legal · Marcus are typing…/,
      ),
    ).toBeInTheDocument();
  });

  it("3 typers → names all three (no awkward 'and 1 more')", () => {
    render(
      <Transcript
        messages={[]}
        roles={FOUR_ROLES}
        typingRoleIds={["r-soc", "r-legal", "r-comms"]}
      />,
    );
    expect(
      screen.getByText(
        /SOC Analyst · Bridget, Legal · Marcus and Comms · Pat are typing…/,
      ),
    ).toBeInTheDocument();
  });

  it("≥4 typers → 'Everyone is hammering away at their keyboards…'", () => {
    render(
      <Transcript
        messages={[]}
        roles={FOUR_ROLES}
        typingRoleIds={["r-soc", "r-legal", "r-comms", "r-ir"]}
      />,
    );
    expect(
      screen.getByText(/Everyone is hammering away at their keyboards…/),
    ).toBeInTheDocument();
    // Plain "X is typing" / "X and Y are typing" must NOT also
    // render — the catch-all replaces, doesn't supplement.
    expect(screen.queryByText(/SOC Analyst.+is typing/)).toBeNull();
    expect(screen.queryByText(/Legal.+are typing/)).toBeNull();
  });

  it("typing role-ids that don't resolve to a known role are dropped silently", () => {
    render(
      <Transcript
        messages={[]}
        roles={FOUR_ROLES}
        typingRoleIds={["r-ghost", "r-soc"]}
      />,
    );
    // Falls through to the 1-typer phrasing — the unknown id is
    // skipped, not rendered as a bare role_id.
    expect(
      screen.getByText(/SOC Analyst · Bridget is typing…/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/r-ghost/)).toBeNull();
  });
});
