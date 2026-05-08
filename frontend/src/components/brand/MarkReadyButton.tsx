/**
 * Decoupled-ready Mark Ready toggle (PR #209 follow-up).
 *
 * Sits in the left rail alongside the role roster — visually separated
 * from the creator's destructive admin row (KICK / REMOVE) so a single
 * misclick can't accidentally kick a player while you meant to mark
 * yourself ready. Replaces the old composer-bound "SUBMIT & READY"
 * button: ready is now a stance, not a property of the message you
 * just sent, and the composer stays editable through ``AI_PROCESSING``
 * for side-comments / interjections.
 *
 * State model
 * -----------
 * The button is **controlled** — it doesn't own ``isReady`` itself.
 * The parent computes the displayed state by overlaying any pending
 * optimistic flip on top of the canonical ``turn.ready_role_ids``
 * snapshot, then passes the result here. ``onToggle`` is fired with
 * the desired NEW state; the parent is responsible for sending the
 * ``set_ready`` WS event with a fresh ``client_seq`` and unwinding
 * the optimistic flip on ``set_ready_rejected``.
 *
 * Why controlled and not self-managed: the same button is used both
 * for the local participant's own toggle and for the creator's
 * impersonation toggle on another active role's row. A single source
 * of truth (snapshot + optimistic-overlay map keyed by client_seq)
 * lives at the page level. Letting each button own its own ready bit
 * would diverge the moment a ``ready_changed`` broadcast arrived for
 * a role whose button was unmounted.
 *
 * Brand carve-out: the ``READY ✓`` checkmark.
 * --------------------------------------------
 * HANDOFF.md whitelists ``·`` separators and ``→`` / ``↓`` arrows;
 * other glyphs are excluded as decoration. The ``✓`` here carries
 * load-bearing semantic meaning — "ready vs not-ready" is a binary
 * status badge in a brand language that has no other typographic
 * affordance for it (no italics, no color-on-color text). The
 * checkmark sits inside the signal-tinted button face the same way
 * the ``✗`` would inside a crit-tinted "removed" badge if we ever
 * had one. Treat as a deliberate carve-out for binary state badges,
 * not as creeping decoration. Any new glyph wanting the same
 * exception should re-prove the load-bearing claim.
 */
const SUBJECT_LABEL_TRUNC_AT = 18;

interface Props {
  /** Whether the SUBJECT role is currently ready (canonical OR
   *  pending-optimistic). */
  isReady: boolean;
  /** Disabled when the session isn't ``AWAITING_PLAYERS``, when the
   *  subject role isn't on the active set, or when the WS is closed. */
  enabled: boolean;
  /** Called with the desired new state. Parent should send the
   *  ``set_ready`` WS event and queue an optimistic-flip entry keyed
   *  by ``client_seq``. */
  onToggle: (next: boolean) => void;
  /**
   * True while the parent has a pending optimistic flip for this
   * subject — i.e. ``set_ready`` was sent but no ack/reject/broadcast
   * has resolved it yet. The button reflects the optimistic state
   * via ``isReady`` (so the label flips immediately), and adds a
   * subtle pulse ring + ``aria-busy`` while the server round-trip
   * is in flight. Without this, a slow round-trip leaves the button
   * looking idle and users double-click thinking the first didn't
   * take, eating their flip-cap budget. UI/UX review MEDIUM M2.
   */
  inFlight?: boolean;
  /**
   * "self" → the local participant is toggling their own ready state
   *   (label: ``MARK READY`` / ``READY ✓``).
   * "impersonate" → the creator is toggling on behalf of another active
   *   role (label: ``MARK <ROLE> READY`` / ``<ROLE> READY ✓``).
   *
   * Distinct copy AND distinct tone (signal=self, info=impersonate)
   * so a creator scanning the rail can tell at a glance which row
   * affects them vs. another seat — and so a screenshot shared in a
   * bug report shows the impersonation context without needing to
   * inspect the surrounding markup. User-persona review HIGH.
   */
  variant?: "self" | "impersonate";
  /** Used for the impersonation label and aria-label. Falls back to
   *  ``"role"`` if absent. Long labels are truncated to keep the
   *  button face from wrapping on narrow rails (UI/UX review BLOCK). */
  subjectLabel?: string;
  /** Optional reason shown as a tooltip when ``enabled=false`` —
   *  e.g. "Not on the active turn", "WebSocket reconnecting". */
  disabledReason?: string;
}

