import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import type { ImpersonateOption } from "../lib/proxy";

// ``ImpersonateOption`` lives in ``../lib/proxy`` so the helper that
// builds the dropdown options and the consumer here can't drift on
// the shape of ``offTurn`` (issue #80, Copilot review on PR #91).
// See ``lib/proxy.ts`` for the field-by-field contract.

/**
 * Wave 1 (issue #134): per-submission intent. ``"ready"`` means the
 * player is signalling "I'm done — AI may advance once everyone
 * else is ready"; ``"discuss"`` means "I'm contributing to discussion,
 * keep my seat open". The composer's two submit buttons map 1:1 onto
 * these values.
 */
export type SubmissionIntent = "ready" | "discuss";

interface Props {
  enabled: boolean;
  placeholder: string;
  /** Visible label above the textarea. Issue #78: parents render
   * "Your turn" when ``isMyTurn`` and "Add a comment" / "Your message"
   * otherwise so the at-a-glance signal isn't lost when the composer
   * stays enabled for out-of-turn sidebar comments. */
  label?: string;
  /**
   * ``asRoleId`` is omitted for normal submissions (use the local
   * participant's role). When the creator picks a different role from
   * the impersonate dropdown, that role's id is forwarded so the parent
   * can call the proxy endpoint.
   *
   * ``intent`` (Wave 1): the player's per-submission ready signal.
   * Always one of ``"ready"`` / ``"discuss"`` — never undefined, the
   * composer always knows which button was pressed. The parent forwards
   * this to the WS payload.
   */
  onSubmit: (text: string, intent: SubmissionIntent, asRoleId?: string) => void;
  /**
   * When ``true``, the local participant has already signalled ready
   * for the current turn. The composer surfaces this as a small
   * "Currently ready ✓" hint and primes the secondary button to
   * "Walk back ready" so the player can re-open discussion if needed.
   * Wave 1 (issue #134).
   */
  isCurrentlyReady?: boolean;
  /**
   * When ``true``, the composer hides the "Submit, still discussing"
   * button. Used for out-of-turn / interjection submissions where
   * intent doesn't apply (the message lands in the transcript and is
   * never part of the ready quorum). Defaults to ``false`` so a normal
   * active-turn composer always shows both buttons.
   */
  hideDiscussButton?: boolean;
  /** Optional callback fired on debounced typing start/stop transitions. */
  onTypingChange?: (typing: boolean) => void;
  /**
   * Solo-test impersonation list. Empty / undefined hides the dropdown.
   * Populated only for the creator and only with *other* active roles
   * (the creator's own seat is always the implicit default).
   */
  impersonateOptions?: ImpersonateOption[];
  /** Label for the local participant's own seat (shown as the default). */
  selfLabel?: string;
  /**
   * Incrementing counter the parent flips when a submit was REJECTED
   * (e.g. WS ``error`` event with ``scope === "submit_response"``).
   * On bump, the composer restores the last-attempted text instead of
   * leaving the textarea blank — so a player who hit Submit a half-
   * second after their turn closed doesn't lose their reply.
   */
  submitErrorEpoch?: number;
}

