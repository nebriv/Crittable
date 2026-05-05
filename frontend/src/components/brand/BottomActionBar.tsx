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
  wsStatus:
    | "connecting"
    | "open"
    | "closed"
    | "error"
    | "kicked"
    | "rejected"
    | "session-gone";
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
  /** Issue #70: AI paused via the Pause-AI toggle. Surfaces as
   *  "LLM: idle (paused)" so the operator can tell the engine apart
   *  from "the AI is just waiting on players". */
  aiPaused: boolean;
  /** Issue #70: validator-recovery breadcrumb. ``recovery`` is the
   *  directive kind (``missing_drive`` / ``missing_yield``);
   *  ``attempt`` / ``budget`` come from the strict-retry loop in
   *  ``turn_driver.run_play_turn``. When set, the chip renders
   *  ``LLM: recovering N/M (kind)`` so a stuck recovery is visible
   *  without scanning the activity panel. */
  recoveryStatus: {
    kind: string;
    attempt?: number;
    budget?: number;
  } | null;
  /** Issue #70 (review): when the current turn errored after the
   *  recovery budget was exhausted, the chip needs to sticky-stay on
   *  a crit-tinted "recovery FAILED" until the operator
   *  force-advances or starts a new turn. Without this, the chip
   *  cleared to "LLM: idle (waiting for players)" the moment the
   *  recovery loop exited — exactly the silent-yield-style
   *  ambiguity the issue exists to kill (User Agent HIGH #3). */
  turnErrored: boolean;
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
        padding: "6px 16px",
        minHeight: 40,
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
      <LlmStateChip
        activeTiers={props.activeTiers}
        recoveryStatus={props.recoveryStatus}
        aiPaused={props.aiPaused}
        backendState={props.backendState}
        turnErrored={props.turnErrored}
      />


      <CostChipMini cost={props.cost} />

      <span className="mono rounded-r-1 bg-ink-800 px-2 py-0.5 text-[10px] uppercase tracking-[0.04em] text-ink-300">
        state: {props.backendState}
      </span>

      {/* Build SHA + admin meta cluster — keep grouped with the
          telemetry above instead of pushing it to the far right.
          Pre-fix this row had a ``<div style={{ flex: 1 }} />``
          chasm separating left-side telemetry from right-side
          meta, which read as two disconnected clusters at typical
          viewport widths. The single-cluster flow with natural
          ``gap-2`` spacing reads as one operator console row. */}
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

/**
 * Multi-state LLM status chip (issue #70 + first-pass review fixes).
 * The original chip was binary: either ``LLM: <tiers>`` (something in
 * flight) or ``LLM: idle``. That collapsed four operationally-distinct
 * cases into one ambiguous "idle" label and was the diagnostic gap
 * behind the 2026-04-30 silent-yield 5-hour log dive — the operator
 * couldn't tell apart "AI is thinking", "AI is waiting on players",
 * "AI is paused", and "AI yielded silently".
 *
 * Priority order (top wins):
 *   1. ``turnErrored`` true       → ``LLM: recovery FAILED`` (crit) —
 *      sticky-stays after recovery exhausted so the bar reflects the
 *      real engine state (User Agent HIGH #3). Cleared by
 *      force-advance / starting a new turn.
 *   2. ``recoveryStatus`` set     → ``LLM: recovering N/M (kind)`` (warn).
 *      When ``attempt === budget`` the label adds "last attempt" so
 *      colorblind operators get a non-color cue (UI/UX HIGH #2).
 *      When ``aiPaused`` is also true, suffix "· paused" so the
 *      operator can confirm pause took effect (User Agent MEDIUM #6).
 *   3. ``activeTiers`` non-empty  → ``LLM: <tiers>`` (warn — "thinking").
 *      Same paused-suffix rule applies.
 *   4. ``aiPaused`` true          → ``LLM: idle (paused)`` (info-tinted).
 *   5. ``AWAITING_PLAYERS``       → ``LLM: waiting for players`` (default).
 *   6. fallback                   → ``LLM: idle`` (default).
 *
 * `aria-live="polite"` is set ONLY on the recovery + crit branches —
 * the bug class the chip exists to surface. The generic in-flight
 * chip lights for every play turn so announcing it would be
 * announce-fatigue (UI/UX MEDIUM #5).
 */
