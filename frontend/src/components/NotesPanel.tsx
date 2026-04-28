import { useEffect, useRef, useState } from "react";

interface Props {
  /** Used to namespace localStorage so each session+role has its own notepad. */
  storageKey: string;
  /** Heading shown above the textarea. */
  heading?: string;
  /** Hint shown when empty. */
  placeholder?: string;
}

/**
 * Per-player private notes. Persisted to ``localStorage`` only — never
 * leaves the browser, so a player can jot down decisions / open questions
 * / follow-ups without leaking them to the rest of the session.
 *
 * Phase 3 will likely add a "share with the team" toggle that posts the
 * snippet into the chat as a player message; for now this is a private
 * scratchpad.
 */
export function NotesPanel({ storageKey, heading = "Notes & follow-ups", placeholder }: Props) {
  const [text, setText] = useState<string>(() => {
    try {
      return window.localStorage.getItem(storageKey) ?? "";
    } catch {
      return "";
    }
  });
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced persist: 400ms after the last keystroke.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      try {
        window.localStorage.setItem(storageKey, text);
        setSavedAt(Date.now());
      } catch {
        /* localStorage may be unavailable / quota'd — silently skip. */
      }
    }, 400);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [text, storageKey]);

  return (
    <section
      aria-labelledby="notes-heading"
      className="flex min-h-0 flex-col gap-2 rounded border border-slate-700 bg-slate-900 p-3 text-sm"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="notes-heading" className="text-xs uppercase tracking-widest text-slate-300">
          {heading}
        </h3>
        <span className="flex items-center gap-2">
          <span
            className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200"
            title="These notes never leave your browser. Clearing site data deletes them."
          >
            Local only
          </span>
          {savedAt ? (
            <span className="text-[10px] text-slate-500" aria-live="polite">
              Saved {new Date(savedAt).toLocaleTimeString()}
            </span>
          ) : null}
        </span>
      </header>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        placeholder={placeholder ?? "Decisions, open questions, follow-ups…"}
        className="min-h-[8rem] resize-y rounded border border-slate-700 bg-slate-950 p-2 text-sm text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
      />
    </section>
  );
}
