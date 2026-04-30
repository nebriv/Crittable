import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MessageView, RoleView } from "../api/client";
import { ChatIndicator } from "./ChatIndicator";
import { TableScroll } from "./TableScroll";

interface Props {
  messages: MessageView[];
  roles: RoleView[];
  /**
   * Live AI text streaming: previously this prop fed a green
   * "AI Facilitator (streaming…)" bubble that rendered the
   * concatenated chunk deltas as they arrived. The bubble was visible
   * to players, but the final ``message_complete`` payload sometimes
   * diverged from the chunk concatenation (the model writes a short
   * rationale then a separate broadcast; chunk text is the rationale,
   * final body is the broadcast). Players read that as the AI
   * silently rewriting its answer mid-flight, which is a trust hit.
   *
   * The prop is now intentionally ignored at render time: chunks
   * trigger the typing indicator (via ``aiThinking``) but never paint
   * partial body text. Kept for backwards compat with the facilitator
   * tab during the transition; will be removed once both call-sites
   * stop passing it.
   */
  streamingText?: string;
  /**
   * True when the backend is doing AI work (any tier — play, interject,
   * setup, briefing, AAR, guardrail). Renders an inline
   * "AI Facilitator is typing…" indicator so a scrolled participant
   * doesn't have to look at the StatusBar.
   */
  aiThinking?: boolean;
  /**
   * Optional human-readable label appended to the thinking indicator,
   * e.g. ``"Recovery pass 2/3 (missing yield)"`` or
   * ``"Replying to SOC Analyst"``. Lets the operator distinguish
   * "thinking" from "stuck" during the play-tier strict-retry loop and
   * surfaces what the AI is doing during otherwise opaque side-channel
   * paths like ``run_interject``.
   */
  aiStatusLabel?: string;
  /** role_ids of human players currently typing (excluding the local user). */
  typingRoleIds?: string[];
  /**
   * When true, the most recent AI bubble is rendered with an amber
   * focus ring so a player who's now active can spot the message they
   * need to respond to without scrolling. Pairs with the
   * "Awaiting your response" chip near the composer; the two cues
   * together mean a non-addressed-but-still-active role can't miss
   * that they're being waited on.
   */
  highlightLastAi?: boolean;
}

/**
 * Constrained markdown renderer for AI bubbles. We intentionally allow only
 * inline emphasis + lists + links; headings are flattened (the AI tends to
 * emit ``####`` for tiny call-outs which break visual rhythm in a chat).
 *
 * Rendering happens in-place in the existing bubble — no nested borders, no
 * background tweaks. Lists get a small left indent.
 */
