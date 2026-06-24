import { useEffect, useRef } from "react";

interface Props {
  /** The session's configured turn cap (from the ``turn_limit_reached``
   *  event). Surfaced so the operator sees *why* play stopped. */
  maxTurns: number;
  /** True when the local participant is the session creator. The creator
   *  is the only role that can End the session, so only they get the
   *  prominent End affordance; players see the same banner as
   *  informational. */
  isCreator: boolean;
  /** End-session handler. Wired only for the creator; ignored otherwise. */
  onEnd?: () => void;
}

/**
 * Broadcast banner shown to every participant when the session hits its
 * configured turn cap. The exercise can't advance further — the creator
 * must End the session to generate the after-action report.
 *
 * Reuses the ``CriticalEventBanner`` chrome (sticky top, mono eyebrow,
 * brand tokens) but in the ``info`` tone rather than ``crit``: a turn-cap
 * is an expected end-of-exercise milestone, not an in-fiction emergency
 * inject. Operator voice per ``design/handoff/BRAND.md`` — states the
 * fact and the next action, no marketing softening.
 *
 * For the creator the primary affordance is END SESSION (focused on
 * mount so a keyboard / screen-reader user lands on the action). Players
 * get a one-line "your facilitator will wrap up" note instead.
 */
export function TurnLimitBanner({ maxTurns, isCreator, onEnd }: Props) {
  const endRef = useRef<HTMLButtonElement | null>(null);

  // Pull focus to the End button (creator only) so the recovery action
  // is immediately reachable without tabbing through the page.
  useEffect(() => {
    if (isCreator) endRef.current?.focus();
  }, [isCreator]);

  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="turn-limit-banner"
      className="sticky top-0 z-20 border-b-4 border-info bg-info-bg p-4 text-ink-050 backdrop-blur-sm"
      style={{ background: "color-mix(in oklch, var(--info) 24%, var(--ink-900))" }}
    >
      <div className="mx-auto flex max-w-5xl items-start justify-between gap-4">
        <div>
          <p className="mono text-[11px] font-bold uppercase tracking-[0.22em] text-info">
            ● TURN LIMIT · {maxTurns} TURNS
          </p>
          <h2 className="mt-1 text-lg font-semibold text-ink-050">
            Turn limit reached.
          </h2>
          <p className="text-sm text-ink-100 opacity-90">
            {isCreator
              ? "End the session to generate the after-action report."
              : "Your facilitator can end the session to generate the after-action report."}
          </p>
        </div>
        {isCreator ? (
          <button
            ref={endRef}
            type="button"
            onClick={onEnd}
            className="mono shrink-0 rounded-r-1 bg-signal px-4 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-ink-900 hover:bg-signal-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-bright"
          >
            END SESSION →
          </button>
        ) : null}
      </div>
    </div>
  );
}
