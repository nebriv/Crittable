/**
 * Rendering tests for ``AarReportView`` — the structured AAR popup.
 *
 * The 2026-05-01 trust-boundary fixes (PR #110) moved AAR coercion into
 * ``_extract_report``. The frontend now trusts the JSON payload as-is;
 * the route handler doesn't repair anything. This file locks that in:
 * the component handles the canonical good shape, the loading + error
 * states, and the score → grade rendering rubric (0-5 → A/B/C/D/F /
 * "—" with the right tone band).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { AarReportView } from "../components/AarReport";

interface PerRoleScore {
  role_id: string;
  decision_quality: number;
  communication: number;
  speed: number;
  decisions: number;
  rationale?: string;
  label?: string;
  display_name?: string | null;
}

function _report(overrides: Partial<PerRoleScore>[] = []): unknown {
  const base = {
    executive_summary: "The team responded effectively to the breach.",
    narrative: "Detection at 03:14 → containment by 03:46 → comms drafted.",
    what_went_well: ["Fast triage", "Clear comms"],
    gaps: ["Legal looped in late"],
    flagged_for_review: [
      "Isolated finance subnet at T+04:12",
      "Open question: revisit ransom decision after backup restore?",
    ],
    recommendations: ["Pre-stage legal contact in IR runbook"],
    per_role_scores:
      overrides.length > 0
        ? overrides.map((o, i) => ({
            role_id: `role-${i}`,
            decision_quality: 4,
            communication: 4,
            speed: 4,
            decisions: 2,
            label: "ROLE",
            ...o,
          }))
        : [
            {
              role_id: "role-ciso",
              decision_quality: 5,
              communication: 4,
              speed: 4,
              decisions: 3,
              rationale: "Decisive on isolation, kept comms cadence.",
              label: "CISO",
              display_name: "Alex",
            },
            {
              role_id: "role-soc",
              decision_quality: 3,
              communication: 3,
              speed: 3,
              decisions: 1,
              rationale: "Provided telemetry on request.",
              label: "SOC",
              display_name: "Bo",
            },
          ],
    overall_score: 4,
    overall_rationale: "Solid exercise with one notable gap.",
    meta: {
      session_id: "s-test",
      title: "Ransomware via vendor portal",
      created_at: "2026-04-30T14:00:00Z",
      ended_at: "2026-04-30T14:38:00Z",
      elapsed_ms: 38 * 60 * 1000,
      turn_count: 12,
      stuck_count: 1,
      roles: [
        {
          id: "role-ciso",
          label: "CISO",
          display_name: "Alex",
          is_creator: true,
        },
        {
          id: "role-soc",
          label: "SOC",
          display_name: "Bo",
          is_creator: false,
        },
      ],
      is_creator: true,
    },
  };
  return base;
}

function _mockFetch(status: number, body: unknown) {
  globalThis.fetch = vi.fn(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: {
        "content-type":
          typeof body === "string" ? "text/plain" : "application/json",
      },
    }),
  ) as unknown as typeof globalThis.fetch;
}

describe("AarReportView", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    /* fetch installed per-test */
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("renders the loading state before the fetch resolves", async () => {
    let resolve!: (r: Response) => void;
    globalThis.fetch = vi.fn(
      () => new Promise<Response>((r) => (resolve = r)),
    ) as unknown as typeof globalThis.fetch;
    render(
      <AarReportView
        sessionId="s1"
        token="tok"
        downloadMdHref="/x.md"
        downloadJsonHref="/x.json"
      />,
    );
    expect(screen.getByText(/loading structured report/i)).toBeInTheDocument();
    // Resolve and wait for the post-resolve render so React's act()
    // settles cleanly. Without this the next test inherits a leaked
    // pending state and console fills with act() warnings.
    resolve(_jsonResponse(_report()));
    await waitFor(() =>
      expect(
        screen.queryByText(/loading structured report/i),
      ).not.toBeInTheDocument(),
    );
  });

  it("renders the report on a 200 + valid JSON body", async () => {
    _mockFetch(200, _report());
    render(
      <AarReportView
        sessionId="s1"
        token="tok"
        downloadMdHref="/x.md"
        downloadJsonHref="/x.json"
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByText(/Ransomware via vendor portal · debrief/i),
      ).toBeInTheDocument(),
    );
    // Per-role rows show labels.
    expect(screen.getByText("CISO")).toBeInTheDocument();
    expect(screen.getByText("SOC")).toBeInTheDocument();
    // Brief blocks render.
    expect(screen.getByText(/Fast triage/i)).toBeInTheDocument();
    expect(screen.getByText(/Legal looped in late/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Pre-stage legal contact in IR runbook/i),
    ).toBeInTheDocument();
    // Export anchors.
    const md = screen.getByText(/MARKDOWN/i);
    expect(md.closest("a")).toHaveAttribute("href", "/x.md");
    expect(md.closest("a")).toHaveAttribute("download");
    const json = screen.getByText(/JSON TIMELINE/i);
    expect(json.closest("a")).toHaveAttribute("href", "/x.json");
  });

  it("renders 410 → 'expired' message", async () => {
    _mockFetch(410, "");
    render(
      <AarReportView
        sessionId="s1"
        token="tok"
        downloadMdHref="/x.md"
        downloadJsonHref="/x.json"
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/expired/i)).toBeInTheDocument(),
    );
  });

  it("renders 425 → 'still generating' message", async () => {
    _mockFetch(425, "");
    render(
      <AarReportView
        sessionId="s1"
        token="tok"
        downloadMdHref="/x.md"
        downloadJsonHref="/x.json"
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByText(/still generating/i),
      ).toBeInTheDocument(),
    );
  });

  it("renders generic HTTP error on 500", async () => {
    _mockFetch(500, "");
    render(
      <AarReportView
        sessionId="s1"
        token="tok"
        downloadMdHref="/x.md"
        downloadJsonHref="/x.json"
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/HTTP 500/i)).toBeInTheDocument(),
    );
  });

  it("displays '— not joined —' for roles without a display_name", async () => {
    _mockFetch(
      200,
      _report([
        {
          role_id: "role-x",
          decision_quality: 3,
          communication: 3,
          speed: 3,
          decisions: 0,
          label: "ANALYST",
          display_name: null,
        },
      ]),
    );
    render(
      <AarReportView
        sessionId="s1"
        token="tok"
        downloadMdHref="/x.md"
        downloadJsonHref="/x.json"
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/not joined/i)).toBeInTheDocument(),
    );
  });

  it("renders FUTURE pills as disabled (PDF / SLACK / RUNBOOK)", async () => {
    _mockFetch(200, _report());
    render(
      <AarReportView
        sessionId="s1"
        token="tok"
        downloadMdHref="/x.md"
        downloadJsonHref="/x.json"
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/PDF REPORT/i)).toBeInTheDocument(),
    );
    const pdfBtn = screen.getByText(/PDF REPORT/i).closest("button")!;
    expect(pdfBtn).toBeDisabled();
    expect(pdfBtn.getAttribute("aria-disabled")).toBe("true");
  });

  it("does not render the OVERALL · N / 5 block (the three top score cards already carry the team grade)", async () => {
    _mockFetch(200, _report());
    render(
      <AarReportView
        sessionId="s1"
        token="tok"
        downloadMdHref="/x.md"
        downloadJsonHref="/x.json"
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("CISO")).toBeInTheDocument(),
    );
    // The legacy "OVERALL · 4 / 5" eyebrow and the overall_rationale
    // prose used to render here. Both are gone; the three score cards
    // (CONTAINMENT / COMMS / DECISION SPEED) at the top already convey
    // the team's grade in the same letter scheme as the per-role rows.
    expect(screen.queryByText(/OVERALL\s*·\s*\d+\s*\/\s*5/)).toBeNull();
    expect(
      screen.queryByText(/Solid exercise with one notable gap\./),
    ).toBeNull();
  });

  it("per-role rows start collapsed and expand on click to show sub-scores + rationale", async () => {
    _mockFetch(200, _report());
    render(
      <AarReportView
        sessionId="s1"
        token="tok"
        downloadMdHref="/x.md"
        downloadJsonHref="/x.json"
      />,
    );
    await waitFor(() => expect(screen.getByText("CISO")).toBeInTheDocument());

    // Sub-score labels and rationale are hidden until the row is
    // toggled open. "DECISION" is unique to the per-role panel (the
    // top card is "DECISION SPEED"); "COMMS" + "SPEED" appear in
    // both the team-aggregate cards and the per-role panel, so the
    // expansion-driven assertions below scope queries to the row.
    expect(screen.queryByText("DECISION")).toBeNull();
    expect(
      screen.queryByText(/Decisive on isolation, kept comms cadence\./),
    ).toBeNull();

    // The row is a real <button type="button"> (not a div with role).
    // Lock the element so a future refactor to a non-button can't
    // silently regress keyboard activation.
    const cisoToggle = screen.getByText("CISO").closest("button")!;
    const cisoRow = within(cisoToggle.closest("li")!);
    expect(cisoToggle.tagName).toBe("BUTTON");
    expect(cisoToggle.getAttribute("type")).toBe("button");
    expect(cisoToggle.getAttribute("aria-expanded")).toBe("false");

    // aria-controls must reference a real DOM id once the panel
    // renders (i.e. on expansion). Pre-expand we just verify the
    // attribute is present and non-empty; the linkage is checked
    // after click.
    const controlsId = cisoToggle.getAttribute("aria-controls");
    expect(controlsId).toBeTruthy();

    // Chevron is the visual analog of aria-expanded — locked so a
    // regression to a static glyph or an inverted toggle is caught.
    expect(within(cisoToggle).getByText("▶")).toBeInTheDocument();

    fireEvent.click(cisoToggle);

    // After click: aria-expanded flips, chevron flips, the three
    // sub-score cells appear with their numeric values, the model's
    // rationale renders inline (not as a tooltip), and aria-controls
    // resolves to the panel that just appeared. Scope to the row's
    // <li> so "COMMS" / "SPEED" don't ambiguously match the top
    // score cards.
    expect(cisoToggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(cisoToggle).getByText("▼")).toBeInTheDocument();
    expect(document.getElementById(controlsId!)).not.toBeNull();
    expect(cisoRow.getByText("DECISION")).toBeInTheDocument();
    expect(cisoRow.getByText("COMMS")).toBeInTheDocument();
    expect(cisoRow.getByText("SPEED")).toBeInTheDocument();
    expect(
      cisoRow.getByText(/Decisive on isolation, kept comms cadence\./),
    ).toBeInTheDocument();

    // Click again → collapses back.
    fireEvent.click(cisoToggle);
    expect(cisoToggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(cisoToggle).getByText("▶")).toBeInTheDocument();
    expect(cisoRow.queryByText("DECISION")).toBeNull();
  });

  it("multiple per-role rows can be expanded simultaneously (side-by-side comparison)", async () => {
    _mockFetch(200, _report());
    render(
      <AarReportView
        sessionId="s1"
        token="tok"
        downloadMdHref="/x.md"
        downloadJsonHref="/x.json"
      />,
    );
    await waitFor(() => expect(screen.getByText("CISO")).toBeInTheDocument());

    fireEvent.click(screen.getByText("CISO").closest("button")!);
    fireEvent.click(screen.getByText("SOC").closest("button")!);

    // Both rationales should be visible — neither click closed the
    // other panel.
    expect(
      screen.getByText(/Decisive on isolation, kept comms cadence\./),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Provided telemetry on request\./),
    ).toBeInTheDocument();
  });

  it("renders the discoverability + grade-legend caption above the per-role list", async () => {
    _mockFetch(200, _report());
    render(
      <AarReportView
        sessionId="s1"
        token="tok"
        downloadMdHref="/x.md"
        downloadJsonHref="/x.json"
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("CISO")).toBeInTheDocument(),
    );
    // The legend tells a first-time creator (a) the rows can be
    // expanded and (b) what each letter actually means. Without it
    // the bare "B" carries no anchoring.
    expect(
      screen.getByText(
        /Open a row for the breakdown.*A exemplary.*B above bar.*C at bar.*D below bar.*F critical/,
      ),
    ).toBeInTheDocument();
  });

  it("each per-role toggle button has an accessible label describing the action", async () => {
    _mockFetch(200, _report());
    render(
      <AarReportView
        sessionId="s1"
        token="tok"
        downloadMdHref="/x.md"
        downloadJsonHref="/x.json"
      />,
    );
    await waitFor(() => expect(screen.getByText("CISO")).toBeInTheDocument());
    // CISO row: label="CISO", display_name="Alex", decisions=3,
    // computed grade from (5+4+4)/3≈4.33→B (rounds to 4 → "B").
    const cisoBtn = screen.getByText("CISO").closest("button")!;
    const ariaLabel = cisoBtn.getAttribute("aria-label") ?? "";
    expect(ariaLabel).toMatch(/CISO/);
    expect(ariaLabel).toMatch(/Alex/);
    expect(ariaLabel).toMatch(/B/);
    expect(ariaLabel).toMatch(/3 decisions/);
    expect(ariaLabel).toMatch(/toggle breakdown/i);
  });

  it("a 0 sub-score (no-score sentinel) does not drag the headline letter — counted only as '—' in the cell, skipped in the average", async () => {
    // Regression: PR #204 review caught that `(0 + 5 + 5) / 3 = 3.33`
    // would round to a "C" headline letter while the expanded panel
    // already renders "—" for the 0 sub-score (per
    // `gradeForScore`'s rubric, 0 means "no score", not F-equivalent).
    // The fix filters 0 / non-finite values in `avg()` and reuses
    // it for the per-role overall — so 0/5/5 grades as A on the
    // surviving sub-scores.
    _mockFetch(
      200,
      _report([
        {
          role_id: "role-partial",
          decision_quality: 0, // not scored
          communication: 5,
          speed: 5,
          decisions: 2,
          rationale: "Strong on comms and speed; decision data missing.",
          label: "PARTIAL",
          display_name: "Riley",
        },
      ]),
    );
    render(
      <AarReportView
        sessionId="s1"
        token="tok"
        downloadMdHref="/x.md"
        downloadJsonHref="/x.json"
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("PARTIAL")).toBeInTheDocument(),
    );
    const toggle = screen.getByText("PARTIAL").closest("button")!;
    const row = within(toggle.closest("li")!);
    // Headline grade: avg of {5, 5} = 5 → "A". Pre-fix: avg of
    // {0, 5, 5} = 3.33 → "C". The aria-label echoes the same
    // headline letter so we can read it without expanding.
    expect(toggle.getAttribute("aria-label")).toMatch(/overall A/);
    fireEvent.click(toggle);
    // Expanded: DECISION cell renders "—" (the 0 sub-score), the
    // other two render their numeric values. Use a regex over the
    // cell's mono span so a stray "5" elsewhere in the panel
    // doesn't satisfy the assertion.
    expect(row.getByText("DECISION")).toBeInTheDocument();
    expect(row.getByText("COMMS")).toBeInTheDocument();
    expect(row.getByText("SPEED")).toBeInTheDocument();
    expect(row.getByText("—")).toBeInTheDocument();
  });

  it("a role with all sub-scores at 0 renders '—' as the headline grade (no valid data)", async () => {
    _mockFetch(
      200,
      _report([
        {
          role_id: "role-empty",
          decision_quality: 0,
          communication: 0,
          speed: 0,
          decisions: 0,
          rationale: undefined,
          label: "ABSENT",
          display_name: null,
        },
      ]),
    );
    render(
      <AarReportView
        sessionId="s1"
        token="tok"
        downloadMdHref="/x.md"
        downloadJsonHref="/x.json"
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("ABSENT")).toBeInTheDocument(),
    );
    // The headline-letter span lives in the toggle button. With
    // all sub-scores at 0 the avg() filter leaves nothing; overall
    // falls back to 0; gradeForScore renders "—" in neutral ink.
    const toggle = screen.getByText("ABSENT").closest("button")!;
    expect(toggle.getAttribute("aria-label")).toMatch(/overall —/);

    // Bug-scrub M3: a sub-score of 0 must NOT render in crit (red)
    // tone. The previous toneForScore(0) returned "crit"; ScoreCard
    // had an isEmpty override that papered over it. Now toneForScore
    // returns "neutral" directly, mapped to ink-500 / ink-600. With
    // the prompt now intentionally telling the model 0 = "no
    // observable evidence", a skipped sub-score appearing in red
    // would make the report look harsh on roles that simply weren't
    // active in that dimension. Pin the tone class.
    const headlineSpan = within(toggle).getByText("—");
    // Headline span carries either text-* or border-* classes from
    // toneClass. With a "neutral" tone these must be ink-500 (text)
    // — never text-crit.
    expect(headlineSpan.className).not.toMatch(/text-crit/);
    expect(headlineSpan.className).toMatch(/text-ink-500/);
  });

  it.each([
    // Class-level: pin the score → tone band relationship across
    // the full 0–5 range so a future tone-band reshuffle can't
    // re-introduce the M3 bug ("0 = no evidence" rendered in crit
    // red). The headline grade letter carries the tone via a text-*
    // class; crit-red is reserved for genuinely failing scores
    // (0 < s < 3), not for "no observable evidence" (score=0).
    { score: 0, expected: /text-ink-500/, forbidden: /text-crit/, name: "0 (skipped → neutral)" },
    { score: 1, expected: /text-crit/, forbidden: null, name: "1 (critical → crit)" },
    { score: 2, expected: /text-crit/, forbidden: null, name: "2 (below bar → crit)" },
    { score: 3, expected: /text-warn/, forbidden: /text-crit/, name: "3 (at bar → warn)" },
    { score: 4, expected: /text-signal/, forbidden: /text-crit/, name: "4 (above bar → signal)" },
    { score: 5, expected: /text-signal/, forbidden: /text-crit/, name: "5 (exemplary → signal)" },
  ])(
    "per-role headline tone band: $name",
    async ({ score, expected, forbidden }) => {
      // Drive the tone via the per-role overall (avg of three
      // identical sub-scores). All-zero exercises the 0 = "neutral"
      // branch; all-non-zero exercises crit/warn/signal.
      _mockFetch(
        200,
        _report([
          {
            role_id: `role-tone-${score}`,
            decision_quality: score,
            communication: score,
            speed: score,
            decisions: 1,
            rationale: "tone-band probe",
            label: `T${score}`,
            display_name: null,
          },
        ]),
      );
      render(
        <AarReportView
          sessionId="s1"
          token="tok"
          downloadMdHref="/x.md"
          downloadJsonHref="/x.json"
        />,
      );
      await waitFor(() =>
        expect(screen.getByText(`T${score}`)).toBeInTheDocument(),
      );
      const toggle = screen.getByText(`T${score}`).closest("button")!;
      // Grade letter span sits last inside the toggle button. With
      // score=0 the grade is "—"; otherwise it's a letter A-F. Find
      // it by class shape (mono + tabular-nums + the score letter).
      const gradeSpan = within(toggle)
        .getAllByText(score === 0 ? "—" : /^[A-F]$/)
        .find((el) => el.classList.contains("mono"));
      expect(gradeSpan, "grade letter span not found").toBeTruthy();
      expect(gradeSpan!.className).toMatch(expected);
      if (forbidden) {
        expect(gradeSpan!.className).not.toMatch(forbidden);
      }
    },
  );

  it("a 0 sub-score renders the DECISION cell in neutral ink, not crit (red)", async () => {
    // Bug-scrub M3 regression: with skip-zero mainstreamed in the
    // prompt rubric, the per-cell tone for a 0 sub-score must be
    // neutral. Previously the cell used toneForScore(0) → crit, then
    // an isEmpty override at the call site swapped to ink-500. The
    // override is gone; toneForScore now returns "neutral" directly.
    _mockFetch(
      200,
      _report([
        {
          role_id: "role-partial-tone",
          decision_quality: 0,
          communication: 5,
          speed: 5,
          decisions: 2,
          rationale: "Skipped decision dimension.",
          label: "PTONE",
          display_name: "T",
        },
      ]),
    );
    render(
      <AarReportView
        sessionId="s1"
        token="tok"
        downloadMdHref="/x.md"
        downloadJsonHref="/x.json"
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("PTONE")).toBeInTheDocument(),
    );
    const toggle = screen.getByText("PTONE").closest("button")!;
    fireEvent.click(toggle);
    // The DECISION cell label sits next to a value span. With value=0
    // the value span shows "—" and must carry text-ink-500 / not
    // text-crit. Two "—" can appear (headline + cell); scope to the
    // expanded breakdown via the parent <li>.
    const row = within(toggle.closest("li")!);
    const dashes = row.getAllByText("—");
    // Every "—" we render in this row must be neutral ink, never crit.
    for (const node of dashes) {
      expect(node.className).not.toMatch(/text-crit/);
    }
  });

  it("expanded row without a rationale falls back to a placeholder line", async () => {
    _mockFetch(
      200,
      _report([
        {
          role_id: "role-x",
          decision_quality: 2,
          communication: 2,
          speed: 2,
          decisions: 1,
          rationale: undefined,
          label: "ANALYST",
          display_name: "Casey",
        },
      ]),
    );
    render(
      <AarReportView
        sessionId="s1"
        token="tok"
        downloadMdHref="/x.md"
        downloadJsonHref="/x.json"
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("ANALYST")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText("ANALYST").closest("button")!);
    expect(screen.getByText(/no rationale recorded/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- helpers

function _jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
