import { useEffect, useState } from "react";

/**
 * Structured AAR layout — renders the JSON variant of the after-action
 * report (`/api/sessions/{id}/export.json`) into the brand mock's
 * <AppAAR> composition: left column with title + meta + 3 score cards
 * + 3 brief blocks, right column with per-role scoring + export
 * actions.
 *
 * Data shape mirrors the structured AAR the backend already produces
 * via the ``finalize_report`` tool. See
 * ``backend/app/api/routes.py::export_json`` for the response envelope.
 *
 * The popup chrome (close button, escape handling, dialog layout)
 * stays in <AARPopup>; this component is the body.
 */

interface RoleMeta {
  id: string;
  label: string;
  display_name: string | null;
  is_creator: boolean;
}

interface PerRoleScore {
  role_id: string;
  decision_quality: number;
  communication: number;
  speed: number;
  decisions: number;
  rationale?: string;
  /** Backend-resolved short label (e.g. "CISO", "IR Lead"). The AI
   *  occasionally emits unrecognized role_ids; the route handler
   *  falls back to label-as-id matching, then to the raw value, so
   *  the UI never has to render a UUID prefix. */
  label?: string;
  display_name?: string | null;
}

interface AarMeta {
  session_id: string;
  title: string | null;
  created_at: string;
  ended_at: string | null;
  elapsed_ms: number | null;
  turn_count: number;
  stuck_count: number;
  roles: RoleMeta[];
  is_creator: boolean;
}

interface AarReport {
  executive_summary: string;
  narrative: string;
  what_went_well: string[];
  gaps: string[];
  /**
   * Issue #117 — moments players flagged mid-exercise via the
   * highlight popover's "Mark for AAR" action. Deliberately
   * category-agnostic: a flag might be a decision, a question, a
   * follow-up, a debrief item, a team-level concern, etc. Empty
   * when the affordance wasn't used and the model didn't flag any
   * from the transcript; the section is hidden in that case.
   */
  flagged_for_review: string[];
  recommendations: string[];
  per_role_scores: PerRoleScore[];
  overall_score: number;
  overall_rationale: string;
  meta: AarMeta;
}

interface Props {
  sessionId: string;
  token: string;
  /** Markdown export href — bound to the existing <a download> button. */
  downloadMdHref: string;
  /** Structured-JSON export href. */
  downloadJsonHref: string;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; report: AarReport }
  | { kind: "error"; message: string };

export function AarReportView({
  sessionId,
  token,
  downloadMdHref,
  downloadJsonHref,
}: Props) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let canceled = false;
    (async () => {
      try {
        const url = `/api/sessions/${sessionId}/export.json?token=${encodeURIComponent(token)}`;
        const res = await fetch(url, { credentials: "same-origin" });
        if (canceled) return;
        if (!res.ok) {
          if (res.status === 410) {
            setState({
              kind: "error",
              message:
                "This after-action report has expired and is no longer available.",
            });
          } else if (res.status === 425) {
            setState({
              kind: "error",
              message: "AAR is still generating — refresh in a moment.",
            });
          } else {
            setState({ kind: "error", message: `HTTP ${res.status}` });
          }
          return;
        }
        const body = (await res.json()) as AarReport;
        if (!canceled) setState({ kind: "ready", report: body });
      } catch (e) {
        if (canceled) return;
        setState({
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    })();
    return () => {
      canceled = true;
    };
  }, [sessionId, token]);

  if (state.kind === "loading") {
    return (
      <div className="flex h-full min-h-[40vh] items-center justify-center">
        <p className="mono text-[11px] uppercase tracking-[0.16em] text-ink-300">
          Loading structured report…
        </p>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <p className="mono rounded-r-1 border border-crit bg-crit-bg p-3 text-[12px] uppercase tracking-[0.04em] text-crit">
        {state.message}
      </p>
    );
  }

  const { report } = state;
  // The dialog body is a tall fixed box (`h-[90vh]`). Each column has
  // its own scroll region so they don't stretch to match each other —
  // the right column is naturally short (per-role rows + 5 export
  // pills) and would otherwise leave a 600 px void below EXPORT.
  // `align-items: start` on the grid keeps each column at content
  // height; per-column overflow lets long brief blocks scroll on the
  // left without dragging the right column with them.
  return (
    <div
      className="grid h-full min-h-0 grid-cols-1 items-start gap-6 lg:grid-cols-[1.2fr_1fr]"
      style={{ overflow: "hidden" }}
    >
      <LeftColumn report={report} />
      <RightColumn
        report={report}
        downloadMdHref={downloadMdHref}
        downloadJsonHref={downloadJsonHref}
      />
    </div>
  );
}

