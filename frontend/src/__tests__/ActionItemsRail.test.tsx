import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageView, RoleView, WorkstreamView } from "../api/client";
import { ActionItemsRail } from "../components/ActionItemsRail";

const ROLES: RoleView[] = [
  {
    id: "role-ciso",
    label: "CISO",
    display_name: "Alex",
    kind: "player",
    is_creator: false,
    token_version: 0,
  },
];

const WORKSTREAMS: WorkstreamView[] = [
  {
    id: "main",
    label: "main",
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

describe("ActionItemsRail — status badge tones", () => {
  it("renders the REPLIED (in_progress) badge in info-cyan, not warn-yellow", () => {
    // Color-cleanup PR (QA review HIGH): the in_progress status
    // badge used to wear ``border-warn bg-warn-bg text-warn``
    // (yellow). With the awaiting-response chip claiming yellow as
    // the unique "you owe a turn answer" signal, in-progress action
    // items moved to the info (cyan) tone — they're status, not
    // warnings. This regression net pins the new tone so a future
    // revert can't slip back.
    //
    // The badge labelled "REPLIED" is rendered when an
    // ``address_role`` ask has a subsequent player message from the
    // addressed role; we construct exactly that sequence below.
    const messages: MessageView[] = [
      msg({
        id: "m1",
        ts: "2026-05-04T13:51:00Z",
        kind: "ai_text",
        body: "CISO — what's your call?",
        tool_name: "address_role",
        tool_args: { role_id: "role-ciso", message: "what's your call?" },
        workstream_id: "main",
      }),
      msg({
        id: "m2",
        ts: "2026-05-04T13:52:00Z",
        kind: "player",
        body: "Recommend isolating the segment.",
        role_id: "role-ciso",
        workstream_id: "main",
      }),
    ];
    render(
      <ActionItemsRail
        messages={messages}
        roles={ROLES}
        workstreams={WORKSTREAMS}
      />,
    );
    const badge = screen.getByText("REPLIED");
    expect(badge.className).toContain("border-info");
    expect(badge.className).toContain("bg-info-bg");
    expect(badge.className).toContain("text-info");
    expect(badge.className).not.toContain("border-warn");
    expect(badge.className).not.toContain("bg-warn-bg");
    expect(badge.className).not.toContain("text-warn");
  });

  it("renders the OPEN (not yet replied) badge in neutral ink tone", () => {
    // The ``open`` status keeps a neutral slate-gray treatment;
    // pinning it here so a future "let's just make everything
    // yellow when nothing's happened" regression gets caught.
    const messages: MessageView[] = [
      msg({
        id: "m1",
        ts: "2026-05-04T13:51:00Z",
        kind: "ai_text",
        body: "CISO — what's your call?",
        tool_name: "address_role",
        tool_args: { role_id: "role-ciso", message: "what's your call?" },
        workstream_id: "main",
      }),
    ];
    render(
      <ActionItemsRail
        messages={messages}
        roles={ROLES}
        workstreams={WORKSTREAMS}
      />,
    );
    const badge = screen.getByText("OPEN");
    expect(badge.className).toContain("border-ink-500");
    expect(badge.className).not.toContain("border-warn");
    expect(badge.className).not.toContain("text-warn");
  });
});
