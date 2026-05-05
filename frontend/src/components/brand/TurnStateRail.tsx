import { RailHeader } from "./RailHeader";

/**
 * Brand-mock <TurnState> + the LeftRail "TURN STATE" panel that wraps
 * five of them. Lifted from /tmp/brand-source/handoff/source/app-screens.jsx
 * lines 147-244.
 *
 * Maps the live ``snapshot.state`` (which is one of CREATED / SETUP /
 * READY / BRIEFING / AWAITING_PLAYERS / AI_PROCESSING / ENDED) onto a
 * five-row indicator. ``done`` rows are dim, ``active`` glows signal,
 * ``pending`` rows sit darker. Pure visual; no behavior change.
 */

const STEPS = [
  { id: "setup",            label: "SETUP" },
  { id: "briefing",         label: "BRIEFING" },
  { id: "ai_processing",    label: "AI PROCESSING" },
  { id: "awaiting_players", label: "AWAITING PLAYERS" },
  { id: "ended",            label: "ENDED" },
] as const;

type StepId = typeof STEPS[number]["id"];

/**
 * Project the backend session state onto our 5-row indicator. The
 * backend has more states than the indicator shows, so we collapse
 * the early states into SETUP and treat both AWAITING_PLAYERS and
 * AI_PROCESSING as live in-session beats.
 */
function activeStep(state: string | null | undefined): StepId | null {
  switch (state) {
    case "CREATED":
    case "SETUP":
    case "READY":
      return "setup";
    case "BRIEFING":
      return "briefing";
    case "AI_PROCESSING":
      return "ai_processing";
    case "AWAITING_PLAYERS":
      return "awaiting_players";
    case "ENDED":
      return "ended";
    default:
      return null;
  }
}

interface RowProps {
  step: StepId;
  done?: boolean;
  active?: boolean;
  /** Issue #111: per-turn progress fraction in [0.0, 1.0] for the
   *  active row's bar. ``null`` / undefined → keep the indeterminate
   *  sweep; a number → render a determinate width-driven bar. Only
   *  the active row consumes this; non-active rows ignore it. */
  progressPct?: number | null;
}

function TurnStateRow({ step, done, active, progressPct }: RowProps) {
  const labels: Record<StepId, string> = {
    setup: "SETUP",
    briefing: "BRIEFING",
    ai_processing: "AI PROCESSING",
    awaiting_players: "AWAITING PLAYERS",
    ended: "ENDED",
  };
  const color = done
    ? "var(--ink-400)"
    : active
      ? "var(--signal)"
      : "var(--ink-500)";
  const dot = done ? "●" : active ? "◉" : "○";
  // Issue #111: when the backend supplied a real progress fraction,
  // render a determinate bar (width = pct * 100%) instead of the
  // indeterminate ``tt-stream`` sweep. ``null`` / undefined falls
  // back to the sweep so the rail still reads as "the system is
  // doing something" before the engine has a meaningful sub-step
  // (e.g. very early in a play turn before the LLM call returns).
  // The width transition is short and ease-out so a step from 0.40
  // → 0.70 reads as a smooth fill rather than a jump.
  const hasDeterminate =
    typeof progressPct === "number" && Number.isFinite(progressPct);
  const clampedPct = hasDeterminate
    ? Math.max(0, Math.min(1, progressPct as number))
    : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span className="mono" style={{ fontSize: 12, color, width: 14 }}>
        {dot}
      </span>
      <span
        className="mono"
        style={{
          fontSize: 10,
          color,
          letterSpacing: "0.12em",
          fontWeight: active ? 700 : 500,
        }}
      >
        {labels[step]}
      </span>
      {active ? (
        <div
          style={{
            position: "relative",
            flex: 1,
            height: 2,
            background: "var(--ink-700)",
            borderRadius: 1,
            overflow: "hidden",
          }}
          // Determinate bar advertises its value; sweep is decorative.
          role={hasDeterminate ? "progressbar" : undefined}
          aria-valuemin={hasDeterminate ? 0 : undefined}
          aria-valuemax={hasDeterminate ? 100 : undefined}
          aria-valuenow={
            hasDeterminate ? Math.round(clampedPct * 100) : undefined
          }
          aria-hidden={hasDeterminate ? undefined : "true"}
        >
          {hasDeterminate ? (
            <div
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: 0,
                width: `${clampedPct * 100}%`,
                background: "var(--signal)",
                transition: "width 300ms ease-out",
              }}
            />
          ) : (
            // Both ``className="animate-tt-stream"`` AND inline
            // ``animation`` are needed: the inline style fires the
            // sweep at runtime, and the class is the hook that the
            // ``prefers-reduced-motion`` rule in ``index.css`` uses
            // to disable it (``animation: none !important`` beats the
            // inline declaration). Pre-PR the inline-only sweep
            // slipped past the reduced-motion override.
            <div
              className="animate-tt-stream"
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                width: "40%",
                background:
                  "linear-gradient(90deg, transparent, var(--signal) 35%, var(--signal) 65%, transparent)",
                animation: "tt-stream 1.8s ease-in-out infinite",
              }}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

interface Props {
  state: string | null | undefined;
  /** Optional subtitle for the section header (e.g. "awaiting 1 of 3"). */
  subtitle?: string;
  /** Issue #111: backend-supplied per-turn progress fraction. See
   *  ``backend/app/sessions/progress.py`` for the per-state policy.
   *  ``null`` / undefined → indeterminate sweep. */
  progressPct?: number | null;
}

export function TurnStateRail({ state, subtitle, progressPct }: Props) {
  const active = activeStep(state);
  const activeIdx = STEPS.findIndex((s) => s.id === active);
  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column" }}>
      <RailHeader
        title="TURN STATE"
        subtitle={subtitle ?? (active ? undefined : "—")}
        inline
      />
      <div
        style={{
          marginTop: 12,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {STEPS.map((s, i) => (
          <TurnStateRow
            key={s.id}
            step={s.id}
            done={activeIdx >= 0 ? i < activeIdx : false}
            active={s.id === active}
            progressPct={s.id === active ? progressPct : null}
          />
        ))}
      </div>
    </div>
  );
}