/**
 * Map a 0-5 sub-score (the rubric in the AAR system prompt:
 * 1=critically-off, 2=below-bar, 3=at-bar, 4=above-bar, 5=exemplary,
 * 0=no-score) to a letter grade. The letters intentionally collapse
 * the 5-point rubric onto a 5-point grade scale 1:1 — half-grades
 * (A-, B+) would imply finer resolution than the rubric supports
 * and tempt the model to bunch at the modifiers.
 *
 * Averages of multiple sub-scores fall on non-integer values; round
 * to the nearest grade band before lookup.
 */
function gradeForScore(score: number): string {
  if (!Number.isFinite(score)) return "—";
  const s = Math.round(Math.max(0, Math.min(5, score)));
  if (s === 5) return "A";
  if (s === 4) return "B";
  if (s === 3) return "C";
  if (s === 2) return "D";
  if (s === 1) return "F";
  return "—";
}

/**
 * Brand status tone for the same 0-5 score:
 *   ≥4   signal (above bar)
 *   ≈3   warn   (at-or-around bar)
 *   <3   crit   (below bar — this is what the AAR is for)
 *   0    crit   (no score / phantom data)
 */
function toneForScore(
  score: number,
): "signal" | "warn" | "crit" {
  if (!Number.isFinite(score) || score <= 0) return "crit";
  if (score >= 3.75) return "signal";
  if (score >= 2.75) return "warn";
  return "crit";
}

function toneClass(tone: "signal" | "warn" | "crit"): {
  border: string;
  text: string;
} {
  if (tone === "signal") return { border: "border-signal", text: "text-signal" };
  if (tone === "warn") return { border: "border-warn", text: "text-warn" };
  return { border: "border-crit", text: "text-crit" };
}

