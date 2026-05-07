import { useEffect, useRef } from "react";
import { SetupNoteView } from "../api/client";
import { ChatIndicator } from "./ChatIndicator";

interface Props {
  notes: SetupNoteView[];
  /** Operation in flight — disables the quick-pick option chips on
   *  the latest AI question so the operator can't dispatch a second
   *  ``api.setupReply()`` while one is already running. Decoupled
   *  from the typing-indicator visibility (see ``aiTyping``) so a
   *  consumer can show its own prominent wait state without also
   *  re-enabling chip clicks (PR #186 review: that combination was a
   *  concurrency bug). */
  busy?: boolean;
  /** Show the small "AI Facilitator is typing…" bouncing dots inside
   *  the chat region. Distinct from ``busy``: the consumer may want
   *  to suppress the dots while a more prominent banner is the
   *  dominant indicator (e.g. SetupView's drafting-plan banner). */
  aiTyping?: boolean;
  onPickOption?: (option: string) => void;
}

/**
 * Chat-style render of the setup conversation. Both speakers visible.
 *
 * AI questions land on the left; creator answers on the right. If the AI
 * supplied option chips, the latest message renders them as quick-pick
 * buttons that send the option text as the next reply.
 */
export function SetupChat({ notes, busy, aiTyping, onPickOption }: Props) {
  // Auto-scroll the chat region to the bottom whenever a new note
  // arrives or the typing indicator flips on — but only when the
  // operator is already near the bottom. Without the near-bottom
  // gate, an operator who scrolls up to re-read a clarifying
  // question gets yanked back to the bottom on every WS event
  // (canonical chat anti-pattern). ``scrollHeight`` is read *after*
  // the current commit so the new note's height is included.
  //
  // The gate's threshold (80px) lines up with the standard
  // "auto-pin if within ~one message of the bottom" pattern used
  // in Slack / Discord; per-pixel exactness isn't important
  // because the threshold is checked against the OLD
  // scrollHeight, not the new one. We capture ``wasNearBottom``
  // *before* layout has reconciled the new note into the DOM
  // (the effect runs in the commit phase, after React's
  // virtual-dom diff but before the browser repaints) so the
  // measurement reflects whether the user was at the bottom
  // immediately prior to this update.
  const NEAR_BOTTOM_PX = 80;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wasNearBottomRef = useRef(true);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (wasNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [notes.length, aiTyping]);
  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    wasNearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  };

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
      ref={containerRef}
      onScroll={handleScroll}
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
      {aiTyping && lastAiNote ? (
        <div className="flex justify-start">
          <ChatIndicator label="AI Facilitator is typing…" tone="ai" />
        </div>
      ) : null}
    </div>
  );
}
