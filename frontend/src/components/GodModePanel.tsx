import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";

interface DebugSnapshot {
  session: Record<string, unknown>;
  turns: unknown[];
  messages: unknown[];
  setup_notes: unknown[];
  audit_events: unknown[];
  in_flight_llm: unknown[];
  extensions: Record<string, unknown>;
}

interface Props {
  sessionId: string;
  creatorToken: string;
  onClose: () => void;
}

/**
 * Full-debug "God Mode" overlay. Polls ``/api/sessions/{id}/debug`` while
 * open and the tab is foregrounded. Distinct from the activity panel — this
 * is the firehose, intentionally creator-internal.
 *
 * Sections render as collapsible blocks so a 200-event audit dump doesn't
 * dominate the page. Polling pauses while ``document.hidden`` to avoid the
 * 1.2 MB/min bandwidth cost when the creator switches tabs.
 */
export function GodModePanel({ sessionId, creatorToken, onClose }: Props) {
  const [data, setData] = useState<DebugSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const cancelled = useRef(false);
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  // Open as a native <dialog>: focus-trap, Esc-to-close, and background
  // ::backdrop come for free.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (typeof el.showModal === "function" && !el.open) {
      el.showModal();
    }
    const handleCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    el.addEventListener("cancel", handleCancel);
    return () => el.removeEventListener("cancel", handleCancel);
  }, [onClose]);

  useEffect(() => {
    cancelled.current = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      // Pause polling while the tab is backgrounded — avoids the 1.2 MB/min
      // bandwidth cost the UI/UX review flagged.
      if (document.hidden) {
        timer = setTimeout(tick, 1500);
        return;
      }
      try {
        const body = (await api.getDebug(sessionId, creatorToken)) as DebugSnapshot;
        if (!cancelled.current) {
          setData(body);
          setError(null);
        }
      } catch (err) {
        if (!cancelled.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
      if (!cancelled.current) timer = setTimeout(tick, 2500);
    }
    tick();
    return () => {
      cancelled.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, creatorToken]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="god-mode-heading"
      className="z-50 w-[min(96vw,1400px)] max-w-none rounded border border-purple-700 bg-slate-950/95 p-4 text-slate-100 backdrop:bg-slate-950/80"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-700 pb-2">
        <div>
          <h2 id="god-mode-heading" className="text-lg font-semibold">
            God Mode — full debug
          </h2>
          <p className="text-xs text-slate-400">
            Creator-only. Polls every 2.5s (paused when tab is hidden). Press
            Esc to close.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter blocks…"
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-300"
            aria-label="Filter debug content"
          />
          <button
            type="button"
            onClick={onClose}
            autoFocus
            className="rounded border border-slate-600 px-3 py-1 text-sm text-slate-200 hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-300"
          >
            Close
          </button>
        </div>
      </header>
      {error ? (
        <p className="mt-2 text-sm text-red-300">poll: {error}</p>
      ) : null}
      <BackendControls sessionId={sessionId} creatorToken={creatorToken} />
      <div className="mt-3 grid max-h-[70vh] grid-cols-1 gap-3 overflow-y-auto md:grid-cols-2">
        <DebugBlock heading="Session" data={data?.session} filter={filter} defaultOpen />
        <DebugBlock heading="In-flight LLM" data={data?.in_flight_llm} filter={filter} defaultOpen />
        <DebugBlock heading="Turns" data={data?.turns} filter={filter} />
        <DebugBlock heading="Audit log (last 200)" data={data?.audit_events} filter={filter} />
        <DebugBlock heading="Messages" data={data?.messages} filter={filter} />
        <DebugBlock heading="Setup notes" data={data?.setup_notes} filter={filter} />
        <DebugBlock heading="Extensions" data={data?.extensions} filter={filter} />
      </div>
    </dialog>
  );
}

/**
 * Inline "Backend controls" strip — the operator's break-glass remediation
 * surface. Lives only inside God Mode so a creator can't accidentally fire
 * these from a normal play screen.
 *
 *  - **Abort current AI turn** — marks the in-flight turn errored. Pair
 *    with Force-advance to resume.
 *  - **Force-advance** — same as the player-visible button, kept here for
 *    one-click recovery without scrolling.
 *  - **End session** — last-resort kill switch (also fires the AAR).
 */
function BackendControls({
  sessionId,
  creatorToken,
}: {
  sessionId: string;
  creatorToken: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function run(label: string, fn: () => Promise<unknown>, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(label);
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: "ok", text: `${label}: ok` });
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      setMsg({ kind: "err", text: `${label}: ${text}` });
      console.warn(`[godmode] ${label} failed`, text);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      aria-label="Backend controls"
      className="mt-3 flex flex-wrap items-center gap-2 rounded border border-amber-700/40 bg-amber-950/20 p-2"
    >
      <span className="text-[11px] uppercase tracking-widest text-amber-200">
        Backend controls
      </span>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() =>
          run(
            "Abort current AI turn",
            () => api.adminAbortTurn(sessionId, creatorToken),
            "Mark the current AI turn errored? Pair with Force-advance to recover.",
          )
        }
        className="rounded border border-amber-500 px-2 py-0.5 text-xs font-semibold text-amber-200 hover:bg-amber-900/30 disabled:opacity-50"
        title="Mark the current AI turn errored. Use when the AI is stuck in a long stream."
      >
        Abort current AI turn
      </button>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => run("Force-advance", () => api.forceAdvance(sessionId, creatorToken))}
        className="rounded border border-sky-500 px-2 py-0.5 text-xs font-semibold text-sky-200 hover:bg-sky-900/30 disabled:opacity-50"
        title="Skip the stuck turn and let the engine advance."
      >
        Force-advance
      </button>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() =>
          run(
            "End session",
            () => api.endSession(sessionId, creatorToken, "ended via god mode"),
            "End the exercise NOW? This generates the AAR and closes the session.",
          )
        }
        className="rounded bg-red-700 px-3 py-0.5 text-xs font-semibold text-white shadow-sm hover:bg-red-600 disabled:opacity-50"
        title="Hard-end the session. Triggers the AAR pipeline."
      >
        End session
      </button>
      {/* One polite live region — toggling between busy + result text so a
          screen reader doesn't double-announce. */}
      <span
        className={
          msg?.kind === "err"
            ? "text-[11px] text-red-300"
            : msg?.kind === "ok"
              ? "text-[11px] text-emerald-300"
              : "text-[11px] text-slate-300"
        }
        role="status"
        aria-live="polite"
      >
        {busy ? `${busy}…` : msg ? msg.text : ""}
      </span>
    </section>
  );
}

function DebugBlock({
  heading,
  data,
  filter,
  defaultOpen,
}: {
  heading: string;
  data: unknown;
  filter: string;
  defaultOpen?: boolean;
}) {
  const json = data === undefined ? "loading…" : JSON.stringify(data, null, 2);
  const matches = !filter || json.toLowerCase().includes(filter.toLowerCase());
  if (filter && !matches) return null;
  return (
    <details
      open={defaultOpen ?? false}
      className="flex min-h-0 flex-col rounded border border-slate-700 bg-slate-900 p-2"
    >
      <summary className="cursor-pointer text-xs uppercase tracking-widest text-slate-300">
        {heading}
      </summary>
      <pre className="mt-1 max-h-[40vh] overflow-auto whitespace-pre-wrap break-words text-[11px] leading-tight text-slate-200">
        {json}
      </pre>
    </details>
  );
}
