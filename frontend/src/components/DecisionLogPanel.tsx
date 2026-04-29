import { DecisionLogEntry } from "../api/client";

interface Props {
  entries: DecisionLogEntry[];
}

/**
 * Creator-only AI decision rationale log (issue #55).
 *
 * Each entry is a one-sentence rationale the AI emitted via the
 * ``record_decision_rationale`` tool explaining why it picked a turn's
 * actions. The most recent entry is shown first so the operator sees the
 * latest reasoning above the fold without scrolling. Player roles never
 * see this surface — the snapshot endpoint scrubs ``decision_log`` for
 * non-creator tokens.
 */
export function DecisionLogPanel({ entries }: Props) {
  const ordered = [...entries].reverse();
  return (
    <section
      aria-label="AI decision rationale log"
      className="flex min-w-0 flex-col gap-2 rounded border border-slate-700 bg-slate-900 p-3 text-sm"
    >
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs uppercase tracking-widest text-slate-300">
          AI decision log
        </h3>
        <span className="text-[11px] text-slate-500">{entries.length} entries</span>
      </header>
      <p className="text-[11px] text-slate-400">
        Why the AI picked each beat (e.g. who it yielded to and why).
        Visible to facilitator only — players never see this.
      </p>
      {ordered.length === 0 ? (
        <p className="text-xs text-slate-500">
          No rationales recorded yet. One short line per play turn will
          appear here as the exercise runs.
        </p>
      ) : (
        <ol className="flex max-h-64 min-w-0 flex-col gap-2 overflow-y-auto pr-1">
          {ordered.map((e) => {
            const beat =
              e.turn_index !== null && e.turn_index !== undefined
                ? `turn ${e.turn_index}`
                : "pre-turn";
            return (
              <li
                key={e.id}
                className="rounded border border-slate-800 bg-slate-950 p-2 text-xs"
              >
                <header className="mb-0.5 flex items-baseline justify-between gap-2 text-[11px] uppercase tracking-wide text-slate-500">
                  <span>{beat}</span>
                  <time dateTime={e.ts}>
                    {new Date(e.ts).toLocaleTimeString()}
                  </time>
                </header>
                <p className="whitespace-pre-wrap break-words text-slate-200">
                  {e.rationale}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
