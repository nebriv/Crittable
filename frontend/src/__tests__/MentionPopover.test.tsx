import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MentionPopover } from "../components/MentionPopover";
import {
  MentionRosterEntry,
  filterMentionRoster,
  nextHighlightIndex,
  optionIdFor,
  readMentionContext,
  resolveMentionToken,
  scanBodyForMentions,
} from "../components/mentionPopoverUtils";

// Wave 2 (composer mentions + facilitator routing).
//
// Pure-function coverage here — the popover's interactive coverage
// (typeahead → keyboard navigation → insertion) lives in
// ``Composer.mentions.test.tsx`` because the keyboard path is owned
// by the parent's keydown handler.

const ROSTER: MentionRosterEntry[] = [
  { target: "ciso", insertLabel: "CISO", displayLabel: "CISO", secondary: "Alex" },
  { target: "soc", insertLabel: "SOC", displayLabel: "SOC", secondary: "Bo" },
  {
    target: "legal",
    insertLabel: "Legal",
    displayLabel: "Legal",
    secondary: "Diana Vance",
  },
];

describe("filterMentionRoster", () => {
  it("renders the synthetic facilitator entry first when the query is empty", () => {
    const out = filterMentionRoster("", ROSTER);
    expect(out[0]?.isFacilitator).toBe(true);
    expect(out[0]?.target).toBe("facilitator");
    expect(out.slice(1).map((e) => e.target)).toEqual(["ciso", "soc", "legal"]);
  });

  it("filters the roster by case-insensitive substring on label", () => {
    // ``cis`` matches CISO's label only — picks the right roster
    // entry without accidentally also matching a display name (the
    // first-word match against display names is intentional, see
    // the next test, but a label-specific query should not pull in
    // unrelated roles via incidental display-name substrings).
    const out = filterMentionRoster("cis", ROSTER);
    expect(out.map((e) => e.target)).toEqual(["ciso"]);
  });

  it("matches the first word of the display name", () => {
    // ``di`` matches the first word of Legal's secondary line ("Diana
    // Vance" → "diana") but no role label.
    const out = filterMentionRoster("di", ROSTER);
    expect(out.map((e) => e.target)).toEqual(["legal"]);
  });

  it("surfaces the facilitator entry for any of its aliases", () => {
    expect(filterMentionRoster("ai", ROSTER).map((e) => e.target)).toContain(
      "facilitator",
    );
    expect(filterMentionRoster("gm", ROSTER).map((e) => e.target)).toContain(
      "facilitator",
    );
    expect(
      filterMentionRoster("facili", ROSTER).map((e) => e.target),
    ).toContain("facilitator");
  });

  it("ignores duplicate facilitator entries in the input roster", () => {
    const withDup: MentionRosterEntry[] = [
      ...ROSTER,
      {
        target: "facilitator",
        insertLabel: "facilitator",
        displayLabel: "facilitator",
      },
    ];
    const out = filterMentionRoster("", withDup);
    const facilitators = out.filter((e) => e.target === "facilitator");
    expect(facilitators).toHaveLength(1);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterMentionRoster("zzz", ROSTER)).toEqual([]);
  });
});

describe("nextHighlightIndex", () => {
  it("wraps forward at the end of the list", () => {
    expect(nextHighlightIndex(2, 1, 3)).toBe(0);
  });
  it("wraps backward at the start of the list", () => {
    expect(nextHighlightIndex(0, -1, 3)).toBe(2);
  });
  it("returns 0 when the list is empty", () => {
    expect(nextHighlightIndex(0, 1, 0)).toBe(0);
  });
});

describe("optionIdFor", () => {
  it("produces a stable id derived from listbox + target", () => {
    expect(optionIdFor("lbx", "ciso")).toBe("lbx-ciso");
  });
  it("sanitises the synthetic facilitator target", () => {
    // The facilitator target is the literal "facilitator" — no
    // sanitisation needed, but the function MUST handle it
    // identically to a role_id so the composer's
    // ``aria-activedescendant`` always points at the rendered
    // option (UI/UX review HIGH H1).
    expect(optionIdFor("lbx", "facilitator")).toBe("lbx-facilitator");
  });
  it("strips characters not legal in an HTML id", () => {
    // Defensive — real role_ids are short alphanumerics, but the
    // sanitiser MUST keep both call sites in sync if someone ever
    // ships a role_id with a slash or colon.
    expect(optionIdFor("lbx", "weird/role:id")).toBe("lbx-weird_role_id");
  });
});

