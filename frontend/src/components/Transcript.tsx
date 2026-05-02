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
   * Role-id of the local viewer. When set, the viewer's own player
   * bubbles render with a `· YOU` mono suffix and a signal-tinted
   * background mirroring the brand mock's <PlayerBubble you /> variant
   * — easier to find your own posts when scanning a long transcript.
   * Optional: callers that don't have a self-role concept (e.g. a
   * read-only spectator) can omit it; the column simply won't appear.
   */
  selfRoleId?: string | null;
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
 * Derive the short uppercase badge text for a role. The brand mock uses
 * 3-4 char codes (CSM, CSE, IC, COM); this app stores arbitrary role
 * labels (CISO, IR Lead, SOC Analyst, …). Take the first whitespace-
 * separated token, uppercase it, and clamp to 4 chars so it fits the
 * 36 px badge without wrapping. Multi-word labels collapse to the first
 * word's prefix — readable at the cost of some specificity, which the
 * full label in the bubble header restores.
 */
function roleCode(label: string): string {
  const first = label.trim().split(/\s+/)[0] ?? "";
  return first.toUpperCase().slice(0, 4) || "—";
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
          h1: ({ children }) => <p className="mb-2 font-semibold text-ink-050">{children}</p>,
          h2: ({ children }) => <p className="mb-2 font-semibold text-ink-050">{children}</p>,
          h3: ({ children }) => <p className="mb-1 font-semibold text-ink-050">{children}</p>,
          h4: ({ children }) => <p className="mb-1 font-semibold text-ink-050">{children}</p>,
          h5: ({ children }) => <p className="mb-1 font-semibold text-ink-050">{children}</p>,
          h6: ({ children }) => <p className="mb-1 font-semibold text-ink-050">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-ink-050">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          del: ({ children }) => <del className="text-ink-400 line-through">{children}</del>,
          blockquote: ({ children }) => (
            <blockquote className="mb-2 border-l-2 border-signal pl-3 italic text-ink-300">
              {children}
            </blockquote>
          ),
          code: ({ children }) => (
            <code className="mono rounded-r-1 bg-ink-850 px-1 py-0.5 text-[0.85em] text-signal">{children}</code>
          ),
          pre: ({ children }) => (
            <pre className="mono mb-2 overflow-auto rounded-r-2 border border-ink-600 bg-ink-950 p-3 text-[0.85em] text-ink-100">
              {children}
            </pre>
          ),
          hr: () => <hr className="my-2 border-dashed border-ink-600" />,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-signal underline hover:text-signal-bright"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <TableScroll>
              <table className="min-w-full border-collapse text-xs">{children}</table>
            </TableScroll>
          ),
          thead: ({ children }) => <thead className="bg-ink-850">{children}</thead>,
          tr: ({ children }) => <tr className="border-b border-ink-700">{children}</tr>,
          th: ({ children }) => (
            <th className="mono border border-ink-600 px-2 py-1 text-left text-[10px] font-bold uppercase tracking-[0.10em] text-ink-200">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-ink-700 px-2 py-1 align-top">{children}</td>
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
  selfRoleId,
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
  // Issue #77 multi-typer aggregation. Prior implementation
  // collapsed everything ≥3 into "X, Y and N more"; the new spec
  // names exactly three when there are three (avoids the awkward
  // "X, Y and 1 more"), and at ≥4 collapses to a neutral catch-
  // all so the indicator doesn't grow unboundedly during a
  // synchronous flurry. The catch-all copy was originally
  // "Everyone is hammering away at their keyboards…" per the
  // issue body, but the User + UI/UX reviewers flagged it as
  // tonally wrong for tense IR scenarios — switched to
  // "All participants are responding…" which is neutral and
  // safe to render mid-incident.
  let typingLabel: string | null = null;
  if (typing.length === 1) {
    typingLabel = `${typing[0]} is typing…`;
  } else if (typing.length === 2) {
    typingLabel = `${typing[0]} and ${typing[1]} are typing…`;
  } else if (typing.length === 3) {
    typingLabel = `${typing[0]}, ${typing[1]} and ${typing[2]} are typing…`;
  } else if (typing.length >= 4) {
    typingLabel = "All participants are responding…";
  }
  return (
    <div
      className="flex flex-col gap-3"
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {messages.map((m, idx) => {
        const role = m.role_id ? roleById.get(m.role_id) : undefined;
        const isAi = m.kind === "ai_text" || m.kind === "critical_inject";
        const isCritical = m.kind === "critical_inject";
        const isSystem = m.kind === "system";
        const isPlayer = m.kind === "player";
        const isInterjection = isPlayer && m.is_interjection;
        const isSelf =
          isPlayer && selfRoleId != null && m.role_id === selfRoleId;
        // ``ring-warn`` highlight on the latest AI bubble when the viewer
        // is the active responder. Critical injects already carry their
        // own crit emphasis, so skip the ring there.
        const focusRing =
          highlightLastAi && idx === lastAiIndex && m.kind === "ai_text"
            ? "ring-2 ring-warn ring-offset-1 ring-offset-ink-900 shadow-[0_0_0_2px_color-mix(in_oklch,var(--warn)_15%,transparent)]"
            : "";
        const ts = new Date(m.ts).toLocaleTimeString();

        if (isSystem) {
          // SystemBeat — center-aligned mono uppercase divider, lifted
          // from app-screens.jsx <SystemBeat>.
          return (
            <article
              key={m.id}
              id={`msg-${m.id}`}
              data-kind={m.kind}
              data-message-id={m.id}
              className="mono scroll-mt-24 select-text border-y border-dashed border-ink-600 px-2 py-1.5 text-center text-[10px] font-bold uppercase tracking-[0.16em] text-ink-400"
            >
              <span className="tabular-nums text-ink-500">
                {ts}
              </span>
              <span className="mx-2 text-ink-600">·</span>
              <span>{m.body}</span>
            </article>
          );
        }

        if (isAi) {
          // AIBubble — left mark avatar (36 px square, signal-deep
          // bordered) + right column with FACILITATOR · TURN N header
          // and a signal-bordered body. Critical injects swap the signal
          // border + dot for crit equivalents.
          const dotColor = isCritical ? "bg-crit" : "bg-signal";
          const labelColor = isCritical ? "text-crit" : "text-signal";
          const borderClass = isCritical
            ? "border border-crit border-l-2 bg-crit-bg"
            : "border border-ink-600 border-l-2 border-l-signal bg-ink-800";
          return (
            <article
              key={m.id}
              id={`msg-${m.id}`}
              data-kind={m.kind}
              data-message-id={m.id}
              className={`scroll-mt-24 flex min-w-0 gap-3 ${focusRing}`}
            >
              <div
                aria-hidden="true"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-r-1 border border-signal-deep bg-ink-800"
              >
                <img
                  src="/logo/svg/mark-encounter-01-dark.svg"
                  alt=""
                  width={26}
                  height={26}
                  // Inline ``style`` rather than the HTML attrs alone:
                  // Tailwind preflight resets ``img { height: auto }``
                  // which overrides the height attribute and forces
                  // the image back to its intrinsic SVG viewBox size.
                  // Inline style wins over preflight specificity-wise.
                  style={{ height: 26, width: 26 }}
                  className="block"
                />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <header className="mono flex items-baseline gap-2 text-[10px] font-bold uppercase tracking-[0.14em]">
                  <span
                    aria-hidden="true"
                    className={`inline-block h-1.5 w-1.5 rounded-full ${dotColor}`}
                  />
                  <span className={`tracking-[0.16em] ${labelColor}`}>
                    {isCritical ? "CRITICAL INJECT" : "AI FACILITATOR"}
                  </span>
                  <span className="ml-auto tabular-nums text-ink-500">
                    {ts}
                  </span>
                </header>
                <div
                  className={`min-w-0 break-words rounded-r-2 px-4 py-3 text-ink-100 ${borderClass}`}
                >
                  <MarkdownBody body={m.body} />
                  {m.tool_name ? (
                    <p className="mono mt-2 text-[10px] uppercase tracking-[0.10em] text-ink-400">
                      tool · {m.tool_name}
                    </p>
                  ) : null}
                </div>
              </div>
            </article>
          );
        }

        // PlayerBubble — right-aligned column with header
        //   `[badge] · ROLE · NAME · YOU` + bubble + right role-code badge
        // (see app-screens.jsx <PlayerBubble>). Self bubbles get the
        // signal-tinted background; interjections get the SIDEBAR badge
        // instead of ✓ SUBMITTED.
        const roleLabel = role?.label ?? "—";
        const code = roleCode(roleLabel);
        const displayName = role?.display_name ?? "";
        const bubbleColour = isSelf
          ? "border border-signal-deep bg-signal-tint"
          : "border border-ink-600 bg-ink-800";
        return (
          <article
            key={m.id}
            id={`msg-${m.id}`}
            data-kind={m.kind}
            data-message-id={m.id}
            className="scroll-mt-24 flex min-w-0 gap-3 pl-6"
          >
            <div className="flex min-w-0 flex-1 flex-col items-end gap-1.5">
              <header className="mono flex flex-wrap items-baseline justify-end gap-2 text-[10px] font-bold uppercase tracking-[0.14em]">
                {isInterjection ? (
                  <span
                    className="mono rounded-r-1 border border-ink-500 bg-ink-700 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.10em] leading-none text-ink-200"
                    title="Posted while not on the active turn — a sidebar comment, not a turn answer."
                  >
                    SIDEBAR
                  </span>
                ) : (
                  <span className="text-signal tracking-[0.16em]">
                    ✓ SUBMITTED
                  </span>
                )}
                <span className="tracking-[0.10em] text-ink-100">
                  {roleLabel}
                </span>
                {displayName ? (
                  <span className="font-semibold tabular-nums text-ink-400">
                    {displayName}
                  </span>
                ) : null}
                {isSelf ? (
                  <span className="text-signal tracking-[0.16em]">
                    · YOU
                  </span>
                ) : null}
                <span className="tabular-nums text-ink-500">{ts}</span>
              </header>
              <div
                className={`min-w-0 break-words rounded-r-2 px-4 py-3 text-left text-sm leading-relaxed text-ink-100 ${bubbleColour}`}
                data-highlightable="true"
                data-message-id={m.id}
                data-message-kind={isPlayer ? "chat" : m.kind === "ai_text" ? "ai" : "system"}
              >
                <p className="whitespace-pre-wrap">{m.body}</p>
                {m.tool_name ? (
                  <p className="mono mt-2 text-[10px] uppercase tracking-[0.10em] text-ink-400">
                    tool · {m.tool_name}
                  </p>
                ) : null}
              </div>
            </div>
            {/* Role-code avatar — fixed 36×36 circle. Distinct geometry
                from the rectangular bubble + ink-700 chips so it reads
                as identity, not a continuation of the message body. */}
            <div
              aria-hidden="true"
              className={`mono flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[10px] font-bold uppercase leading-none tracking-[0.04em] ${
                isSelf
                  ? "border border-signal-deep bg-signal-tint text-signal"
                  : "border border-ink-500 bg-ink-700 text-ink-100"
              }`}
            >
              {code}
            </div>
          </article>
        );
      })}
      {aiThinking ? (
        // ``silent`` because the wrapping <div role="log"
        // aria-live="polite" aria-relevant="additions text"> already
        // announces additions; nesting another aria-live region would
        // double-announce on NVDA (UI/UX review HIGH H-1).
        <ChatIndicator
          label={
            aiStatusLabel
              ? `AI Facilitator — ${aiStatusLabel}`
              : "AI Facilitator is typing…"
          }
          tone="ai"
          silent
        />
      ) : null}
      {typingLabel ? (
        <ChatIndicator label={typingLabel} tone="player" silent />
      ) : null}
    </div>
  );
}
