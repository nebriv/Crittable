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
import { describe, expect, it, vi } from "vitest";

import {
  defaultHighlightActions,
  type HighlightAction,
  type HighlightContext,
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
