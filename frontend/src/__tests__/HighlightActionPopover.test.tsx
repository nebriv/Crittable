/**
 * Component tests for the highlight-action popover (issue #98).
 *
 * Exercises the surface that the QA review on PR #115 flagged as
 * untested: selection detection, ``data-highlightable`` ancestor
 * walk, ``onSelect`` invocation, and Escape dismissal.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { HighlightActionPopover } from "../components/HighlightActionPopover";
import type { HighlightAction } from "../lib/highlightActions";

// jsdom's Range has no getBoundingClientRect; the popover needs one
// to position itself. Stub it with a fixed rect — these tests don't
// care about pixel positioning.
beforeAll(() => {
  if (typeof Range.prototype.getBoundingClientRect !== "function") {
    Range.prototype.getBoundingClientRect = () =>
      ({ top: 100, left: 100, bottom: 116, right: 200, width: 100, height: 16, x: 100, y: 100, toJSON: () => ({}) }) as DOMRect;
  }
});

function dispatchSelectionInside(el: HTMLElement, text = "hello world"): void {
  // jsdom's Selection API is partial; fake the bits the popover reads.
  const range = document.createRange();
  range.selectNodeContents(el);
  // jsdom's getBoundingClientRect on a text node returns zeros, which
  // makes the popover render at the viewport-clamped fallback. That's
  // fine for these tests — we care about presence + behaviour, not
  // pixel positioning.
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  // Override toString so the popover sees real text. jsdom's
  // Selection.toString() returns "" by default for text nodes.
  Object.defineProperty(sel, "toString", {
    configurable: true,
    value: () => text,
  });
  Object.defineProperty(sel, "isCollapsed", {
    configurable: true,
    get: () => false,
  });
  Object.defineProperty(sel, "anchorNode", {
    configurable: true,
    get: () => el.firstChild ?? el,
  });
  document.dispatchEvent(new Event("selectionchange"));
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
});

describe("HighlightActionPopover", () => {
  it("does NOT render when the selection is outside any data-highlightable ancestor", async () => {
    const onSelect = vi.fn().mockResolvedValue(undefined);
    const actions: HighlightAction[] = [
      { id: "x", label: "X", onSelect },
    ];
    render(
      <>
        <div data-testid="non-highlightable">a chat bubble</div>
        <HighlightActionPopover
          sessionId="s"
          roleId="r"
          token="t"
          actions={actions}
        />
      </>,
    );
    dispatchSelectionInside(screen.getByTestId("non-highlightable"));
    // No menu appears.
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
  });

  it("renders an action button when selection is inside a data-highlightable element", async () => {
    const onSelect = vi.fn().mockResolvedValue(undefined);
    const actions: HighlightAction[] = [
      { id: "pin", label: "Add to notes", onSelect },
    ];
    render(
      <>
        <div
          data-testid="bubble"
          data-highlightable="true"
          data-message-id="msg_42"
          data-message-kind="ai"
        >
          AI inject text
        </div>
        <HighlightActionPopover
          sessionId="s"
          roleId="r_self"
          token="tok"
          actions={actions}
        />
      </>,
    );
    dispatchSelectionInside(screen.getByTestId("bubble"), "AI inject text");
    const btn = await screen.findByRole("menuitem", { name: /add to notes/i });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledTimes(1);
    });
    const ctx = onSelect.mock.calls[0][0];
    expect(ctx).toMatchObject({
      sessionId: "s",
      roleId: "r_self",
      token: "tok",
      sourceMessageId: "msg_42",
      sourceKind: "ai",
    });
    expect(ctx.text.length).toBeGreaterThan(0);
  });

  it("hides the menu on Escape", async () => {
    const actions: HighlightAction[] = [
      { id: "pin", label: "Pin", onSelect: vi.fn().mockResolvedValue(undefined) },
    ];
    render(
      <>
        <div
          data-testid="bubble"
          data-highlightable="true"
          data-message-id="m"
          data-message-kind="chat"
        >
          some text
        </div>
        <HighlightActionPopover
          sessionId="s"
          roleId="r"
          token="t"
          actions={actions}
        />
      </>,
    );
    dispatchSelectionInside(screen.getByTestId("bubble"), "some text");
    await screen.findByRole("menu");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
  });
});