function LlmStateChip({
  activeTiers,
  recoveryStatus,
  aiPaused,
  backendState,
  turnErrored,
}: {
  activeTiers: string[];
  recoveryStatus: { kind: string; attempt?: number; budget?: number } | null;
  aiPaused: boolean;
  backendState: string;
  turnErrored: boolean;
}) {
  const pausedSuffix = aiPaused ? " · paused" : "";
  // 1) Recovery exhausted — turn errored after strict-retry budget.
  //    Crit-tinted, sticky-stays until next state transition. This
  //    is the case the issue exists to make obvious; without it, the
  //    chip would clear to "waiting for players" the moment the
  //    recovery loop exited.
  if (turnErrored) {
    return (
      <span
        role="status"
        aria-live="polite"
        className="mono rounded-r-1 border border-crit bg-crit/30 px-2 py-0.5 text-[10px] font-semibold uppercase text-crit"
        title="The current turn errored after the recovery budget was exhausted. Use Force-advance or End session to recover."
      >
        LLM: recovery FAILED
      </span>
    );
  }
  // 2) Recovery cascade is the loudest in-flight signal — "the AI is
  //    mid-recovery" is the precise state the original silent-yield
  //    bug was invisible in. Render even when ``activeTiers`` is
  //    empty (between the failing attempt and the next LLM call).
  if (recoveryStatus) {
    const a = recoveryStatus.attempt;
    const b = recoveryStatus.budget;
    const aLabel = a ?? "?";
    const bLabel = b ?? "?";
    const kind = recoveryStatus.kind.replace(/_/g, " ");
    const lastAttempt =
      typeof a === "number" && typeof b === "number" && a >= b;
    return (
      <span
        role="status"
        aria-live="polite"
        className="mono rounded-r-1 border border-warn bg-warn-bg px-2 py-0.5 text-[10px] font-semibold uppercase text-warn"
        title={`Validator recovery in flight — kind=${recoveryStatus.kind}, attempt ${aLabel}/${bLabel}.${lastAttempt ? " This is the last attempt — turn will error if it fails." : ""}${aiPaused ? " AI pause is queued for next call." : ""}`}
      >
        LLM: recovering {aLabel}/{bLabel}
        {lastAttempt ? " — last attempt" : ""} ({kind}){pausedSuffix}
      </span>
    );
  }
  // 3) Anything in flight — the legacy "thinking" signal. Tooltip
  //    lists every tier so guardrail+play stacks are inspectable.
  //    No aria-live — this fires every play turn and would be
  //    announce-fatigue.
  if (activeTiers.length > 0) {
    return (
      <span
        className="mono rounded-r-1 border border-warn bg-warn-bg px-2 py-0.5 text-[10px] font-semibold uppercase text-warn"
        title={`Active LLM tier(s): ${activeTiers.join(", ")}.${aiPaused ? " AI pause is queued for next call." : ""}`}
      >
        LLM: {activeTiers.join("+")}
        {pausedSuffix}
      </span>
    );
  }
  // 4) Operator has paused the AI's facilitator-reply path. No
  //    in-flight call is expected; this is *not* a regression.
  if (aiPaused) {
    return (
      <span
        className="mono rounded-r-1 border border-info bg-info-bg px-2 py-0.5 text-[10px] uppercase text-info"
        title="AI is paused — facilitator-mention replies will queue until resumed."
      >
        LLM: idle (paused)
      </span>
    );
  }
  // 5) Engine waiting on players — "idle by design". Distinguishes
  //    healthy AWAITING_PLAYERS from "AI yielded silently and the
  //    engine doesn't know it" (which now would surface in the
  //    SessionActivityPanel's per-turn validator rollup).
  if (backendState === "AWAITING_PLAYERS") {
    return (
      <span
        className="mono rounded-r-1 bg-ink-800 px-2 py-0.5 text-[10px] uppercase text-ink-300"
        title="No LLM call in flight — the engine is waiting for player submissions / ready signals."
      >
        LLM: waiting for players
      </span>
    );
  }
  // 6) Catch-all — pre-session, between-turns, post-end.
  return (
    <span
      className="mono rounded-r-1 bg-ink-800 px-2 py-0.5 text-[10px] uppercase text-ink-500"
      title="No LLM call in flight."
    >
      LLM: idle
    </span>
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
