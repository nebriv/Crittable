import { useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MessageView, RoleView, WorkstreamView } from "../api/client";
import { colorForWorkstream } from "../lib/workstreamPalette";
import { ChatIndicator } from "./ChatIndicator";
import { TableScroll } from "./TableScroll";

interface Props {
  messages: MessageView[];
  roles: RoleView[];
  /**
   * Phase B chat-declutter (docs/plans/chat-decluttering.md §4.7):
   * declared workstreams for this session, in declaration order. The
   * 6-slot color palette is assigned by index here, so the same id
   * resolves to the same stripe color across the filter pills, the
   * track-bar, and the synthetic "track opened" landmark row. Empty
   * list = no categorization (single ``#main`` bucket); messages get
   * the slate-gray stripe but no synthetic rows render. Optional —
   * callers that don't have a session snapshot (e.g. a tests-only
   * harness) can omit it; the transcript falls back to slate.
   */
  workstreams?: WorkstreamView[];
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
   * that they're being waited on. Yellow is reserved for THIS signal —
   * "you owe a turn answer" — so it stays distinct from the
   * signal-blue self/@-mention identity treatment.
   */
  highlightLastAi?: boolean;
  /**
   * Chat-declutter polish: optional contextmenu hook for manual
   * workstream override. Fires on right-click on a message bubble that
   * the viewer is permitted to re-tag — i.e. the creator can
   * right-click any bubble; a player can right-click their own
   * bubbles only. The page wires the open-menu position + the target
   * message; this component just signals the user's intent. ``null``
   * disables the contextmenu entirely (e.g. a non-creator viewer
   * looking at someone else's bubbles).
   */
  onMessageContextMenu?: (args: {
    messageId: string;
    workstreamId: string | null;
    x: number;
    y: number;
  }) => void;
  /**
   * Set of role_ids the viewer authored. Used to gate which player
   * bubbles fire ``onMessageContextMenu`` on right-click. ``null`` =
   * viewer is the creator (every bubble is fair game).
   */
  selfAuthoredRoleIds?: Set<string> | null;
  /**
   * True when the viewer is the session creator. Creator can re-tag
   * any message; non-creator only their own. The combination with
   * ``selfAuthoredRoleIds`` keeps the predicate explicit — the
   * Transcript itself doesn't need a token to make the call.
   */
  viewerIsCreator?: boolean;
}

/**
 * Substantial ``share_data`` calls (logs, IOC tables, telemetry
 * dumps) collapse to a one-line summary card by default — clicking
 * "View details" unfurls the full markdown body. The threshold
 * matches Timeline's `SHARE_DATA_MIN_CHARS` so the same dump that
 * earns a "Data brief" rail pin also earns the chat-collapse: if it's
 * substantial enough to want a re-find affordance, it's substantial
 * enough to clutter the chat firehose at 4-person scale. User
 * feedback: "the transcript moves very quickly when the AI dumps
 * big chunks." Smaller share_data calls (a single telemetry line, a
 * tiny config snippet) render inline as before — collapsing those
 * adds friction without saving real-estate.
 */
const SHARE_DATA_COLLAPSE_CHARS = 300;

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
 * Pick a short preview line for a collapsed share_data card.
 * Walks the body line-by-line, strips leading markdown chrome
 * (heading hashes, bullet markers, surrounding ``**bold**``), skips
 * empty lines, and skips a line that's just the label restated
 * (the AI often emits ``**Label**\n\n…data…`` and the collapsed
 * card already shows the label prominently — re-rendering it as
 * preview is wasted real-estate). Returns the first substantive
 * line, clamped to 140 chars.
 */
