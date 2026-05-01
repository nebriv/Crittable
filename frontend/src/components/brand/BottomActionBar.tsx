import { useEffect, useState } from "react";
import { CostSnapshot } from "../../api/client";

/**
 * Brand-mock <ActionBar> + the right-side WS / build telemetry strip.
 * Lifted from /tmp/brand-source/handoff/source/app-screens.jsx
 * lines 566-585. Renders as a sticky 48 px bar at the very bottom of
 * the in-session view.
 *
 * Layout:
 *   [CREATOR ADMIN label] [phase CTAs]            [telemetry] [WS · CONNECTED]
 *
 * Per the user's request after the initial brand pass, *most* of the
 * dense operator telemetry that previously lived in the top bar
 * (turn count, message count, rationale count, connection count,
 * last event time, LLM tier chip, cost, state, build SHA, God Mode,
 * "New session") is now down here so the top bar stays uncluttered
 * brand chrome.
 */
type Phase = "intro" | "setup" | "ready" | "play" | "ended";

interface Props {
  phase: Phase;
  backendState: string;
  wsStatus: "connecting" | "open" | "closed" | "error";
  godMode: boolean;
  onToggleGodMode: () => void;
  onStart: () => void;
  onForceAdvance: () => void;
  onEnd: () => void;
  onNewSession: () => void;
  onViewAar: () => void;
  playerCount: number;
  hasFinalizedPlan: boolean;
  aarStatus: string | null;
  busy: boolean;
  turnIndex: number | null;
  rationaleCount: number;
  connectionCount: number | null;
  lastEventAt: number | null;
  cost: CostSnapshot | null;
  messageCount: number;
  activeTiers: string[];
  buildSha: string;
  buildTs: string;
}

