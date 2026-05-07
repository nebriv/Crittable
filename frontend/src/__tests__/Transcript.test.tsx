import { fireEvent, render, screen } from "@testing-library/react";
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

  it("substantial share_data renders collapsed with a 'Show N lines' affordance", () => {
    // User feedback on the chat-firehose problem: "the transcript
    // moves very quickly when the AI dumps big chunks." Substantial
    // share_data calls (>= 300 chars, matching the Timeline rail-pin
    // threshold) collapse to a one-line summary by default. The
    // viewer expands via "Show N lines" — operator-voice, previews
    // the cost (User-persona review MEDIUM); the same content is
    // also pinned in Timeline for re-find. This test pins the
    // collapse default so a future revert of the threshold or the
    // collapse logic can't silently re-flood the chat.
    const longBody =
      "**Defender telemetry — 03:14 UTC**\n\n" + "alert line foo bar baz\n".repeat(40);
    const messages = [
      {
        id: "share-big",
        ts: new Date().toISOString(),
        role_id: null,
        kind: "ai_text",
        body: longBody,
        tool_name: "share_data",
        tool_args: { label: "Defender telemetry — 03:14 UTC", data: "..." },
        workstream_id: null,
        mentions: [],
      },
    ];
    render(<Transcript messages={messages} roles={ROLES} />);
    // Collapsed: the brief label + a "Show N lines" button render,
    // but the bulk of the body (the repeated alert lines) does NOT.
    expect(screen.getByText("▤ DATA BRIEF")).toBeInTheDocument();
    expect(
      screen.getByText("Defender telemetry — 03:14 UTC"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /show \d+ lines/i }),
    ).toBeInTheDocument();
    // QA review LOW L-1: lock the assertion to the count of repeated
    // occurrences, not just absence — a future regression that
    // accidentally puts ALL 40 lines into the preview would be caught
    // (a single occurrence in the preview is acceptable; 40 is not).
    expect(
      screen.queryAllByText(/alert line foo bar baz/i).length,
    ).toBeLessThan(5);
  });

  it("'Show N lines' click expands the share_data card; 'Hide details' collapses it again", () => {
    // Round-trips the toggle so we know the state machine doesn't
    // get stuck open or stuck closed. The button label flips
    // between "Show N lines" and "Hide details" so the assertion
    // is the visible affordance, not an internal flag.
    const longBody =
      "**IOC dump**\n\n" +
      Array.from({ length: 30 }, (_, i) => `203.0.113.${i} blocked`).join("\n");
    const messages = [
      {
        id: "share-toggle",
        ts: new Date().toISOString(),
        role_id: null,
        kind: "ai_text",
        body: longBody,
        tool_name: "share_data",
        tool_args: { label: "IOC dump", data: "..." },
        workstream_id: null,
        mentions: [],
      },
    ];
    render(<Transcript messages={messages} roles={ROLES} />);
    // Collapsed initially.
    const expandButton = screen.getByRole("button", { name: /show \d+ lines/i });
    expect(screen.queryByText(/203\.0\.113\.5 blocked/)).not.toBeInTheDocument();
    fireEvent.click(expandButton);
    // Expanded: full body in the DOM, button label flipped.
    expect(screen.getByText(/203\.0\.113\.5 blocked/)).toBeInTheDocument();
    const collapseButton = screen.getByRole("button", { name: /hide details/i });
    expect(collapseButton).toBeInTheDocument();
    // Round-trip: collapse again.
    fireEvent.click(collapseButton);
    expect(screen.queryByText(/203\.0\.113\.5 blocked/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /show \d+ lines/i })).toBeInTheDocument();
  });

  it("a small share_data dump (under the threshold) renders inline without the collapse card", () => {
    // The threshold (300 chars) matches Timeline's rail-pin
    // threshold — a small ``share_data`` (a single telemetry line,
    // a tiny config snippet) doesn't earn a rail pin AND doesn't
    // earn the chat-collapse. Collapsing those would add friction
    // without saving real-estate.
    const smallBody = "**alerts**\n\nfoo bar";
    const messages = [
      {
        id: "share-small",
        ts: new Date().toISOString(),
        role_id: null,
        kind: "ai_text",
        body: smallBody,
        tool_name: "share_data",
        tool_args: { label: "alerts", data: "..." },
        workstream_id: null,
        mentions: [],
      },
    ];
    render(<Transcript messages={messages} roles={ROLES} />);
    // No "Data brief" collapse chrome and no "Show … lines"
    // button — the body just renders inline like any other AI
    // message.
    expect(screen.queryByText("▤ DATA BRIEF")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /show \d+ lines/i }),
    ).not.toBeInTheDocument();
    // Body content visible without expanding.
    expect(screen.getByText(/foo bar/)).toBeInTheDocument();
  });

  it("share_data preview strips surrounding ``**bold**`` cleanly (no orphan asterisks)", () => {
    // QA review MEDIUM M-1: ``derivePreview`` used to apply the
    // leading-marker strip BEFORE the surrounding-bold strip — the
    // ``*`` in the marker character class ate the leading ``**``,
    // leaving the trailing ``**`` orphaned. Result: previews
    // rendered as ``Defender telemetry — 03:14 UTC**`` AND the
    // label-skip dedupe failed (lowercased forms no longer matched
    // the label). This test pins the fix so the regex order can't
    // silently revert.
    //
    // The body's first line ``**Defender telemetry — 03:14 UTC**``
    // matches the label exactly, so a correct preview routine skips
    // it and lands on a later line. A buggy routine emits the line
    // verbatim with trailing asterisks. Asserting NO ``**`` appears
    // anywhere in the preview line catches the bug regardless of
    // which line is chosen.
    const body =
      "**Defender telemetry — 03:14 UTC**\n\n" +
      "Looking at 4h window; 12 alerts pulled. " +
      "alert line foo bar baz\n".repeat(20);
    const messages = [
      {
        id: "share-preview",
        ts: new Date().toISOString(),
        role_id: null,
        kind: "ai_text",
        body,
        tool_name: "share_data",
        tool_args: { label: "Defender telemetry — 03:14 UTC", data: "..." },
        workstream_id: null,
        mentions: [],
      },
    ];
    const { container } = render(<Transcript messages={messages} roles={ROLES} />);
    // The preview line lives in a ``line-clamp-1`` paragraph inside
    // the collapsed card. Find it and check no ``**`` cruft.
    const previews = container.querySelectorAll("p.line-clamp-1");
    expect(previews.length).toBeGreaterThan(0);
    for (const p of previews) {
      expect(p.textContent).not.toContain("**");
    }
  });

  it("share_data with missing tool_args.label falls back to 'Data shared'", () => {
    // QA review LOW L-2: an AI emission with ``tool_name=share_data``
    // but no ``tool_args.label`` (or ``tool_args=null``) is a
    // realistic shape from a malformed call. The collapsed card
    // should render with the fallback string instead of an empty
    // header.
    const longBody = "alert line foo bar baz\n".repeat(40);
    const messages = [
      {
        id: "share-no-label",
        ts: new Date().toISOString(),
        role_id: null,
        kind: "ai_text",
        body: longBody,
        tool_name: "share_data",
        tool_args: null,
        workstream_id: null,
        mentions: [],
      },
    ];
    render(<Transcript messages={messages} roles={ROLES} />);
    expect(screen.getByText("▤ DATA BRIEF")).toBeInTheDocument();
    expect(screen.getByText("Data shared")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /show \d+ lines/i }),
    ).toBeInTheDocument();
  });

  it("focus-hit share_data demotes card chrome to neutral (avoids amber + cyan stacking)", () => {
    // UI/UX review HIGH H1: when a substantial share_data is also
    // the latest AI bubble being awaited (focus-hit warn border)
    // OR @-mentions the viewer (signal blue border), the bubble
    // already carries an accent color. Stacking the cyan card
    // chrome on top would re-introduce the same noise problem the
    // yellow-cleanup commit specifically aimed to remove. The
    // ``accent="neutral"`` branch demotes the DATA BRIEF tag to
    // ink-300 and the button to a neutral ink palette so the outer
    // bubble border alone carries the semantic.
    const longBody = "**Big share**\n\n" + "data line\n".repeat(40);
    const messages = [
      {
        id: "share-focus",
        ts: new Date().toISOString(),
        role_id: null,
        kind: "ai_text",
        body: longBody,
        tool_name: "share_data",
        tool_args: { label: "Big share", data: "..." },
        workstream_id: null,
        mentions: [],
      },
    ];
    const { container } = render(
      <Transcript messages={messages} roles={ROLES} highlightLastAi />,
    );
    // The DATA BRIEF tag should NOT carry text-info on a focus-hit
    // bubble. ``getByText`` returns the span; check its className.
    const tag = screen.getByText("▤ DATA BRIEF");
    expect(tag.className).not.toContain("text-info");
    expect(tag.className).toContain("text-ink-300");
    // Confirm the outer bubble retained the warn border (the
    // focus-hit semantic is intact — only the card chrome demoted).
    const bubble = container
      .querySelector("#msg-share-focus")
      ?.querySelector('[data-message-kind="ai"]');
    expect(bubble?.className).toContain("border-warn");
  });
});
