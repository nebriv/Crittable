import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import type { ImpersonateOption } from "../lib/proxy";

// ``ImpersonateOption`` lives in ``../lib/proxy`` so the helper that
// builds the dropdown options and the consumer here can't drift on
// the shape of ``offTurn`` (issue #80, Copilot review on PR #91).
// See ``lib/proxy.ts`` for the field-by-field contract.

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
   */
  onSubmit: (text: string, asRoleId?: string) => void;
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
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTyping = useRef(false);
  const dirtySinceBeat = useRef(false);
  const HEARTBEAT_MS = 1000;
  const STOP_AFTER_IDLE_MS = 2500;
  // Last text the user attempted to submit. Held outside React state
  // so we can restore it without an extra render on the success path.
  const lastAttemptedRef = useRef<string>("");
  // Track the last epoch we've already handled so the restore-on-error
  // effect only fires when the parent actually bumps the counter, not
  // on initial mount.
  const handledErrorEpochRef = useRef<number | undefined>(submitErrorEpoch);

  function handle(e: FormEvent) {
    e.preventDefault();
    if (!enabled || !text.trim()) return;
    const trimmed = text.trim();
    lastAttemptedRef.current = trimmed;
    onSubmit(trimmed, asRoleId || undefined);
    setText("");
    // Reset back to "speak as me" after every submit so the next message
    // doesn't accidentally post under the previous proxy role. Sticky
    // proxy mode was a real footgun in solo testing.
    setAsRoleId("");
    // Tear down the heartbeat + idle timers and emit a final
    // typing_stop so peers don't keep showing us as typing for
    // the length of TYPING_VISIBLE_MS after we just submitted.
    emitTypingStop();
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
  }

  function emitTypingStop() {
    teardownTypingTimers();
    if (isTyping.current) {
      isTyping.current = false;
      dirtySinceBeat.current = false;
      onTypingChange?.(false);
    }
  }

  function handleChange(value: string) {
    setText(value);
    if (!enabled || !onTypingChange) return;
    // If the textarea is now empty (e.g. user cleared with
    // backspace), tear down the heartbeat + emit stop. Holding
    // "typing" on an empty composer is misleading.
    if (!value.trim()) {
      emitTypingStop();
      return;
    }
    if (!isTyping.current) {
      // First keystroke since silence: emit start immediately
      // (receiver TTL handles flicker). Begin the heartbeat
      // interval; mark not-dirty because we just sent a beat.
      isTyping.current = true;
      dirtySinceBeat.current = false;
      onTypingChange(true);
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
      heartbeatTimer.current = setInterval(() => {
        // Re-check enabled in case the turn flipped between beats.
        if (!enabled || !isTyping.current) return;
        if (!dirtySinceBeat.current) return;
        onTypingChange?.(true);
        dirtySinceBeat.current = false;
      }, HEARTBEAT_MS);
    } else {
      // Already typing — just mark dirty so the next heartbeat
      // tick sends a refresh.
      dirtySinceBeat.current = true;
    }
    // Refresh the idle timer on every keystroke. When it fires
    // we emit ``typing_stop`` and clear the heartbeat.
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(emitTypingStop, STOP_AFTER_IDLE_MS);
  }

  useEffect(() => {
    return () => {
      // Unmount cleanup — clear timers + send a final stop so
      // peers don't see a stuck "X is typing…" indicator for
      // the length of TYPING_VISIBLE_MS after we navigate away.
      if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      if (isTyping.current && onTypingChange) {
        isTyping.current = false;
        onTypingChange(false);
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
    emitTypingStop();
    // emitTypingStop is stable per render; only re-run when
    // ``enabled`` flips so we don't churn on onTypingChange
    // identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const hasImpersonate = (impersonateOptions?.length ?? 0) > 0;

  return (
    <form onSubmit={handle} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <label
          className="text-xs uppercase tracking-widest text-slate-400"
          htmlFor="composer"
        >
          {label ?? "Your message"}
        </label>
        {hasImpersonate ? (
          <label className="flex items-center gap-1 text-xs text-slate-300">
            Respond as
            <select
              value={asRoleId}
              onChange={(e) => setAsRoleId(e.target.value)}
              disabled={!enabled}
              className="rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-xs text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 disabled:opacity-50"
              title="Creator-only solo-test helper. Submit on behalf of another active role."
            >
              <option value="">{selfLabel ?? "self"} (you)</option>
              {(impersonateOptions ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  {/* Off-turn proxy lands as an interjection (sidebar
                      comment); call that out plainly so a creator
                      doesn't think they're submitting a turn answer
                      under the role's name. Issue #80. */}
                  {o.label}
                  {o.offTurn ? " — sidebar (off-turn)" : " (proxy)"}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {asRoleId ? (() => {
        // Loud impersonation banner so a creator who picked "as: SOC" but
        // then types fast can't miss that they're about to post under
        // someone else's name. The submit button colour shifts to amber
        // for the same reason. The inline "back to me" button is the
        // user-agent's MEDIUM ask: switching out of proxy mode shouldn't
        // require reopening the dropdown.
        //
        // Issue #80: when the selected role is off-turn the wording
        // shifts from "(proxy)" to "(sidebar — not a turn answer)" so
        // the creator knows the submission won't count as the role's
        // turn answer.
        const selected = (impersonateOptions ?? []).find(
          (o) => o.id === asRoleId,
        );
        const offTurn = Boolean(selected?.offTurn);
        return (
          <div
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-600/60 bg-amber-950/40 px-2 py-1 text-xs text-amber-100"
            role="status"
            aria-live="polite"
          >
            <span>
              Submitting as{" "}
              <span className="font-semibold">
                {selected?.label ?? asRoleId}
              </span>{" "}
              {offTurn ? "(sidebar — not a turn answer)" : "(proxy)"}
            </span>
            <button
              type="button"
              onClick={() => setAsRoleId("")}
              className="rounded border border-amber-500/60 px-2 py-0.5 text-[11px] font-semibold text-amber-100 hover:bg-amber-900/40"
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
        className={`w-full rounded border ${
          asRoleId ? "border-amber-600/60" : "border-slate-700"
        } bg-slate-900 p-2 text-sm text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 disabled:opacity-50`}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-slate-300">
          <kbd className="rounded border border-slate-600 bg-slate-800 px-1 font-mono text-[10px]">Enter</kbd>{" "}
          to send,{" "}
          <kbd className="rounded border border-slate-600 bg-slate-800 px-1 font-mono text-[10px]">Shift</kbd>+
          <kbd className="rounded border border-slate-600 bg-slate-800 px-1 font-mono text-[10px]">Enter</kbd>{" "}
          for a new line
        </span>
        <button
          type="submit"
          disabled={!enabled || !text.trim()}
          className={`rounded px-3 py-1 text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 disabled:opacity-50 ${
            asRoleId
              ? "bg-amber-600 hover:bg-amber-500 focus-visible:outline-amber-300"
              : "bg-sky-600 hover:bg-sky-500 focus-visible:outline-sky-300"
          }`}
        >
          {(() => {
            if (!asRoleId) return "Submit";
            const selected = (impersonateOptions ?? []).find(
              (o) => o.id === asRoleId,
            );
            return selected?.offTurn ? "Submit (sidebar)" : "Submit (proxy)";
          })()}
        </button>
      </div>
    </form>
  );
}
