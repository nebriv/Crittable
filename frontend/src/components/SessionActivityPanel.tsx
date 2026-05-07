import { useEffect, useRef, useState } from "react";
import { RoleView, api } from "../api/client";

interface ActivityDiagnostic {
  kind: string;
  ts: string;
  name?: string | null;
  tier?: string | null;
  reason?: string | null;
  hint?: string | null;
}

/**
 * Issue #70: per-attempt validator pass landed in the audit log by
 * ``turn_driver.run_play_turn``. The panel renders one row per
 * attempt so the operator sees `Turn 6: drive ✗ → recovered via
 * broadcast (attempt 2), yield ✓ (attempt 3)` without needing log
 * access.
 */
interface ValidationAttempt {
  attempt: number | null;
  slots: string[];
  violations: string[];
  warnings: string[];
  ok: boolean;
  ts?: string;
}

interface RecoveryAttempt {
  attempt: number | null;
  kind: string | null;
  tools: string[];
  ts?: string;
}

interface TurnDiagnostics {
  turn_index: number;
  validations: ValidationAttempt[];
  recoveries: RecoveryAttempt[];
}

interface ActivitySnapshot {
  state: string;
  // Issue #70: ``/activity`` always returns these — the backend
  // populates them unconditionally on every poll. Per CLAUDE.md
  // "NO BACKWARDS COMPATIBILITY" they're typed as required so a
  // future field drop is caught at typecheck time, not at runtime.
  ai_paused: boolean;
  turn: {
    index: number;
    status: string;
    active_role_ids: string[];
    submitted_role_ids: string[];
    waiting_on_role_ids: string[];
    error_reason: string | null;
    retried_with_strict: boolean;
  } | null;
  in_flight_llm: { tier: string; model: string; stream: boolean; elapsed_ms: number }[];
  aar_status: string;
  aar_error: string | null;
  turn_count: number;
  message_count: number;
  setup_note_count: number;
  recent_diagnostics: ActivityDiagnostic[];
  recent_turn_diagnostics: TurnDiagnostics[];
  legacy_carve_out_enabled: boolean;
}

interface Props {
  sessionId: string;
  creatorToken: string;
  roles: RoleView[];
  /** Poll cadence; default 3s. */
  pollMs?: number;
  /**
   * Optional contextual remediation. When the current turn is errored, the
   * panel exposes a "Force-advance turn" button right next to the error
   * message instead of asking the operator to scan a separate Controls
   * panel for it. Wired by the parent.
   */
  onForceAdvance?: () => void;
  busy?: boolean;
}

/**
 * Always-visible creator-only "what is the backend doing right now?" panel.
 *
 * Polls ``/api/sessions/{id}/activity`` every ``pollMs`` ms (default 3s) and
 * renders: turn progress, who we're waiting on, in-flight LLM call with
 * elapsed time, AAR status. Strictly *operational* signal — no plan content,
 * no message bodies, no audit payloads. Those live in God Mode.
 */
