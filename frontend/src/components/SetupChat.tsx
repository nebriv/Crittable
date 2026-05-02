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
      <div className="mono rounded-r-3 border border-ink-600 bg-ink-850 p-3 text-[11px] uppercase tracking-[0.06em] text-ink-400">
        Setup hasn't started yet — waiting for the AI's first question.
      </div>
    );
  }

  const lastAiNote = [...notes].reverse().find((n) => n.speaker === "ai");

  return (
    <div
      className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto rounded-r-3 border border-ink-600 bg-ink-850 p-3"
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
                "max-w-[85%] rounded-r-2 px-3 py-2 text-sm border " +
                (isAi
                  ? "border-ink-600 border-l-2 border-l-signal bg-ink-800 text-ink-100"
                  : "border-signal-deep bg-signal-tint text-ink-050")
              }
            >
              <div className="mono mb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-signal opacity-90">
                {isAi ? `AI · ${(n.topic ?? "facilitator").toUpperCase()}` : "YOU"}
              </div>
              <p className="whitespace-pre-wrap text-ink-100">{n.content}</p>
              {isAi && idx === notes.length - 1 && n.options && n.options.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {n.options.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      disabled={busy}
                      onClick={() => onPickOption?.(opt)}
                      className="mono rounded-r-1 border border-signal-deep bg-signal-tint px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.10em] text-signal hover:bg-signal/20 disabled:opacity-50"
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
