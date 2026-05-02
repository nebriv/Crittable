import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSessionTitle,
  DEFAULT_TITLE,
  PENDING_MARKER,
  useSessionTitle,
} from "../lib/useSessionTitle";

// The hook drives ``document.title`` — a pure-function compositor
// (``buildSessionTitle``) is the load-bearing primitive; the hook
// just calls it inside a React effect. We test the pure function
// thoroughly + a few render-time integration cases for the hook.

describe("buildSessionTitle", () => {
  it("returns just the brand when nothing is pending and no state", () => {
    expect(buildSessionTitle({ pending: false, state: null })).toBe(
      DEFAULT_TITLE,
    );
    expect(buildSessionTitle({ pending: false, state: undefined })).toBe(
      DEFAULT_TITLE,
    );
  });

  it("prepends the marker when pending without a state label", () => {
    // Edge case — should still surface the dot so a backgrounded tab
    // can see "you owe an action" even when we don't have a state
    // label to show.
    expect(buildSessionTitle({ pending: true, state: null })).toBe(
      `${PENDING_MARKER} ${DEFAULT_TITLE}`,
    );
  });

  it("renders state — brand without a marker when not pending", () => {
    expect(buildSessionTitle({ pending: false, state: "AI thinking" })).toBe(
      `AI thinking — ${DEFAULT_TITLE}`,
    );
  });

  it("renders marker + state — brand when pending with a label", () => {
    // The canonical "your turn" form: dot first so it's visible in
    // truncated tab titles, label second, brand last.
    expect(buildSessionTitle({ pending: true, state: "Your turn" })).toBe(
      `${PENDING_MARKER} Your turn — ${DEFAULT_TITLE}`,
    );
  });

  it("uses U+25CF for the marker (renders consistently across platform fonts)", () => {
    // Lock the marker codepoint — substituting a fancy glyph would
    // tofu on default Linux fonts, defeating the cue.
    expect(PENDING_MARKER).toBe("●");
  });

  it("treats empty-string state as no state (collapses to brand)", () => {
    // A future caller passing an empty string from a falsy branch
    // shouldn't render a stray dash.
    expect(buildSessionTitle({ pending: false, state: "" })).toBe(
      DEFAULT_TITLE,
    );
    expect(buildSessionTitle({ pending: true, state: "" })).toBe(
      `${PENDING_MARKER} ${DEFAULT_TITLE}`,
    );
  });

  it("locks the canonical state-label literals (regression net for silent rewrites)", () => {
    // These labels are read aloud by screen readers on tab-title-change
    // and visible in the OS tab strip — a silent rewrite ("Setup" →
    // "Brief") would land without test failure unless the literals are
    // pinned somewhere. The set below is the union of state labels
    // emitted by Play.tsx and Facilitator.tsx (see ``titleSignal`` in
    // each).
    const labels = [
      "Your turn",
      "AI thinking",
      "Submitted",
      "Briefing",
      "Setup",
      "Setup · AI thinking",
      "Ready",
      "Ready to start",
      "Waiting on roles",
      "Initializing",
      "Ended",
    ];
    for (const label of labels) {
      expect(buildSessionTitle({ pending: false, state: label })).toBe(
        `${label} — ${DEFAULT_TITLE}`,
      );
    }
  });
});

// ---------------------------------------------------------------------
// Hook integration tests — render a tiny component that calls the hook
// and assert on ``document.title`` after each render.

interface HarnessProps {
  pending: boolean;
  state?: string | null;
}

function Harness({ pending, state }: HarnessProps) {
  useSessionTitle({ pending, state });
  return <div data-testid="probe">probe</div>;
}

describe("useSessionTitle (hook integration)", () => {
  let originalTitle: string;
  beforeEach(() => {
    originalTitle = document.title;
    document.title = "";
  });
  afterEach(() => {
    document.title = originalTitle;
  });

  it("sets the title on initial mount", () => {
    render(<Harness pending={true} state="Your turn" />);
    expect(document.title).toBe(`${PENDING_MARKER} Your turn — ${DEFAULT_TITLE}`);
  });

  it("updates the title when pending flips", () => {
    const { rerender } = render(<Harness pending={false} state="AI thinking" />);
    expect(document.title).toBe(`AI thinking — ${DEFAULT_TITLE}`);
    rerender(<Harness pending={true} state="Your turn" />);
    expect(document.title).toBe(`${PENDING_MARKER} Your turn — ${DEFAULT_TITLE}`);
  });

  it("updates the title when state changes", () => {
    const { rerender } = render(<Harness pending={false} state="Setup" />);
    expect(document.title).toBe(`Setup — ${DEFAULT_TITLE}`);
    rerender(<Harness pending={false} state="Briefing" />);
    expect(document.title).toBe(`Briefing — ${DEFAULT_TITLE}`);
  });

  it("restores the default title on unmount", () => {
    // A route change (Play → Home) shouldn't leave a stale "● Your
    // turn" hanging in the tab. Cleanup must reset to the brand.
    const { unmount } = render(<Harness pending={true} state="Your turn" />);
    expect(document.title).toBe(`${PENDING_MARKER} Your turn — ${DEFAULT_TITLE}`);
    unmount();
    expect(document.title).toBe(DEFAULT_TITLE);
  });

  it("collapses to just the brand when state is null and nothing pending", () => {
    render(<Harness pending={false} state={null} />);
    expect(document.title).toBe(DEFAULT_TITLE);
  });
});
