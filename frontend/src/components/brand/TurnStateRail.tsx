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
}

function TurnStateRow({ step, done, active }: RowProps) {
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
            flex: 1,
            height: 2,
            background: "var(--ink-700)",
            borderRadius: 1,
            overflow: "hidden",
          }}
          aria-hidden="true"
        >
          <div
            style={{
              width: "60%",
              height: "100%",
              background: "var(--signal)",
              animation: "tt-pulse 1.6s ease-in-out infinite",
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

interface Props {
  state: string | null | undefined;
  /** Optional subtitle for the section header (e.g. "awaiting 1 of 3"). */
  subtitle?: string;
}

export function TurnStateRail({ state, subtitle }: Props) {
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
          />
        ))}
      </div>
    </div>
  );
}
