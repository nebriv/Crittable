import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MessageView, RoleView, WorkstreamView } from "../api/client";
import { RightSidebar } from "../components/RightSidebar";

const ROLES: RoleView[] = [
  {
    id: "role-ir",
    label: "IR Lead",
    display_name: "Sam",
    kind: "player",
    is_creator: false,
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

describe("RightSidebar — 3-tab system (chat-declutter polish)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("renders the three tabs and selects Artifacts by default", () => {
    render(<RightSidebar messages={[]} roles={ROLES} workstreams={WORKSTREAMS} />);
    const tablist = screen.getAllByRole("tablist")[0];
    const tabs = tablist.querySelectorAll("button[role='tab']");
    const labels = Array.from(tabs).map((t) => t.textContent);
    expect(labels).toEqual(["Artifacts", "Action items", "Timeline"]);
    const artifactsTab = tablist.querySelector("button[id='rail-tab-artifacts']");
    expect(artifactsTab?.getAttribute("aria-selected")).toBe("true");
  });

  it("switches to the Action items tab on click", () => {
    render(<RightSidebar messages={[]} roles={ROLES} workstreams={WORKSTREAMS} />);
    const actionsTab = screen.getAllByRole("tab", { name: "Action items" })[0];
    fireEvent.click(actionsTab);
    expect(actionsTab.getAttribute("aria-selected")).toBe("true");
  });

  it("persists the active tab across renders via localStorage", () => {
    const { unmount } = render(
      <RightSidebar messages={[]} roles={ROLES} workstreams={WORKSTREAMS} />,
    );
    fireEvent.click(screen.getAllByRole("tab", { name: "Timeline" })[0]);
    unmount();
    render(<RightSidebar messages={[]} roles={ROLES} workstreams={WORKSTREAMS} />);
    const timelineTab = screen.getAllByRole("tab", { name: "Timeline" })[0];
    expect(timelineTab.getAttribute("aria-selected")).toBe("true");
  });

  it("Artifacts tab pins substantial share_data calls", () => {
    const longBody = "log dump: " + "X".repeat(400);
    const messages: MessageView[] = [
      msg({
        id: "m1",
        kind: "ai_text",
        ts: "2026-05-04T14:00:00Z",
        body: longBody,
        tool_name: "share_data",
        tool_args: { label: "EDR alert table" },
        workstream_id: "containment",
      }),
    ];
    render(
      <RightSidebar messages={messages} roles={ROLES} workstreams={WORKSTREAMS} />,
    );
    // Both the desktop aside and the mobile <details> render the same
    // body. Both should show the artifact title.
    const matches = screen.getAllByText("EDR alert table");
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("Action items tab surfaces address_role asks with status", () => {
    const messages: MessageView[] = [
      msg({
        id: "m1",
        kind: "ai_text",
        ts: "2026-05-04T14:00:00Z",
        body: "Sam, please isolate the affected segment",
        tool_name: "address_role",
        tool_args: { role_id: "role-ir", message: "isolate the segment" },
      }),
    ];
    render(
      <RightSidebar messages={messages} roles={ROLES} workstreams={WORKSTREAMS} />,
    );
    fireEvent.click(screen.getAllByRole("tab", { name: "Action items" })[0]);
    expect(screen.getAllByText("IR Lead").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/OPEN/).length).toBeGreaterThanOrEqual(1);
  });
});
