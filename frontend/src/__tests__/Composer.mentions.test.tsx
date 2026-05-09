import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "../components/Composer";
import { MentionRosterEntry } from "../components/mentionPopoverUtils";

// Wave 2 (composer mentions + facilitator routing).
//
// Integration coverage for the @-popover wired through Composer:
//   * keyboard navigation (ArrowDown / ArrowUp / Enter / Escape)
//   * click-outside dismissal
//   * mark/resolve invariant on submit
//   * synthetic ``@facilitator`` + alias fallout (typing ``@ai``
//     resolves to the canonical ``"facilitator"`` token)
//   * backspace into a mark removes the WHOLE mark
//   * ARIA wiring on the textarea
//
// Pure-function popover tests live in MentionPopover.test.tsx.

const ROSTER: MentionRosterEntry[] = [
  { target: "ciso", insertLabel: "CISO", displayLabel: "CISO", secondary: "Alex" },
  { target: "soc", insertLabel: "SOC", displayLabel: "SOC", secondary: "Bo" },
  { target: "diana", insertLabel: "Legal", displayLabel: "Legal", secondary: "Diana" },
];

function setup(opts: { roster?: MentionRosterEntry[] } = {}) {
  const onSubmit = vi.fn();
  const utils = render(
    <Composer
      enabled={true}
      placeholder="Type something"
      label="Your message"
      onSubmit={onSubmit}
      mentionRoster={opts.roster ?? ROSTER}
    />,
  );
  const textarea = screen.getByPlaceholderText(
    "Type something",
  ) as HTMLTextAreaElement;
  return { ...utils, textarea, onSubmit };
}

/**
 * Simulate the user typing the given value as the new textarea
 * contents with the caret at the end. Uses ``fireEvent.change``
 * so React's controlled-component tracker fires onChange normally.
 *
 * Pre-setting ``textarea.value`` directly here would defeat the
 * tracker (React's ``_valueTracker`` would skip the change as a
 * no-op), so we leave the value override to the event init.
 */
function type(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, { target: { value } });
  // After React commits the new value the caret needs to move to
  // the end so a subsequent ``@`` keystroke is recognized as a
  // mention trigger. The next ``type()`` call will fire change
  // again and onChange reads ``e.target.selectionStart`` from the
  // actual DOM, so this set-and-forget is enough.
  textarea.setSelectionRange(value.length, value.length);
}

