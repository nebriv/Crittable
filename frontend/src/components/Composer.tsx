import { FormEvent, useEffect, useRef, useState } from "react";

interface ImpersonateOption {
  /** Role-id to submit as. */
  id: string;
  /** Visible label, e.g. "SOC Analyst". */
  label: string;
}

interface Props {
  enabled: boolean;
  placeholder: string;
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
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTyping = useRef(false);
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

  function handleChange(value: string) {
    setText(value);
    if (!enabled || !onTypingChange) return;
    if (!isTyping.current) {
      isTyping.current = true;
      onTypingChange(true);
    }
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      isTyping.current = false;
      onTypingChange(false);
    }, 1500);
  }

  useEffect(() => {
    return () => {
      if (typingTimer.current) clearTimeout(typingTimer.current);
      if (isTyping.current && onTypingChange) {
        isTyping.current = false;
        onTypingChange(false);
      }
    };
  }, [onTypingChange]);

  const hasImpersonate = (impersonateOptions?.length ?? 0) > 0;

  return (
    <form onSubmit={handle} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <label
          className="text-xs uppercase tracking-widest text-slate-400"
          htmlFor="composer"
        >
          Your turn
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
                  {o.label} (proxy)
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {asRoleId ? (
        // Loud impersonation banner so a creator who picked "as: SOC" but
        // then types fast can't miss that they're about to post under
        // someone else's name. The submit button colour shifts to amber
        // for the same reason. The inline "back to me" button is the
        // user-agent's MEDIUM ask: switching out of proxy mode shouldn't
        // require reopening the dropdown.
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-600/60 bg-amber-950/40 px-2 py-1 text-xs text-amber-100"
          role="status"
          aria-live="polite"
        >
          <span>
            Submitting as{" "}
            <span className="font-semibold">
              {(impersonateOptions ?? []).find((o) => o.id === asRoleId)?.label ?? asRoleId}
            </span>{" "}
            (proxy)
          </span>
          <button
            type="button"
            onClick={() => setAsRoleId("")}
            className="rounded border border-amber-500/60 px-2 py-0.5 text-[11px] font-semibold text-amber-100 hover:bg-amber-900/40"
          >
            Back to {selfLabel ?? "me"}
          </button>
        </div>
      ) : null}
      <textarea
        id="composer"
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={placeholder}
        disabled={!enabled}
        rows={3}
        className={`w-full rounded border ${
          asRoleId ? "border-amber-600/60" : "border-slate-700"
        } bg-slate-900 p-2 text-sm text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 disabled:opacity-50`}
      />
      <button
        type="submit"
        disabled={!enabled || !text.trim()}
        className={`self-end rounded px-3 py-1 text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 disabled:opacity-50 ${
          asRoleId
            ? "bg-amber-600 hover:bg-amber-500 focus-visible:outline-amber-300"
            : "bg-sky-600 hover:bg-sky-500 focus-visible:outline-sky-300"
        }`}
      >
        Submit{asRoleId ? " (proxy)" : ""}
      </button>
    </form>
  );
}
