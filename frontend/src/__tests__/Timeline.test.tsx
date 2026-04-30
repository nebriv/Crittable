import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageView, RoleView } from "../api/client";
import { Timeline } from "../components/Timeline";

const ROLES: RoleView[] = [
  { id: "r1", label: "CISO", display_name: "Alex", kind: "player", token_version: 0, is_creator: true },
  { id: "r2", label: "SOC", display_name: "Bee", kind: "player", token_version: 0, is_creator: false },
];

function msg(over: Partial<MessageView>): MessageView {
  return {
    id: "m" + Math.random().toString(36).slice(2, 8),
    ts: "2026-04-30T10:00:00Z",
    role_id: null,
    kind: "ai_text",
    body: "",
    tool_name: null,
    tool_args: null,
    ...over,
  };
}

describe("Timeline", () => {
  it("shows the empty-state copy when no pin-worthy events have fired", () => {
    render(<Timeline messages={[]} roles={ROLES} />);
    expect(screen.getByText(/Key beats will appear here automatically/i)).toBeInTheDocument();
  });

  it("pins critical injects with the headline as title", () => {
    const messages = [
      msg({
        kind: "critical_inject",
        body: "Slack screenshot leaked",
        tool_args: { headline: "Media leak — Slack screenshot viral" },
      }),
    ];
    render(<Timeline messages={messages} roles={ROLES} />);
    expect(screen.getByText("Media leak — Slack screenshot viral")).toBeInTheDocument();
    expect(screen.getByText("Critical")).toBeInTheDocument();
  });

  it("pins pose_choice as a Decision with the role label + question", () => {
    const messages = [
      msg({
        kind: "ai_text",
        tool_name: "pose_choice",
        body: "**CISO** — pick one\n\n**A.** Isolate now\n**B.** Monitor 15 min",
        tool_args: { role_id: "r1", question: "Isolate or monitor?", options: ["Isolate now", "Monitor 15 min"] },
      }),
    ];
    render(<Timeline messages={messages} roles={ROLES} />);
    expect(screen.getByText(/CISO — Isolate or monitor\?/i)).toBeInTheDocument();
    expect(screen.getByText("Decision")).toBeInTheDocument();
  });

  it("pins substantial share_data dumps as Data brief", () => {
    const messages = [
      msg({
        kind: "ai_text",
        tool_name: "share_data",
        body: "**Defender telemetry — 03:14 UTC**\n\n" + "alert line ".repeat(60),
        tool_args: { label: "Defender telemetry — 03:14 UTC", data: "..." },
      }),
    ];
    render(<Timeline messages={messages} roles={ROLES} />);
    expect(screen.getByText("Defender telemetry — 03:14 UTC")).toBeInTheDocument();
    expect(screen.getByText("Data brief")).toBeInTheDocument();
  });

  it("does NOT pin a tiny share_data (below the chars threshold)", () => {
    const messages = [
      msg({
        kind: "ai_text",
        tool_name: "share_data",
        body: "**alerts**\n\nfoo",
        tool_args: { label: "alerts", data: "foo" },
      }),
    ];
    render(<Timeline messages={messages} roles={ROLES} />);
    expect(screen.queryByText("Data brief")).not.toBeInTheDocument();
    expect(screen.getByText(/Key beats will appear here/i)).toBeInTheDocument();
  });

  it("renders mixed pin types in transcript order", () => {
    const messages = [
      msg({
        id: "m1",
        kind: "system",
        body: "Session started",
      }),
      msg({
        id: "m2",
        kind: "ai_text",
        tool_name: "pose_choice",
        body: "options",
        tool_args: { role_id: "r1", question: "Decide?" },
      }),
      msg({
        id: "m3",
        kind: "critical_inject",
        body: "leak",
        tool_args: { headline: "Press leak" },
      }),
      msg({
        id: "m4",
        kind: "ai_text",
        tool_name: "share_data",
        body: "**alerts**\n\n" + "x".repeat(400),
        tool_args: { label: "Defender alert dump", data: "..." },
      }),
    ];
    render(<Timeline messages={messages} roles={ROLES} />);
    const tags = screen.getAllByText(/^(Critical|Pinned|Decision|Data brief|Lifecycle)$/);
    expect(tags.map((t) => t.textContent)).toEqual([
      "Lifecycle",
      "Decision",
      "Critical",
      "Data brief",
    ]);
  });

  it("auto-pins beat transitions when the AI broadcast mentions a new Beat N", () => {
    const messages = [
      msg({
        id: "m1",
        kind: "ai_text",
        tool_name: "broadcast",
        body: "**BEAT 1 — Detection & Triage**\n\nAlerts firing on finance laptops.",
      }),
      msg({
        id: "m2",
        kind: "ai_text",
        tool_name: "broadcast",
        body: "Defender confirms 5 hosts. Containment posture?", // no beat mention
      }),
      msg({
        id: "m3",
        kind: "ai_text",
        tool_name: "broadcast",
        body: "**BEAT 2 — Scope Assessment**\n\nIR Lead — your call?",
      }),
    ];
    render(<Timeline messages={messages} roles={ROLES} />);
    const titles = screen
      .getAllByText(/BEAT [12]/i)
      .map((el) => el.textContent);
    expect(titles).toContain("BEAT 1 — Detection & Triage");
    expect(titles).toContain("BEAT 2 — Scope Assessment");
    expect(screen.getAllByText("Beat")).toHaveLength(2);
  });

  it("does NOT pin a beat that's already been pinned (one entry per index)", () => {
    const messages = [
      msg({
        kind: "ai_text",
        tool_name: "broadcast",
        body: "**BEAT 2 — Containment**",
      }),
      msg({
        kind: "ai_text",
        tool_name: "broadcast",
        body: "We're still in Beat 2. Containment continues.", // re-mentions beat 2
      }),
      msg({
        kind: "ai_text",
        tool_name: "broadcast",
        body: "Phase 3 begins now.", // synonym; should pin
      }),
    ];
    render(<Timeline messages={messages} roles={ROLES} />);
    expect(screen.getAllByText("Beat")).toHaveLength(2);
    expect(screen.getByText("BEAT 2 — Containment")).toBeInTheDocument();
    expect(screen.getByText("Phase 3 begins now.")).toBeInTheDocument();
  });

  it("still renders legacy mark_timeline_point pins so old sessions read correctly", () => {
    const messages = [
      msg({
        kind: "ai_text",
        tool_name: "mark_timeline_point",
        body: "Beat 1 wrap",
        tool_args: { title: "Beat 1 — Triage complete" },
      }),
    ];
    render(<Timeline messages={messages} roles={ROLES} />);
    expect(screen.getByText("Beat 1 — Triage complete")).toBeInTheDocument();
    expect(screen.getByText("Pinned")).toBeInTheDocument();
  });
});
