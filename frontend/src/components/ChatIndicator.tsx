/**
 * Unified chat typing indicator. Three bouncing dots + a label.
 *
 * Used both for the AI ("AI is thinking…", "AI is typing…") and for human
 * players ("Alice is typing…"). Keeps the visual language consistent so a
 * participant who sees the indicator instantly knows what it means
 * regardless of who is producing it.
 */
interface Props {
  label: string;
  tone?: "ai" | "player";
}

export function ChatIndicator({ label, tone = "ai" }: Props) {
  const colour =
    tone === "ai"
      ? "border-emerald-700/40 bg-emerald-950/40 text-emerald-200"
      : "border-sky-700/40 bg-sky-950/40 text-sky-200";
  const dotColour = tone === "ai" ? "bg-emerald-400" : "bg-sky-400";
  return (
    <div
      role="status"
      aria-live="polite"
      className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs ${colour}`}
    >
      <span aria-hidden="true" className="inline-flex gap-0.5">
        <span
          className={`inline-block h-1.5 w-1.5 animate-bounce rounded-full ${dotColour}`}
          style={{ animationDelay: "0ms" }}
        />
        <span
          className={`inline-block h-1.5 w-1.5 animate-bounce rounded-full ${dotColour}`}
          style={{ animationDelay: "150ms" }}
        />
        <span
          className={`inline-block h-1.5 w-1.5 animate-bounce rounded-full ${dotColour}`}
          style={{ animationDelay: "300ms" }}
        />
      </span>
      <span>{label}</span>
    </div>
  );
}
