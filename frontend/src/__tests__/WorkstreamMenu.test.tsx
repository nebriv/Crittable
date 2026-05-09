import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkstreamView } from "../api/client";
import { WorkstreamMenu } from "../components/WorkstreamMenu";

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

// Issue #162: required props for the per-message mute toggle. Default
// to "not hidden" + a no-op handler so the workstream-side cases stay
// focused on workstream behavior.
const MUTE_DEFAULTS = {
  hiddenFromAi: false,
  onToggleHiddenFromAi: () => {},
};

describe("WorkstreamMenu", () => {
  it("renders one entry per declared workstream + #main", () => {
    render(
      <WorkstreamMenu
        position={{ x: 100, y: 100 }}
        current={null}
        workstreams={WORKSTREAMS}
        onPick={() => {}}
        onClose={() => {}}
        {...MUTE_DEFAULTS}
      />,
    );
    expect(screen.getByText("#main (unscoped)")).toBeInTheDocument();
    expect(screen.getByText("#Containment")).toBeInTheDocument();
    expect(screen.getByText("#Comms")).toBeInTheDocument();
  });

  it("highlights the current workstream with a check", () => {
    render(
      <WorkstreamMenu
        position={{ x: 100, y: 100 }}
        current="containment"
        workstreams={WORKSTREAMS}
        onPick={() => {}}
        onClose={() => {}}
        {...MUTE_DEFAULTS}
      />,
    );
    // The check glyph appears once next to the active row.
    const check = screen.getByText("✓");
    expect(check).toBeInTheDocument();
  });

  it("invokes onPick(null) when #main is selected", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(
      <WorkstreamMenu
        position={{ x: 100, y: 100 }}
        current="containment"
        workstreams={WORKSTREAMS}
        onPick={onPick}
        onClose={onClose}
        {...MUTE_DEFAULTS}
      />,
    );
    fireEvent.click(screen.getByText("#main (unscoped)"));
    expect(onPick).toHaveBeenCalledWith(null);
    expect(onClose).toHaveBeenCalled();
  });

  it("invokes onPick(id) when a workstream is selected", () => {
    const onPick = vi.fn();
    render(
      <WorkstreamMenu
        position={{ x: 100, y: 100 }}
        current={null}
        workstreams={WORKSTREAMS}
        onPick={onPick}
        onClose={() => {}}
        {...MUTE_DEFAULTS}
      />,
    );
    fireEvent.click(screen.getByText("#Containment"));
    expect(onPick).toHaveBeenCalledWith("containment");
  });

  it("returns null when position is null (closed state)", () => {
    const { container } = render(
      <WorkstreamMenu
        position={null}
        current={null}
        workstreams={WORKSTREAMS}
        onPick={() => {}}
        onClose={() => {}}
        {...MUTE_DEFAULTS}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("calls onClose on Escape", () => {
    const onClose = vi.fn();
    render(
      <WorkstreamMenu
        position={{ x: 100, y: 100 }}
        current={null}
        workstreams={WORKSTREAMS}
        onPick={() => {}}
        onClose={onClose}
        {...MUTE_DEFAULTS}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("renders an empty-state line when no workstreams declared", () => {
    render(
      <WorkstreamMenu
        position={{ x: 100, y: 100 }}
        current={null}
        workstreams={[]}
        onPick={() => {}}
        onClose={() => {}}
        {...MUTE_DEFAULTS}
      />,
    );
    expect(screen.getByText("No workstreams declared")).toBeInTheDocument();
  });

  // ---------------------------------------------- Issue #162: AI-mute toggle
  it("renders the Hidden from AI toggle in the unchecked state by default", () => {
    render(
      <WorkstreamMenu
        position={{ x: 100, y: 100 }}
        current={null}
        workstreams={WORKSTREAMS}
        onPick={() => {}}
        onClose={() => {}}
        hiddenFromAi={false}
        onToggleHiddenFromAi={() => {}}
      />,
    );
    const toggle = screen.getByTestId("hidden-from-ai-toggle");
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText("ON")).toBeNull();
  });

  it("marks the Hidden from AI toggle checked when the message is muted", () => {
    render(
      <WorkstreamMenu
        position={{ x: 100, y: 100 }}
        current={null}
        workstreams={WORKSTREAMS}
        onPick={() => {}}
        onClose={() => {}}
        hiddenFromAi={true}
        onToggleHiddenFromAi={() => {}}
      />,
    );
    const toggle = screen.getByTestId("hidden-from-ai-toggle");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("ON")).toBeInTheDocument();
  });

  it("invokes onToggleHiddenFromAi(true) and onClose when toggling on", () => {
    const onToggle = vi.fn();
    const onClose = vi.fn();
    render(
      <WorkstreamMenu
        position={{ x: 100, y: 100 }}
        current={null}
        workstreams={WORKSTREAMS}
        onPick={() => {}}
        onClose={onClose}
        hiddenFromAi={false}
        onToggleHiddenFromAi={onToggle}
      />,
    );
    fireEvent.click(screen.getByTestId("hidden-from-ai-toggle"));
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(onClose).toHaveBeenCalled();
  });

  it("invokes onToggleHiddenFromAi(false) when toggling off an already-muted message", () => {
    const onToggle = vi.fn();
    render(
      <WorkstreamMenu
        position={{ x: 100, y: 100 }}
        current={null}
        workstreams={WORKSTREAMS}
        onPick={() => {}}
        onClose={() => {}}
        hiddenFromAi={true}
        onToggleHiddenFromAi={onToggle}
      />,
    );
    fireEvent.click(screen.getByTestId("hidden-from-ai-toggle"));
    expect(onToggle).toHaveBeenCalledWith(false);
  });
});
