import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSessionTitle,
  DEFAULT_TITLE,
  FAVICON_DEFAULT_HREF,
  FAVICON_PENDING_HREF,
  PENDING_MARKER,
  setFaviconPending,
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

// ---------------------------------------------------------------------
// Favicon swap — the SVG ``link[rel=icon]`` href should toggle between
// the default mark and the amber-badge variant in lockstep with
// ``pending``. Test the helper directly + integration through the hook.

function installFaviconLink(initialHref: string): HTMLLinkElement {
  // jsdom doesn't honor index.html — every test installs its own
  // fake link so the helper has something to query.
  const existing = document.querySelector<HTMLLinkElement>(
    'link[rel="icon"][type="image/svg+xml"]',
  );
  if (existing) existing.remove();
  const link = document.createElement("link");
  link.rel = "icon";
  link.type = "image/svg+xml";
  link.href = initialHref;
  document.head.appendChild(link);
  return link;
}

function removeFaviconLink(): void {
  const link = document.querySelector<HTMLLinkElement>(
    'link[rel="icon"][type="image/svg+xml"]',
  );
  if (link) link.remove();
}

function currentFaviconHref(): string | null {
  const link = document.querySelector<HTMLLinkElement>(
    'link[rel="icon"][type="image/svg+xml"]',
  );
  if (!link) return null;
  // ``link.href`` is the resolved absolute URL — pull the path so the
  // assertion is host-agnostic.
  return new URL(link.href).pathname;
}

describe("setFaviconPending", () => {
  beforeEach(() => {
    installFaviconLink(FAVICON_DEFAULT_HREF);
  });
  afterEach(() => {
    removeFaviconLink();
  });

  it("swaps the SVG favicon href to the pending variant", () => {
    setFaviconPending(true);
    expect(currentFaviconHref()).toBe(FAVICON_PENDING_HREF);
  });

  it("restores the default SVG favicon when pending=false", () => {
    setFaviconPending(true);
    setFaviconPending(false);
    expect(currentFaviconHref()).toBe(FAVICON_DEFAULT_HREF);
  });

  it("no-ops when the SVG link element is absent", () => {
    // Test environment without the index.html: the helper must not
    // throw — a missing favicon is a soft failure (PNGs / .ico still
    // render fine, just without the badge).
    removeFaviconLink();
    expect(() => setFaviconPending(true)).not.toThrow();
    expect(() => setFaviconPending(false)).not.toThrow();
    expect(currentFaviconHref()).toBeNull();
  });

  it("skips the DOM write when the href is already the requested value", () => {
    // Cheap repaint guard for the rapid-state-thrash case (chunk
    // boundaries flipping pending on/off). We can't observe browser
    // repaints in jsdom, so we observe that ``link.href`` isn't
    // re-assigned by spying on the setter. The instance-level
    // ``Object.defineProperty`` shadows the prototype ``href``
    // descriptor on this one element only — no global state to
    // restore (the link is removed in ``afterEach``).
    const link = installFaviconLink(FAVICON_DEFAULT_HREF);
    let writeCount = 0;
    Object.defineProperty(link, "href", {
      configurable: true,
      get() {
        return `http://localhost${FAVICON_DEFAULT_HREF}`;
      },
      set() {
        writeCount += 1;
      },
    });
    setFaviconPending(false);
    expect(writeCount).toBe(0);
  });
});

describe("useSessionTitle (favicon integration)", () => {
  let savedTitle: string;
  beforeEach(() => {
    savedTitle = document.title;
    installFaviconLink(FAVICON_DEFAULT_HREF);
  });
  afterEach(() => {
    // Reset title and link so this suite doesn't bleed state into
    // other test files that read ``document.title`` or the favicon.
    document.title = savedTitle;
    removeFaviconLink();
  });

  it("swaps the favicon when pending fires", () => {
    const { rerender } = render(
      <Harness pending={false} state="AI thinking" />,
    );
    expect(currentFaviconHref()).toBe(FAVICON_DEFAULT_HREF);
    rerender(<Harness pending={true} state="Your turn" />);
    expect(currentFaviconHref()).toBe(FAVICON_PENDING_HREF);
  });

  it("sets the pending favicon when mounted already pending", () => {
    // Real Play.tsx mount with cached state hits this — the user's
    // first paint after a refresh is on a turn already waiting on
    // them. The ``false→true`` test above doesn't cover the
    // initial-mount-with-pending=true path.
    render(<Harness pending={true} state="Your turn" />);
    expect(currentFaviconHref()).toBe(FAVICON_PENDING_HREF);
  });

  it("doesn't re-write the favicon when only the state label changes", () => {
    // The hook's effect deps include ``opts.state``, so a state-only
    // change re-runs the effect. The helper's
    // ``link.href.endsWith(href)`` guard should keep this from
    // touching the DOM. This regression test catches a future change
    // that drops the guard at the helper layer.
    const { rerender } = render(<Harness pending={true} state="Your turn" />);
    const link = document.querySelector<HTMLLinkElement>(
      'link[rel="icon"][type="image/svg+xml"]',
    );
    if (!link) throw new Error("test setup: favicon link missing");
    let writeCount = 0;
    Object.defineProperty(link, "href", {
      configurable: true,
      get() {
        return `http://localhost${FAVICON_PENDING_HREF}`;
      },
      set() {
        writeCount += 1;
      },
    });
    // State changes but pending stays true — favicon should not be
    // re-written even though the effect re-runs.
    rerender(<Harness pending={true} state="Submitted" />);
    expect(writeCount).toBe(0);
  });

  it("restores the default favicon on unmount", () => {
    const { unmount } = render(
      <Harness pending={true} state="Your turn" />,
    );
    expect(currentFaviconHref()).toBe(FAVICON_PENDING_HREF);
    unmount();
    expect(currentFaviconHref()).toBe(FAVICON_DEFAULT_HREF);
  });
});
