interface Props {
  severity: string;
  headline: string;
  body: string;
  onAcknowledge: () => void;
  canAcknowledge: boolean;
}

export function CriticalEventBanner({ severity, headline, body, onAcknowledge, canAcknowledge }: Props) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="sticky top-0 z-20 border-b-4 border-red-500 bg-red-950/95 p-4 text-red-50"
    >
      <div className="mx-auto flex max-w-5xl items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-widest">{severity} · breaking</p>
          <h2 className="text-lg font-semibold">{headline}</h2>
          <p className="text-sm opacity-90">{body}</p>
        </div>
        <button
          type="button"
          onClick={onAcknowledge}
          disabled={!canAcknowledge}
          className="rounded bg-red-100 px-3 py-1 text-sm font-semibold text-red-900 disabled:opacity-50"
        >
          Acknowledge
        </button>
      </div>
    </div>
  );
}
