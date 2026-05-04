import { MessageView, RoleView, WorkstreamView } from "../api/client";
import { colorForWorkstream } from "../lib/workstreamPalette";

interface Props {
  messages: MessageView[];
  roles: RoleView[];
  workstreams: WorkstreamView[];
  onScrollMissed?: (messageId: string) => void;
}

interface ArtifactEntry {
  id: string;
  ts: string;
  kind: "Data brief" | "Persistence" | "Decision";
  title: string;
  body: string;
  workstreamId: string | null;
  actor: string;
}

// Same threshold the backend's exports module uses — a share_data is
// "pinworthy" only when it's ≥300 chars. Short shares clutter the
// rail; substantial dumps deserve a pin.
const SHARE_DATA_PIN_MIN_CHARS = 300;

const PERSISTENCE_HINT_RE =
  /persist|persistence|reinfect|footh?old|backdoor/i;

/**
 * "Artifacts" tab — pinned cards for the operator to debrief from.
 *
 * Surfaces:
 *   - Substantial ``share_data`` calls (≥300 chars body): EDR alert
 *     tables, log dumps, IOC lists. The "what did we capture?" view.
 *   - AI broadcasts that name persistence / reinfection as a finding —
 *     a heuristic pin for the most consequential narrative beats so
 *     the operator can ctrl-F'less them later.
 *   - ``pose_choice`` calls — explicit decision forks. Shown here too
 *     so the artifacts view doubles as the "key moments" pool when an
 *     exercise hasn't generated big share_data dumps yet.
 *
 * Each card carries a colored track-bar matching the message's
 * ``workstream_id`` so the operator's filter-by-track mental model
 * carries through. Click jumps the transcript to the originating
 * message; if the message is hidden by an active filter,
 * ``onScrollMissed`` lets the parent page clear the filter and
 * retry.
 */
export function ArtifactsRail({
  messages,
  roles,
  workstreams,
  onScrollMissed,
}: Props) {
  const declaredOrder = workstreams.map((w) => w.id);
  const labelByRoleId = new Map(roles.map((r) => [r.id, r.label]));
  const items: ArtifactEntry[] = [];
  for (const m of messages) {
    if (m.tool_name === "share_data") {
      if ((m.body?.length ?? 0) < SHARE_DATA_PIN_MIN_CHARS) continue;
      const label =
        typeof m.tool_args?.label === "string"
          ? (m.tool_args.label as string).trim()
          : "";
      items.push({
        id: m.id,
        ts: new Date(m.ts).toLocaleTimeString(),
        kind: "Data brief",
        title: label || "Data shared",
        body: m.body,
        workstreamId: m.workstream_id,
        actor: actorLabel(m, labelByRoleId),
      });
      continue;
    }
    if (m.tool_name === "pose_choice") {
      const question =
        typeof m.tool_args?.question === "string"
          ? (m.tool_args.question as string).trim()
          : "";
      items.push({
        id: m.id,
        ts: new Date(m.ts).toLocaleTimeString(),
        kind: "Decision",
        title: question || "Decision point",
        body: m.body,
        workstreamId: m.workstream_id,
        actor: actorLabel(m, labelByRoleId),
      });
      continue;
    }
    // Persistence / reinfection: AI-side broadcasts that name a
    // long-tail finding the operator will want to debrief on. Heuristic
    // — the rail is a curated subset, false positives are cheap.
    if (
      m.tool_name === "broadcast"
      && m.kind === "ai_text"
      && PERSISTENCE_HINT_RE.test(m.body || "")
    ) {
      const title =
        m.body
          .split(/\r?\n/)
          .find((ln) => PERSISTENCE_HINT_RE.test(ln))
          ?.trim()
          .slice(0, 120) ?? "Persistence finding";
      items.push({
        id: m.id,
        ts: new Date(m.ts).toLocaleTimeString(),
        kind: "Persistence",
        title,
        body: m.body,
        workstreamId: m.workstream_id,
        actor: actorLabel(m, labelByRoleId),
      });
    }
  }

  return (
    <RailListShell
      heading={`Artifacts · ${items.length} pinned`}
      empty="No artifacts pinned yet — substantial share_data, persistence findings, and decision points appear here."
    >
      {items.map((it) => (
        <ArtifactCard
          key={it.id}
          item={it}
          color={colorForWorkstream(it.workstreamId, declaredOrder)}
          onScrollMissed={onScrollMissed}
        />
      ))}
    </RailListShell>
  );
}

function ArtifactCard({
  item,
  color,
  onScrollMissed,
}: {
  item: ArtifactEntry;
  color: string;
  onScrollMissed?: (id: string) => void;
}) {
  return (
    <li className="rounded-r-1 border border-ink-600 bg-ink-900">
      <button
        type="button"
        onClick={() => scrollToMessage(item.id, onScrollMissed)}
        aria-label={`Jump to ${item.title} in the transcript`}
        className="flex w-full items-stretch gap-2 px-2 py-1.5 text-left hover:bg-ink-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal"
        title="Click to scroll the transcript to this moment."
      >
        <span
          aria-hidden="true"
          className="block w-1 shrink-0 rounded-r-1 self-stretch"
          style={{ background: color }}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <header className="mono flex items-center justify-between text-[10px] uppercase tracking-[0.16em] text-ink-300">
            <span>{item.kind}</span>
            <span className="tabular-nums text-ink-400">{item.ts}</span>
          </header>
          <p className="text-xs font-semibold text-ink-050">{item.title}</p>
          <p className="line-clamp-2 text-[11px] text-ink-300">{item.body}</p>
          <p className="mono text-[10px] text-ink-500">{item.actor} · jump →</p>
        </span>
      </button>
    </li>
  );
}

function actorLabel(
  m: MessageView,
  labelByRoleId: Map<string, string>,
): string {
  if (m.role_id) return labelByRoleId.get(m.role_id) ?? "—";
  return "AI Facilitator";
}

function scrollToMessage(
  id: string,
  onScrollMissed: ((id: string) => void) | undefined,
): void {
  const el = document.getElementById(`msg-${id}`);
  if (!el) {
    console.warn(
      `[artifacts] msg-${id} not in DOM — likely hidden by an active transcript filter`,
    );
    onScrollMissed?.(id);
    return;
  }
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  // ``data-flash`` drives the flash highlight via CSS; we don't need a
  // React state mirror because the attribute toggle is the source of
  // truth (the bubble may re-render between scroll and timeout, but the
  // attribute is restored by React from the DOM diff). 1.4 s matches
  // the Timeline tab so the same visual cue ties all three surfaces
  // together.
  el.setAttribute("data-flash", "1");
  setTimeout(() => {
    el.removeAttribute("data-flash");
  }, 1400);
}

/** Shared empty-state + heading shell so the three tab bodies look
 *  consistent. Heading is sr-only — the visible chrome is the tab
 *  itself. */
export function RailListShell({
  heading,
  empty,
  children,
}: {
  heading: string;
  empty: string;
  children: React.ReactNode;
}) {
  const arr = Array.isArray(children) ? children : [children];
  const isEmpty = arr.filter(Boolean).length === 0;
  return (
    <div className="flex min-h-0 flex-col gap-2 p-3 text-sm">
      <h3 className="sr-only">{heading}</h3>
      {isEmpty ? (
        <p className="mono text-[10px] uppercase tracking-[0.04em] text-ink-400">
          {empty}
        </p>
      ) : (
        <ol className="flex flex-col gap-2 overflow-y-auto pr-1">
          {children}
        </ol>
      )}
    </div>
  );
}