export function SessionActivityPanel({
  sessionId,
  creatorToken,
  roles,
  // Default sourced from the build-time ``VITE_ACTIVITY_POLL_MS`` env
  // var so operators can tune without a code change. Falls back to
  // 3000ms when unset (historical default).
  pollMs = __ATF_ACTIVITY_POLL_MS__,
  onForceAdvance,
  busy,
}: Props) {
  const [data, setData] = useState<ActivitySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const fetchedAt = useRef<number>(Date.now());
  const canceled = useRef(false);

  useEffect(() => {
    canceled.current = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      // Pause polling when the tab is hidden — saves backend cycles when
      // the creator alt-tabs away. Resumes on the next ``visibilitychange``
      // event (handled below).
      if (document.hidden) {
        timer = setTimeout(tick, pollMs);
        return;
      }
      try {
        const body = (await api.getActivity(sessionId, creatorToken)) as ActivitySnapshot;
        if (!canceled.current) {
          setData(body);
          fetchedAt.current = Date.now();
          setError(null);
        }
      } catch (err) {
        if (!canceled.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
      if (!canceled.current) {
        timer = setTimeout(tick, pollMs);
      }
    }
    function onVisible() {
      // Clear any pending timer before kicking a fresh tick — without this
      // the hidden-branch's queued setTimeout interleaves with the resume
      // tick and the panel ends up double-polling.
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!document.hidden) tick();
    }
    document.addEventListener("visibilitychange", onVisible);
    tick();
    return () => {
      canceled.current = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sessionId, creatorToken, pollMs]);

  // Local clock so the in-flight elapsed counter actually ticks between
  // polls. Use a 250 ms tick so the displayed seconds advance smoothly.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  const roleLabel = (rid: string) => roles.find((r) => r.id === rid)?.label ?? rid;

  return (
    <section
      aria-labelledby="activity-heading"
      className="flex flex-col gap-2 rounded border border-ink-600 bg-ink-850 p-3 text-sm"
    >
      <header className="flex items-baseline justify-between gap-2">
        <h3 id="activity-heading" className="text-xs uppercase tracking-widest text-ink-300">
          Backend activity
        </h3>
        <span className="flex items-center gap-1">
          {now - fetchedAt.current > pollMs * 2 ? (
            <span className="rounded bg-warn/40 px-1.5 py-0.5 text-[10px] text-warn">
              stale {Math.floor((now - fetchedAt.current) / 1000)}s
            </span>
          ) : null}
          <span className="rounded bg-info/40 px-1.5 py-0.5 text-[10px] text-info">
            creator only
          </span>
        </span>
      </header>

      {!data ? (
        <p className="text-xs text-ink-400">Loading…</p>
      ) : (
        <>
          {/* Issue #70: surface the legacy soft-drive carve-out
              kill-switch in red so a misconfigured deployment is
              visible without log access. The flag default is false;
              if it's true, an operator flipped it on for emergency
              rollback and forgot to flip it back. The validator
              treats this as a downgrade ("warning, not violation")
              for the AI's "missing DRIVE on a player @facilitator"
              case — exactly the kind of silent-yield window the
              issue exists to make visible. */}
          {data.legacy_carve_out_enabled ? (
            <div
              role="alert"
              className="rounded border border-warn bg-warn/30 p-2 text-[11px] text-warn"
            >
              <p className="font-semibold uppercase tracking-wider">
                Legacy carve-out enabled
              </p>
              <p className="mt-0.5 text-ink-200">
                <span className="mono">
                  LLM_RECOVERY_DRIVE_SOFT_ON_OPEN_QUESTION=True
                </span>{" "}
                is set on the backend. The validator will downgrade the
                missing-DRIVE check to a warning when a player @-mentions
                the facilitator, which can let the AI silently yield.
              </p>
              <p className="mt-1 text-ink-200">
                Safe for testing; <strong>disable for production</strong>.
                To turn off, set{" "}
                <span className="mono">
                  LLM_RECOVERY_DRIVE_SOFT_ON_OPEN_QUESTION=False
                </span>{" "}
                in the backend environment and restart.
              </p>
            </div>
          ) : null}
          {data.ai_paused ? (
            <p className="rounded border border-info bg-info-bg px-2 py-1 text-[11px] text-info">
              AI is paused — facilitator-mention replies queue until resumed.
            </p>
          ) : null}
          <p className="text-xs text-ink-300">
            Turn{" "}
            <span className="font-semibold text-ink-100">
              {data.turn ? data.turn.index + 1 : 0}
            </span>{" "}
            · status{" "}
            <span className="font-semibold text-ink-100">
              {data.turn?.status ?? "—"}
            </span>
          </p>
          {data.turn?.waiting_on_role_ids?.length ? (
            <p className="text-xs text-warn">
              {/* Wave 1 (issue #134): waiting_on_role_ids is now
                  derived from ready_role_ids, not submitted_role_ids
                  — i.e. "not yet ready", which can include roles who
                  have spoken but haven't signaled ready yet. The
                  copy reflects that. */}
              Waiting on (not yet ready):{" "}
              {data.turn.waiting_on_role_ids.map(roleLabel).join(", ")}
            </p>
          ) : data.turn?.active_role_ids?.length ? (
            <p className="text-xs text-signal">
              All active roles have signaled ready.
            </p>
          ) : null}
          {data.turn?.error_reason ? (
            <div className="flex flex-col gap-1 rounded border border-crit/40 bg-crit/30 p-2">
              <p className="text-xs text-crit">
                Error: {data.turn.error_reason}
                {data.turn.retried_with_strict ? " (after strict retry)" : ""}
              </p>
              {onForceAdvance ? (
                <button
                  type="button"
                  onClick={onForceAdvance}
                  disabled={busy}
                  aria-disabled={busy}
                  className="self-start rounded border border-warn px-2 py-0.5 text-xs font-semibold text-warn hover:bg-warn/30 disabled:cursor-not-allowed disabled:opacity-50"
                  title="Skip the stuck AI turn and let the engine advance."
                >
                  Force-advance turn
                </button>
              ) : null}
            </div>
          ) : null}

          {data.in_flight_llm.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {data.in_flight_llm.map((c, idx) => {
                // Server snapshot returned ``elapsed_ms`` as of ``fetchedAt``;
                // bias forward by the local clock drift so the displayed
                // seconds tick smoothly between polls. Cap the drift at
                // ``pollMs * 2`` so the counter doesn't run away while the
                // tab is hidden (polling pauses but the local clock keeps
                // advancing).
                const drift = Math.max(0, Math.min(pollMs * 2, now - fetchedAt.current));
                const seconds = ((c.elapsed_ms + drift) / 1000).toFixed(1);
                return (
                  <li key={idx} className="rounded bg-ink-900 px-2 py-1 text-xs">
                    <span className="font-semibold text-signal">AI {c.tier}</span>
                    <span className="ml-1 text-ink-400">{c.model}</span>
                    <span className="ml-1 text-ink-500">{c.stream ? "stream" : "rpc"}</span>
                    <span className="ml-2 text-ink-200">{seconds}s</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-xs text-ink-500">No in-flight LLM calls.</p>
          )}

          <p className="text-xs text-ink-300">
            AAR:{" "}
            <span
              className={
                data.aar_status === "ready"
                  ? "text-signal"
                  : data.aar_status === "failed"
                    ? "text-crit"
                    : data.aar_status === "generating"
                      ? "text-warn"
                      : "text-ink-400"
              }
            >
              {data.aar_status}
            </span>
          </p>
          {data.aar_error ? (
            <p className="text-[10px] text-crit">{data.aar_error}</p>
          ) : null}

          <p className="text-[10px] text-ink-500">
            {data.turn_count} turns · {data.message_count} msgs · {data.setup_note_count} setup notes
          </p>

          {data.recent_diagnostics && data.recent_diagnostics.length > 0 ? (
            <details className="rounded border border-warn bg-warn/20 p-1.5 text-xs">
              <summary className="cursor-pointer text-warn">
                Recent backend diagnostics ({data.recent_diagnostics.length})
              </summary>
              <ul className="mt-1 flex flex-col gap-1">
                {data.recent_diagnostics.map((diag, idx) => (
                  <li
                    key={`${diag.ts}-${idx}`}
                    className="rounded bg-ink-900 px-2 py-1 text-[11px] text-ink-200"
                  >
                    <span className="font-semibold text-warn">{diag.kind}</span>
                    {diag.tier ? (
                      <span className="ml-1 text-ink-400">[{diag.tier}]</span>
                    ) : null}
                    {diag.name ? (
                      <span className="ml-1 text-ink-300">{diag.name}</span>
                    ) : null}
                    {diag.reason ? (
                      <p className="text-ink-300">{diag.reason}</p>
                    ) : null}
                    {diag.hint ? (
                      <p className="text-signal">→ {diag.hint}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {/* Issue #70: per-turn validator + recovery rollup. Pre-fix
              this lived only in stdout-only structlog events; a
              silent-yield regression took 5 hours to diagnose because
              the creator panel couldn't tell apart "AI is thinking"
              from "AI yielded silently". Now each attempt of each
              turn shows up here as `drive ✓ yield ✓` (success) or
              `drive ✗ yield ✓ — missing_drive recovered via broadcast`
              (recovered) or `drive ✗ yield ✗` (warnings highlighted in
              red). The rollup is creator-only and capped to the most
              recent 3 turns server-side to keep the polled response
              cheap on long sessions. */}
          {data.recent_turn_diagnostics &&
          data.recent_turn_diagnostics.length > 0 ? (
            <details
              open
              className="rounded border border-ink-600 bg-ink-900 p-1.5 text-xs"
            >
              <summary
                className="cursor-pointer text-ink-300"
                aria-label={`Validator rollup, last ${data.recent_turn_diagnostics.length} turns`}
              >
                Validator rollup · last{" "}
                {data.recent_turn_diagnostics.length} turn
                {data.recent_turn_diagnostics.length === 1 ? "" : "s"}
              </summary>
              <ul className="mt-1 flex flex-col gap-1">
                {data.recent_turn_diagnostics.map((td) => (
                  <TurnDiagnosticsRow key={td.turn_index} diagnostics={td} />
                ))}
              </ul>
              {/* Issue #70 review (User Agent MEDIUM #5): point the
                  operator at God Mode for the full history rather
                  than leaving them stuck at the most-recent-3-turns
                  cap. Plain text — God Mode is the same window so a
                  link would just be "scroll up to that pill". */}
              <p className="mt-1 text-[10px] text-ink-500">
                For older turns, open <strong>God Mode</strong> →
                turn_diagnostics.
              </p>
            </details>
          ) : null}
        </>
      )}

      {error ? <p className="text-[10px] text-crit">poll: {error}</p> : null}
    </section>
  );
}

/**
 * Per-turn validator-attempt + recovery breadcrumb row.
 *
 * Each turn can produce 1..N validation attempts (one per LLM call
 * inside ``run_play_turn``'s strict-retry loop). Between attempts the
 * validator may queue a recovery directive — a narrowed follow-up LLM
 * call pinned to a specific tool. The row shows attempts in order,
 * each with the slots that fired (DRIVE / YIELD / etc.) and a
 * green ✓ / red ✗ tick per slot. A recovery directive that fired
 * between attempts renders as a "↪ recovered via <tool> (kind:
 * missing_drive)" hint underneath. Warnings (e.g. "drive missing but
 * downgraded — legacy carve-out fired") render in red with no ✓ to
 * make the silent-yield class of bug visually obvious.
 */
function TurnDiagnosticsRow({
  diagnostics,
}: {
  diagnostics: TurnDiagnostics;
}) {
  // Build a quick lookup: which directive ran AFTER each attempt.
  // Recovery directives are queued at the end of an attempt and
  // executed on attempt+1; we pair recovery.attempt with that
  // failing-attempt number so the UI groups them with the attempt
  // that triggered them.
  const recoveriesByAttempt = new Map<number, RecoveryAttempt>();
  for (const r of diagnostics.recoveries) {
    if (r.attempt !== null) recoveriesByAttempt.set(r.attempt, r);
  }
  const finalAttempt =
    diagnostics.validations.length > 0
      ? diagnostics.validations[diagnostics.validations.length - 1]
      : null;
  // Three outcomes drive the top-of-row badge (User Agent HIGH #2):
  //  - ``ok``        — first attempt passed cleanly. Green.
  //  - ``recovered`` — final attempt passed AFTER >= 1 retries. Warn —
  //                    it WORKED but a regression in the underlying
  //                    behavior is worth tracking.
  //  - ``violations``— final attempt failed. Crit — turn errored or
  //                    will need force-advance.
  const overallOk = finalAttempt?.ok === true;
  const attemptCount = diagnostics.validations.length;
  const recovered = overallOk && attemptCount > 1;
  return (
    <li className="rounded bg-ink-900 px-2 py-1 text-[11px] text-ink-200">
      <p className="flex items-center gap-1.5">
        <span className="font-semibold text-ink-100">
          Turn {diagnostics.turn_index + 1}
        </span>
        {finalAttempt ? (
          recovered ? (
            <span
              className="rounded bg-warn-bg px-1 text-warn"
              title={`Final attempt validation passed after ${attemptCount} attempts. The first attempt(s) needed recovery — fine, but worth tracking.`}
            >
              recovered ({attemptCount} attempts)
            </span>
          ) : overallOk ? (
            <span
              className="rounded bg-signal/30 px-1 text-signal"
              title="First-attempt validation passed cleanly."
            >
              ok
            </span>
          ) : (
            <span
              className="rounded bg-crit/30 px-1 text-crit"
              title="Final attempt did NOT pass — turn errored or was force-advanced."
            >
              violations
            </span>
          )
        ) : (
          <span className="text-ink-500">no validator pass yet</span>
        )}
      </p>
      <ul className="mt-0.5 flex flex-col gap-0.5 pl-3">
        {diagnostics.validations.map((v, idx) => {
          const recovery =
            v.attempt !== null ? recoveriesByAttempt.get(v.attempt) : null;
          // Final attempt = "current state of the turn". Prior
          // attempts = "history that the recovery loop already
          // resolved" (User Agent MEDIUM #7). Prior-attempt
          // violations rendered in warn (medium severity) instead of
          // crit (high severity) so the row doesn't read as multiple
          // active bugs.
          const isFinal = idx === diagnostics.validations.length - 1;
          const violationTone =
            isFinal && !v.ok ? "text-crit" : "text-warn";
          return (
            <li
              key={`v-${v.attempt}-${v.ts ?? "na"}`}
              className="border-l border-ink-700 pl-2"
            >
              <span className="text-ink-300">
                attempt {v.attempt}: {renderSlotTicks(v, isFinal)}
              </span>
              {v.violations.length > 0 ? (
                <span className={`ml-1 ${violationTone}`}>
                  · violations: {v.violations.join(", ")}
                </span>
              ) : null}
              {v.warnings.length > 0 ? (
                <span
                  className="ml-1 text-warn"
                  title={v.warnings.join(" · ")}
                >
                  ⚠ warnings: {v.warnings.length}
                </span>
              ) : null}
              {recovery ? (
                <p className="text-warn">
                  ↪ recovered via {recovery.tools.join(", ") || "—"} (kind:{" "}
                  <span className="mono">{recovery.kind ?? "?"}</span>)
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </li>
  );
}

const SLOT_LABELS = {
  drive: "drive",
  yield: "yield",
} as const;

function renderSlotTicks(v: ValidationAttempt, isFinal: boolean) {
  // Show only the contract-relevant slots — drive + yield — since the
  // bookkeeping / pin / narrate / escalate slots aren't required for
  // turn validity and would clutter the row.
  // ``isFinal`` mutes prior-attempt ✗ marks so the row reads as one
  // resolved history (User Agent MEDIUM #7).
  // ``aria-hidden`` on the glyph itself prevents SR from reading
  // "check mark drive" awkwardly — the textual label below is what
  // SR users hear (UI/UX LOW #8).
  const fired = new Set(v.slots);
  const missing = new Set(v.violations);
  return (Object.keys(SLOT_LABELS) as Array<keyof typeof SLOT_LABELS>).map(
    (slot) => {
      const has = fired.has(slot);
      const isMissing = missing.has(`missing_${slot}`);
      const tone = has
        ? "text-signal"
        : isMissing
          ? isFinal
            ? "text-crit"
            : "text-warn"
          : "text-ink-500";
      return (
        <span key={slot} className={`ml-1 ${tone}`}>
          <span aria-hidden="true">{has ? "✓" : "✗"}</span>{" "}
          {SLOT_LABELS[slot]}
        </span>
      );
    },
  );
}
