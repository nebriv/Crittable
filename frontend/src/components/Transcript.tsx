import { MessageView, RoleView } from "../api/client";

interface Props {
  messages: MessageView[];
  roles: RoleView[];
  streamingText?: string;
  /**
   * True when the backend is in AI_PROCESSING (or equivalent) but no streaming
   * chunks have arrived yet. Renders an inline "AI is thinking…" bubble so a
   * scrolled participant doesn't have to look at the StatusBar.
   */
  aiThinking?: boolean;
}

export function Transcript({ messages, roles, streamingText, aiThinking }: Props) {
  const roleById = new Map(roles.map((r) => [r.id, r]));
  return (
    <div
      className="flex flex-col gap-3"
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {messages.map((m) => {
        const role = m.role_id ? roleById.get(m.role_id) : undefined;
        const actor = role
          ? `${role.label}${role.display_name ? ` · ${role.display_name}` : ""}`
          : m.kind.startsWith("ai")
            ? "AI Facilitator"
            : "System";
        const colour =
          m.kind === "critical_inject"
            ? "border-red-500/60 bg-red-950/40"
            : m.kind === "player"
              ? "border-sky-700/40 bg-sky-950/30"
              : m.kind === "system"
                ? "border-slate-700 bg-slate-900/50 text-slate-400"
                : "border-emerald-700/40 bg-emerald-950/30";
        return (
          <article
            key={m.id}
            className={`rounded-md border p-3 ${colour}`}
            data-kind={m.kind}
          >
            <header className="mb-1 flex items-center justify-between text-xs uppercase tracking-wide text-slate-400">
              <span>{actor}</span>
              <span>{new Date(m.ts).toLocaleTimeString()}</span>
            </header>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{m.body}</p>
            {m.tool_name ? (
              <p className="mt-1 text-xs text-slate-400">tool: {m.tool_name}</p>
            ) : null}
          </article>
        );
      })}
      {streamingText ? (
        <article
          className="rounded-md border border-emerald-500/60 bg-emerald-900/30 p-3"
          aria-busy="true"
        >
          <header className="mb-1 text-xs uppercase tracking-wide text-emerald-300">
            AI Facilitator (streaming…)
          </header>
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{streamingText}</p>
        </article>
      ) : aiThinking ? (
        <article
          className="rounded-md border border-emerald-700/40 bg-emerald-950/30 p-3"
          data-kind="ai-thinking"
          aria-busy="true"
        >
          <header className="mb-1 text-xs uppercase tracking-wide text-emerald-300">
            AI Facilitator
          </header>
          <p className="inline-flex items-center gap-2 text-sm text-emerald-200">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 animate-ping rounded-full bg-emerald-400"
            />
            <span className="opacity-90">AI is thinking…</span>
          </p>
        </article>
      ) : null}
    </div>
  );
}
