/**
 * Unified chat typing indicator. Three bouncing dots + a label.
 *
 * Used both for the AI ("AI is thinking…", "AI is typing…") and for human
 * players ("Alice is typing…"). Keeps the visual language consistent so a
 * participant who sees the indicator instantly knows what it means
 * regardless of who is producing it.
 *
 * ``silent`` drops ``role="status"`` + ``aria-live="polite"`` from the
 * wrapper. Used by callers that already nest the indicator inside an
 * ARIA live region (e.g. Transcript's ``role="log"``); without this
 * opt-out the nested live regions get double-announced by NVDA
 * (UI/UX review HIGH H-1).
 */
interface Props {
  label: string;
  tone?: "ai" | "player";
  silent?: boolean;
}

export function ChatIndicator({ label, tone = "ai", silent = false }: Props) {
  const colour =
    tone === "ai"
      ? "border border-signal-deep bg-signal-tint text-signal"
      : "border border-info bg-info-bg text-info";
  const dotColour = tone === "ai" ? "bg-signal" : "bg-info";
  // ``max-w-full break-words`` so a long multi-typer label
  // ("SOC Analyst · Bridget, Legal · Marcus and Comms · Pat are
  //  typing…") wraps inside a narrow column instead of pushing
  // the parent flex column wider and producing horizontal scroll
  // on mobile (UI/UX review BLOCK B-2).
  const ariaProps = silent ? {} : { role: "status", "aria-live": "polite" as const };
  return (
    <div
      {...ariaProps}
      className={`mono inline-flex max-w-full items-center gap-2 break-words rounded-r-1 px-3 py-1.5 text-[11px] uppercase tracking-[0.10em] ${colour}`}
    >
      <span aria-hidden="true" className="inline-flex shrink-0 gap-0.5">
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