export function BottomActionBar(props: Props) {
  const wsColour =
    props.wsStatus === "open"
      ? "text-signal"
      : props.wsStatus === "connecting"
        ? "text-warn"
        : "text-crit";
  const canStart =
    (props.phase === "ready" || props.phase === "setup") &&
    props.hasFinalizedPlan &&
    props.playerCount >= 2;

  // Re-render every second so "Last: Xs ago" stays fresh without
  // tearing the timer down on every WS frame. See the long comment
  // in TopBar for the rationale.
  const hasLastEvent = props.lastEventAt !== null;
  const [, _setTick] = useState(0);
  useEffect(() => {
    if (!hasLastEvent) return;
    const id = setInterval(() => _setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [hasLastEvent]);
  const lastEventLabel =
    props.lastEventAt === null
      ? "—"
      : (() => {
          const ms = Math.max(0, Date.now() - props.lastEventAt);
          if (ms < 1000) return "<1s";
          const s = Math.floor(ms / 1000);
          if (s < 60) return `${s}s`;
          const m = Math.floor(s / 60);
          if (m < 60) return `${m}m`;
          return `${Math.floor(m / 60)}h`;
        })();

  return (
    <footer
      role="contentinfo"
      style={{
        background: "var(--ink-950)",
        borderTop: "1px solid var(--ink-600)",
        padding: "8px 16px",
        minHeight: 48,
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 8,
      }}
    >
      <span className="mono text-[10px] font-bold uppercase tracking-[0.22em] text-ink-300">
        CREATOR ADMIN
      </span>

      {(props.phase === "ready" || props.phase === "setup") && (
        <button
          type="button"
          onClick={props.onStart}
          disabled={!canStart || props.busy}
          className="mono rounded-r-1 bg-signal px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-ink-900 hover:bg-signal-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal-bright disabled:cursor-not-allowed disabled:opacity-50"
          title={
            !props.hasFinalizedPlan
              ? "Finalize the plan first"
              : props.playerCount < 2
                ? "Add at least 2 player roles"
                : ""
          }
        >
          START SESSION →
        </button>
      )}
      {props.phase === "play" && (
        <>
          <button
            type="button"
            onClick={props.onForceAdvance}
            disabled={props.busy}
            className="mono rounded-r-1 border border-ink-500 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-200 hover:border-signal hover:text-signal focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal disabled:opacity-50"
            title="Hand the turn to the AI now."
          >
            FORCE-ADVANCE
          </button>
          <button
            type="button"
            onClick={props.onEnd}
            disabled={props.busy}
            className="mono rounded-r-1 border border-crit px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-crit hover:bg-crit-bg focus-visible:outline focus-visible:outline-2 focus-visible:outline-crit disabled:opacity-50"
          >
            END SESSION
          </button>
        </>
      )}
      {props.phase === "ended" && props.aarStatus === "ready" && (
        <button
          type="button"
          onClick={props.onViewAar}
          className="mono rounded-r-1 bg-signal px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-ink-900 hover:bg-signal-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal-bright"
        >
          VIEW AAR →
        </button>
      )}

      <span className="mono rounded-r-1 bg-ink-800 px-2 py-0.5 text-[10px] tabular-nums text-ink-200">
        T#{props.turnIndex ?? "—"}
      </span>
      <span className="mono rounded-r-1 bg-ink-800 px-2 py-0.5 text-[10px] tabular-nums text-ink-200">
        {props.messageCount} msgs
      </span>
      <span className="mono rounded-r-1 bg-ink-800 px-2 py-0.5 text-[10px] tabular-nums text-ink-200">
        Rationale: {props.rationaleCount}
      </span>
      <span className="mono rounded-r-1 bg-ink-800 px-2 py-0.5 text-[10px] tabular-nums text-ink-300">
        Tabs: {props.connectionCount ?? "—"}
      </span>
      <span
        className="mono rounded-r-1 bg-ink-800 px-2 py-0.5 text-[10px] tabular-nums text-ink-300"
        title="Time since last WS frame."
      >
        Last: {lastEventLabel}
      </span>
      {props.activeTiers.length > 0 ? (
        <span
          role="status"
          aria-live="polite"
          className="mono rounded-r-1 border border-warn bg-warn-bg px-2 py-0.5 text-[10px] font-semibold uppercase text-warn"
          title={`Active LLM tier(s): ${props.activeTiers.join(", ")}`}
        >
          LLM: {props.activeTiers.join("+")}
        </span>
      ) : (
        <span className="mono rounded-r-1 bg-ink-800 px-2 py-0.5 text-[10px] uppercase text-ink-500">
          LLM: idle
        </span>
      )}

      <CostChipMini cost={props.cost} />

      <span className="mono rounded-r-1 bg-ink-800 px-2 py-0.5 text-[10px] uppercase tracking-[0.04em] text-ink-300">
        state: {props.backendState}
      </span>

      <div style={{ flex: 1 }} />

      <span
        className="mono rounded-r-1 bg-ink-800 px-2 py-0.5 text-[10px] text-ink-400"
        title={`Build: ${props.buildSha} · ${props.buildTs}`}
      >
        v {props.buildSha}
      </span>
      <button
        type="button"
        onClick={props.onToggleGodMode}
        aria-pressed={props.godMode}
        className={
          "mono rounded-r-1 border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] focus-visible:outline focus-visible:outline-2 focus-visible:outline-info " +
          (props.godMode
            ? "border-info bg-info-bg text-info"
            : "border-ink-500 text-ink-400 hover:border-info hover:text-info")
        }
        title="Toggle full debug overlay (audit log, system prompt, etc). Creator-only."
      >
        {props.godMode ? "● God Mode" : "○ God Mode"}
      </button>
      <button
        type="button"
        onClick={props.onNewSession}
        disabled={props.busy}
        className="mono rounded-r-1 border border-ink-500 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-300 hover:border-ink-400 hover:bg-ink-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal disabled:opacity-50"
        title="End the current session and return to the new-session form."
      >
        + NEW SESSION
      </button>
      <span
        className={"mono text-[11px] font-bold tracking-[0.16em] " + wsColour}
        title={`WebSocket status: ${props.wsStatus}`}
      >
        ● {props.wsStatus.toUpperCase()}
      </span>
    </footer>
  );
}

function CostChipMini({ cost }: { cost: CostSnapshot | null }) {
  if (!cost) {
    return (
      <span
        className="mono rounded-r-1 bg-ink-800 px-2 py-0.5 text-[10px] tabular-nums text-ink-400"
        title="No cost data yet — first LLM call will populate this."
      >
        Cost: $—
      </span>
    );
  }
  return (
    <details className="relative">
      <summary
        className="mono cursor-pointer list-none rounded-r-1 bg-ink-800 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-signal hover:bg-ink-750 focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal"
        title="Cumulative Anthropic API spend for this session. Click to expand."
      >
        Cost: ${cost.estimated_usd.toFixed(4)}
      </summary>
      <div className="absolute bottom-full right-0 z-20 mb-1 w-72 rounded border border-ink-600 bg-ink-850 p-3 text-xs text-ink-200 shadow-lg">
        <p className="mono mb-1 text-[10px] font-bold uppercase tracking-[0.20em] text-ink-400">
          Cost — token breakdown
        </p>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
          <dt className="text-ink-400">Input</dt>
          <dd className="mono text-right tabular-nums text-ink-100">
            {cost.input_tokens.toLocaleString()}
          </dd>
          <dt className="text-ink-400">Output</dt>
          <dd className="mono text-right tabular-nums text-ink-100">
            {cost.output_tokens.toLocaleString()}
          </dd>
          <dt className="text-ink-400">Cache read</dt>
          <dd className="mono text-right tabular-nums text-ink-100">
            {cost.cache_read_tokens.toLocaleString()}
          </dd>
          <dt className="text-ink-400">Cache create</dt>
          <dd className="mono text-right tabular-nums text-ink-100">
            {cost.cache_creation_tokens.toLocaleString()}
          </dd>
          <dt className="font-semibold text-signal">Estimated</dt>
          <dd className="mono text-right font-semibold tabular-nums text-signal">
            ${cost.estimated_usd.toFixed(4)}
          </dd>
        </dl>
        <p className="mt-2 text-[10px] leading-tight text-ink-500">
          Charged to the operator's Anthropic key. Cumulative for this session.
        </p>
      </div>
    </details>
  );
}