describe("Composer @-mention popover (Wave 2)", () => {
  it("opens on @ keypress and renders the facilitator entry first", () => {
    const { textarea } = setup();
    type(textarea, "hi @");
    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeTruthy();
    const options = screen.getAllByRole("option");
    expect(options[0].textContent).toMatch(/facilitator/i);
  });

  it("filters by typeahead and commits on Enter", () => {
    const { textarea, onSubmit } = setup();
    type(textarea, "hi @ci");
    const opts = screen.getAllByRole("option");
    expect(opts.map((o) => o.textContent?.toLowerCase())).toEqual([
      expect.stringContaining("ciso"),
    ]);
    // Enter commits the highlighted (only) option.
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("hi @CISO ");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith(
      "hi @CISO",
      ["ciso"],
      undefined,
    );
  });

  it("resolves @ai to the canonical facilitator token", () => {
    const { textarea, onSubmit } = setup();
    type(textarea, "@ai");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("@facilitator ");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith(
      "@facilitator",
      ["facilitator"],
      undefined,
    );
  });

  it("Escape dismisses without inserting", () => {
    const { textarea } = setup();
    type(textarea, "@ci");
    expect(screen.queryByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    // Text is unchanged — Escape didn't commit.
    expect(textarea.value).toBe("@ci");
  });

  it("ArrowDown wraps + ArrowUp moves backward", () => {
    const { textarea } = setup();
    type(textarea, "@");
    // Initial: facilitator (index 0) highlighted.
    let opts = screen.getAllByRole("option");
    expect(opts[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    opts = screen.getAllByRole("option");
    expect(opts[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    opts = screen.getAllByRole("option");
    expect(opts[0].getAttribute("aria-selected")).toBe("true");
  });

  it("backspace into a mark removes the WHOLE mark", () => {
    const { textarea, onSubmit } = setup();
    type(textarea, "hi @ci");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("hi @CISO ");
    // User deletes a character INSIDE the mention token. The
    // reconciler detects the edit overlaps the mark's range and
    // drops the mark whole (plan §4.6).
    type(textarea, "hi @CIS ");
    // Submit and confirm mentions[] is now empty.
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("hi @CIS", [], undefined);
  });

  it("text inserted BEFORE a mark does NOT drop the mark", () => {
    // Copilot review on PR #152: the original ``reconcileMarks``
    // compared ``prev.slice(start, end)`` with ``next.slice(start,
    // end)`` at fixed offsets. Any insertion before the mention
    // shifted indices and the mark was incorrectly dropped, even
    // though the user never touched the token itself.
    //
    // Lock the invariant: a popover-picked mention survives an
    // unrelated edit anywhere ahead of it. The mark's end-position
    // shifts; the target stays.
    const { textarea, onSubmit } = setup();
    type(textarea, "@ci");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("@CISO ");
    // Now insert text BEFORE the mention. Text becomes
    // ``"prefix @CISO ", which should still resolve "ciso" on submit.
    type(textarea, "prefix " + textarea.value);
    fireEvent.keyDown(textarea, { key: "Enter" });
    const last = onSubmit.mock.calls[onSubmit.mock.calls.length - 1];
    expect(last[0]).toBe("prefix @CISO");
    expect(last[1]).toEqual(["ciso"]);
  });

  it("text appended AFTER a mark does NOT drop the mark", () => {
    // Symmetric to the previous test — appending should also leave
    // the mark intact (its [start,end) is in the unchanged prefix
    // of the new text).
    const { textarea, onSubmit } = setup();
    type(textarea, "@ci");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("@CISO ");
    type(textarea, textarea.value + "and what's the call?");
    fireEvent.keyDown(textarea, { key: "Enter" });
    const last = onSubmit.mock.calls[onSubmit.mock.calls.length - 1];
    expect(last[0]).toBe("@CISO and what's the call?");
    expect(last[1]).toEqual(["ciso"]);
  });

  it("paste-replace of the entire body drops all marks", () => {
    // Worst-case edit (cmd+A → paste). The new text shares no
    // common prefix or suffix with prev, so the edit range covers
    // every mark; all marks are dropped.
    const { textarea, onSubmit } = setup();
    type(textarea, "@ci");
    fireEvent.keyDown(textarea, { key: "Enter" });
    type(textarea, textarea.value + "and @soc");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toContain("@SOC");
    // Wholesale replace — both marks should drop.
    type(textarea, "totally different content with no @-tokens");
    fireEvent.keyDown(textarea, { key: "Enter" });
    const last = onSubmit.mock.calls[onSubmit.mock.calls.length - 1];
    expect(last[1]).toEqual([]);
  });

  it("dedupes mentions on submit — multiple inserts of the same role count once", () => {
    const { textarea, onSubmit } = setup();
    type(textarea, "@ci");
    fireEvent.keyDown(textarea, { key: "Enter" }); // inserts @CISO
    type(textarea, textarea.value + "@ci");
    fireEvent.keyDown(textarea, { key: "Enter" }); // inserts @CISO again
    fireEvent.keyDown(textarea, { key: "Enter" }); // submit
    const calls = onSubmit.mock.calls;
    const submitCall = calls[calls.length - 1];
    // Second positional arg is mentions[]; should have exactly one
    // entry for ``ciso``. (PR #209 follow-up: dropped the ``intent``
    // arg, so positions shifted left by one.)
    expect(submitCall[1]).toEqual(["ciso"]);
  });

  it("textarea wires aria-controls and aria-activedescendant to the listbox", () => {
    const { textarea } = setup();
    expect(textarea.getAttribute("role")).toBe("combobox");
    expect(textarea.getAttribute("aria-haspopup")).toBe("listbox");
    expect(textarea.getAttribute("aria-expanded")).toBe("false");
    type(textarea, "@");
    expect(textarea.getAttribute("aria-expanded")).toBe("true");
    const lbxId = textarea.getAttribute("aria-controls");
    expect(lbxId).toBeTruthy();
    expect(screen.getByRole("listbox").id).toBe(lbxId);
    const active = textarea.getAttribute("aria-activedescendant");
    expect(active).toBeTruthy();
    // The active descendant id is derived from the listbox id + the
    // currently-highlighted target (facilitator on first open).
    expect(active!.startsWith(`${lbxId}-`)).toBe(true);
  });

  it("Tab also commits the highlighted option (parity with Enter)", () => {
    const { textarea, onSubmit } = setup();
    type(textarea, "@ci");
    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(textarea.value).toBe("@CISO ");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit.mock.calls[0][1]).toEqual(["ciso"]);
  });

  it("does NOT open the popover for an @ inside an email-like token", () => {
    const { textarea } = setup();
    type(textarea, "ping foo@bar");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("plain @<role> mention sends the role_id and NOT the facilitator token", () => {
    // Routing-intent locking test: a player addressing a teammate
    // should never accidentally trigger the AI interject — the
    // backend's WS branch only fires ``run_interject`` when the
    // literal ``"facilitator"`` token is in ``mentions[]``.
    //
    // Type ``@diana`` (no trailing text — a space would close the
    // popover before we can commit). The popover matches Legal's
    // secondary "Diana" line. Enter commits, then a second Enter
    // submits.
    const { textarea, onSubmit } = setup();
    type(textarea, "@diana");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toContain("@Legal");
    fireEvent.keyDown(textarea, { key: "Enter" });
    const last = onSubmit.mock.calls[onSubmit.mock.calls.length - 1];
    // Mentions list contains ONLY the role_id, never "facilitator".
    expect(last[1]).toEqual(["diana"]);
    expect(last[1]).not.toContain("facilitator");
  });

  it("hand-typed @facilitator (no popover pick) still resolves on submit", () => {
    // User feedback: a player who types ``@facilitator`` literally —
    // out of muscle memory or because they dismissed the popover —
    // should produce the same structural ``mentions[]`` payload as a
    // popover-driven submission. The body-scan fallback in the
    // composer's submit handler resolves canonical aliases + roster
    // labels at submit time.
    const { textarea, onSubmit } = setup();
    // Type the canonical token directly, then press Escape to
    // dismiss the popover (simulating "I know what I want, get out
    // of my way"). The body-scan should still pick it up on submit.
    type(textarea, "@facilitator");
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(textarea, { key: "Enter" });
    const last = onSubmit.mock.calls[onSubmit.mock.calls.length - 1];
    expect(last[0]).toBe("@facilitator");
    expect(last[1]).toEqual(["facilitator"]);
  });

  it("hand-typed alias @ai resolves to the canonical facilitator on submit", () => {
    const { textarea, onSubmit } = setup();
    type(textarea, "@ai what time is it");
    // Space after @ai already closed the popover; no Escape needed.
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(textarea, { key: "Enter" });
    const last = onSubmit.mock.calls[onSubmit.mock.calls.length - 1];
    expect(last[1]).toEqual(["facilitator"]);
  });

  it("hand-typed @<role> resolves to the role_id on submit", () => {
    const { textarea, onSubmit } = setup();
    // Type @CISO followed by a space + more text (popover closes
    // on the space; body-scan fires at submit).
    type(textarea, "@CISO confirm clock");
    fireEvent.keyDown(textarea, { key: "Enter" });
    const last = onSubmit.mock.calls[onSubmit.mock.calls.length - 1];
    expect(last[1]).toEqual(["ciso"]);
  });

  it("hand-typed mention is de-duplicated against popover-picked marks", () => {
    // If the user picks @CISO from the popover AND types @CISO
    // again literally, the submitted mentions list should contain
    // exactly one ``ciso`` entry — order-preserving on first
    // appearance. The body-scan fallback finds the second @CISO
    // and tries to add it; the dedupe set keeps the kept list to
    // one entry.
    const { textarea, onSubmit } = setup();
    type(textarea, "@ci");
    fireEvent.keyDown(textarea, { key: "Enter" }); // popover-picks @CISO
    // Append literal @CISO + dismiss the popover that opens at it
    // so the next Enter triggers form-submit, not popover-commit.
    type(textarea, textarea.value + "and again @CISO");
    fireEvent.keyDown(textarea, { key: "Escape" });
    fireEvent.keyDown(textarea, { key: "Enter" }); // submit
    const last = onSubmit.mock.calls[onSubmit.mock.calls.length - 1];
    expect(last[1]).toEqual(["ciso"]);
  });

  it("kbd hint row mentions @facilitator for discoverability", () => {
    // User-Persona review HIGH H1: the hint row is the canonical
    // place a power-user looks for keyboard affordances. Locking
    // the affordance copy here so a future hint-row tweak doesn't
    // silently drop the @facilitator hint.
    setup();
    expect(
      screen.getByText(/mention.*for AI/i),
    ).toBeInTheDocument();
  });
});
