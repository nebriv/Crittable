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

  it("renders the labeled status when aiStatusLabel is provided", () => {
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
        workstream_id: null,
        mentions: [],
      },
      {
        id: "m2",
        ts: new Date().toISOString(),
        role_id: "r1",
        kind: "player",
        body: "Player reply",
        tool_name: null,
        tool_args: null,
        workstream_id: null,
        mentions: [],
      },
      {
        id: "m3",
        ts: new Date().toISOString(),
        role_id: null,
        kind: "ai_text",
        body: "Latest AI bubble — should have the amber ring.",
        tool_name: "broadcast",
        tool_args: null,
        workstream_id: null,
        mentions: [],
      },
    ];
    const { container } = render(
      <Transcript messages={messages} roles={ROLES} highlightLastAi />,
    );
    const m1 = container.querySelector("#msg-m1");
    const m3 = container.querySelector("#msg-m3");
    expect(m1).not.toBeNull();
    expect(m3).not.toBeNull();
    // The highlight rides on the bubble body's border — swapping the
    // default ``border-ink-600`` for ``border-warn`` — instead of a
    // ring stack on the article. m3 (latest AI bubble) shows the
    // warn border; m1 (earlier AI bubble) keeps the default ink-600.
    const m1Bubble = m1?.querySelector('[data-message-kind="ai"]');
    const m3Bubble = m3?.querySelector('[data-message-kind="ai"]');
    expect(m1Bubble?.className).not.toContain("border-warn");
    expect(m1Bubble?.className).toContain("border-ink-600");
    expect(m3Bubble?.className).toContain("border-warn");
    expect(m3Bubble?.className).not.toContain("border-ink-600");
    // Belt-and-braces against the original visual bug: the row-level
    // ring stack must be GONE from the article. If a future refactor
    // re-adds ``ring-warn`` / ``ring-2`` / ``ring-offset-*`` /
    // ``shadow-[...]`` to the article (in addition to the new border)
    // the broken outer-outline regression is back even though the
    // border check above would still pass.
    expect(m3?.className).not.toMatch(/\bring-/);
    expect(m3?.className).not.toContain("shadow-");
    expect(m1?.className).not.toMatch(/\bring-/);
  });

  it("an @-mentioned AI bubble swaps to border-warn; critical inject keeps border-crit", () => {
    // Two newly-coupled paths land in the same `borderClass` ladder:
    // mention → warn, critical inject → crit. The crit branch is
    // first in the ladder so a critical inject that ALSO mentions
    // the viewer must keep its red border (the security-relevant
    // signal wins over the focus signal).
    const messages = [
      {
        id: "ai-mention",
        ts: new Date().toISOString(),
        role_id: null,
        kind: "ai_text",
        body: "AI bubble that @-tags the viewer.",
        tool_name: "broadcast",
        tool_args: null,
        workstream_id: null,
        mentions: ["r1"],
      },
      {
        id: "crit-mention",
        ts: new Date().toISOString(),
        role_id: null,
        kind: "critical_inject",
        body: "Critical inject that ALSO @-tags the viewer.",
        tool_name: "critical_inject",
        tool_args: null,
        workstream_id: null,
        mentions: ["r1"],
      },
    ];
    const { container } = render(
      <Transcript messages={messages} roles={ROLES} selfRoleId="r1" />,
    );
    const aiBubble = container
      .querySelector("#msg-ai-mention")
      ?.querySelector('[data-message-kind="ai"]');
    const critBubble = container
      .querySelector("#msg-crit-mention")
      ?.querySelector('[data-message-kind="ai"]');
    expect(aiBubble?.className).toContain("border-warn");
    expect(aiBubble?.className).not.toContain("border-crit");
    expect(critBubble?.className).toContain("border-crit");
    expect(critBubble?.className).not.toContain("border-warn");
  });

  it("an @-mentioned player bubble swaps to border-warn; self bubbles keep signal-tint", () => {
    // The player ladder is: self → signal-tint, mention → warn,
    // default → ink-600. A self-authored bubble that ALSO mentions
    // the viewer (rare but legal — a player tagging themselves)
    // keeps the signal-tinted self treatment because the signal
    // "this is yours" outranks "you got mentioned" for self-posts.
    const messages = [
      {
        id: "p-mention",
        ts: new Date().toISOString(),
        role_id: "r2",
        kind: "player",
        body: "Other player bubble mentioning the viewer.",
        tool_name: null,
        tool_args: null,
        workstream_id: null,
        mentions: ["r1"],
      },
      {
        id: "p-self",
        ts: new Date().toISOString(),
        role_id: "r1",
        kind: "player",
        body: "Self-authored bubble (no mention).",
        tool_name: null,
        tool_args: null,
        workstream_id: null,
        mentions: [],
      },
    ];
    const rolesWithSecond: RoleView[] = [
      ...ROLES,
      {
        id: "r2",
        label: "IR Lead",
        display_name: "Sam",
        kind: "player",
        token_version: 0,
        is_creator: false,
      },
    ];
    const { container } = render(
      <Transcript
        messages={messages}
        roles={rolesWithSecond}
        selfRoleId="r1"
      />,
    );
    const mentionedBubble = container
      .querySelector("#msg-p-mention")
      ?.querySelector('[data-message-kind="chat"]');
    const selfBubble = container
      .querySelector("#msg-p-self")
      ?.querySelector('[data-message-kind="chat"]');
    expect(mentionedBubble?.className).toContain("border-warn");
    expect(mentionedBubble?.className).not.toContain("border-signal-deep");
    expect(selfBubble?.className).toContain("border-signal-deep");
    expect(selfBubble?.className).toContain("bg-signal-tint");
    expect(selfBubble?.className).not.toContain("border-warn");
  });
});
