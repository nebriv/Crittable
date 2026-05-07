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

  it("an @-mentioned AI bubble gets a bright signal border (identity, not alarm); critical inject keeps border-crit", () => {
    // Four priority levels in the AI bubble's `borderClass` ladder:
    //   1. critical inject → crit (red), always wins.
    //   2. your-turn (``isFocusHit`` via highlightLastAi) → warn.
    //      Reserved for "you owe a turn answer". Wins over mention.
    //   3. @-mention only → signal (bright blue identity tone).
    //      Earlier passes used signal-deep, which was too close to
    //      ink-600 to scan peripherally; signal pops without
    //      colliding with the warn-amber call-to-action.
    //   4. default → ink-600.
    // The user-reported "too many yellow things" regression came
    // from collapsing 2+3 onto warn — mention-only bubbles now read
    // as identity (blue family, same hue as the ``· YOU`` self
    // suffix) so amber stays reserved for "you owe a turn answer".
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
    // Mention-only AI bubble: bright signal border (not signal-deep,
    // which is too close to ink-600), NOT yellow. The regex with a
    // word boundary keeps "border-signal" from accidentally matching
    // "border-signal-deep" (toContain would pass on either).
    expect(aiBubble?.className).toMatch(/\bborder-signal\b/);
    expect(aiBubble?.className).not.toContain("border-signal-deep");
    expect(aiBubble?.className).not.toContain("border-warn");
    expect(aiBubble?.className).not.toContain("border-crit");
    // Critical inject keeps its red emphasis even when @-mentioning
    // the viewer — the security-relevant signal wins.
    expect(critBubble?.className).toContain("border-crit");
    expect(critBubble?.className).not.toContain("border-warn");
    expect(critBubble?.className).not.toContain("border-signal-deep");
  });

  it("focus-and-mention bubble keeps border-warn (your-turn wins over mention)", () => {
    // QA review HIGH on the color-cleanup PR: the priority ladder
    // (crit > focus > mention > default) had no test pinning the
    // focus-vs-mention tie-break. A future refactor reordering to
    // ``isMentioned ? signal : isFocusHit ? warn : default`` would
    // silently drop the user-facing "your turn" amber for a player
    // who gets @-mentioned on the same message they're about to
    // answer — which is the most common case in practice (the AI
    // typically tags the role it's asking). This test pins the
    // ladder so the regression can't sneak through.
    const messages = [
      {
        id: "ai-old",
        ts: new Date().toISOString(),
        role_id: null,
        kind: "ai_text",
        body: "Earlier AI bubble — neither focus nor mention.",
        tool_name: "broadcast",
        tool_args: null,
        workstream_id: null,
        mentions: [],
      },
      {
        id: "ai-latest",
        ts: new Date().toISOString(),
        role_id: null,
        kind: "ai_text",
        body: "Latest AI bubble — focus AND mention.",
        tool_name: "broadcast",
        tool_args: null,
        workstream_id: null,
        mentions: ["r1"],
      },
    ];
    const { container } = render(
      <Transcript
        messages={messages}
        roles={ROLES}
        selfRoleId="r1"
        highlightLastAi
      />,
    );
    const latestBubble = container
      .querySelector("#msg-ai-latest")
      ?.querySelector('[data-message-kind="ai"]');
    // Focus wins: amber border, NOT signal blue.
    expect(latestBubble?.className).toContain("border-warn");
    expect(latestBubble?.className).not.toMatch(/\bborder-signal\b/);
    expect(latestBubble?.className).not.toContain("border-signal-deep");
    // The @YOU badge still renders alongside the warn border —
    // identity is independent of severity.
    const badge = container
      .querySelector("#msg-ai-latest")
      ?.querySelector('[title="This message mentions you"]');
    expect(badge).not.toBeNull();
    // Badge identity is blue (signal border + signal text) on a
    // contrast-safe ink-900 background. Verifying both halves
    // catches a regression where a future styling pass tints the
    // badge background back to signal-tint (which vanishes against
    // a self-bubble's signal-tint background per UI/UX review).
    expect(badge?.className).toContain("border-signal");
    expect(badge?.className).toContain("text-signal");
    expect(badge?.className).toContain("bg-ink-900");
    expect(badge?.className).not.toContain("bg-signal-tint");
    expect(badge?.className).not.toContain("border-warn");
  });

  it("an @-mentioned player bubble gets a bright signal identity border; self bubbles keep signal-tint", () => {
    // The player ladder is: self → signal-deep border + signal-tint
    // background, mention → bright signal border on ink-800, default
    // → ink-600. Both self and mention sit in the blue family — "this
    // is about me" reads as one consistent identity color, distinct
    // from the amber "you owe a response" chip near the composer.
    // The mention case uses bright signal (not signal-deep, which is
    // barely distinguishable from ink-600 at peripheral-vision
    // distance per UI/UX review). Self + mention is rare and the
    // signal-tint self treatment wins (the viewer rarely needs to be
    // reminded they mentioned themselves).
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
    // Mention-only player bubble: bright signal border on standard
    // ink-800 background. NOT yellow, NOT the dim signal-deep variant.
    // Word-boundary regex keeps the assertion from accidentally
    // matching "border-signal-deep".
    expect(mentionedBubble?.className).toMatch(/\bborder-signal\b/);
    expect(mentionedBubble?.className).not.toContain("border-signal-deep");
    expect(mentionedBubble?.className).not.toContain("border-warn");
    expect(mentionedBubble?.className).not.toContain("bg-signal-tint");
    // Self bubble: signal-deep border + signal-tint background.
    expect(selfBubble?.className).toContain("border-signal-deep");
    expect(selfBubble?.className).toContain("bg-signal-tint");
    expect(selfBubble?.className).not.toContain("border-warn");
  });
});