describe("resolveMentionToken", () => {
  const roster: MentionRosterEntry[] = [
    { target: "ciso-id", insertLabel: "CISO", displayLabel: "CISO" },
    { target: "soc-id", insertLabel: "SOC", displayLabel: "SOC" },
  ];

  it("resolves the canonical facilitator token", () => {
    expect(resolveMentionToken("facilitator", roster)).toBe("facilitator");
  });
  it("resolves alias @ai to the canonical facilitator", () => {
    expect(resolveMentionToken("ai", roster)).toBe("facilitator");
    expect(resolveMentionToken("AI", roster)).toBe("facilitator");
  });
  it("resolves alias @gm to the canonical facilitator", () => {
    expect(resolveMentionToken("gm", roster)).toBe("facilitator");
  });
  it("resolves a roster label case-insensitively", () => {
    expect(resolveMentionToken("ciso", roster)).toBe("ciso-id");
    expect(resolveMentionToken("CISO", roster)).toBe("ciso-id");
  });
  it("returns null for unknown tokens", () => {
    expect(resolveMentionToken("nobody", roster)).toBeNull();
  });
});

describe("scanBodyForMentions (hand-typed mention fallback)", () => {
  // User feedback: a player who types ``@facilitator`` (or
  // ``@CISO``) literally — without picking from the popover —
  // should still produce the same structural ``mentions[]`` payload.
  // The composer's submit handler runs this scan against the body
  // and merges the resolved targets with the popover-driven marks.
  const roster: MentionRosterEntry[] = [
    {
      target: "ciso-id",
      insertLabel: "CISO",
      displayLabel: "CISO",
      secondary: "Alex Park",
    },
    {
      target: "soc-id",
      insertLabel: "SOC",
      displayLabel: "SOC",
      secondary: "Bo",
    },
    {
      target: "ir-lead-id",
      insertLabel: "IR Lead",
      displayLabel: "IR Lead",
      secondary: "Diana Vance",
    },
  ];

  it("picks up a literal @facilitator at start of message", () => {
    expect(scanBodyForMentions("@facilitator help", roster)).toEqual([
      "facilitator",
    ]);
  });
  it("picks up @ai alias and resolves to facilitator", () => {
    expect(scanBodyForMentions("hey @ai how are we?", roster)).toEqual([
      "facilitator",
    ]);
  });
  it("picks up multiple distinct mentions in order", () => {
    expect(
      scanBodyForMentions("@SOC @facilitator confirm trace", roster),
    ).toEqual(["soc-id", "facilitator"]);
  });
  it("dedupes repeated mentions", () => {
    expect(
      scanBodyForMentions("@CISO update? @ciso again", roster),
    ).toEqual(["ciso-id"]);
  });
  it("ignores @-tokens that aren't roster labels or aliases", () => {
    expect(
      scanBodyForMentions("@nobody knows @everyone @CISO", roster),
    ).toEqual(["ciso-id"]);
  });
  it("does NOT match @ inside an email address", () => {
    expect(
      scanBodyForMentions("ping foo@bar.com about @CISO", roster),
    ).toEqual(["ciso-id"]);
  });
  it("ignores pathologically long unknown tokens", () => {
    // A 500-char unknown @-token shouldn't accidentally extend
    // into something that resolves; bounded-roster matching means
    // it just falls through.
    const long = "@" + "x".repeat(500);
    expect(scanBodyForMentions(long, roster)).toEqual([]);
  });

  // ---------- Multi-word label / display name (user feedback) ----------

  it("resolves a multi-word role label like @IR Lead", () => {
    expect(scanBodyForMentions("@IR Lead confirm clock", roster)).toEqual([
      "ir-lead-id",
    ]);
  });
  it("resolves the longer label when shorter prefix would also match", () => {
    // Defensive: a future roster might have BOTH "IR" and "IR
    // Lead". The longest-first match table picks "IR Lead" so a
    // user typing the full name doesn't accidentally resolve the
    // shorter one.
    const both: MentionRosterEntry[] = [
      ...roster,
      { target: "ir-id", insertLabel: "IR", displayLabel: "IR" },
    ];
    expect(scanBodyForMentions("@IR Lead now", both)).toEqual(["ir-lead-id"]);
    // And plain "@IR alone" still matches the short one.
    expect(scanBodyForMentions("@IR alone", both)).toEqual(["ir-id"]);
  });
  it("resolves @<first-name> from secondary", () => {
    expect(scanBodyForMentions("@Diana what's the call", roster)).toEqual([
      "ir-lead-id",
    ]);
  });
  it("resolves @<last-name> from secondary", () => {
    expect(scanBodyForMentions("@Vance any read?", roster)).toEqual([
      "ir-lead-id",
    ]);
  });
  it("resolves a multi-word display name like @Diana Vance", () => {
    expect(scanBodyForMentions("@Diana Vance please", roster)).toEqual([
      "ir-lead-id",
    ]);
  });
  it("does NOT match @CISOlater (token-terminator gate)", () => {
    // Without the terminator gate, a needle match anywhere inside
    // a longer @-token would resolve. The composer must respect
    // word boundaries on both edges.
    expect(scanBodyForMentions("@CISOlater go", roster)).toEqual([]);
  });
  it("token terminators include common punctuation", () => {
    // ``@CISO,`` is the same person as ``@CISO `` — punctuation
    // closes the token.
    expect(scanBodyForMentions("hey @CISO, you in?", roster)).toEqual([
      "ciso-id",
    ]);
  });
});