export function MarkReadyButton({
  isReady,
  enabled,
  onToggle,
  variant = "self",
  subjectLabel,
  disabledReason,
  inFlight = false,
}: Props) {
  // Truncate long role labels with an ellipsis so the button face
  // doesn't wrap to 3 lines on a 220px-wide rail. UI/UX review
  // BLOCK B2 — labels like "Senior Threat Intelligence Analyst"
  // bloated the rail when the button rendered in the impersonate
  // variant. The full label is still visible in the row above.
  const trunc = (s: string) =>
    s.length > SUBJECT_LABEL_TRUNC_AT
      ? `${s.slice(0, SUBJECT_LABEL_TRUNC_AT - 1)}…`
      : s;
  // Label split: state on the left, action verb on the right. The
  // older single-line "READY ✓ — WALK BACK" read as an instruction
  // ("walk back") more than a status, and a creator clicking it
  // wasn't sure whether it was confirming their ready or undoing it.
  // User-persona review HIGH H1: separate concerns visually.
  const stateLabel = (() => {
    if (variant === "impersonate") {
      const target = trunc((subjectLabel ?? "role").toUpperCase());
      return isReady ? `${target} READY ✓` : `MARK ${target} READY →`;
    }
    return isReady ? "READY ✓" : "MARK READY →";
  })();
  // Secondary "tap to undo" hint — only rendered for the SELF variant
  // when already ready. The impersonation variant uses the row label
  // as its lead-in ("CISO READY ✓"), so an undo hint there would be
  // ambiguous (whose ready are we undoing?).
  const showUndoHint = variant === "self" && isReady;
  // ``aria-pressed`` is only meaningful on the self variant — it
  // describes the LOCAL participant's ready state. On the
  // impersonation variant the toggle reflects another role's state,
  // so AT announcing "MARK SOC READY, pressed" would confuse the
  // creator into thinking THEY are ready. The visual+textual label
  // ("SOC READY ✓" vs "MARK SOC READY →") already disambiguates; we
  // drop ``aria-pressed`` for the impersonate variant and lean on
  // the explicit label instead. QA review HIGH.
  const ariaPressed = variant === "self" ? isReady : undefined;
  const tone = isReady ? "ready" : "not-ready";
  const title = (() => {
    if (!enabled) return disabledReason ?? "Ready toggle is unavailable right now.";
    if (variant === "impersonate") {
      return isReady
        ? `Walk back ${subjectLabel ?? "this role"}'s ready signal — re-opens discussion for them.`
        : `Mark ${subjectLabel ?? "this role"} ready on their behalf — the AI advances once every active role is ready.`;
    }
    return isReady
      ? "Tap to undo your ready signal — re-opens discussion. The AI won't advance until you're ready again."
      : "Mark yourself ready. The AI advances once every active role is ready.";
  })();

  // Brand tones:
  //   self+ready          → signal-filled (green); the dominant signal
  //                         on the page when YOU are done.
  //   self+not-ready      → ink-800 outline w/ signal-bright text;
  //                         neutral primary affordance.
  //   impersonate+ready   → info-tint (cyan); distinct from self-ready
  //                         so the creator's eye locks onto their own
  //                         row first when scanning.
  //   impersonate+not-ready → ink-800 outline w/ info text; matches.
  // Per User-persona review HIGH H2 — the visual distinction makes
  // the self-vs-impersonation footgun (clicking the wrong row) a
  // colour-discriminable mistake instead of a label-discriminable one.
  const cls = (() => {
    if (variant === "impersonate") {
      return isReady
        ? "mono w-full rounded-r-1 border border-info bg-info-bg px-3 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-info hover:bg-info/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-info disabled:cursor-not-allowed disabled:opacity-50"
        : "mono w-full rounded-r-1 border border-info bg-ink-800 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-info hover:bg-ink-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-info disabled:cursor-not-allowed disabled:opacity-50";
    }
    return isReady
      ? "mono w-full rounded-r-1 border border-signal bg-signal-tint px-3 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-signal hover:bg-signal/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal disabled:cursor-not-allowed disabled:opacity-50"
      : "mono w-full rounded-r-1 border border-signal-deep bg-ink-800 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-signal-bright hover:bg-ink-700 hover:border-signal focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal disabled:cursor-not-allowed disabled:opacity-50";
  })();
  // ``animate-tt-pulse`` is the brand's existing subtle signal-blue
  // ring keyframe (1.6s ease-in-out, see tailwind.config.ts:131).
  // Using the existing animation keeps the visual language native to
  // the rail and avoids introducing a new keyframe for a one-off.
  // ``motion-reduce:animate-none`` honors the user's OS-level reduce-
  // motion preference; ``aria-busy`` carries the same signal for AT.
  const inFlightCls = inFlight
    ? " animate-tt-pulse motion-reduce:animate-none"
    : "";

  return (
    <button
      type="button"
      onClick={() => onToggle(!isReady)}
      disabled={!enabled}
      aria-pressed={ariaPressed}
      aria-busy={inFlight || undefined}
      aria-label={
        variant === "self"
          ? isReady
            ? "Walk back your ready signal"
            : "Mark yourself ready"
          : isReady
            ? `Walk back ${subjectLabel ?? "this role"}'s ready signal`
            : `Mark ${subjectLabel ?? "this role"} ready`
      }
      title={title}
      data-tone={tone}
      data-variant={variant}
      data-in-flight={inFlight ? "true" : undefined}
      data-testid={
        variant === "impersonate" ? "mark-ready-impersonate" : "mark-ready"
      }
      className={cls + inFlightCls}
    >
      <span className="flex flex-col items-center gap-0.5">
        <span className="break-words">{stateLabel}</span>
        {showUndoHint ? (
          <span className="mono text-[9px] font-normal tracking-[0.10em] opacity-70">
            tap to undo
          </span>
        ) : null}
      </span>
    </button>
  );
}
