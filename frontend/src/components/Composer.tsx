import { FormEvent, useState } from "react";

interface Props {
  enabled: boolean;
  placeholder: string;
  onSubmit: (text: string) => void;
}

export function Composer({ enabled, placeholder, onSubmit }: Props) {
  const [text, setText] = useState("");

  function handle(e: FormEvent) {
    e.preventDefault();
    if (!enabled || !text.trim()) return;
    onSubmit(text.trim());
    setText("");
  }

  return (
    <form onSubmit={handle} className="flex flex-col gap-2">
      <label className="text-xs uppercase tracking-widest text-slate-400" htmlFor="composer">
        Your turn
      </label>
      <textarea
        id="composer"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        disabled={!enabled}
        rows={3}
        className="w-full rounded border border-slate-700 bg-slate-900 p-2 text-sm text-slate-100 disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={!enabled || !text.trim()}
        className="self-end rounded bg-sky-600 px-3 py-1 text-sm font-semibold text-white disabled:opacity-50"
      >
        Submit
      </button>
    </form>
  );
}
