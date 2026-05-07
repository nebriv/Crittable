import { MessageView, RoleView, WorkstreamView } from "../api/client";
import { colorForWorkstream } from "../lib/workstreamPalette";
import { RailListShell } from "./ArtifactsRail";

interface Props {
  messages: MessageView[];
  roles: RoleView[];
  workstreams: WorkstreamView[];
  onScrollMissed?: (messageId: string) => void;
}

interface ActionEntry {
  id: string;
  ts: string;
  ownerLabel: string;
  text: string;
  status: "open" | "in_progress" | "done";
  workstreamId: string | null;
  status_reason: string | null;
}

/**
 * "Action items" tab — open / in-progress TODOs the operator owes
 * follow-through on.
 *
 * Phase 4 polish derives the list from existing message metadata
 * rather than introducing a new tracking surface (a per-message
 * "assign as TODO" affordance is tracked separately):
 *
 *   - ``address_role`` calls — the AI explicitly asked role X to do Y.
 *     Status = ``open`` until role X has posted a player message AFTER
 *     the ask in the same workstream (``in_progress``); marked
 *     ``done`` only if the role's response carries an ``intent="ready"``
 *     submission AND the AI has since broadcast a non-question
 *     follow-up. We can't see ``intent`` on snapshot messages directly
 *     yet (tracked) — so MVP heuristic: "open" until the addressed
 *     role replies once, then "in_progress".
 *   - ``pose_choice`` calls — same lifecycle as address_role; the
 *     question is the action.
 *
 * Status badge tones: open=slate (neutral, "nothing-happened-yet"),
 * in_progress=info-cyan (a status, not a warning), done=signal-blue
 * (consistent with the signal-tinted self/identity treatment).
 * In-progress used to be amber but was demoted to info — yellow is
 * reserved for "you owe a turn answer", and "the AI asked another
 * role for a reply" isn't that. Click jumps the transcript to the AI
 * ask; ``onScrollMissed`` lets the parent clear an active filter and
 * retry.
 */
export function ActionItemsRail({
  messages,
  roles,
  workstreams,
  onScrollMissed,
}: Props) {
  const declaredOrder = workstreams.map((w) => w.id);
  const labelByRoleId = new Map(roles.map((r) => [r.id, r.label]));
  // Walk the transcript once. For each address_role / pose_choice, we
  // determine whether the addressed role has spoken since (status =
  // in_progress) or not (status = open). Done lifecycle requires AI
  // confirmation, which we can't reliably detect from the snapshot
  // alone — surfacing as "done" would risk false positives, so we
  // intentionally never mark anything done from this view (the shared
  // notepad's checkbox flow remains the authoritative "done" surface).
  const items: ActionEntry[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.tool_name !== "address_role" && m.tool_name !== "pose_choice") continue;
    const ownerId =
      typeof m.tool_args?.role_id === "string"
        ? (m.tool_args.role_id as string)
        : null;
    const ownerLabel = ownerId
      ? labelByRoleId.get(ownerId) ?? "—"
      : "—";
    const text =
      m.tool_name === "pose_choice"
        ? typeof m.tool_args?.question === "string"
          ? (m.tool_args.question as string).trim()
          : "Decision point"
        : (m.body || "Open ask").trim().slice(0, 200);
    let status: ActionEntry["status"] = "open";
    let status_reason: string | null = null;
    if (ownerId) {
      const replied = messages.slice(i + 1).some(
        (later) => later.kind === "player" && later.role_id === ownerId,
      );
      if (replied) {
        status = "in_progress";
        status_reason = `${ownerLabel} replied`;
      }
    }
    items.push({
      id: m.id,
      ts: new Date(m.ts).toLocaleTimeString(),
      ownerLabel,
      text,
      status,
      status_reason,
      workstreamId: m.workstream_id,
    });
  }
  // Open items sort first, then in_progress, then done — matches the
  // operator's "what do I still owe?" mental model. Within a status,
  // newest-first so the most recent ask is at the top.
  const order: Record<ActionEntry["status"], number> = {
    open: 0,
    in_progress: 1,
    done: 2,
  };
  items.sort((a, b) => {
    const cmp = order[a.status] - order[b.status];
    if (cmp !== 0) return cmp;
    return a.ts < b.ts ? 1 : -1;
  });
  return (
    <RailListShell
      heading={`Action items · ${items.length} tracked`}
      empty="No action items yet — address_role and pose_choice asks appear here as the AI tags roles."
    >
      {items.map((it) => (
        <ActionCard
          key={it.id}
          item={it}
          color={colorForWorkstream(it.workstreamId, declaredOrder)}
          onScrollMissed={onScrollMissed}
        />
      ))}
    </RailListShell>
  );
}

function ActionCard({
  item,
  color,
  onScrollMissed,
}: {
  item: ActionEntry;
  color: string;
  onScrollMissed?: (id: string) => void;
}) {
  const tone =
    item.status === "in_progress"
      ? "border-info bg-info-bg text-info"
      : item.status === "done"
        ? "border-signal bg-signal-tint text-signal"
        : "border-ink-500 bg-ink-700 text-ink-200";
  // User-persona review HIGH H4: the heuristic only proves the
  // addressed role replied — not that they completed the ask. Surface
  // "REPLIED" not "IN PROGRESS" so the operator doesn't trust a flip
  // to amber as completion signal. The underlying enum stays
  // ``in_progress`` so the sort order + badge tone keep working.
  const label =
    item.status === "in_progress"
      ? "REPLIED"
      : item.status === "done"
        ? "DONE"
        : "OPEN";
  return (
    <li className="rounded-r-1 border border-ink-600 bg-ink-900">
      <button
        type="button"
        onClick={() => scrollToMessage(item.id, onScrollMissed)}
        aria-label={`Jump to ${item.text.slice(0, 60)} in the transcript`}
        className="flex w-full items-stretch gap-2 px-2 py-1.5 text-left hover:bg-ink-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal"
        title="Click to scroll the transcript to the originating ask."
      >
        <span
          aria-hidden="true"
          className="block w-1 shrink-0 rounded-r-1 self-stretch"
          style={{ background: color }}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <header className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-ink-050">
              {item.ownerLabel}
            </span>
            <span
              className={`mono rounded-r-1 border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.10em] ${tone}`}
            >
              {label}
            </span>
          </header>
          <p className="text-[11px] text-ink-300">{item.text}</p>
          <footer className="mono flex items-center justify-between text-[10px] text-ink-500">
            <span>
              {item.status_reason ?? "awaiting reply"} · jump →
            </span>
            <span className="tabular-nums">{item.ts}</span>
          </footer>
        </span>
      </button>
    </li>
  );
}

function scrollToMessage(
  id: string,
  onScrollMissed: ((id: string) => void) | undefined,
): void {
  const el = document.getElementById(`msg-${id}`);
  if (!el) {
    console.warn(
      `[actions] msg-${id} not in DOM — likely hidden by an active transcript filter`,
    );
    onScrollMissed?.(id);
    return;
  }
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.setAttribute("data-flash", "1");
  setTimeout(() => {
    el.removeAttribute("data-flash");
  }, 1400);
}
