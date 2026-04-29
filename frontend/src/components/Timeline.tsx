import { useState } from "react";
import { MessageView, RoleView } from "../api/client";

interface Props {
  messages: MessageView[];
  roles: RoleView[];
}

interface TimelineEntry {
  id: string;
  ts: string;
  tag: "Critical" | "Pinned" | "Lifecycle";
  title: string;
  body: string;
  tone: string;
}

/**
 * Right-sidebar overview/timeline. Highlights *only* the key beats of the
 * exercise — not a firehose of every AI broadcast. Three categories:
 *
 *  - **Critical** — ``critical_inject`` messages (urgent injects).
 *  - **Pinned**   — ``mark_timeline_point`` calls, the AI's explicit "this
 *                   moment matters" signal.
 *  - **Lifecycle** — session start / end / force-advance system notes.
 *
 * Routine ``broadcast`` / ``inject_event`` / ``request_artifact`` calls
 * intentionally do NOT appear here; they would drown out the signal.
 *
 * Each entry is a button — clicking scrolls the transcript to the originating
 * message bubble (which has ``id="msg-{id}"``).
 */
export function Timeline({ messages, roles: _roles }: Props) {
  // ``_roles`` kept in the prop signature so the parent doesn't need to
  // change; the timeline currently doesn't render role labels because the
  // entries are already attributed in the AI's title.
  void _roles;

  const items: TimelineEntry[] = [];
  for (const m of messages) {
    if (m.kind === "critical_inject") {
      const headline = (m.tool_args?.headline as string | undefined)?.trim();
      items.push({
        id: m.id,
        ts: new Date(m.ts).toLocaleTimeString(),
        tag: "Critical",
        title: headline || "Critical event",
        body: m.body,
        tone: "border-red-500/60 bg-red-950/40",
      });
      continue;
    }
    if (m.tool_name === "mark_timeline_point") {
      const title = (m.tool_args?.title as string | undefined)?.trim();
      items.push({
        id: m.id,
        ts: new Date(m.ts).toLocaleTimeString(),
        tag: "Pinned",
        title: title || "Pinned moment",
        body: m.body,
        tone: "border-violet-600/50 bg-violet-950/30",
      });
      continue;
    }
    if (m.kind === "system") {
      // Only major lifecycle beats — session start/end + force-advance.
      const body = m.body.toLowerCase();
      if (
        body.includes("session ended")
        || body.includes("session started")
        || body.includes("force-advanced")
      ) {
        items.push({
          id: m.id,
          ts: new Date(m.ts).toLocaleTimeString(),
          tag: "Lifecycle",
          title: body.includes("ended")
            ? "Session ended"
            : body.includes("force-advanced")
              ? "Force-advanced"
              : "Session started",
          body: m.body,
          tone: "border-slate-600 bg-slate-950",
        });
      }
    }
  }

  // State-driven highlight: imperative ``classList`` mutations are stripped
  // by React on the next re-render of the target bubble. Toggle a
  // ``data-flash`` attribute via state instead so the ring survives until
  // the timer clears it.
  const [flashing, setFlashing] = useState<string | null>(null);

  function scrollTo(id: string) {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    setFlashing(id);
    el.setAttribute("data-flash", "1");
    setTimeout(() => {
      el.removeAttribute("data-flash");
      setFlashing((cur) => (cur === id ? null : cur));
    }, 1400);
  }
  void flashing;

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
          Key beats will appear here as the AI pins them.
        </p>
      ) : (
        <ol className="flex flex-col gap-2 overflow-y-auto pr-1">
          {items.map((it) => (
            <li key={it.id} className={`rounded border ${it.tone}`}>
              <button
                type="button"
                onClick={() => scrollTo(it.id)}
                aria-label={`Jump to ${it.title} in the transcript`}
                className="flex w-full flex-col gap-0.5 px-2 py-1.5 text-left hover:bg-slate-800/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-amber-300"
                title="Click to scroll the transcript to this moment."
              >
                <header className="flex items-center justify-between text-[10px] uppercase tracking-widest text-slate-300">
                  <span>{it.tag}</span>
                  <span>{it.ts}</span>
                </header>
                <p className="text-xs font-semibold text-slate-50">{it.title}</p>
                {it.body && it.body !== it.title ? (
                  <p className="line-clamp-2 text-[11px] text-slate-300">{it.body}</p>
                ) : null}
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
