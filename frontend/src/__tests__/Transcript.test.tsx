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

  it("ignores streamingText content (no partial rendering)", () => {
    // Pre-fix the green "AI Facilitator (streaming…)" bubble rendered
    // the concatenated chunk deltas live, then the final
    // ``message_complete`` body sometimes diverged (rationale chunked
    // but a separate broadcast got committed). Players read that as
    // the AI rewriting itself mid-flight. We now ignore chunk content
    // entirely; only ``aiThinking`` lights the typing indicator.
    render(
      <Transcript
        messages={[]}
        roles={ROLES}
        aiThinking
        aiStatusLabel="Typing…"
        streamingText="The AI has started replying…"
      />,
    );
    // Partial chunk text must NOT appear in the rendered output.
    expect(
      screen.queryByText(/The AI has started replying/i),
    ).not.toBeInTheDocument();
    // The typing indicator IS rendered with the supplied label.
    expect(
      screen.getByText(/AI Facilitator — Typing/i),
    ).toBeInTheDocument();
  });

  it("rings the latest AI bubble when highlightLastAi is true", () => {
    // The amber focus ring is the visual partner to the
    // "Awaiting your response" chip on the player page. A non-
    // addressed-but-still-active role can spot which message they
    // need to react to without scrolling back to the top banner.
    const messages = [
      {
        id: "m1",
        ts: new Date().toISOString(),
        role_id: null,
        kind: "ai_text",
        body: "Old AI bubble — no ring on this one.",
        tool_name: "broadcast",
        tool_args: null,
      },
      {
        id: "m2",
        ts: new Date().toISOString(),
        role_id: "r1",
        kind: "player",
        body: "Player reply",
        tool_name: null,
        tool_args: null,
      },
      {
        id: "m3",
        ts: new Date().toISOString(),
        role_id: null,
        kind: "ai_text",
        body: "Latest AI bubble — should have the amber ring.",
        tool_name: "broadcast",
        tool_args: null,
      },
    ];
    const { container } = render(
      <Transcript messages={messages} roles={ROLES} highlightLastAi />,
    );
    const m1 = container.querySelector("#msg-m1");
    const m3 = container.querySelector("#msg-m3");
    expect(m1).not.toBeNull();
    expect(m3).not.toBeNull();
    // Tailwind ring class names — m3 has them, m1 doesn't. Post-redesign
    // the ring color is `--warn` (was amber) — same semantic ("you owe a
    // response"), brand-aligned token.
    expect(m1?.className).not.toContain("ring-warn");
    expect(m3?.className).toContain("ring-warn");
  });
});
