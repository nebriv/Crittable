import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { MessageView, WorkstreamView } from "../api/client";
import { TranscriptFilters } from "../components/TranscriptFilters";
import { DEFAULT_FILTER, FilterState } from "../lib/transcriptFilters";

const SELF = "role-soc";

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
  partial: Partial<MessageView> & Pick<MessageView, "id" | "kind" | "ts">,
): MessageView {
  return {
    role_id: null,
    body: "",
    tool_name: null,
    tool_args: null,
    workstream_id: null,
    mentions: [],
    ...partial,
  };
}

const MESSAGES: MessageView[] = [
  msg({
    id: "m1",
    kind: "ai_text",
    ts: "2026-05-04T14:00:00Z",
    body: "@SOC isolate",
    workstream_id: "containment",
    mentions: ["role-soc"],
  }),
  msg({
    id: "m2",
    kind: "ai_text",
    ts: "2026-05-04T14:01:00Z",
    body: "@Comms statement",
    workstream_id: "comms",
    mentions: ["role-comms"],
  }),
  msg({
    id: "m3",
    kind: "critical_inject",
    ts: "2026-05-04T14:01:30Z",
    body: "Reporter call",
  }),
];

function Harness({
  initialState = DEFAULT_FILTER,
  workstreams = WORKSTREAMS,
}: {
  initialState?: FilterState;
  workstreams?: WorkstreamView[];
}) {
  const [state, setState] = useState<FilterState>(initialState);
  return (
    <TranscriptFilters
      messages={MESSAGES}
      workstreams={workstreams}
      selfRoleId={SELF}
      state={state}
      onChange={setState}
    />
  );
}

describe("TranscriptFilters", () => {
  it("renders pills with counts in declared order", () => {
    render(<Harness />);
    // Pills carry their count in the aria-label for screen readers.
    expect(screen.getByRole("button", { name: /^All \(3\)$/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Mentions of you \(1\)/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Critical \(1\)$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Containment \(1\)$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Comms \(1\)$/ })).toBeInTheDocument();
  });

  it("hides the workstream-pill row when no workstreams declared", () => {
    render(<Harness workstreams={[]} />);
    expect(screen.queryByText("AND")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Containment/ })).not.toBeInTheDocument();
  });

  it("flips quality-pill aria-pressed when clicked", () => {
    render(<Harness />);
    const me = screen.getByRole("button", { name: /Mentions of you/ });
    expect(me).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(me);
    expect(me).toHaveAttribute("aria-pressed", "true");
    // 'All' should have flipped to false.
    expect(
      screen.getByRole("button", { name: /^All / }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("track pills toggle independently and accumulate", () => {
    render(<Harness />);
    const cont = screen.getByRole("button", { name: /^Containment / });
    const comms = screen.getByRole("button", { name: /^Comms / });
    fireEvent.click(cont);
    fireEvent.click(comms);
    expect(cont).toHaveAttribute("aria-pressed", "true");
    expect(comms).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(cont);
    expect(cont).toHaveAttribute("aria-pressed", "false");
    expect(comms).toHaveAttribute("aria-pressed", "true");
  });

  it("'Reset filters' link clears any active filter", () => {
    render(<Harness initialState={{ quality: "critical", tracks: new Set() }} />);
    // Two buttons match "clear all transcript filters" once the
    // hidden-mentions banner is showing (the row-level link + the
    // banner-level link). We want the row-level one — it's the first
    // match in DOM order. ``getAllByRole``[0] is robust to both.
    const buttons = screen.getAllByRole("button", {
      name: /clear all transcript filters/i,
    });
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(buttons[0]);
    expect(screen.getByRole("button", { name: /^All / })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /^Critical / })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("renders the hidden-mentions banner when current filter hides a mention-of-self", () => {
    render(<Harness initialState={{ quality: "critical", tracks: new Set() }} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/1 @-mention for you hidden/);
    expect(status).toHaveTextContent(/Critical/);
    // User-persona review H3: banner offers TWO recovery actions —
    // "Show those" (jumps to @Me) and "Reset filters" (nukes
    // everything). Verify both are present and the jump action
    // routes to the @Me filter rather than clearing.
    const showThose = within(status).getByRole("button", {
      name: /switch filter to mentions of you/i,
    });
    fireEvent.click(showThose);
    // After "Show those", the @Me pill is pressed.
    expect(
      screen.getByRole("button", { name: /Mentions of you/ }),
    ).toHaveAttribute("aria-pressed", "true");
    // Banner is gone (m1 — the only mention — is now visible under
    // the @Me filter).
    expect(screen.queryByText(/@-mentions? for you hidden/)).toBeNull();
  });

  it("hidden-mentions banner 'Reset filters' button clears the filter", () => {
    render(<Harness initialState={{ quality: "critical", tracks: new Set() }} />);
    const status = screen.getByRole("status");
    const reset = within(status).getByRole("button", {
      name: /clear all transcript filters/i,
    });
    fireEvent.click(reset);
    expect(screen.getByRole("button", { name: /^All / })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("does not render the hidden-mentions banner on the default filter", () => {
    render(<Harness />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