export function Composer({
  enabled,
  placeholder,
  label,
  onSubmit,
  onTypingChange,
  impersonateOptions,
  selfLabel,
  submitErrorEpoch,
  isCurrentlyReady = false,
  hideDiscussButton = false,
}: Props) {
  const [text, setText] = useState("");
  // Empty string == speak as the local participant. Anything else is a
  // role_id passed up to the parent for proxy submission.
  const [asRoleId, setAsRoleId] = useState<string>("");
  // Heartbeat-based typing indicator (issue #77). Pre-fix the
  // sender emitted exactly one ``typing_start`` after a 1.5 s
  // continuous-typing gate and one ``typing_stop`` after 3.5 s of
  // idle. If either packet was dropped, or the user paused briefly
  // and the receiver TTL fired before they resumed, the indicator
  // vanished mid-typing and didn't come back. Switching to a
  // 1 Hz heartbeat: while the user is actively typing AND has hit
  // a key since the last beat, we re-emit ``typing_start`` every
  // ~1 s, which refreshes the receiver-side TTL. ``typing_stop``
  // still fires on idle / submit / disable / unmount.
  //
  // ``dirtySinceBeat`` is the gate — without it, the heartbeat
  // would keep firing across long pauses (defeating the point).
  // We mark dirty on every keystroke, clear on every beat, and
  // skip the beat send when not dirty. The idle timer (separate
  // from the heartbeat interval) still fires the explicit stop
  // after STOP_AFTER_IDLE_MS so the receiver doesn't have to
  // wait for the TTL sweep to evict.
  //
  // ``pendingStartTimer`` keeps a single fat-finger keystroke from
  // broadcasting a ghost indicator (UI/UX review BLOCK B-1; original
  // issue #53). When it fires we count keystrokes-since-schedule:
  // <2 means the user typed once and stopped (no broadcast); ≥2
  // means they're really at the keyboard (start fires + heartbeat
  // begins). Without the count gate the timer would still emit
  // start for a single keystroke that didn't clear the textarea —
  // Copilot review on PR #99.
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingStartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTyping = useRef(false);
  const dirtySinceBeat = useRef(false);
  const keystrokesInGate = useRef(0);
  const TYPING_START_DELAY_MS = 500;
  const HEARTBEAT_MS = 1000;
  const STOP_AFTER_IDLE_MS = 2500;
  // Last text the user attempted to submit. Held outside React state
  // so we can restore it without an extra render on the success path.
  const lastAttemptedRef = useRef<string>("");
  // Track the last epoch we've already handled so the restore-on-error
  // effect only fires when the parent actually bumps the counter, not
  // on initial mount.
  const handledErrorEpochRef = useRef<number | undefined>(submitErrorEpoch);

  function submit(intent: SubmissionIntent) {
    if (!enabled || !text.trim()) return;
    const trimmed = text.trim();
    lastAttemptedRef.current = trimmed;
    onSubmit(trimmed, intent, asRoleId || undefined);
    setText("");
    // Reset back to "speak as me" after every submit so the next message
    // doesn't accidentally post under the previous proxy role. Sticky
    // proxy mode was a real footgun in solo testing.
    setAsRoleId("");
    // Tear down the heartbeat + idle timers and emit a final
    // typing_stop so peers don't keep showing us as typing for
    // the length of TYPING_VISIBLE_MS after we just submitted.
    emitTypingStop("submit");
  }

  function handle(e: FormEvent) {
    // Form-submit (Enter key in textarea, primary button click) maps
    // to the "ready" intent — the standard "I'm done, AI may advance"
    // signal. The "Submit, still discussing" button calls
    // ``submit("discuss")`` directly and bypasses this handler.
    e.preventDefault();
    submit("ready");
  }

  // Restore the last-attempted text when the parent signals a submit
  // rejection. Without this, the optimistic ``setText("")`` above
  // would silently eat the player's reply on a "role cannot submit on
  // this turn" race.
  useEffect(() => {
    if (submitErrorEpoch === undefined) return;
    if (submitErrorEpoch === handledErrorEpochRef.current) return;
    handledErrorEpochRef.current = submitErrorEpoch;
    if (lastAttemptedRef.current) {
      setText(lastAttemptedRef.current);
    }
  }, [submitErrorEpoch]);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter submits; Shift+Enter inserts a newline. IME composition events
    // (Japanese / Chinese / Korean input) keep the default newline behavior so
    // accepting a candidate doesn't accidentally send the message.
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (!enabled || !text.trim()) return;
    handle(e as unknown as FormEvent);
  }

  function teardownTypingTimers() {
    if (heartbeatTimer.current) {
      clearInterval(heartbeatTimer.current);
      heartbeatTimer.current = null;
    }
    if (idleTimer.current) {
      clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
    if (pendingStartTimer.current) {
      clearTimeout(pendingStartTimer.current);
      pendingStartTimer.current = null;
    }
    keystrokesInGate.current = 0;
  }

  // Reasons logged at every emitTypingStop call site so a "stuck
  // typing indicator in production" report has a breadcrumb to
  // bisect the cause (idle / submit / clear / disable / unmount).
  // Per CLAUDE.md logging-and-debuggability policy.
  function emitTypingStop(reason: string) {
    teardownTypingTimers();
    if (isTyping.current) {
      isTyping.current = false;
      dirtySinceBeat.current = false;
      onTypingChange?.(false);
      console.debug("[composer] typing_stop", { reason });
    }
  }

  function handleChange(value: string) {
    setText(value);
    if (!enabled || !onTypingChange) return;
    // If the textarea is now empty (e.g. user cleared with
    // backspace), tear down the heartbeat + emit stop. Holding
    // "typing" on an empty composer is misleading.
    if (!value.trim()) {
      emitTypingStop("textarea cleared");
      return;
    }
    if (!isTyping.current) {
      keystrokesInGate.current += 1;
      if (!pendingStartTimer.current) {
        // First keystroke since silence: schedule a delayed
        // ``typing_start`` so a single fat-finger doesn't
        // surface a ghost indicator on every peer (UI/UX
        // review BLOCK B-1; original issue #53). The gate
        // requires ≥2 keystrokes before firing — without that
        // count check, a single keystroke that doesn't clear
        // the textarea still emitted start when the timer
        // fired (Copilot review on PR #99).
        pendingStartTimer.current = setTimeout(() => {
          pendingStartTimer.current = null;
          const count = keystrokesInGate.current;
          keystrokesInGate.current = 0;
          if (!enabled) return;
          if (count < 2) {
            // User typed once and stopped — don't broadcast.
            // The idle timer (still scheduled) will tear down
            // any state when STOP_AFTER_IDLE_MS elapses.
            return;
          }
          isTyping.current = true;
          dirtySinceBeat.current = false;
          onTypingChange?.(true);
          if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
          heartbeatTimer.current = setInterval(() => {
            // Re-check enabled in case the turn flipped between
            // beats.
            if (!enabled || !isTyping.current) return;
            if (!dirtySinceBeat.current) return;
            onTypingChange?.(true);
            dirtySinceBeat.current = false;
          }, HEARTBEAT_MS);
        }, TYPING_START_DELAY_MS);
      }
    } else {
      // Already typing — just mark dirty so the next heartbeat
      // tick sends a refresh.
      dirtySinceBeat.current = true;
    }
    // Refresh the idle timer on every keystroke. When it fires
    // we emit ``typing_stop`` and clear the heartbeat.
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(
      () => emitTypingStop("idle"),
      STOP_AFTER_IDLE_MS,
    );
  }

  useEffect(() => {
    return () => {
      // Unmount cleanup — clear timers + send a final stop so
      // peers don't see a stuck "X is typing…" indicator for
      // the length of TYPING_VISIBLE_MS after we navigate away.
      // Use ``teardownTypingTimers`` rather than inline clears so
      // every ref is nulled: a non-null but cancelled timer ID in
      // ``pendingStartTimer.current`` would prevent future typing
      // sessions from scheduling a new gate timer (issue #77).
      teardownTypingTimers();
      if (isTyping.current && onTypingChange) {
        isTyping.current = false;
        onTypingChange(false);
        console.debug("[composer] typing_stop", { reason: "unmount" });
      }
    };
  }, [onTypingChange]);

  // When the turn ends mid-typing burst the composer goes
  // ``disabled`` but the timers are still in flight. Without this
  // hook the indicator would linger on other clients for the
  // remaining TTL window after the turn flipped, falsely
  // suggesting we're still composing.
  useEffect(() => {
    if (enabled) return;
    emitTypingStop("disabled");
    // emitTypingStop is stable per render; only re-run when
    // ``enabled`` flips so we don't churn on onTypingChange
    // identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const hasImpersonate = (impersonateOptions?.length ?? 0) > 0;

  return (
    <form
      onSubmit={handle}
      className="flex flex-col gap-2 rounded-r-3 border-t border-ink-600 bg-ink-850 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <label
          className="mono text-[10px] font-bold uppercase tracking-[0.20em] text-signal"
          htmlFor="composer"
        >
          {label ? `RESPONDING AS · ${label.toUpperCase()}` : "RESPONDING AS · YOU"}
        </label>
        {hasImpersonate ? (
          <label className="mono flex items-center gap-1 text-[10px] uppercase tracking-[0.10em] text-ink-300">
            Respond as
            <select
              value={asRoleId}
              onChange={(e) => setAsRoleId(e.target.value)}
              disabled={!enabled}
              className="mono rounded-r-1 border border-ink-500 bg-ink-900 px-1 py-0.5 text-[11px] text-ink-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal disabled:opacity-50"
              title="Creator-only solo-test helper. Submit on behalf of another active role."
            >
              <option value="">{selfLabel ?? "self"} (you)</option>
              {(impersonateOptions ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                  {o.offTurn ? " — sidebar (off-turn)" : " (proxy)"}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {asRoleId ? (() => {
        const selected = (impersonateOptions ?? []).find(
          (o) => o.id === asRoleId,
        );
        const offTurn = Boolean(selected?.offTurn);
        return (
          <div
            className="mono flex flex-wrap items-center justify-between gap-2 rounded-r-1 border border-warn bg-warn-bg px-2 py-1 text-[11px] uppercase tracking-[0.04em] text-warn"
            role="status"
            aria-live="polite"
          >
            <span>
              Submitting as{" "}
              <span className="font-bold">
                {selected?.label ?? asRoleId}
              </span>{" "}
              {offTurn ? "(sidebar — not a turn answer)" : "(proxy)"}
            </span>
            <button
              type="button"
              onClick={() => setAsRoleId("")}
              className="mono rounded-r-1 border border-warn px-2 py-0.5 text-[10px] font-bold uppercase text-warn hover:bg-warn/20"
            >
              Back to {selfLabel ?? "me"}
            </button>
          </div>
        );
      })() : null}
      <textarea
        id="composer"
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={!enabled}
        rows={3}
        className={`w-full rounded-r-1 border bg-ink-900 p-3 text-sm text-ink-100 sans focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal-deep disabled:opacity-50 ${
          asRoleId ? "border-warn" : "border-signal-deep"
        }`}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="mono text-[10px] uppercase tracking-[0.04em] text-ink-400">
          <kbd className="mono rounded-r-1 border border-ink-500 bg-ink-800 px-1 text-[10px] text-ink-100">Enter</kbd>{" "}
          to send,{" "}
          <kbd className="mono rounded-r-1 border border-ink-500 bg-ink-800 px-1 text-[10px] text-ink-100">Shift</kbd>+
          <kbd className="mono rounded-r-1 border border-ink-500 bg-ink-800 px-1 text-[10px] text-ink-100">Enter</kbd>{" "}
          for a new line
          {isCurrentlyReady && !hideDiscussButton ? (
            <>
              {" · "}
              <span className="text-signal" aria-live="polite">
                You're marked ready
              </span>
            </>
          ) : null}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {!hideDiscussButton ? (
            <button
              type="button"
              onClick={() => submit("discuss")}
              disabled={!enabled || !text.trim()}
              title={
                isCurrentlyReady
                  ? "Send this message and walk back your ready signal — keeps the team discussing"
                  : "Send this message without signalling ready — keeps the turn open for more discussion"
              }
              className="mono rounded-r-1 border border-ink-400 bg-ink-800 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-ink-100 hover:bg-ink-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isCurrentlyReady
                ? "WALK BACK READY ↺"
                : "STILL DISCUSSING →"}
            </button>
          ) : null}
          <button
            type="submit"
            disabled={!enabled || !text.trim()}
            title={
              hideDiscussButton
                ? "Send this sidebar message"
                : "Send this message AND mark yourself ready — AI advances once everyone is ready"
            }
            className={`mono rounded-r-1 px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.18em] focus-visible:outline focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50 ${
              asRoleId
                ? "bg-warn text-ink-900 hover:bg-warn/80 focus-visible:outline-warn"
                : "bg-signal text-ink-900 hover:bg-signal-bright focus-visible:outline-signal-bright"
            }`}
          >
            {(() => {
              if (asRoleId) {
                const selected = (impersonateOptions ?? []).find(
                  (o) => o.id === asRoleId,
                );
                return selected?.offTurn
                  ? "SUBMIT (SIDEBAR) →"
                  : "SUBMIT (PROXY) →";
              }
              if (hideDiscussButton) return "SUBMIT →";
              return "SUBMIT & READY →";
            })()}
          </button>
        </div>
      </div>
    </form>
  );
}
