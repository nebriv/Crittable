import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarkReadyButton } from "../components/brand/MarkReadyButton";

// Decoupled-ready (PR #209 follow-up). The MarkReadyButton is the
// single rail affordance for closing the per-turn ready quorum,
// replacing the old composer-bound SUBMIT & READY. The button is
// CONTROLLED — the parent (Play.tsx / Facilitator.tsx) overlays
// canonical snapshot ready state with any pending optimistic flips
// keyed by ``client_seq`` and passes the result down. These tests
// pin the contract: label/aria/tone per (variant, isReady, enabled),
// onToggle's desired-NEW-state argument, and the disabled-tooltip
// fallback chain.

describe("<MarkReadyButton/>", () => {
  describe("self variant", () => {
    it("not-ready: shows MARK READY → with arrow, no undo hint", () => {
      const onToggle = vi.fn();
      render(
        <MarkReadyButton
          isReady={false}
          enabled={true}
          onToggle={onToggle}
          variant="self"
        />,
      );
      const btn = screen.getByTestId("mark-ready");
      expect(btn.textContent).toMatch(/MARK READY/);
      // No "tap to undo" subtext on the not-ready face.
      expect(btn.textContent).not.toMatch(/tap to undo/i);
      expect(btn.getAttribute("data-tone")).toBe("not-ready");
      // aria-pressed=false because variant is self.
      expect(btn.getAttribute("aria-pressed")).toBe("false");
    });

    it("ready: shows READY ✓ plus 'tap to undo' hint", () => {
      const onToggle = vi.fn();
      render(
        <MarkReadyButton
          isReady={true}
          enabled={true}
          onToggle={onToggle}
          variant="self"
        />,
      );
      const btn = screen.getByTestId("mark-ready");
      expect(btn.textContent).toMatch(/READY ✓/);
      expect(btn.textContent).toMatch(/tap to undo/i);
      expect(btn.getAttribute("data-tone")).toBe("ready");
      expect(btn.getAttribute("aria-pressed")).toBe("true");
    });

    it("onToggle is called with desired NEW state (true when not-ready, false when ready)", () => {
      const onToggle = vi.fn();
      const { rerender } = render(
        <MarkReadyButton
          isReady={false}
          enabled={true}
          onToggle={onToggle}
          variant="self"
        />,
      );
      fireEvent.click(screen.getByTestId("mark-ready"));
      expect(onToggle).toHaveBeenLastCalledWith(true);

      rerender(
        <MarkReadyButton
          isReady={true}
          enabled={true}
          onToggle={onToggle}
          variant="self"
        />,
      );
      fireEvent.click(screen.getByTestId("mark-ready"));
      expect(onToggle).toHaveBeenLastCalledWith(false);
    });

    it("disabled: button is disabled, onToggle never fires, tooltip surfaces disabledReason", () => {
      const onToggle = vi.fn();
      render(
        <MarkReadyButton
          isReady={false}
          enabled={false}
          onToggle={onToggle}
          variant="self"
          disabledReason="Reconnecting — Mark Ready re-opens once the connection is back."
        />,
      );
      const btn = screen.getByTestId("mark-ready");
      expect(btn).toHaveProperty("disabled", true);
      fireEvent.click(btn);
      expect(onToggle).not.toHaveBeenCalled();
      expect(btn.getAttribute("title")).toMatch(/Reconnecting/);
    });

    it("disabled with no disabledReason falls back to a generic tooltip", () => {
      render(
        <MarkReadyButton
          isReady={false}
          enabled={false}
          onToggle={vi.fn()}
          variant="self"
        />,
      );
      const btn = screen.getByTestId("mark-ready");
      expect(btn.getAttribute("title")).toMatch(/unavailable/i);
    });
  });

  describe("impersonate variant", () => {
    it("not-ready: shows MARK <ROLE> READY → using subjectLabel", () => {
      render(
        <MarkReadyButton
          isReady={false}
          enabled={true}
          onToggle={vi.fn()}
          variant="impersonate"
          subjectLabel="SOC Analyst"
        />,
      );
      const btn = screen.getByTestId("mark-ready-impersonate");
      // Subject label uppercased + framed inside the action verb.
      expect(btn.textContent).toMatch(/MARK SOC ANALYST READY/);
      // No "tap to undo" hint on the impersonation variant — it'd
      // be ambiguous (whose ready are we undoing?).
      expect(btn.textContent).not.toMatch(/tap to undo/i);
    });

    it("ready: shows <ROLE> READY ✓ without instruction copy", () => {
      render(
        <MarkReadyButton
          isReady={true}
          enabled={true}
          onToggle={vi.fn()}
          variant="impersonate"
          subjectLabel="Legal"
        />,
      );
      const btn = screen.getByTestId("mark-ready-impersonate");
      expect(btn.textContent).toMatch(/LEGAL READY ✓/);
      expect(btn.textContent).not.toMatch(/tap to undo/i);
    });

    it("aria-pressed is omitted on impersonate variant (state belongs to another role)", () => {
      render(
        <MarkReadyButton
          isReady={true}
          enabled={true}
          onToggle={vi.fn()}
          variant="impersonate"
          subjectLabel="SOC"
        />,
      );
      const btn = screen.getByTestId("mark-ready-impersonate");
      // aria-pressed is meaningful only for self-toggle; on the
      // impersonation row it'd confuse AT users into thinking THEY
      // are pressed/ready.
      expect(btn.hasAttribute("aria-pressed")).toBe(false);
    });

    it("aria-label names the subject role explicitly", () => {
      render(
        <MarkReadyButton
          isReady={false}
          enabled={true}
          onToggle={vi.fn()}
          variant="impersonate"
          subjectLabel="IR Lead"
        />,
      );
      const btn = screen.getByTestId("mark-ready-impersonate");
      expect(btn.getAttribute("aria-label")).toMatch(/IR Lead/);
    });

    it("truncates very long subject labels with an ellipsis", () => {
      // 36-char label — beyond the 18-char truncation threshold.
      render(
        <MarkReadyButton
          isReady={false}
          enabled={true}
          onToggle={vi.fn()}
          variant="impersonate"
          subjectLabel="Senior Threat Intelligence Analyst"
        />,
      );
      const btn = screen.getByTestId("mark-ready-impersonate");
      // The visible label is truncated; the aria-label keeps the
      // full role name for AT.
      expect(btn.textContent).toMatch(/SENIOR THREAT INT…/);
      expect(btn.textContent).not.toMatch(/Analyst/);
      expect(btn.getAttribute("aria-label")).toMatch(
        /Senior Threat Intelligence Analyst/,
      );
    });

    it("missing subjectLabel falls back to 'role'", () => {
      render(
        <MarkReadyButton
          isReady={false}
          enabled={true}
          onToggle={vi.fn()}
          variant="impersonate"
        />,
      );
      const btn = screen.getByTestId("mark-ready-impersonate");
      expect(btn.textContent).toMatch(/MARK ROLE READY/);
    });
  });

  describe("variant differentiation", () => {
    it("renders distinct data-variant attributes so the rail's two roles are visually distinguishable", () => {
      const { rerender } = render(
        <MarkReadyButton
          isReady={false}
          enabled={true}
          onToggle={vi.fn()}
          variant="self"
        />,
      );
      expect(
        screen.getByTestId("mark-ready").getAttribute("data-variant"),
      ).toBe("self");

      rerender(
        <MarkReadyButton
          isReady={false}
          enabled={true}
          onToggle={vi.fn()}
          variant="impersonate"
          subjectLabel="SOC"
        />,
      );
      expect(
        screen.getByTestId("mark-ready-impersonate").getAttribute("data-variant"),
      ).toBe("impersonate");
    });

    it("default variant is 'self' when not specified", () => {
      render(
        <MarkReadyButton isReady={false} enabled={true} onToggle={vi.fn()} />,
      );
      expect(
        screen.getByTestId("mark-ready").getAttribute("data-variant"),
      ).toBe("self");
    });
  });
});
