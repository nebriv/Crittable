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
  // Idle timer fires ``typing_stop`` after the user has been idle long
  // enough that the indicator should disappear. Pending-start timer waits
  // until the user has been typing continuously for a couple of seconds
  // before announcing — without the delay the indicator flashes on every
  // single keystroke and creates the "blinking screen" pattern reported
  // in issue #53.
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingStartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTyping = useRef(false);
  // Debounce config. The thresholds are intentionally separated so a
  // user who pauses to think briefly (~1s) doesn't churn start/stop.
  const TYPING_START_DELAY_MS = 1500;
  const TYPING_IDLE_MS = 3500;
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
    if (pendingStartTimer.current) {
      clearTimeout(pendingStartTimer.current);
      pendingStartTimer.current = null;
    }
    if (idleTimer.current) {
      clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
    if (isTyping.current) {
      isTyping.current = false;
      onTypingChange?.(false);
    }
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

  function handleChange(value: string) {
    setText(value);
    if (!enabled || !onTypingChange) return;
    // If the textarea is now empty (e.g. user cleared with backspace),
    // tear down the timers and emit a stop if needed. Holding "typing"
    // on an empty composer is misleading.
    if (!value.trim()) {
      if (pendingStartTimer.current) {
        clearTimeout(pendingStartTimer.current);
        pendingStartTimer.current = null;
      }
      if (idleTimer.current) {
        clearTimeout(idleTimer.current);
        idleTimer.current = null;
      }
      if (isTyping.current) {
        isTyping.current = false;
        onTypingChange(false);
      }
      return;
    }
    // Start path: don't broadcast immediately. Schedule a delayed
    // ``typing_start`` so a user who types one character and stops
    // never lights up the indicator.
    if (!isTyping.current && !pendingStartTimer.current) {
      pendingStartTimer.current = setTimeout(() => {
        pendingStartTimer.current = null;
        // Re-check enabled — the turn may have flipped while we waited.
        if (!enabled) return;
        isTyping.current = true;
        onTypingChange?.(true);
      }, TYPING_START_DELAY_MS);
    }
    // Refresh the idle timer on every keystroke. When it fires we emit
    // ``typing_stop`` and cancel any pending start so a buffered start
    // can't sneak through after we've already gone quiet.
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      idleTimer.current = null;
      if (pendingStartTimer.current) {
        clearTimeout(pendingStartTimer.current);
        pendingStartTimer.current = null;
      }
      if (isTyping.current) {
        isTyping.current = false;
        onTypingChange?.(false);
      }
    }, TYPING_IDLE_MS);
  }

  useEffect(() => {
    return () => {
      if (pendingStartTimer.current) clearTimeout(pendingStartTimer.current);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      if (isTyping.current && onTypingChange) {
        isTyping.current = false;
        onTypingChange(false);
      }
    };
  }, [onTypingChange]);

  // When the turn ends mid-typing burst the composer goes ``disabled``
  // but the timers are still in flight. Without this hook the indicator
  // would linger on other clients for up to TYPING_IDLE_MS after the
  // turn flipped, falsely suggesting we're still composing.
  useEffect(() => {
    if (enabled) return;
    if (pendingStartTimer.current) {
      clearTimeout(pendingStartTimer.current);
      pendingStartTimer.current = null;
    }
    if (idleTimer.current) {
      clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
    if (isTyping.current) {
      isTyping.current = false;
      onTypingChange?.(false);
    }
  }, [enabled, onTypingChange]);

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
