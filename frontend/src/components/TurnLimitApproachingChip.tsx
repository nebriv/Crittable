import { useEffect, useState } from "react";
import { StatusChip } from "./brand/StatusChip";

/**
 * One-time "N turns left — start wrapping up" soft-warning notice.
 *
 * Driven by the broadcast ``turn_limit_approaching`` WS event (cost/abuse
 * C2), which the engine fires at most once per session when a freshly-
 * opened turn first crosses ``AI_TURN_SOFT_WARN_PCT`` of the cap. Shown
 * to BOTH creator and players so everyone knows to wrap up before the
 * hard cap parks the exercise.
 *
 * Deliberately subtle and NON-blocking (``pointer-events: none``, fixed
 * to the bottom-right, never claims a layout slot) and self-expiring —
 * same lifecycle contract as <BackendStatusChip>: the parent passes
 * ``turnsRemaining`` plus a monotonic ``nonce`` (bumped on every frame);
 * each new nonce (re)arms the auto-clear timer. ``info`` tone (an
 * expected end-of-exercise milestone, not an error). Renders nothing
 * until the first event (``nonce <= 0``).
 */

/** Auto-clear delay after the ``turn_limit_approaching`` event. */
export const TURN_LIMIT_NOTICE_TTL_MS = 10000;

interface Props {
  /** Turns left when the warning fired. */
  turnsRemaining: number;
  /** Monotonic counter bumped by the page on every event. ``<= 0`` =
   *  never fired this session (renders nothing). */
  nonce: number;
  /** Override for the auto-clear delay (tests). */
  ttlMs?: number;
}

export function TurnLimitApproachingChip({
  turnsRemaining,
  nonce,
  ttlMs,
}: Props) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (nonce <= 0) {
      // No event yet (or the page reset). Stay hidden; nothing to arm.
      return;
    }
    setVisible(true);
    const ttl = ttlMs ?? TURN_LIMIT_NOTICE_TTL_MS;
    const id = window.setTimeout(() => setVisible(false), ttl);
    return () => window.clearTimeout(id);
  }, [nonce, ttlMs]);

  if (!visible) return null;

  const label =
    turnsRemaining === 1 ? "1 TURN LEFT" : `${turnsRemaining} TURNS LEFT`;

  return (
    <div
      // Fixed, non-blocking, lifted clear of any bottom chrome (the
      // 48 px sticky action bar on the creator surface) and stacked
      // above the ``bottom: 56`` <BackendStatusChip> so the two never
      // sit on top of each other in the rare moment both are live.
      // Self-expires.
      role="status"
      aria-live="polite"
      data-testid="turn-limit-approaching-chip"
      style={{
        position: "fixed",
        right: 12,
        bottom: 92,
        zIndex: 30,
        pointerEvents: "none",
      }}
    >
      <StatusChip
        label={`● ${label}`}
        value="Start wrapping up"
        tone="info"
        title="Approaching the turn limit — wrap up soon."
      />
    </div>
  );
}
