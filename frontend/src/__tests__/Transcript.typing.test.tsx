import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RoleView } from "../api/client";
import { Transcript } from "../components/Transcript";

// Issue #77 — Transcript multi-typer aggregation. Pre-fix any
// 3+ typers collapsed to "X, Y and N more"; the new spec names
// exactly three when there are three (avoiding the awkward
// "X, Y and 1 more"), and at ≥4 collapses to a neutral catch-
// all ("All participants are responding…") so the indicator
// doesn't grow unboundedly. The original issue body asked for
// playful copy ("Everyone is hammering away at their
// keyboards…") but the User + UI/UX reviewers + maintainer
// agreed it reads as the app cracking a joke during tense
// IR scenarios — swapped to neutral copy on the second commit.

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
      screen.queryByText(/All participants are responding/i),
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

  it("≥4 typers → 'All participants are responding…' (neutral catch-all)", () => {
    render(
      <Transcript
        messages={[]}
        roles={FOUR_ROLES}
        typingRoleIds={["r-soc", "r-legal", "r-comms", "r-ir"]}
      />,
    );
    expect(
      screen.getByText(/All participants are responding…/),
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

  it("typing chip renders after the message list (chronological ordering)", () => {
    // QA review MEDIUM: the chip should be the *last* visible
    // entry in the transcript region so it reads as "what's
    // happening right now" rather than appearing between past
    // messages.
    const messages = [
      {
        id: "m1",
        kind: "player" as const,
        role_id: "r-soc",
        body: "First message body",
        ts: "2026-05-01T00:00:00Z",
        tool_name: null,
        tool_args: null,
        workstream_id: null,
        mentions: [],
      },
      {
        id: "m2",
        kind: "ai_text" as const,
        role_id: null,
        body: "AI response body",
        ts: "2026-05-01T00:00:01Z",
        tool_name: null,
        tool_args: null,
        workstream_id: null,
        mentions: [],
      },
    ];
    const { container } = render(
      <Transcript
        messages={messages}
        roles={FOUR_ROLES}
        typingRoleIds={["r-soc"]}
      />,
    );
    // Get all article (message bubble) + the typing chip in DOM
    // order. The typing label text should appear *after* both
    // message bodies in the rendered tree.
    const text = container.textContent ?? "";
    const firstMsgIdx = text.indexOf("First message body");
    const aiMsgIdx = text.indexOf("AI response body");
    // ``is typing…`` is a substring unique to the typing chip
    // (message bubbles include the role label "SOC Analyst" too,
    // so searching for that finds the message header first).
    const typingIdx = text.indexOf("is typing…");
    expect(firstMsgIdx).toBeGreaterThanOrEqual(0);
    expect(aiMsgIdx).toBeGreaterThan(firstMsgIdx);
    expect(typingIdx).toBeGreaterThan(aiMsgIdx);
  });

  it("typing indicator is silent inside the role=log live region (no nested aria-live)", () => {
    // UI/UX review HIGH H-1: nesting a role=status aria-live
    // element inside the role=log aria-live wrapper made NVDA
    // double-announce. Transcript passes ``silent`` to the
    // ChatIndicator children so the inner element is plain.
    const { container } = render(
      <Transcript
        messages={[]}
        roles={FOUR_ROLES}
        typingRoleIds={["r-soc"]}
      />,
    );
    // Outer log region is the live region.
    const log = container.querySelector('[role="log"]');
    expect(log?.getAttribute("aria-live")).toBe("polite");
    // No inner role=status / aria-live elements.
    expect(container.querySelectorAll('[role="status"]').length).toBe(0);
    const inner = container.querySelectorAll("[aria-live]");
    // Only the outer log, no inner duplicates.
    expect(inner.length).toBe(1);
    expect(inner[0]).toBe(log);
  });
});
