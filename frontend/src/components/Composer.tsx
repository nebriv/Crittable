import { FormEvent, useEffect, useRef, useState } from "react";

interface Props {
  enabled: boolean;
  placeholder: string;
  onSubmit: (text: string) => void;
  /** Optional callback fired on debounced typing start/stop transitions. */
  onTypingChange?: (typing: boolean) => void;
}

export function Composer({ enabled, placeholder, onSubmit, onTypingChange }: Props) {
  const [text, setText] = useState("");
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTyping = useRef(false);

  function handle(e: FormEvent) {
    e.preventDefault();
    if (!enabled || !text.trim()) return;
    onSubmit(text.trim());
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

  return (
    <form onSubmit={handle} className="flex flex-col gap-2">
      <label className="text-xs uppercase tracking-widest text-slate-400" htmlFor="composer">
        Your turn
      </label>
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
        Submit
      </button>
    </form>
  );
}
