import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageView, RoleView, WorkstreamView } from "../api/client";
import { Transcript } from "../components/Transcript";

const ROLES: RoleView[] = [
  {
    id: "role-soc",
    label: "SOC",
    display_name: "Bo",
    kind: "player",
    is_creator: false,
    token_version: 0,
  },
  {
    id: "role-ciso",
    label: "CISO",
    display_name: "Alex",
    kind: "player",
    is_creator: true,
    token_version: 0,
  },
];

const WORKSTREAMS: WorkstreamView[] = [
  {
    id: "containment",
    label: "Containment",
    lead_role_id: null,
    state: "open",
    created_at: "2026-05-04T13:50:00Z",
    closed_at: null,
  },
  {
    id: "comms",
    label: "Comms",
    lead_role_id: null,
    state: "open",
    created_at: "2026-05-04T13:50:00Z",
    closed_at: null,
  },
];

function msg(
  partial: Partial<MessageView> & Pick<MessageView, "id" | "kind" | "ts" | "body">,
): MessageView {
  return {
    role_id: null,
    tool_name: null,
    tool_args: null,
    workstream_id: null,
    mentions: [],
    ...partial,
  };
}

describe("Transcript — workstream chrome (Phase B)", () => {
  it("stamps `data-workstream-id` on AI bubbles for declared workstreams", () => {
    const messages: MessageView[] = [
      msg({
        id: "m1",
        kind: "ai_text",
        ts: "2026-05-04T14:00:00Z",
        body: "@SOC isolate now",
        workstream_id: "containment",
        mentions: ["role-soc"],
      }),
    ];
    render(
      <Transcript messages={messages} roles={ROLES} workstreams={WORKSTREAMS} />,
    );
    const article = document.getElementById("msg-m1");
    expect(article).not.toBeNull();
    expect(article?.getAttribute("data-workstream-id")).toBe("containment");
  });

  it("renders the @YOU badge when mentions includes selfRoleId", () => {
    // Plan §5.1 — the badge is gated on the structural ``mentions[]``
    // list, NOT body regex. Even though the body says "@SOC", what
    // drives the badge is the AI dispatch stamping ``mentions=["role-soc"]``.
    const messages: MessageView[] = [
      msg({
        id: "m1",
        kind: "ai_text",
        ts: "2026-05-04T14:00:00Z",
        body: "isolate the affected segment",
        workstream_id: "containment",
        mentions: ["role-soc"],
      }),
    ];
    render(
      <Transcript
        messages={messages}
        roles={ROLES}
        workstreams={WORKSTREAMS}
        selfRoleId="role-soc"
      />,
    );
    const article = document.getElementById("msg-m1")!;
    expect(within(article).getByText("@YOU")).toBeInTheDocument();
  });

  it("does NOT render the @YOU badge when mentions is empty (no body regex)", () => {
    // Even though the body literally contains "@you" or "@SOC" text,
    // the highlight is structural — empty ``mentions`` ⇒ no badge.
    const messages: MessageView[] = [
      msg({
        id: "m1",
        kind: "ai_text",
        ts: "2026-05-04T14:00:00Z",
        body: "@SOC @you please respond",
        mentions: [],
      }),
    ];
    render(
      <Transcript
        messages={messages}
        roles={ROLES}
        workstreams={WORKSTREAMS}
        selfRoleId="role-soc"
      />,
    );
    expect(screen.queryByText("@YOU")).toBeNull();
  });

  it("emits a synthetic 'opened by' landmark before the first message of a track", () => {
    // Two messages in containment, one in comms. Two landmarks
    // expected: one before m1 (containment-open) and one before m3
    // (comms-open). m2 stays inside containment so no second landmark
    // for it.
    const messages: MessageView[] = [
      msg({
        id: "m1",
        kind: "ai_text",
        ts: "2026-05-04T14:00:00Z",
        body: "@SOC isolate",
        workstream_id: "containment",
        mentions: ["role-soc"],
        role_id: null,
      }),
      msg({
        id: "m2",
        kind: "player",
        ts: "2026-05-04T14:00:30Z",
        role_id: "role-soc",
        body: "isolating",
        workstream_id: "containment",
      }),
      msg({
        id: "m3",
        kind: "ai_text",
        ts: "2026-05-04T14:01:00Z",
        body: "@CISO statement",
        workstream_id: "comms",
        mentions: ["role-ciso"],
      }),
    ];
    render(
      <Transcript messages={messages} roles={ROLES} workstreams={WORKSTREAMS} />,
    );
    expect(screen.getByText(/#Containment/)).toBeInTheDocument();
    expect(screen.getByText(/#Comms/)).toBeInTheDocument();
    // The "opened by" copy fires for both.
    const openedBy = screen.getAllByText(/opened by/);
    expect(openedBy.length).toBe(2);
  });

  it("renders sticky minute-anchor rows at minute boundaries", () => {
    const messages: MessageView[] = [
      msg({
        id: "m1",
        kind: "ai_text",
        ts: "2026-05-04T14:00:00Z",
        body: "first",
      }),
      msg({
        id: "m2",
        kind: "ai_text",
        ts: "2026-05-04T14:00:45Z",
        body: "second",
      }),
      msg({
        id: "m3",
        kind: "ai_text",
        ts: "2026-05-04T14:01:00Z",
        body: "third",
      }),
    ];
    const { container } = render(
      <Transcript messages={messages} roles={ROLES} workstreams={[]} />,
    );
    // One anchor per minute boundary crossed. m1 starts a new minute
    // (always — first message), m3 crosses into the next minute. m2
    // stays in the same minute as m1, so no new anchor.
    const stickyAnchors = container.querySelectorAll(".sticky.top-0");
    expect(stickyAnchors.length).toBe(2);
  });

  it("falls back to slate stripe for unscoped messages", () => {
    const messages: MessageView[] = [
      msg({
        id: "m1",
        kind: "ai_text",
        ts: "2026-05-04T14:00:00Z",
        body: "general broadcast",
        workstream_id: null,
      }),
    ];
    render(
      <Transcript messages={messages} roles={ROLES} workstreams={WORKSTREAMS} />,
    );
    const article = document.getElementById("msg-m1");
    // ``data-workstream-id`` is the empty string when unscoped. The
    // stripe color is decided in JS — no easy DOM assertion for the
    // exact oklch value, but the fact that the article carries
    // ``data-workstream-id=""`` confirms the unscoped path landed.
    expect(article?.getAttribute("data-workstream-id")).toBe("");
  });
});
