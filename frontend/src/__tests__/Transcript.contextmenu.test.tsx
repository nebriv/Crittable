import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MessageView, RoleView, WorkstreamView } from "../api/client";
import { Transcript } from "../components/Transcript";

const ROLES: RoleView[] = [
  {
    id: "role-author",
    label: "IR Lead",
    display_name: "Sam",
    kind: "player",
    is_creator: false,
    token_version: 0,
  },
  {
    id: "role-other",
    label: "Comms",
    display_name: "Bo",
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

describe("Transcript — workstream contextmenu (chat-declutter polish)", () => {
  it("creator can right-click any bubble to fire onMessageContextMenu", () => {
    const onCtx = vi.fn();
    const messages: MessageView[] = [
      msg({
        id: "m1",
        kind: "player",
        ts: "2026-05-04T14:00:00Z",
        body: "hi",
        role_id: "role-author",
        workstream_id: "containment",
      }),
    ];
    render(
      <Transcript
        messages={messages}
        roles={ROLES}
        workstreams={WORKSTREAMS}
        viewerIsCreator={true}
        selfAuthoredRoleIds={null}
        onMessageContextMenu={onCtx}
      />,
    );
    const article = document.getElementById("msg-m1")!;
    fireEvent.contextMenu(article);
    expect(onCtx).toHaveBeenCalledTimes(1);
    expect(onCtx).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "m1",
        workstreamId: "containment",
      }),
    );
  });

  it("non-creator can right-click their OWN bubble", () => {
    const onCtx = vi.fn();
    const messages: MessageView[] = [
      msg({
        id: "m1",
        kind: "player",
        ts: "2026-05-04T14:00:00Z",
        body: "hi",
        role_id: "role-author",
      }),
    ];
    render(
      <Transcript
        messages={messages}
        roles={ROLES}
        workstreams={WORKSTREAMS}
        viewerIsCreator={false}
        selfAuthoredRoleIds={new Set(["role-author"])}
        onMessageContextMenu={onCtx}
      />,
    );
    fireEvent.contextMenu(document.getElementById("msg-m1")!);
    expect(onCtx).toHaveBeenCalledTimes(1);
  });

  it("non-creator CANNOT right-click someone else's bubble", () => {
    const onCtx = vi.fn();
    const messages: MessageView[] = [
      msg({
        id: "m1",
        kind: "player",
        ts: "2026-05-04T14:00:00Z",
        body: "hi",
        role_id: "role-other",
      }),
    ];
    render(
      <Transcript
        messages={messages}
        roles={ROLES}
        workstreams={WORKSTREAMS}
        viewerIsCreator={false}
        selfAuthoredRoleIds={new Set(["role-author"])}
        onMessageContextMenu={onCtx}
      />,
    );
    // The default browser contextmenu fires; our handler bails out.
    fireEvent.contextMenu(document.getElementById("msg-m1")!);
    expect(onCtx).not.toHaveBeenCalled();
  });

  it("renders the keyboard '...' affordance only for messages the viewer may re-tag", () => {
    const messages: MessageView[] = [
      msg({
        id: "m-own",
        kind: "player",
        ts: "2026-05-04T14:00:00Z",
        body: "mine",
        role_id: "role-author",
      }),
      msg({
        id: "m-other",
        kind: "player",
        ts: "2026-05-04T14:01:00Z",
        body: "theirs",
        role_id: "role-other",
      }),
    ];
    render(
      <Transcript
        messages={messages}
        roles={ROLES}
        workstreams={WORKSTREAMS}
        viewerIsCreator={false}
        selfAuthoredRoleIds={new Set(["role-author"])}
        onMessageContextMenu={() => {}}
      />,
    );
    const ownTrigger = document
      .getElementById("msg-m-own")!
      .querySelector("button[aria-label='Move to workstream']");
    const otherTrigger = document
      .getElementById("msg-m-other")!
      .querySelector("button[aria-label='Move to workstream']");
    expect(ownTrigger).not.toBeNull();
    expect(otherTrigger).toBeNull();
  });
});
