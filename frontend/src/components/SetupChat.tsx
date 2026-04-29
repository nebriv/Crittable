import { SetupNoteView } from "../api/client";
import { ChatIndicator } from "./ChatIndicator";

interface Props {
  notes: SetupNoteView[];
  busy?: boolean;
  onPickOption?: (option: string) => void;
}

/**
 * Chat-style render of the setup conversation. Both speakers visible.
 *
 * AI questions land on the left; creator answers on the right. If the AI
 * supplied option chips, the latest message renders them as quick-pick
 * buttons that send the option text as the next reply.
 */
export function SetupChat({ notes, busy, onPickOption }: Props) {
  if (notes.length === 0) {
    return (
      <div className="rounded border border-slate-700 bg-slate-900 p-3 text-xs text-slate-400">
        Setup hasn't started yet — waiting for the AI's first question.
      </div>
    );
  }

  const lastAiNote = [...notes].reverse().find((n) => n.speaker === "ai");

  return (
    <div
      className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto rounded border border-slate-700 bg-slate-900 p-3"
      role="log"
      aria-live="polite"
      aria-relevant="additions"
    >
      {notes.map((n, idx) => {
        const isAi = n.speaker === "ai";
        return (
          <div
            key={`${idx}-${n.ts}`}
            className={`flex ${isAi ? "justify-start" : "justify-end"}`}
          >
            <div
              className={
                "max-w-[85%] rounded-lg px-3 py-2 text-sm " +
                (isAi
                  ? "bg-slate-800 text-slate-100"
                  : "bg-sky-700 text-sky-50")
              }
            >
              <div className="mb-0.5 text-[10px] uppercase tracking-widest opacity-70">
                {isAi ? `AI · ${n.topic ?? "facilitator"}` : "You"}
              </div>
              <p className="whitespace-pre-wrap">{n.content}</p>
              {isAi && idx === notes.length - 1 && n.options && n.options.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {n.options.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      disabled={busy}
                      onClick={() => onPickOption?.(opt)}
                      className="rounded border border-sky-400 bg-slate-900 px-2 py-0.5 text-xs text-sky-200 hover:bg-sky-900/40 disabled:opacity-50"
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
      {busy && lastAiNote ? (
        <div className="flex justify-start">
          <ChatIndicator label="AI Facilitator is typing…" tone="ai" />
        </div>
      ) : null}
    </div>
  );
}
