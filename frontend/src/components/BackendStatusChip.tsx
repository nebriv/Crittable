import { useEffect, useState } from "react";
import { StatusChip } from "./brand/StatusChip";

/**
 * Creator-only, self-expiring "degraded / heavy load" indicator.
 *
 * Driven by the ``backend_status`` WS event (sent creator-only — players
 * never receive it). The signal is low-information by design: a short
 * human-readable message, no counts. The chip is deliberately subtle
 * (brand ``warn``-tone ``StatusChip``) and NON-blocking — it never
 * intercepts pointer events or claims a layout slot that would push
 * controls around — and it auto-clears a few seconds after the last
 * event so a transient blip doesn't leave a stale banner latched on.
 *
 * Visibility lifecycle is owned here rather than in the page: the parent
 * passes the latest message plus a monotonic ``nonce`` (bumped on every
 * ``backend_status`` frame). Each new nonce (re)arms an ~8 s timer; when
 * it fires we hide. Re-arming on the message identity alone would miss
 * back-to-back identical messages, so the nonce is the load-bearing
 * trigger.
 */

/** Auto-clear delay after the most recent ``backend_status`` event. */
export const BACKEND_STATUS_TTL_MS = 8000;

interface Props {
  /** Operator-facing copy from the latest event. ``null`` = never
   *  received one this session (renders nothing). */
  message: string | null;
  /** Monotonic counter bumped by the page on every ``backend_status``
   *  frame. Re-arms the auto-clear timer even when ``message`` repeats. */
  nonce: number;
  /** Override for the auto-clear delay (tests). */
  ttlMs?: number;
}

export function BackendStatusChip({ message, nonce, ttlMs }: Props) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!message || nonce <= 0) {
      // No event yet (or the page reset). Stay hidden; nothing to arm.
      return;
    }
    setVisible(true);
    const ttl = ttlMs ?? BACKEND_STATUS_TTL_MS;
    const id = window.setTimeout(() => {
      setVisible(false);
    }, ttl);
    return () => window.clearTimeout(id);
    // ``nonce`` is the re-arm trigger; ``message`` is read for the truthy
    // guard but a fresh frame always bumps ``nonce`` too.
  }, [nonce, message, ttlMs]);

  if (!visible || !message) return null;

  return (
    <div
      // ``role="status"`` + polite: it's an ambient health nudge, not an
      // interrupt. ``pointer-events: none`` guarantees the chip can never
      // sit over and swallow a click meant for a control beneath it.
      role="status"
      aria-live="polite"
      data-testid="backend-status-chip"
      style={{ pointerEvents: "none" }}
    >
      <StatusChip
        label="● BACKEND"
        value={message}
        tone="warn"
        title={message}
      />
    </div>
  );
}
