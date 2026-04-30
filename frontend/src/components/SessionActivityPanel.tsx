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

interface ActivitySnapshot {
  state: string;
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
  recent_diagnostics?: ActivityDiagnostic[];
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
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
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
        if (!cancelled.current) {
          setData(body);
          fetchedAt.current = Date.now();
          setError(null);
        }
      } catch (err) {
        if (!cancelled.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
      if (!cancelled.current) {
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
      cancelled.current = true;
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
      className="flex flex-col gap-2 rounded border border-slate-700 bg-slate-900 p-3 text-sm"
    >
      <header className="flex items-baseline justify-between gap-2">
        <h3 id="activity-heading" className="text-xs uppercase tracking-widest text-slate-300">
          Backend activity
        </h3>
        <span className="flex items-center gap-1">
          {now - fetchedAt.current > pollMs * 2 ? (
            <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] text-amber-200">
              stale {Math.floor((now - fetchedAt.current) / 1000)}s
            </span>
          ) : null}
          <span className="rounded bg-purple-900/40 px-1.5 py-0.5 text-[10px] text-purple-200">
            creator only
          </span>
        </span>
      </header>

      {!data ? (
        <p className="text-xs text-slate-400">Loading…</p>
      ) : (
        <>
          <p className="text-xs text-slate-300">
            Turn{" "}
            <span className="font-semibold text-slate-100">
              {data.turn ? data.turn.index + 1 : 0}
            </span>{" "}
            · status{" "}
            <span className="font-semibold text-slate-100">
              {data.turn?.status ?? "—"}
            </span>
          </p>
          {data.turn?.waiting_on_role_ids?.length ? (
            <p className="text-xs text-amber-300">
              Waiting on:{" "}
              {data.turn.waiting_on_role_ids.map(roleLabel).join(", ")}
            </p>
          ) : data.turn?.active_role_ids?.length ? (
            <p className="text-xs text-emerald-300">
              All active roles have submitted.
            </p>
          ) : null}
          {data.turn?.error_reason ? (
            <div className="flex flex-col gap-1 rounded border border-red-700/40 bg-red-950/30 p-2">
              <p className="text-xs text-red-200">
                Error: {data.turn.error_reason}
                {data.turn.retried_with_strict ? " (after strict retry)" : ""}
              </p>
              {onForceAdvance ? (
                <button
                  type="button"
                  onClick={onForceAdvance}
                  disabled={busy}
                  aria-disabled={busy}
                  className="self-start rounded border border-amber-500 px-2 py-0.5 text-xs font-semibold text-amber-200 hover:bg-amber-900/30 disabled:cursor-not-allowed disabled:opacity-50"
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
                  <li key={idx} className="rounded bg-slate-950 px-2 py-1 text-xs">
                    <span className="font-semibold text-emerald-300">AI {c.tier}</span>
                    <span className="ml-1 text-slate-400">{c.model}</span>
                    <span className="ml-1 text-slate-500">{c.stream ? "stream" : "rpc"}</span>
                    <span className="ml-2 text-slate-200">{seconds}s</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-xs text-slate-500">No in-flight LLM calls.</p>
          )}

          <p className="text-xs text-slate-300">
            AAR:{" "}
            <span
              className={
                data.aar_status === "ready"
                  ? "text-emerald-300"
                  : data.aar_status === "failed"
                    ? "text-red-300"
                    : data.aar_status === "generating"
                      ? "text-amber-300"
                      : "text-slate-400"
              }
            >
              {data.aar_status}
            </span>
          </p>
          {data.aar_error ? (
            <p className="text-[10px] text-red-300">{data.aar_error}</p>
          ) : null}

          <p className="text-[10px] text-slate-500">
            {data.turn_count} turns · {data.message_count} msgs · {data.setup_note_count} setup notes
          </p>

          {data.recent_diagnostics && data.recent_diagnostics.length > 0 ? (
            <details className="rounded border border-amber-700/40 bg-amber-950/20 p-1.5 text-xs">
              <summary className="cursor-pointer text-amber-200">
                Recent backend diagnostics ({data.recent_diagnostics.length})
              </summary>
              <ul className="mt-1 flex flex-col gap-1">
                {data.recent_diagnostics.map((diag, idx) => (
                  <li
                    key={`${diag.ts}-${idx}`}
                    className="rounded bg-slate-950 px-2 py-1 text-[11px] text-slate-200"
                  >
                    <span className="font-semibold text-amber-200">{diag.kind}</span>
                    {diag.tier ? (
                      <span className="ml-1 text-slate-400">[{diag.tier}]</span>
                    ) : null}
                    {diag.name ? (
                      <span className="ml-1 text-slate-300">{diag.name}</span>
                    ) : null}
                    {diag.reason ? (
                      <p className="text-slate-300">{diag.reason}</p>
                    ) : null}
                    {diag.hint ? (
                      <p className="text-emerald-300">→ {diag.hint}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}

      {error ? <p className="text-[10px] text-red-300">poll: {error}</p> : null}
    </section>
  );
}
