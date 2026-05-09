/**
 * Issue #191 — creator-only banner for transient upstream LLM provider
 * outages (Anthropic 529 / 5xx / 429 / connection timeout).
 *
 * Players don't see this banner: they can't act on the outage (only the
 * creator can Force-advance / Retry), so a player-side banner would
 * imply an action they don't have. Players continue to see "AI is
 * thinking" until the creator drives the recovery.
 *
 * Copy framing per `docs/handoff/BRAND.md` operator voice: explicit
 * about the upstream blame, actionable about the recovery, no
 * marketing softening. Status-page link is the primary affordance.
 */

import type { ServerEvent } from "../lib/ws";

type UpstreamErrorEvent = Extract<ServerEvent, { type: "error" }>;

const STATUS_PAGE_URL = "https://status.claude.com/";

interface Props {
  /** The most recent ``upstream_llm`` event payload. */
  event: UpstreamErrorEvent;
  /** Click handler for the operator's "Dismiss" button. The next
   *  upstream error re-mounts the banner with fresh content. */
  onDismiss: () => void;
}

interface Copy {
  /** Eyebrow + breaking-banner label, mirrors CriticalEventBanner. */
  label: string;
  /** Single-line headline used in the banner heading. */
  headline: string;
  /** Body sentence. Inline with the status-page link so the operator's
   *  eye lands on the affordance. */
  body: string;
}

function copyForCategory(event: UpstreamErrorEvent): Copy {
  // Operator voice (BRAND.md): imperative, specific, no marketing
  // softeners. Body lines describe the upstream blip and the wait
  // expectation only — they do NOT prescribe a control to click.
  // The right recovery (Force-advance in PLAY, retry-AAR in ENDED,
  // resubmit setup reply in SETUP) varies by phase, and a play-tier
  // hardcoded "use Force-advance" reads as wrong copy on the AAR
  // failure path. The existing TopBar / activity-panel controls are
  // visible regardless; the banner's job is to *explain*, not to
  // teach the existing chrome.
  const retry =
    typeof event.retry_hint_seconds === "number" && event.retry_hint_seconds > 0
      ? `Anthropic suggests retrying after ${event.retry_hint_seconds}s.`
      : "Try again in 30–60s.";
  switch (event.category) {
    case "overloaded":
      return {
        label: "UPSTREAM · OVERLOADED",
        headline: "Anthropic API overloaded.",
        body: "Session paused. Anthropic queues clear fast under load — try again in 30–60s.",
      };
    case "rate_limited":
      return {
        label: "UPSTREAM · RATE-LIMITED",
        headline: "Rate-limited by Anthropic.",
        body: `Session paused. ${retry}`,
      };
    case "server_error":
      return {
        label: "UPSTREAM · SERVER ERROR",
        headline: "Anthropic returned a server error.",
        body: "Session paused. Try again in 30s.",
      };
    case "timeout":
      return {
        label: "UPSTREAM · CONNECTION TIMED OUT",
        headline: "Connection to Anthropic timed out.",
        body: "Session paused. Network or upstream blip — try again in 30s.",
      };
    default:
      return {
        label: "UPSTREAM · ERROR",
        headline: "Unexpected error reached Crittable from the AI provider path.",
        body: "Session paused. Try again in 30s.",
      };
  }
}

export function UpstreamLlmErrorBanner({ event, onDismiss }: Props) {
  const copy = copyForCategory(event);
  const trace = event.request_id;
  const statusCode = event.status_code;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="sticky top-0 z-20 border-b-4 border-warn bg-warn-bg p-4 text-ink-050 backdrop-blur-sm"
      style={{ background: "color-mix(in oklch, var(--warn) 24%, var(--ink-900))" }}
    >
      <div className="mx-auto flex max-w-5xl items-start justify-between gap-4">
        <div>
          <p className="mono text-[11px] font-bold uppercase tracking-[0.22em] text-warn">
            ● {copy.label}
          </p>
          <h2 className="mt-1 text-lg font-semibold text-ink-050">{copy.headline}</h2>
          <p className="text-sm text-ink-100 opacity-90">
            {copy.body}{" "}
            Live provider status:{" "}
            <a
              href={STATUS_PAGE_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="font-semibold text-signal-bright underline decoration-dotted underline-offset-2 hover:text-signal"
            >
              status.claude.com
            </a>
            .
          </p>
          {(trace || typeof statusCode === "number") ? (
            <p
              className="mono mt-2 break-all text-[10px] uppercase tracking-[0.16em] text-ink-200 opacity-70"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {typeof statusCode === "number" ? `HTTP ${statusCode}` : null}
              {typeof statusCode === "number" && trace ? " · " : null}
              {trace ? `req ${trace}` : null}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="mono shrink-0 rounded-1 border border-ink-300 bg-transparent px-4 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-ink-100 hover:bg-ink-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-bright"
        >
          DISMISS
        </button>
      </div>
    </div>
  );
}