describe("readMentionContext", () => {
  it("opens for an @ at line start", () => {
    expect(readMentionContext("@", 1)).toEqual({ atIndex: 0, query: "" });
  });
  it("opens for an @ following whitespace", () => {
    expect(readMentionContext("hi @ci", 6)).toEqual({ atIndex: 3, query: "ci" });
  });
  it("does NOT open for an @ inside an email", () => {
    expect(readMentionContext("ping foo@bar.com", 16)).toBeNull();
  });
  it("closes once the user types a space after the query", () => {
    expect(readMentionContext("hi @ciso ", 9)).toBeNull();
  });
  it("closes when the caret is past the end of the @-token", () => {
    // Caret to the right of "Legal " — no @ between caret and the
    // nearest preceding whitespace.
    expect(readMentionContext("@Legal hi", 9)).toBeNull();
  });
  it("returns null for pathologically long queries", () => {
    const t = "@" + "a".repeat(40);
    expect(readMentionContext(t, t.length)).toBeNull();
  });
});

describe("MentionPopover render", () => {
  function setup(query = "") {
    const onSelect = vi.fn();
    const onDismiss = vi.fn();
    const setHighlighted = vi.fn();
    const utils = render(
      <MentionPopover
        query={query}
        roster={ROSTER}
        listboxId="lbx"
        onSelect={onSelect}
        onDismiss={onDismiss}
        highlightedIndex={0}
        setHighlightedIndex={setHighlighted}
      />,
    );
    return { ...utils, onSelect, onDismiss, setHighlighted };
  }

  it("renders the listbox + roster rows + facilitator entry", () => {
    setup();
    const listbox = screen.getByRole("listbox");
    expect(listbox.id).toBe("lbx");
    const options = screen.getAllByRole("option");
    // Facilitator first, then 3 roster rows.
    expect(options).toHaveLength(4);
    // First option has the facilitator distinguishing class (border-b
    // for the divider) — we can assert by content instead of class
    // for resilience.
    expect(options[0].textContent).toMatch(/facilitator/i);
  });

  it("marks the highlighted option as aria-selected and the others as not", () => {
    setup();
    const options = screen.getAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(options[1].getAttribute("aria-selected")).toBe("false");
  });

  it("commits the picked option on mousedown", () => {
    const { onSelect } = setup();
    const options = screen.getAllByRole("option");
    // Click on the SOC row (index 2 — facilitator + ciso + soc).
    fireEvent.mouseDown(options[2]);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].target).toBe("soc");
  });

  it("renders a No matches notice (role=status) when nothing matches", () => {
    // UI/UX review HIGH H2: the empty state is rendered as a
    // ``role="status"`` live region rather than as a dimmed
    // ``role="option"``, so screen readers don't announce a
    // pickable choice that isn't pickable. The listbox stays in
    // the DOM (empty) so the textarea's ``aria-controls`` doesn't
    // dangle.
    setup("zzzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    const status = screen.getByRole("status");
    expect(status.textContent).toMatch(/no matches/i);
    // The listbox is still present so aria-controls resolves.
    const listbox = screen.getByRole("listbox");
    expect(listbox.id).toBe("lbx");
  });

  it("dismisses on click outside", () => {
    const { onDismiss } = setup();
    fireEvent.mouseDown(document.body);
    expect(onDismiss).toHaveBeenCalled();
  });
});