function derivePreview(body: string, label: string): string {
  const labelNorm = label.trim().toLowerCase();
  const lines = body.split(/\r?\n/);
  for (const raw of lines) {
    const stripped = raw
      .trim()
      .replace(/^[#>\-*•]+\s*/, "")
      .replace(/^\*\*(.+?)\*\*$/, "$1")
      .trim();
    if (stripped.length === 0) continue;
    if (stripped.toLowerCase() === labelNorm) continue;
    return stripped.length > 140 ? stripped.slice(0, 140).trimEnd() + "…" : stripped;
  }
  return "";
}

/**
 * Phase B chat-declutter — bucket a message timestamp by wall-clock
 * minute. Used by the sticky minute-anchor row so a scrolled-up
 * reader can tell "what time is this" without hunting for a
 * timestamp on every bubble. ``Intl.DateTimeFormat`` so the user's
 * locale picks 12h vs 24h, but we constrain the components to the
 * minute resolution (no seconds).
 */
function minuteKey(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
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
  workstreams,
  // streamingText is intentionally not destructured — see the prop
  // docstring. We accept it so existing callers don't break, but we
  // never render partial chunk text.
  aiThinking,
  aiStatusLabel,
  typingRoleIds,
  highlightLastAi,
  selfRoleId,
  onMessageContextMenu,
  selfAuthoredRoleIds,
  viewerIsCreator,
}: Props) {
  // Tracks which substantial ``share_data`` messages have been
  // expanded by the viewer. Pure render state — not synced to the
  // server, not shared across tabs. Resetting on tab refresh is
  // intentional: the collapse default is the firehose mitigation, so
  // re-loading the page should reset to "all collapsed" and let the
  // viewer choose what to read again. (If we ever want sticky
  // expansion we can persist into localStorage keyed by message id;
  // not worth it until someone asks.)
  const [expandedShareData, setExpandedShareData] = useState<Set<string>>(
    () => new Set(),
  );
  function toggleShareDataExpansion(messageId: string): void {
    setExpandedShareData((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }
  // Build a once-per-render predicate so each bubble can ask "may I
  // open the menu on right-click?" in O(1). Creator can re-tag any
  // message; non-creator only their own. ``onMessageContextMenu``
  // not wired ⇒ predicate falls through to false (menu disabled).
  function canOverride(m: MessageView): boolean {
    if (!onMessageContextMenu) return false;
    if (viewerIsCreator) return true;
    if (m.role_id == null) return false;
    if (!selfAuthoredRoleIds) return false;
    return selfAuthoredRoleIds.has(m.role_id);
  }
  function handleContextMenu(
    e: ReactMouseEvent<HTMLElement>,
    m: MessageView,
  ): void {
    if (!canOverride(m)) return;
    e.preventDefault();
    onMessageContextMenu?.({
      messageId: m.id,
      workstreamId: m.workstream_id,
      x: e.clientX,
      y: e.clientY,
    });
  }
  const roleById = new Map(roles.map((r) => [r.id, r]));
  const declaredOrder = (workstreams ?? []).map((w) => w.id);
  const workstreamLabelById = new Map(
    (workstreams ?? []).map((w) => [w.id, w.label]),
  );
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
  // Phase B chat-declutter — landmark synthesis. Walk the messages
  // once, emitting a "track opened by ROLE at HH:MM:SS" row before
  // the first message of each declared workstream and a sticky
  // minute-anchor row each time the wall-clock minute boundary
  // crosses. Both are pure derived chrome — no server state, no
  // backend round-trip. The row pre-computation lives outside the
  // render JSX so the render path stays a flat map without a
  // useEffect dance to track previous values.
  type Landmark =
    | { kind: "track_open"; key: string; workstreamId: string; ts: string; roleLabel: string }
    | { kind: "minute"; key: string; minute: string };
  const landmarksByMessageId = new Map<string, Landmark[]>();
  const seenWorkstreams = new Set<string>();
  let lastMinute: string | null = null;
  for (const m of messages) {
    const out: Landmark[] = [];
    const minute = minuteKey(m.ts);
    if (lastMinute !== minute) {
      out.push({ kind: "minute", key: `min-${m.id}`, minute });
      lastMinute = minute;
    }
    if (m.workstream_id && !seenWorkstreams.has(m.workstream_id)) {
      const ws = workstreamLabelById.get(m.workstream_id);
      if (ws) {
        const role = m.role_id ? roleById.get(m.role_id) : null;
        const roleLabel = role ? role.label : "AI Facilitator";
        out.push({
          kind: "track_open",
          key: `track-${m.id}`,
          workstreamId: m.workstream_id,
          ts: m.ts,
          roleLabel,
        });
      }
      seenWorkstreams.add(m.workstream_id);
    }
    if (out.length > 0) landmarksByMessageId.set(m.id, out);
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
        // Amber-border highlight on the latest AI bubble when the
        // viewer is the active responder. Critical injects already
        // carry their own crit emphasis, so skip the highlight there.
        // The highlight rides on the bubble body's border (swapping
        // ``border-ink-600`` for ``border-warn``) rather than a ring
        // stack on the outer row — a ring around the article wraps
        // the avatar + stripe + bubble together and reads as broken
        // chrome instead of a focus signal. 1px border matches the
        // brand pattern in ``app-screens.jsx``.
        const isFocusHit =
          !!highlightLastAi && idx === lastAiIndex && m.kind === "ai_text";
        const ts = new Date(m.ts).toLocaleTimeString();
        // Phase B chat-declutter — track-bar stripe + structural
        // @-highlight. The stripe is 3 px on the left edge of the
        // bubble; ``colorForWorkstream`` falls back to slate gray
        // for ``#main`` / unknown ids. The mention-flag drives the
        // signal-blue ``@YOU`` badge ONLY from the structural
        // ``mentions[]`` list — we never regex the body, per plan
        // §5.1.
        //
        // Two distinct semantic states, two distinct colors:
        //   - ``isFocusHit`` = your-turn-now → amber (warn). The
        //     loudest "you owe a response" signal; matches the
        //     awaiting-response chip above the composer.
        //   - ``isMentioned`` = you-are-tagged → signal blue. Same
        //     hue family as the ``· YOU`` self suffix on player
        //     bubbles, so identity reads as one consistent color.
        // Yellow used to do both jobs, which was the user-reported
        // "too many yellow things vying for attention" problem.
        const stripeColor = colorForWorkstream(m.workstream_id, declaredOrder);
        const isMentioned =
          selfRoleId != null && (m.mentions ?? []).includes(selfRoleId);
        const landmarks = landmarksByMessageId.get(m.id) ?? [];

        if (isSystem) {
          // SystemBeat — center-aligned mono uppercase divider, lifted
          // from app-screens.jsx <SystemBeat>. Landmarks (minute /
          // track-open) render BEFORE the system row so the chrome
          // sequence reads naturally: "[14:32]" → "track opened" →
          // SYSTEM beat.
          return (
            <Landmarks
              key={`grp-${m.id}`}
              entries={landmarks}
              declaredOrder={declaredOrder}
              workstreamLabelById={workstreamLabelById}
            >
              <article
                key={m.id}
                id={`msg-${m.id}`}
                data-kind={m.kind}
                data-message-id={m.id}
                data-highlightable="true"
                data-message-kind="system"
                className="mono scroll-mt-24 select-text border-y border-dashed border-ink-600 px-2 py-1.5 text-center text-[10px] font-bold uppercase tracking-[0.16em] text-ink-400"
              >
                <span className="tabular-nums text-ink-500">{ts}</span>
                <span className="mx-2 text-ink-600">·</span>
                <span>{m.body}</span>
              </article>
            </Landmarks>
          );
        }

        if (isAi) {
          // AIBubble — left mark avatar (36 px square, signal-deep
          // bordered) + right column with FACILITATOR · TURN N header
          // and a signal-bordered body. Critical injects swap the signal
          // border + dot for crit equivalents. The 3 px workstream
          // stripe is layered onto the left border via inline style
          // (Tailwind has no arbitrary-color border util that survives
          // dark-mode oklch tokens). For critical injects we keep the
          // crit-red border at the bubble level — the workstream stripe
          // sits OUTSIDE that border on a dedicated rail so the two
          // signals don't collide (UI/UX review specifically asked we
          // avoid recoloring the critical-inject red).
          // Header chrome — dot + label color. Three priority levels:
          //   1. Critical inject → crit (red), always wins.
          //   2. Your-turn focus (``isFocusHit``) → warn (amber).
          //      Reserved for "you owe a response on this turn".
          //   3. @-mention only → signal (blue). Identity, not alarm.
          //   4. Default → signal (blue). The standard AI bubble.
          // Yellow being two-job (turn + mention) was the
          // user-reported "yellow noise" problem; mention drops to
          // blue to align with the ``· YOU`` self suffix on player
          // bubbles.
          const dotColor = isCritical
            ? "bg-crit"
            : isFocusHit && !isCritical
              ? "bg-warn"
              : "bg-signal";
          const labelColor = isCritical
            ? "text-crit"
            : isFocusHit && !isCritical
              ? "text-warn"
              : "text-signal";
          // Bubble border priority mirrors the dot/label rules above.
          // Your-turn bubbles get the amber border; mention-only
          // bubbles get a brighter signal border (not signal-deep,
          // which is barely distinguishable from the default ink-600
          // chrome at peripheral-vision distance — UI/UX review HIGH).
          // The brighter signal stays clearly distinct from the warn
          // amber so "you owe a response" and "you're tagged" remain
          // separate visual signals.
          const borderClass = isCritical
            ? "border border-crit border-l-2 bg-crit-bg"
            : isFocusHit
              ? "border border-warn bg-ink-800"
              : isMentioned
                ? "border border-signal bg-ink-800"
                : "border border-ink-600 bg-ink-800";
          return (
            <Landmarks
              key={`grp-${m.id}`}
              entries={landmarks}
              declaredOrder={declaredOrder}
              workstreamLabelById={workstreamLabelById}
            >
              <article
                key={m.id}
                id={`msg-${m.id}`}
                data-kind={m.kind}
                data-message-id={m.id}
                data-workstream-id={m.workstream_id ?? ""}
                onContextMenu={(e) => handleContextMenu(e, m)}
                className="scroll-mt-24 flex min-w-0 gap-3"
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
                    style={{ height: 26, width: 26 }}
                    className="block"
                  />
                </div>
                <div
                  aria-hidden="true"
                  className="shrink-0 self-stretch"
                  style={{ width: 3, background: stripeColor, borderRadius: 2 }}
                  title={
                    m.workstream_id
                      ? `Workstream: #${workstreamLabelById.get(m.workstream_id) ?? m.workstream_id}`
                      : "Unscoped (#main)"
                  }
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <header className="mono flex items-baseline gap-2 text-[10px] font-bold uppercase tracking-[0.14em]">
                    <span
                      aria-hidden="true"
                      className={`inline-block h-1.5 w-1.5 rounded-full ${dotColor}`}
                    />
                    <span className={`tracking-[0.16em] ${labelColor}`}>
                      {isCritical ? "CRITICAL INJECT" : "AI FACILITATOR"}
                    </span>
                    {isMentioned ? (
                      <span
                        className="rounded-r-1 border border-signal bg-ink-900 px-1.5 py-0.5 text-[9px] font-bold uppercase leading-none tracking-[0.10em] text-signal"
                        title="This message mentions you"
                      >
                        @YOU
                      </span>
                    ) : null}
                    <span className="ml-auto tabular-nums text-ink-500">{ts}</span>
                    {canOverride(m) ? (
                      <KeyboardOverrideTrigger
                        onOpen={(x, y) =>
                          onMessageContextMenu?.({
                            messageId: m.id,
                            workstreamId: m.workstream_id,
                            x,
                            y,
                          })
                        }
                      />
                    ) : null}
                  </header>
                  {(() => {
                    // Substantial ``share_data`` calls collapse to a
                    // one-line "Data brief" summary by default; the
                    // viewer expands inline via "View details". The
                    // bubble wrapper, header, @YOU badge, and
                    // workstream stripe stay identical between the two
                    // states — only the body content + the toggle
                    // affordance changes. Non-share_data tools and
                    // small share_data dumps render exactly as before
                    // (full MarkdownBody).
                    const isLargeShareData =
                      m.tool_name === "share_data" &&
                      (m.body?.length ?? 0) >= SHARE_DATA_COLLAPSE_CHARS;
                    const isShareDataExpanded = expandedShareData.has(m.id);
                    const shareDataLabel =
                      m.tool_name === "share_data" &&
                      typeof m.tool_args?.label === "string"
                        ? (m.tool_args.label as string).trim() || "Data shared"
                        : "Data shared";
                    return (
                      <div
                        className={`min-w-0 break-words rounded-r-2 px-4 py-3 text-ink-100 ${borderClass}`}
                        // Issue #98: AI / inject bubbles must be highlight-pinnable
                        // — they're the artifact users most want to capture into
                        // their notepad timeline.
                        data-highlightable="true"
                        data-message-id={m.id}
                        data-message-kind="ai"
                      >
                        {isLargeShareData && !isShareDataExpanded ? (
                          <ShareDataCollapsedBody
                            label={shareDataLabel}
                            body={m.body}
                            onExpand={() => toggleShareDataExpansion(m.id)}
                          />
                        ) : (
                          <>
                            <MarkdownBody body={m.body} />
                            {isLargeShareData ? (
                              <button
                                type="button"
                                onClick={() => toggleShareDataExpansion(m.id)}
                                className="mono mt-3 inline-flex items-center gap-1 rounded-r-1 border border-info bg-info-bg px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-info hover:bg-info/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-info"
                                aria-expanded="true"
                              >
                                ▴ Hide details
                              </button>
                            ) : null}
                            {m.tool_name && !isLargeShareData ? (
                              <p className="mono mt-2 text-[10px] uppercase tracking-[0.10em] text-ink-400">
                                tool · {m.tool_name}
                              </p>
                            ) : null}
                          </>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </article>
            </Landmarks>
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
        // Player bubble border. Self-bubbles keep their signal-tinted
        // background with a signal-deep edge; @-mentions of the
        // viewer get a brighter signal border on the standard
        // ink-800 (same brightness rule as the AI bubble path —
        // signal-deep was too close to ink-600 to scan
        // peripherally). Self + @-mention is rare and the self-tint
        // already wins; we don't escalate that case to amber since
        // amber is reserved for "you owe a turn answer" (the
        // awaiting-response chip + your-turn AI bubble).
        const bubbleColour = isSelf
          ? "border border-signal-deep bg-signal-tint"
          : isMentioned
            ? "border border-signal bg-ink-800"
            : "border border-ink-600 bg-ink-800";
        return (
          <Landmarks
            key={`grp-${m.id}`}
            entries={landmarks}
            declaredOrder={declaredOrder}
            workstreamLabelById={workstreamLabelById}
          >
            <article
              key={m.id}
              id={`msg-${m.id}`}
              data-kind={m.kind}
              data-message-id={m.id}
              data-workstream-id={m.workstream_id ?? ""}
              onContextMenu={(e) => handleContextMenu(e, m)}
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
                    <span className="text-signal tracking-[0.16em]">✓ SUBMITTED</span>
                  )}
                  <span className="tracking-[0.10em] text-ink-100">{roleLabel}</span>
                  {displayName ? (
                    <span className="font-semibold tabular-nums text-ink-400">
                      {displayName}
                    </span>
                  ) : null}
                  {isSelf ? (
                    <span className="text-signal tracking-[0.16em]">· YOU</span>
                  ) : null}
                  {isMentioned ? (
                    <span
                      className="rounded-r-1 border border-signal-deep bg-signal-tint px-1.5 py-0.5 text-[9px] font-bold uppercase leading-none tracking-[0.10em] text-signal"
                      title="This message mentions you"
                    >
                      @YOU
                    </span>
                  ) : null}
                  <span className="tabular-nums text-ink-500">{ts}</span>
                  {canOverride(m) ? (
                    <KeyboardOverrideTrigger
                      onOpen={(x, y) =>
                        onMessageContextMenu?.({
                          messageId: m.id,
                          workstreamId: m.workstream_id,
                          x,
                          y,
                        })
                      }
                    />
                  ) : null}
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
                {/* Wave 3 (issue #69): when this player message tagged
                    ``@facilitator`` AND the AI was paused at submit
                    time, surface an italic indicator under the bubble
                    so the player understands why no AI reply followed.
                    Both predicates intentional — the server snapshots
                    ``ai_paused_at_submit`` only when the mention is
                    present, so the mention check is belt-and-braces
                    against any future drift. ``role="note"`` because
                    the indicator is contextual annotation, not a
                    status update — the session-wide pause banner is
                    the live-region surface. */}
                {isPlayer
                  && m.ai_paused_at_submit === true
                  && (m.mentions ?? []).includes("facilitator") ? (
                  <p
                    role="note"
                    data-testid="ai-silenced-indicator"
                    className="mt-1 italic text-[11px] leading-tight text-ink-400"
                  >
                    AI silenced — won't reply
                  </p>
                ) : null}
              </div>
              <div
                aria-hidden="true"
                className="shrink-0 self-stretch"
                style={{ width: 3, background: stripeColor, borderRadius: 2 }}
                title={
                  m.workstream_id
                    ? `Workstream: #${workstreamLabelById.get(m.workstream_id) ?? m.workstream_id}`
                    : "Unscoped (#main)"
                }
              />
              {/* Role-code avatar — fixed 36×36 circle. Distinct
                  geometry from the rectangular bubble + ink-700 chips
                  so it reads as identity, not a continuation of the
                  message body. */}
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
          </Landmarks>
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

/**
 * Phase B chat-declutter — render the synthetic landmark rows
 * (minute anchor + "track opened by …") that precede a message in
 * the transcript. Wraps the bubble in a Fragment so the
 * ``messages.map`` keeps returning a single child per message
 * (React's rule, not ours).
 *
 * The minute anchor uses ``position: sticky`` inside the scrolling
 * region — a reader who has scrolled up by 50 messages still sees
 * "what minute am I in" pinned at the top until the next anchor
 * scrolls into view and replaces it. Pure CSS, no IntersectionObserver.
 *
 * The track-open row is purely decorative chrome — ``role="presentation"``
 * + ``aria-hidden="false"`` because it's still useful context for a
 * screen-reader user navigating the transcript ("track opened by
 * SOC at 14:33"); we just don't want it announced as a list item or
 * a heading. NVDA reads it as plain text.
 */
/**
 * Collapsed-by-default render for substantial ``share_data`` calls.
 * Shows the AI-supplied label (the same string Timeline uses for the
 * "Data brief" rail pin), a one-line preview from the body, and a
 * size-stat (line count + char count) so the viewer can decide
 * whether to expand. The "View details" button toggles the parent
 * Transcript's `expandedShareData` set; once expanded, the bubble
 * re-renders with the full MarkdownBody and a "Hide details" button.
 *
 * Tone is info-cyan, matching the Timeline rail's Data-brief pin
 * color so a viewer who sees the rail entry and clicks through to
 * the chat finds the same visual language. Yellow is intentionally
 * avoided — that's reserved for "you owe a turn answer" (the
 * awaiting-response chip).
 */
function ShareDataCollapsedBody({
  label,
  body,
  onExpand,
}: {
  label: string;
  body: string;
  onExpand: () => void;
}) {
  const preview = derivePreview(body, label);
  const lineCount = body
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0).length;
  const charCount = body.length;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="mono text-[10px] font-bold uppercase tracking-[0.16em] text-info">
          ▤ DATA BRIEF
        </span>
        <span className="text-sm font-semibold text-ink-050">{label}</span>
        <span className="mono ml-auto text-[10px] tabular-nums text-ink-400">
          {lineCount} {lineCount === 1 ? "line" : "lines"} ·{" "}
          {charCount.toLocaleString()} chars
        </span>
      </div>
      {preview ? (
        <p className="line-clamp-1 text-xs text-ink-300">{preview}</p>
      ) : null}
      <button
        type="button"
        onClick={onExpand}
        className="mono self-start inline-flex items-center gap-1 rounded-r-1 border border-info bg-info-bg px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-info hover:bg-info/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-info"
        aria-expanded="false"
        title="Reveal the full data dump inline. The same content is also pinned in the Timeline rail."
      >
        ▾ View details
      </button>
    </div>
  );
}

function KeyboardOverrideTrigger({
  onOpen,
}: {
  onOpen: (x: number, y: number) => void;
}) {
  // User-persona review CRITICAL C-1: the right-click contextmenu
  // hijacks browser muscle memory ("copy this AI text to my notes")
  // with no in-app discovery. The visible ``⋯`` button + a
  // descriptive ``title`` is the discoverability fallback — hover
  // over a bubble's chevron and you see "Move to workstream
  // (right-click also works)". Keyboard-only users hit Tab to land
  // here; they don't depend on a contextmenu event ever firing.
  return (
    <button
      type="button"
      aria-label="Move to workstream"
      title="Move to workstream — right-click the message also works"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        onOpen(rect.right, rect.bottom);
      }}
      className="mono ml-1 rounded-r-1 px-1 text-[10px] leading-none text-ink-400 hover:bg-ink-700 hover:text-ink-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal"
    >
      ⋯
    </button>
  );
}

function Landmarks({
  entries,
  declaredOrder,
  workstreamLabelById,
  children,
}: {
  entries: ReadonlyArray<
    | { kind: "track_open"; key: string; workstreamId: string; ts: string; roleLabel: string }
    | { kind: "minute"; key: string; minute: string }
  >;
  declaredOrder: readonly string[];
  workstreamLabelById: Map<string, string>;
  children: ReactNode;
}) {
  if (entries.length === 0) return <>{children}</>;
  return (
    <>
      {entries.map((entry) => {
        if (entry.kind === "minute") {
          return (
            <div
              key={entry.key}
              className="mono sticky top-0 z-10 -mx-1 select-none border-b border-dashed border-ink-700 bg-ink-850/95 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-ink-300 backdrop-blur"
              aria-hidden="false"
            >
              <span className="tabular-nums">{entry.minute}</span>
            </div>
          );
        }
        const color = colorForWorkstream(entry.workstreamId, declaredOrder);
        const label = workstreamLabelById.get(entry.workstreamId) ?? entry.workstreamId;
        const ts = new Date(entry.ts).toLocaleTimeString();
        return (
          <div
            key={entry.key}
            className="mono flex select-none items-center gap-2 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-ink-300"
            role="presentation"
          >
            <span
              aria-hidden="true"
              className="inline-block h-2 w-8 rounded-r-0"
              style={{ background: color }}
            />
            <span style={{ color }}>#{label}</span>
            <span className="text-ink-500">opened by</span>
            <span className="text-ink-100">{entry.roleLabel}</span>
            <span className="ml-auto tabular-nums text-ink-500">{ts}</span>
          </div>
        );
      })}
      {children}
    </>
  );
}