function MarkdownBody({ body }: { body: string }) {
  return (
    <div className="text-sm leading-relaxed">
      <ReactMarkdown
        // Defense in depth: AI-emitted text is untrusted. react-markdown v10
        // already escapes HTML by default, but ``skipHtml`` ensures a future
        // dependency bump or rehype-raw-style plugin can't open an XSS hole.
        skipHtml
        // GFM = tables, strikethrough, autolinks, task lists. The AI emits
        // tables freely (per-role scores etc.) and they were rendering as
        // raw pipe text without this.
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-2 last:mb-0 whitespace-pre-wrap">{children}</p>,
          ul: ({ children }) => <ul className="mb-2 ml-5 list-disc">{children}</ul>,
          ol: ({ children }) => <ol className="mb-2 ml-5 list-decimal">{children}</ol>,
          li: ({ children }) => <li className="mb-0.5">{children}</li>,
          h1: ({ children }) => <p className="mb-2 font-semibold">{children}</p>,
          h2: ({ children }) => <p className="mb-2 font-semibold">{children}</p>,
          h3: ({ children }) => <p className="mb-1 font-semibold">{children}</p>,
          h4: ({ children }) => <p className="mb-1 font-semibold">{children}</p>,
          h5: ({ children }) => <p className="mb-1 font-semibold">{children}</p>,
          h6: ({ children }) => <p className="mb-1 font-semibold">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          del: ({ children }) => <del className="text-slate-400 line-through">{children}</del>,
          blockquote: ({ children }) => (
            <blockquote className="mb-2 border-l-4 border-slate-700 pl-2 italic text-slate-300">
              {children}
            </blockquote>
          ),
          code: ({ children }) => (
            <code className="rounded bg-slate-800 px-1 py-0.5 text-[0.85em]">{children}</code>
          ),
          pre: ({ children }) => (
            <pre className="mb-2 overflow-auto rounded bg-slate-950 p-2 text-[0.85em]">
              {children}
            </pre>
          ),
          hr: () => <hr className="my-2 border-slate-700" />,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-sky-300 underline"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <TableScroll>
              <table className="min-w-full border-collapse text-xs">{children}</table>
            </TableScroll>
          ),
          thead: ({ children }) => <thead className="bg-slate-900/60">{children}</thead>,
          tr: ({ children }) => <tr className="border-b border-slate-800">{children}</tr>,
          th: ({ children }) => (
            <th className="border border-slate-700 px-2 py-1 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-slate-800 px-2 py-1 align-top">{children}</td>
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

export function Transcript({
  messages,
  roles,
  // streamingText is intentionally not destructured — see the prop
  // docstring. We accept it so existing callers don't break, but we
  // never render partial chunk text.
  aiThinking,
  aiStatusLabel,
  typingRoleIds,
  highlightLastAi,
}: Props) {
  const roleById = new Map(roles.map((r) => [r.id, r]));
  // Find the index of the latest AI-authored bubble (ai_text or
  // critical_inject). Only that one gets the focus ring; an older AI
  // message in the transcript stays visually neutral.
  let lastAiIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const k = messages[i].kind;
    if (k === "ai_text" || k === "critical_inject") {
      lastAiIndex = i;
      break;
    }
  }
  const typing = (typingRoleIds ?? []).flatMap((id) => {
    const r = roleById.get(id);
    return r ? [`${r.label}${r.display_name ? ` · ${r.display_name}` : ""}`] : [];
  });
  const typingLabel =
    typing.length === 0
      ? null
      : typing.length === 1
        ? `${typing[0]} is typing…`
        : typing.length === 2
          ? `${typing[0]} and ${typing[1]} are typing…`
          : `${typing[0]}, ${typing[1]} and ${typing.length - 2} more are typing…`;
  return (
    <div
      className="flex flex-col gap-3"
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {messages.map((m, idx) => {
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
        // AI bubbles render markdown (the model prefers it for emphasis +
        // lists). Everything else stays as plain text — players type prose,
        // system notes are pre-formatted.
        const isAi = m.kind === "ai_text" || m.kind === "critical_inject";
        // Amber focus ring on the latest AI bubble when this viewer is
        // the active responder. Pairs with the "Awaiting your response"
        // chip near the composer (Play.tsx). Critical-inject bubbles
        // already have their own red emphasis so we skip the ring there
        // to avoid double-glow noise.
        const focusRing =
          highlightLastAi && idx === lastAiIndex && m.kind === "ai_text"
            ? "ring-2 ring-amber-400/70 ring-offset-1 ring-offset-slate-950 shadow-[0_0_0_2px_rgba(252,211,77,0.15)]"
            : "";
        return (
          <article
            key={m.id}
            id={`msg-${m.id}`}
            className={`scroll-mt-24 min-w-0 break-words rounded-md border p-3 ${colour} ${focusRing}`}
            data-kind={m.kind}
            data-message-id={m.id}
          >
            <header className="mb-1 flex items-center justify-between text-xs uppercase tracking-wide text-slate-400">
              <span>{actor}</span>
              <span>{new Date(m.ts).toLocaleTimeString()}</span>
            </header>
            {isAi ? (
              <MarkdownBody body={m.body} />
            ) : (
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{m.body}</p>
            )}
            {m.tool_name ? (
              <p className="mt-1 text-xs text-slate-400">tool: {m.tool_name}</p>
            ) : null}
          </article>
        );
      })}
      {aiThinking ? (
        <ChatIndicator
          label={
            aiStatusLabel
              ? `AI Facilitator — ${aiStatusLabel}`
              : "AI Facilitator is typing…"
          }
          tone="ai"
        />
      ) : null}
      {typingLabel ? <ChatIndicator label={typingLabel} tone="player" /> : null}
    </div>
  );
}
