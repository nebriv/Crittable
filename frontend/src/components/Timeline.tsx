import { MessageView, RoleView } from "../api/client";

interface Props {
  messages: MessageView[];
  roles: RoleView[];
}

/**
 * Right-sidebar overview/timeline. Picks "key information" out of the chat
 * stream so a player can scan the major beats without re-reading the full
 * transcript:
 *
 *  - critical_inject  — breaking-news beats
 *  - inject_event     — routine new developments narrated by the AI
 *  - broadcast        — AI-wide announcements
 *  - request_artifact — explicit deliverable asks
 *  - state-change     — system messages about session lifecycle
 *
 * Plain chat lines and player submissions are intentionally excluded — the
 * Transcript already covers those. The point of the timeline is signal, not
 * the full chat noise.
 */
export function Timeline({ messages, roles }: Props) {
  const roleLabel = (rid: string | null) =>
    rid ? roles.find((r) => r.id === rid)?.label ?? rid : "AI";

  const items = messages.filter((m) => {
    if (m.kind === "critical_inject") return true;
    if (m.kind === "system") return true;
    if (m.tool_name && ["broadcast", "inject_event", "request_artifact"].includes(m.tool_name)) {
      return true;
    }
    return false;
  });

  return (
    <section
      aria-labelledby="timeline-heading"
      className="flex min-h-0 flex-col gap-2 rounded border border-slate-700 bg-slate-900 p-3 text-sm"
    >
      <h3 id="timeline-heading" className="text-xs uppercase tracking-widest text-slate-300">
        Timeline
      </h3>
      {items.length === 0 ? (
        <p className="text-xs text-slate-400">
          Major beats will appear here as the exercise unfolds.
        </p>
      ) : (
        <ol className="flex flex-col gap-2 overflow-y-auto pr-1">
          {items.map((m) => {
            const tone =
              m.kind === "critical_inject"
                ? "border-red-500/60 bg-red-950/40"
                : m.tool_name === "broadcast"
                  ? "border-emerald-700/40 bg-emerald-950/30"
                  : m.tool_name === "inject_event"
                    ? "border-amber-600/40 bg-amber-950/30"
                    : m.tool_name === "request_artifact"
                      ? "border-sky-700/40 bg-sky-950/30"
                      : "border-slate-700 bg-slate-950";
            const tag =
              m.kind === "critical_inject"
                ? "Critical"
                : m.tool_name === "broadcast"
                  ? "Broadcast"
                  : m.tool_name === "inject_event"
                    ? "Event"
                    : m.tool_name === "request_artifact"
                      ? "Artifact ask"
                      : "System";
            const ts = new Date(m.ts).toLocaleTimeString();
            return (
              <li
                key={m.id}
                className={`rounded border px-2 py-1.5 ${tone}`}
              >
                <header className="flex items-center justify-between text-[10px] uppercase tracking-widest text-slate-300">
                  <span>{tag}</span>
                  <span>{ts}</span>
                </header>
                <p className="mt-0.5 text-xs text-slate-100">{m.body}</p>
                {m.role_id ? (
                  <p className="mt-0.5 text-[10px] text-slate-400">
                    addressed to {roleLabel(m.role_id)}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
