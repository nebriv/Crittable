/**
 * Component tests for the highlight-action popover (issue #98).
 *
 * Exercises the surface that the QA review on PR #115 flagged as
 * untested: selection detection, ``data-highlightable`` ancestor
 * walk, ``onSelect`` invocation, and Escape dismissal.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HighlightActionPopover } from "../components/HighlightActionPopover";
import {
  defaultHighlightActions,
  type HighlightAction,
} from "../lib/highlightActions";
// Range.prototype.getBoundingClientRect is stubbed globally in
// src/test-setup.ts (jsdom doesn't ship it; the popover needs it).

function dispatchSelectionInside(el: HTMLElement, text = "hello world"): void {
  // jsdom's Selection API is partial; fake the bits the popover reads.
  const range = document.createRange();
  range.selectNodeContents(el);
  // jsdom's getBoundingClientRect on a text node returns zeros, which
  // makes the popover render at the viewport-clamped fallback. That's
  // fine for these tests — we care about presence + behavior, not
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
    await act(async () => {
      dispatchSelectionInside(screen.getByTestId("non-highlightable"));
    });
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
    await act(async () => {
      dispatchSelectionInside(screen.getByTestId("bubble"), "AI inject text");
    });
    const btn = await screen.findByRole("menuitem", { name: /add to notes/i });
    await act(async () => {
      fireEvent.click(btn);
    });
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

  it("does NOT open the menu mid-drag (suppressed until mouseup)", async () => {
    const onSelect = vi.fn().mockResolvedValue(undefined);
    const actions: HighlightAction[] = [
      { id: "pin", label: "Add to notes", onSelect },
    ];
    render(
      <>
        <div
          data-testid="bubble"
          data-highlightable="true"
          data-message-id="msg_drag"
          data-message-kind="chat"
        >
          some text the user is drag-selecting
        </div>
        <HighlightActionPopover
          sessionId="s"
          roleId="r"
          token="t"
          actions={actions}
        />
      </>,
    );
    // Simulate the user pressing the mouse button down on the bubble
    // (start of a drag-select). The popover should NOT open on the
    // selectionchange events that fire while the mouse is held down —
    // the menu would otherwise pop up under the cursor and break the
    // drag a few characters in.
    await act(async () => {
      fireEvent.mouseDown(screen.getByTestId("bubble"));
      dispatchSelectionInside(screen.getByTestId("bubble"), "some text");
    });
    // No menu while the mouse is down.
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    // Release the mouse — popover should now appear at the final
    // selection rect.
    await act(async () => {
      fireEvent.mouseUp(document);
    });
    await screen.findByRole("menu");
  });

  it("does NOT clear the selection on scroll (regression: drag-select dies)", async () => {
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
    await act(async () => {
      dispatchSelectionInside(screen.getByTestId("bubble"), "some text");
    });
    await screen.findByRole("menu");
    // Confirm the selection is intact before the scroll.
    expect(window.getSelection()?.isCollapsed).toBe(false);
    // Fire a window-level scroll (e.g. chat container auto-scrolls
    // because the user dragged near the edge).
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
    });
    // The popover hides (its rect is now stale) but the selection
    // MUST stay alive — clearing it would terminate the drag-select
    // mid-stream, which was the user-reported regression.
    expect(window.getSelection()?.isCollapsed).toBe(false);
  });

  it("renders BOTH default actions when given the default registry (issue #117)", async () => {
    // Acceptance criterion for issue #117: 'when you highlight a text
    // blurb I want the option to flag for AAR review'. Both buttons
    // must be present in the popover when the default registry is
    // wired through; without this assertion a registry-filter
    // regression that hid the new action would be invisible.
    render(
      <>
        <div
          data-testid="bubble"
          data-highlightable="true"
          data-message-id="msg_default"
          data-message-kind="ai"
        >
          AI inject text
        </div>
        <HighlightActionPopover
          sessionId="s"
          roleId="r"
          token="t"
          actions={defaultHighlightActions}
        />
      </>,
    );
    await act(async () => {
      dispatchSelectionInside(screen.getByTestId("bubble"), "AI inject text");
    });
    const addToNotes = await screen.findByRole("menuitem", {
      name: /add to notes/i,
    });
    const markForAar = await screen.findByRole("menuitem", {
      name: /mark for aar/i,
    });
    expect(addToNotes).toBeTruthy();
    expect(markForAar).toBeTruthy();
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
    await act(async () => {
      dispatchSelectionInside(screen.getByTestId("bubble"), "some text");
    });
    await screen.findByRole("menu");
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
  });
});
