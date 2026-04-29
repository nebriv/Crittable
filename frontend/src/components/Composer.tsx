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
}

export function Composer({
  enabled,
  placeholder,
  onSubmit,
  onTypingChange,
  impersonateOptions,
  selfLabel,
}: Props) {
  const [text, setText] = useState("");
  // Empty string == speak as the local participant. Anything else is a
  // role_id passed up to the parent for proxy submission.
  const [asRoleId, setAsRoleId] = useState<string>("");
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTyping = useRef(false);

  function handle(e: FormEvent) {
    e.preventDefault();
    if (!enabled || !text.trim()) return;
    onSubmit(text.trim(), asRoleId || undefined);
    setText("");
    if (isTyping.current) {
      isTyping.current = false;
      onTypingChange?.(false);
    }
  }

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
          <label className="flex items-center gap-1 text-[11px] text-slate-400">
            Respond as
            <select
              value={asRoleId}
              onChange={(e) => setAsRoleId(e.target.value)}
              disabled={!enabled}
              className="rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-[11px] text-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 disabled:opacity-50"
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
      <textarea
        id="composer"
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={placeholder}
        disabled={!enabled}
        rows={3}
        className="w-full rounded border border-slate-700 bg-slate-900 p-2 text-sm text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={!enabled || !text.trim()}
        className="self-end rounded bg-sky-600 px-3 py-1 text-sm font-semibold text-white hover:bg-sky-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 disabled:opacity-50"
      >
        Submit{asRoleId ? " (proxy)" : ""}
      </button>
    </form>
  );
}