/** "1H 38M" / "47M" / "—" — short, mono-friendly. */
function formatElapsed(ms: number | null): string {
  if (ms == null) return "—";
  const totalMin = Math.max(1, Math.round(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}M`;
  return `${h}H ${m}M`;
}

/** "2026-04-30 14:22 UTC" — match the brand mock format verbatim. */
function formatGenerated(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi} UTC`;
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function LeftColumn({ report }: { report: AarReport }) {
  const { meta, per_role_scores } = report;
  const containment = avg(per_role_scores.map((r) => r.decision_quality));
  const comms = avg(per_role_scores.map((r) => r.communication));
  const decisionSpeed = avg(per_role_scores.map((r) => r.speed));
  const headerTitle =
    (meta.title?.trim() || "Cybersecurity tabletop exercise") + " · debrief";
  return (
    <section className="flex max-h-full min-h-0 flex-col gap-4 overflow-y-auto pr-2">
      <header className="flex flex-col gap-1">
        <p className="mono text-[11px] font-bold uppercase tracking-[0.22em] text-signal">
          AFTER-ACTION REPORT
        </p>
        <h1 className="text-3xl font-semibold tracking-[-0.02em] text-ink-050 sans">
          {headerTitle}
        </h1>
        <p className="mono mt-1 text-[11px] uppercase tracking-[0.10em] text-ink-400 tabular-nums">
          {meta.turn_count} TURNS · {meta.stuck_count} STUCK ·{" "}
          {formatElapsed(meta.elapsed_ms)} · GENERATED{" "}
          {formatGenerated(meta.ended_at)}
        </p>
      </header>

      <div className="grid grid-cols-3 gap-2">
        <ScoreCard label="CONTAINMENT" score={containment} />
        <ScoreCard label="COMMS" score={comms} />
        <ScoreCard label="DECISION SPEED" score={decisionSpeed} />
      </div>

      {report.what_went_well.length > 0 ? (
        <BriefBlock title="WHAT WORKED" items={report.what_went_well} />
      ) : null}
      {report.gaps.length > 0 ? (
        <BriefBlock title="WHAT DIDN'T" items={report.gaps} tone="warn" />
      ) : null}
      {report.flagged_for_review.length > 0 ? (
        <BriefBlock
          title="FLAGGED FOR REVIEW"
          items={report.flagged_for_review}
          tone="signal"
        />
      ) : null}
      {report.recommendations.length > 0 ? (
        <BriefBlock
          title="RECOMMENDATIONS"
          items={report.recommendations}
          tone="signal"
        />
      ) : null}

      {report.executive_summary || report.narrative ? (
        <section className="rounded-r-2 border border-ink-600 bg-ink-800 p-4">
          <p className="mono mb-2 text-[10px] font-bold uppercase tracking-[0.20em] text-ink-300">
            NARRATIVE
          </p>
          {report.executive_summary ? (
            <p className="mb-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-100">
              {report.executive_summary}
            </p>
          ) : null}
          {report.narrative ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-200">
              {report.narrative}
            </p>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

function ScoreCard({ label, score }: { label: string; score: number }) {
  // "—" (no data) renders in neutral ink so the empty state doesn't
  // read as a failing grade. F still gets crit treatment.
  const grade = gradeForScore(score);
  const isEmpty = grade === "—";
  const tone = toneForScore(score);
  const t = toneClass(tone);
  const borderClass = isEmpty ? "border-ink-600" : t.border;
  const textClass = isEmpty ? "text-ink-500" : t.text;
  return (
    <div
      className={`flex flex-col gap-1 rounded-r-3 border bg-ink-850 p-4 ${borderClass}`}
    >
      <p className="mono text-[9px] font-bold uppercase tracking-[0.20em] text-ink-300">
        {label}
      </p>
      <p
        className={`mono text-4xl font-bold leading-none tabular-nums ${textClass}`}
      >
        {grade}
      </p>
    </div>
  );
}

function RightColumn({
  report,
  downloadMdHref,
  downloadJsonHref,
}: {
  report: AarReport;
  downloadMdHref: string;
  downloadJsonHref: string;
}) {
  const { meta, per_role_scores } = report;
  const labelById = new Map(meta.roles.map((r) => [r.id, r] as const));
  // Per-role expansion state. Set, not boolean, so multiple rows can
  // be open at once for side-by-side comparison ("why did CISO get B
  // when SOC also got B?"). Resets to empty whenever the dialog
  // re-mounts; the report is meant to be read in one sitting.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (roleId: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  };

  return (
    <section className="flex max-h-full flex-col gap-4 overflow-y-auto rounded-r-3 border border-ink-600 bg-ink-850 p-4">
      <div className="flex flex-col gap-1">
        <p className="mono text-[10px] font-bold uppercase tracking-[0.22em] text-ink-300">
          PER-ROLE SCORING
        </p>
        {/* Discoverability + grade-legend caption. The bare letter
            grade carries no anchoring without a key (a CISO seeing
            "B" can't tell if it's "fine" or "we need a postmortem"),
            and the chevron alone reads as ornament — calling out the
            tap affordance turns a static-looking row into a clearly
            interactive one. */}
        <p className="mono text-[9px] uppercase tracking-[0.14em] text-ink-400">
          Tap a row for the breakdown · A exemplary · B above bar · C at bar · D below bar · F critical
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {per_role_scores.map((s) => {
          // Prefer the backend-resolved label/display_name (which
          // already handles AI emitting label-as-id, unknown ids,
          // etc.); fall back to a roster-side lookup for older AAR
          // payloads that pre-date the resolver.
          const fromMeta = labelById.get(s.role_id);
          const label = s.label ?? fromMeta?.label ?? "—";
          const displayName =
            (s.display_name ?? fromMeta?.display_name) ?? null;
          const overall = (s.decision_quality + s.communication + s.speed) / 3;
          const grade = gradeForScore(overall);
          const isEmpty = grade === "—";
          const tone = toneForScore(overall);
          const tc = toneClass(tone);
          const gradeColor = isEmpty ? "text-ink-500" : tc.text;
          const isOpen = expanded.has(s.role_id);
          const detailId = `aar-role-detail-${s.role_id}`;
          return (
            <li
              key={`${s.role_id}-${label}`}
              className="rounded-r-1 border border-ink-600 bg-ink-800"
            >
              <button
                type="button"
                onClick={() => toggle(s.role_id)}
                aria-expanded={isOpen}
                aria-controls={detailId}
                aria-label={`${label}${
                  displayName ? `, ${displayName}` : ""
                }: overall ${grade}, ${s.decisions} ${
                  s.decisions === 1 ? "decision" : "decisions"
                }. Toggle breakdown.`}
                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-ink-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal"
              >
                <span
                  aria-hidden="true"
                  className="mono shrink-0 text-[9px] leading-none text-ink-200"
                  style={{ width: 8 }}
                >
                  {isOpen ? "▼" : "▶"}
                </span>
                <span
                  className="mono shrink-0 truncate text-[11px] font-bold uppercase tracking-[0.10em] text-ink-100"
                  style={{ minWidth: 56, maxWidth: 96 }}
                >
                  {label}
                </span>
                <span className="sans flex-1 truncate text-[13px] text-ink-200">
                  {displayName ?? (
                    <span className="text-ink-500">— not joined —</span>
                  )}
                </span>
                <span className="mono text-[10px] uppercase tracking-[0.10em] text-ink-400 tabular-nums">
                  {s.decisions} {s.decisions === 1 ? "DECISION" : "DECISIONS"}
                </span>
                <span
                  className={`mono w-7 text-right text-[16px] font-bold tabular-nums ${gradeColor}`}
                >
                  {grade}
                </span>
              </button>
              {isOpen ? (
                <div
                  id={detailId}
                  className="flex flex-col gap-2 border-t border-ink-700 bg-ink-850 px-3 py-3"
                >
                  <div className="grid grid-cols-3 gap-2">
                    <SubScoreCell
                      label="DECISION"
                      value={s.decision_quality}
                    />
                    <SubScoreCell label="COMMS" value={s.communication} />
                    <SubScoreCell label="SPEED" value={s.speed} />
                  </div>
                  {s.rationale ? (
                    <p className="text-[12px] leading-relaxed text-ink-200">
                      {s.rationale}
                    </p>
                  ) : (
                    <p className="mono text-[10px] uppercase tracking-[0.16em] text-ink-500">
                      No rationale recorded.
                    </p>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="border-t border-dashed border-ink-600 pt-3">
        <p className="mono mb-2 text-[10px] font-bold uppercase tracking-[0.22em] text-ink-300">
          EXPORT
        </p>
        <div className="flex flex-wrap gap-1.5">
          <a
            href={downloadMdHref}
            download
            rel="noopener"
            className="mono rounded-r-1 border border-signal-deep bg-signal-tint px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-signal hover:border-signal hover:bg-signal/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal"
          >
            MARKDOWN
          </a>
          <a
            href={downloadJsonHref}
            download
            rel="noopener"
            className="mono rounded-r-1 border border-signal-deep bg-signal-tint px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-signal hover:border-signal hover:bg-signal/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal"
          >
            JSON TIMELINE
          </a>
          <FuturePillBtn label="PDF REPORT" />
          <FuturePillBtn label="SLACK SUMMARY" />
          <FuturePillBtn label="RUNBOOK DIFF" />
        </div>
      </div>

      {/* The dialog footer already shows the truncated session id —
          no need to repeat it inline; we just take the spare height
          so the column doesn't visually trail off. */}
    </section>
  );
}

/**
 * One labeled sub-score (DECISION / COMMS / SPEED) shown inside the
 * expanded per-role panel. Surfaces the raw 0-5 rubric value so two
 * roles that both round to "B" overall still tell a different story
 * (e.g. 5/5/3 reads very differently from 4/4/4). Uses the same
 * tone bands as the headline letter — color carries severity, the
 * number carries precision.
 */
function SubScoreCell({ label, value }: { label: string; value: number }) {
  const isEmpty = !Number.isFinite(value) || value <= 0;
  const tone = toneForScore(value);
  const tc = toneClass(tone);
  const valueColor = isEmpty ? "text-ink-500" : tc.text;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="mono text-[9px] font-bold uppercase tracking-[0.16em] text-ink-400">
        {label}
      </span>
      <span
        className={`mono text-[14px] font-bold tabular-nums ${valueColor}`}
      >
        {isEmpty ? "—" : value}
        {isEmpty ? null : (
          <span className="text-ink-500"> / 5</span>
        )}
      </span>
    </div>
  );
}

/**
 * Disabled placeholder for export targets that the brand mock shows
 * but the backend doesn't yet emit (PDF render, Slack summary,
 * runbook diff). Renders identical to the live buttons so the layout
 * matches the mock; the ``aria-disabled`` + ``title`` make the
 * "coming soon" state legible to keyboard / screen-reader users.
 */
function FuturePillBtn({ label }: { label: string }) {
  return (
    <button
      type="button"
      aria-disabled="true"
      disabled
      title="Phase 3 — not yet implemented. Use MARKDOWN or JSON TIMELINE today."
      className="mono cursor-not-allowed rounded-r-1 border border-ink-500 bg-transparent px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400 opacity-60"
    >
      {label}
    </button>
  );
}

function BriefBlock({
  title,
  items,
  tone = "signal",
}: {
  title: string;
  items: string[];
  tone?: "signal" | "warn" | "crit";
}) {
  const t = toneClass(tone);
  return (
    <section
      className={`rounded-r-2 border-l-2 bg-ink-800 p-4 ${t.border} border-y border-r border-y-ink-600 border-r-ink-600`}
    >
      <p
        className={`mono mb-2 text-[10px] font-bold uppercase tracking-[0.20em] ${t.text}`}
      >
        {title}
      </p>
      <ul className="flex list-none flex-col gap-1.5 pl-0 text-sm leading-relaxed text-ink-100">
        {items.map((it, i) => (
          <li key={i} className="flex gap-2">
            <span
              aria-hidden="true"
              className="mt-2 inline-block h-1 w-1 shrink-0 rounded-full bg-ink-500"
            />
            <span className="min-w-0 whitespace-pre-wrap break-words">{it}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
