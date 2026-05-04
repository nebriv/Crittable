import { useEffect, useRef } from "react";

interface Props {
  severity: string;
  headline: string;
  body: string;
  onAcknowledge: () => void;
}

/**
 * Floating banner shown when ``inject_critical_event`` fires.
 *
 * "Acknowledge" is a CLIENT-SIDE DISMISS — it just clears the local
 * banner state. There's no server round-trip and no shared "the team
 * has acknowledged" signal. So every viewer who sees the banner must
 * be able to dismiss it from their own tab; gating on turn-ownership
 * (the prior ``canAcknowledge={isMyTurn}`` predicate) trapped
 * non-active roles and spectators with a permanent banner they
 * couldn't get rid of. Always enabled now.
 */
export function CriticalEventBanner({ severity, headline, body, onAcknowledge }: Props) {
  const ackRef = useRef<HTMLButtonElement | null>(null);

  // Pull focus to the acknowledge button so a keyboard / screen-reader user
  // doesn't have to tab through the rest of the page to reach it.
  useEffect(() => {
    ackRef.current?.focus();
  }, []);

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="sticky top-0 z-20 border-b-4 border-crit bg-crit-bg p-4 text-ink-050 backdrop-blur-sm"
      style={{ background: "color-mix(in oklch, var(--crit) 28%, var(--ink-900))" }}
    >
      <div className="mx-auto flex max-w-5xl items-start justify-between gap-4">
        <div>
          <p className="mono text-[11px] font-bold uppercase tracking-[0.22em] text-crit">
            ● {severity.toUpperCase()} · BREAKING
          </p>
          <h2 className="mt-1 text-lg font-semibold text-ink-050">{headline}</h2>
          <p className="text-sm text-ink-100 opacity-90">{body}</p>
        </div>
        <button
          ref={ackRef}
          type="button"
          onClick={onAcknowledge}
          className="mono rounded-r-1 bg-signal px-4 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-ink-900 hover:bg-signal-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-bright"
        >
          ACKNOWLEDGE
        </button>
      </div>
    </div>
  );
}
