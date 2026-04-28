import { MessageView, RoleView } from "../api/client";

interface Props {
  messages: MessageView[];
  roles: RoleView[];
  streamingText?: string;
}

export function Transcript({ messages, roles, streamingText }: Props) {
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
        <article className="rounded-md border border-emerald-500/60 bg-emerald-900/30 p-3" aria-live="polite">
          <header className="mb-1 text-xs uppercase tracking-wide text-emerald-300">AI Facilitator (streaming…)</header>
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{streamingText}</p>
        </article>
      ) : null}
    </div>
  );
}
