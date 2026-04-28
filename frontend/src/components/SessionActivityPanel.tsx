import { useEffect, useRef, useState } from "react";
import { RoleView, api } from "../api/client";

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
}

interface Props {
  sessionId: string;
  creatorToken: string;
  roles: RoleView[];
  /** Poll cadence; default 3s. */
  pollMs?: number;
}

/**
 * Always-visible creator-only "what is the backend doing right now?" panel.
 *
 * Polls ``/api/sessions/{id}/activity`` every ``pollMs`` ms (default 3s) and
 * renders: turn progress, who we're waiting on, in-flight LLM call with
 * elapsed time, AAR status. Strictly *operational* signal — no plan content,
 * no message bodies, no audit payloads. Those live in God Mode.
 */
export function SessionActivityPanel({ sessionId, creatorToken, roles, pollMs = 3000 }: Props) {
  const [data, setData] = useState<ActivitySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const fetchedAt = useRef<number>(Date.now());
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
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
    tick();
    return () => {
      cancelled.current = true;
      if (timer) clearTimeout(timer);
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
      <header className="flex items-baseline justify-between">
        <h3 id="activity-heading" className="text-xs uppercase tracking-widest text-slate-300">
          Backend activity
        </h3>
        <span className="text-[10px] text-slate-500">creator only</span>
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
            <p className="text-xs text-red-300">
              Error: {data.turn.error_reason}
              {data.turn.retried_with_strict ? " (after strict retry)" : ""}
            </p>
          ) : null}

          {data.in_flight_llm.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {data.in_flight_llm.map((c, idx) => {
                // Server snapshot returned ``elapsed_ms`` as of ``fetchedAt``;
                // bias forward by the local clock drift so the displayed
                // seconds tick smoothly between polls instead of freezing.
                const drift = Math.max(0, now - fetchedAt.current);
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
        </>
      )}

      {error ? <p className="text-[10px] text-red-300">poll: {error}</p> : null}
    </section>
  );
}
