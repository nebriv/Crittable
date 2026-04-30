import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RoleView } from "../api/client";
import { Transcript } from "../components/Transcript";

const ROLES: RoleView[] = [
  {
    id: "r1",
    label: "CISO",
    display_name: "Alex",
    kind: "player",
    token_version: 0,
    is_creator: true,
  },
];

describe("Transcript", () => {
  it("renders the default 'AI Facilitator is typing…' indicator when aiThinking and no label", () => {
    render(<Transcript messages={[]} roles={ROLES} aiThinking />);
    expect(
      screen.getByText(/AI Facilitator is typing/i),
    ).toBeInTheDocument();
  });

  it("renders the labelled status when aiStatusLabel is provided", () => {
    // Issue #63: the operator must be able to tell "thinking" from
    // "stuck" during the play-tier strict-retry loop. The label is
    // appended to the indicator so a recovery pass shows up as
    // "AI Facilitator — Recovery pass 2/3 (missing yield)" instead of
    // just the generic typing string.
    render(
      <Transcript
        messages={[]}
        roles={ROLES}
        aiThinking
        aiStatusLabel="Recovery pass 2/3 (missing yield)"
      />,
    );
    expect(
      screen.getByText(/AI Facilitator — Recovery pass 2\/3 \(missing yield\)/i),
    ).toBeInTheDocument();
  });

  it("does NOT render the indicator when aiThinking is false", () => {
    render(
      <Transcript
        messages={[]}
        roles={ROLES}
        aiThinking={false}
        aiStatusLabel="Replying to SOC Analyst"
      />,
    );
    expect(screen.queryByText(/AI Facilitator/i)).not.toBeInTheDocument();
  });

  it("does NOT render the indicator while streamingText is non-empty", () => {
    // Streaming text takes precedence — the bubble renders the partial
    // response, so a separate "thinking" indicator would be redundant.
    render(
      <Transcript
        messages={[]}
        roles={ROLES}
        aiThinking
        aiStatusLabel="Recovery pass 2/3"
        streamingText="The AI has started replying…"
      />,
    );
    expect(
      screen.queryByText(/AI Facilitator — Recovery/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/The AI has started replying/i),
    ).toBeInTheDocument();
  });
});
