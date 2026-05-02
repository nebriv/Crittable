import { useEffect, useRef } from "react";

interface Props {
  severity: string;
  headline: string;
  body: string;
  onAcknowledge: () => void;
  canAcknowledge: boolean;
}

export function CriticalEventBanner({ severity, headline, body, onAcknowledge, canAcknowledge }: Props) {
  const ackRef = useRef<HTMLButtonElement | null>(null);

  // Pull focus to the acknowledge button so a keyboard / screen-reader user
  // doesn't have to tab through the rest of the page to reach it.
  useEffect(() => {
    if (canAcknowledge) ackRef.current?.focus();
  }, [canAcknowledge]);

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
          disabled={!canAcknowledge}
          className="mono rounded-r-1 bg-signal px-4 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-ink-900 hover:bg-signal-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-bright disabled:opacity-50"
        >
          ACKNOWLEDGE
        </button>
      </div>
    </div>
  );
}
