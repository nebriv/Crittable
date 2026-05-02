/**
 * Component tests for the right-rail collapsible wrapper.
 *
 * Pins the contract callers depend on: title is always visible, body
 * shows/hides on toggle, ``aria-expanded`` reflects state, and the
 * ``persistKey`` survives a remount (so a user's "I don't want to see
 * the placeholder HUD" preference doesn't reset on every page nav).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CollapsibleRailPanel } from "../components/brand/CollapsibleRailPanel";

describe("CollapsibleRailPanel", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("renders title and body when expanded by default", () => {
    render(
      <CollapsibleRailPanel title="HUD">
        <div data-testid="body">body content</div>
      </CollapsibleRailPanel>,
    );
    expect(screen.getByText("HUD")).toBeInTheDocument();
    expect(screen.getByTestId("body")).toBeInTheDocument();
  });

  it("hides body when defaultCollapsed is true", () => {
    render(
      <CollapsibleRailPanel title="HUD" defaultCollapsed>
        <div data-testid="body">body content</div>
      </CollapsibleRailPanel>,
    );
    expect(screen.queryByTestId("body")).toBeNull();
  });

  it("toggles body visibility on header click and reflects aria-expanded", () => {
    render(
      <CollapsibleRailPanel title="HUD">
        <div data-testid="body">body content</div>
      </CollapsibleRailPanel>,
    );
    const button = screen.getByRole("button", { name: /HUD/ });
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("body")).toBeInTheDocument();

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("body")).toBeNull();

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("body")).toBeInTheDocument();
  });

  it("persists collapsed state to localStorage when persistKey is set", () => {
    const key = "crittable.test.rail.collapsed";
    const { unmount } = render(
      <CollapsibleRailPanel title="HUD" persistKey={key}>
        <div data-testid="body">x</div>
      </CollapsibleRailPanel>,
    );
    fireEvent.click(screen.getByRole("button", { name: /HUD/ }));
    expect(window.localStorage.getItem(key)).toBe("1");
    unmount();
    // Remount — should pick up the stored "collapsed" state.
    render(
      <CollapsibleRailPanel title="HUD" persistKey={key}>
        <div data-testid="body">x</div>
      </CollapsibleRailPanel>,
    );
    expect(screen.queryByTestId("body")).toBeNull();
  });

  it("renders subtitle in warn tone when subtitleTone='warn'", () => {
    render(
      <CollapsibleRailPanel title="HUD" subtitle="placeholder" subtitleTone="warn">
        <div>body</div>
      </CollapsibleRailPanel>,
    );
    const subtitle = screen.getByText("placeholder");
    expect(subtitle).toBeInTheDocument();
    // Inline style sets ``color: var(--warn)``; jsdom returns the
    // raw token string. Asserting the style avoids snapshot brittleness.
    expect(subtitle.getAttribute("style") ?? "").toContain("var(--warn)");
  });
});
