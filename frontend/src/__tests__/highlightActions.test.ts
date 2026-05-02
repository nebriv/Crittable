/**
 * Smoke tests for the highlight-action registry (issue #98).
 *
 * The registry is the load-bearing piece for v2 expansion: future
 * actions ("Mark for AAR", "Flag as follow-up", "Quote in chat") plug
 * in via a single registry append. These tests pin the contract:
 *
 *   - default registry contains exactly one v1 action ("Add to notes")
 *     and that action's id is stable.
 *   - actions can be filtered by ``isAvailable`` based on
 *     ``HighlightContext.sourceKind``.
 *   - ``onSelect`` is invoked with the full context and surfaces errors
 *     to the caller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  defaultHighlightActions,
  NOTEPAD_PIN_EVENT,
  type HighlightAction,
  type HighlightContext,
  type NotepadPinEventDetail,
} from "../lib/highlightActions";

describe("highlightActions default registry", () => {
  it("ships exactly one v1 action — pin to notepad", () => {
    expect(defaultHighlightActions).toHaveLength(1);
    expect(defaultHighlightActions[0].id).toBe("pin-to-notepad");
    expect(defaultHighlightActions[0].label).toBe("Add to notes");
  });

  it("default action has no isAvailable gate (works for any source kind)", () => {
    const action = defaultHighlightActions[0];
    expect(action.isAvailable).toBeUndefined();
  });
});

describe("HighlightAction interface contract", () => {
  it("invokes onSelect with the full context object", async () => {
    const onSelect = vi.fn().mockResolvedValue(undefined);
    const action: HighlightAction = {
      id: "test-action",
      label: "Test",
      onSelect,
    };
    const ctx: HighlightContext = {
      text: "hello",
      sourceMessageId: "msg_1",
      sourceKind: "chat",
      roleId: "r_test",
      sessionId: "sess_test",
      token: "tok_test",
    };
    await action.onSelect(ctx);
    expect(onSelect).toHaveBeenCalledWith(ctx);
  });

  it("supports per-source-kind gating via isAvailable", () => {
    const aiOnly: HighlightAction = {
      id: "ai-only",
      label: "AI Only",
      isAvailable: (c) => c.sourceKind === "ai",
      onSelect: async () => {},
    };
    const chatCtx: HighlightContext = {
      text: "x",
      sourceMessageId: null,
      sourceKind: "chat",
      roleId: "r",
      sessionId: "s",
      token: "t",
    };
    const aiCtx: HighlightContext = { ...chatCtx, sourceKind: "ai" };
    expect(aiOnly.isAvailable?.(chatCtx)).toBe(false);
    expect(aiOnly.isAvailable?.(aiCtx)).toBe(true);
  });

  it("rejects propagate from onSelect so callers can show error toasts", async () => {
    const action: HighlightAction = {
      id: "fails",
      label: "Fails",
      onSelect: async () => {
        throw new Error("nope");
      },
    };
    await expect(
      action.onSelect({
        text: "x",
        sourceMessageId: null,
        sourceKind: "chat",
        roleId: "r",
        sessionId: "s",
        token: "t",
      }),
    ).rejects.toThrow("nope");
  });
});

describe("pin-to-notepad action — window event dispatch", () => {
  // Restore fetch after each test so the global stub doesn't leak.
  let originalFetch: typeof globalThis.fetch | undefined;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 204 }),
    );
  });
  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  it("dispatches crittable:notepad-pin on the window after a successful POST", async () => {
    const action = defaultHighlightActions[0];
    const seen: NotepadPinEventDetail[] = [];
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<NotepadPinEventDetail>).detail;
      seen.push(detail);
    };
    window.addEventListener(NOTEPAD_PIN_EVENT, handler);
    try {
      await action.onSelect({
        text: "selected snippet",
        sourceMessageId: "msg_42",
        sourceKind: "ai",
        roleId: "r",
        sessionId: "s",
        token: "t",
      });
    } finally {
      window.removeEventListener(NOTEPAD_PIN_EVENT, handler);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      text: "selected snippet",
      sourceMessageId: "msg_42",
    });
  });

  it("sanitises the dispatched text — markdown markers and HTML are stripped", async () => {
    // Belt-and-braces: server runs the same sanitiser on the POST
    // payload, but the editor inserts the dispatched text locally and
    // pushes it back via ``pushSnapshot``. Without client-side
    // sanitisation, an unsanitised string round-trips into
    // ``session.notepad.markdown_snapshot`` and the AAR.
    const action = defaultHighlightActions[0];
    const seen: NotepadPinEventDetail[] = [];
    const handler = (e: Event) => {
      seen.push((e as CustomEvent<NotepadPinEventDetail>).detail);
    };
    window.addEventListener(NOTEPAD_PIN_EVENT, handler);
    try {
      await action.onSelect({
        text: "# heading injected\n[link](http://evil.example) <script>x</script>",
        sourceMessageId: "msg_xss",
        sourceKind: "chat",
        roleId: "r",
        sessionId: "s",
        token: "t",
      });
    } finally {
      window.removeEventListener(NOTEPAD_PIN_EVENT, handler);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0].text).not.toMatch(/^#/);
    expect(seen[0].text).not.toContain("](http");
    expect(seen[0].text).not.toContain("<script>");
    expect(seen[0].text).toContain("heading injected");
    expect(seen[0].text).toContain("link");
  });

  it("does NOT dispatch the event if the POST rejects — caller decides toast wording", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "rate limited" }), { status: 429 }),
    );
    const action = defaultHighlightActions[0];
    const handler = vi.fn();
    window.addEventListener(NOTEPAD_PIN_EVENT, handler);
    try {
      await expect(
        action.onSelect({
          text: "selected snippet",
          sourceMessageId: "msg_42",
          sourceKind: "ai",
          roleId: "r",
          sessionId: "s",
          token: "t",
        }),
      ).rejects.toBeDefined();
    } finally {
      window.removeEventListener(NOTEPAD_PIN_EVENT, handler);
    }
    expect(handler).not.toHaveBeenCalled();
  });
});
