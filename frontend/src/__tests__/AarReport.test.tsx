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
import { render, screen, waitFor } from "@testing-library/react";

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
});

// ---------------------------------------------------------------- helpers

function _jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
