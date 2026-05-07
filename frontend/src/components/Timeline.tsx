import { useState } from "react";
import { MessageView, RoleView } from "../api/client";

interface Props {
  messages: MessageView[];
  roles: RoleView[];
  /**
   * Phase B chat-declutter (UI/UX review HIGH): invoked when a
   * Timeline pin's target ``msg-{id}`` is missing from the DOM —
   * typically because a transcript filter is hiding it. The parent
   * page owns the filter state and can clear it then re-attempt the
   * scroll, surface a recovery toast, etc. Optional — without a
   * handler the click degrades to a console warning + no-op (the
   * pre-Phase-B behavior).
   */
  onScrollMissed?: (messageId: string) => void;
}

interface TimelineEntry {
  id: string;
  ts: string;
  tag: "Critical" | "Pinned" | "Beat" | "Decision" | "Data brief" | "Lifecycle";
  title: string;
  body: string;
  tone: string;
}

// Lower bound for ``share_data`` body length (in chars, post-label) to be
// pin-worthy. Short data shares (a single line of telemetry) would clutter
// the rail; only substantial dumps — log tables, IOC lists — get pinned.
const SHARE_DATA_MIN_CHARS = 300;

// Beat detector: matches the AI naming a phase / beat / stage in a broadcast.
// Examples it should catch:
//   "**BEAT 2 — Scope Assessment**"
//   "Beat 3: Stakeholder Briefing"
//   "Phase 1 — Detection & Triage"
//   "Stage 2 (Containment)"
// Captures the keyword + the integer index. Case-insensitive. Title is
// reconstructed from the line that contains the match so it includes the
// human-readable label the AI wrote inline.
const BEAT_RE = /\b(beat|phase|stage)\s+(\d{1,2})\b/i;

/**
 * Right-sidebar overview/timeline. Highlights *only* the key beats of the
 * exercise — not a firehose of every AI broadcast. Six categories:
 *
 *  - **Critical** — ``critical_inject`` messages (urgent injects).
 *  - **Beat**     — first broadcast that mentions ``Beat N`` / ``Phase
 *                   N`` / ``Stage N`` (auto-detected; one entry per
 *                   index). The most important pin type for AAR review.
 *  - **Pinned**   — legacy ``mark_timeline_point`` calls (kept for
 *                   sessions created before the 2026-04-30 redesign;
 *                   the tool is no longer in the play palette).
 *  - **Decision** — ``pose_choice`` calls — explicit decision points
 *                   the team will want to scroll back to.
 *  - **Data brief** — substantial ``share_data`` calls — telemetry,
 *                   IOC dumps, log tables players will want to re-read.
 *  - **Lifecycle** — session start / end / force-advance system notes.
 *
 * Routine ``broadcast`` / ``inject_event`` / ``request_artifact`` calls
 * intentionally do NOT appear here; they would drown out the signal.
 *
 * Each entry is a button — clicking scrolls the transcript to the originating
 * message bubble (which has ``id="msg-{id}"``).
 */
export function Timeline({
  messages,
  roles: _roles,
  onScrollMissed,
}: Props) {
  // ``_roles`` kept in the prop signature so the parent doesn't need to
  // change; the timeline currently doesn't render role labels because the
  // entries are already attributed in the AI's title.
  void _roles;

  const items: TimelineEntry[] = [];
  // Track the highest beat / phase / stage index we've already pinned, so
  // the rail gets ONE entry per phase boundary — not every time the AI
  // mentions "beat 2" downstream. Beat 1 is included (the first
  // briefing broadcast usually says "BEAT 1 — Detection & Triage").
  let highestBeatPinned = 0;
  for (const m of messages) {
    if (m.kind === "critical_inject") {
      const headline = (m.tool_args?.headline as string | undefined)?.trim();
      items.push({
        id: m.id,
        ts: new Date(m.ts).toLocaleTimeString(),
        tag: "Critical",
        title: headline || "Critical event",
        body: m.body,
        tone: "border-crit bg-crit-bg",
      });
      continue;
    }
    if (m.tool_name === "mark_timeline_point") {
      // Legacy: tool removed from PLAY_TOOLS in the 2026-04-30 redesign
      // (see docs/tool-design.md), but transcripts from older sessions
      // still contain entries — keep rendering them.
      const title = (m.tool_args?.title as string | undefined)?.trim();
      items.push({
        id: m.id,
        ts: new Date(m.ts).toLocaleTimeString(),
        tag: "Pinned",
        title: title || "Pinned moment",
        body: m.body,
        tone: "border-info bg-info-bg",
      });
      continue;
    }
    if (m.tool_name === "pose_choice") {
      // Decision points — the AI surfaced a multi-choice fork. Always
      // pin: a tactical decision is exactly the kind of moment players
      // will want to scroll back to during the AAR.
      const question = (m.tool_args?.question as string | undefined)?.trim();
      const role = _roles.find((r) => r.id === (m.tool_args?.role_id as string | undefined));
      const roleLabel = role ? `${role.label} — ` : "";
      items.push({
        id: m.id,
        ts: new Date(m.ts).toLocaleTimeString(),
        tag: "Decision",
        title: roleLabel + (question || "Decision point"),
        body: m.body,
        tone: "border-warn bg-warn-bg",
      });
      continue;
    }
    // Beat / phase / stage transitions — pinned ONCE per index. Detected
    // from broadcasts (the AI's voice) and from address_role messages,
    // since the AI often opens a beat with "Beat 2 — CISO, your call ...".
    // Critical injects are handled above and may also contain a beat
    // mention; that's fine, a critical inject overrides for that moment
    // and the next broadcast in a new beat still gets a Beat pin.
    if (m.tool_name === "broadcast" || m.tool_name === "address_role") {
      const match = BEAT_RE.exec(m.body || "");
      if (match) {
        const idx = parseInt(match[2], 10);
        if (idx > highestBeatPinned) {
          highestBeatPinned = idx;
          // Reconstruct a friendly title from the line containing the
          // match (so we keep "BEAT 2 — Scope Assessment" verbatim if
          // the AI wrote it that way). Strip common decorations.
          const line = (m.body || "")
            .split(/\r?\n/)
            .find((ln) => BEAT_RE.test(ln))
            ?.replace(/^[\s>#*•-]+|[\s>#*•-]+$/g, "")
            .replace(/\*\*/g, "")
            .trim();
          items.push({
            id: m.id,
            ts: new Date(m.ts).toLocaleTimeString(),
            tag: "Beat",
            title: line || `${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()} ${idx}`,
            body: m.body,
            tone: "border-signal-deep bg-signal-tint",
          });
          continue;
        }
      }
    }
    if (m.tool_name === "share_data") {
      // Substantial data dumps only — short shares would clutter the rail.
      if ((m.body?.length ?? 0) < SHARE_DATA_MIN_CHARS) continue;
      const label = (m.tool_args?.label as string | undefined)?.trim();
      items.push({
        id: m.id,
        ts: new Date(m.ts).toLocaleTimeString(),
        tag: "Data brief",
        title: label || "Data shared",
        body: m.body,
        tone: "border-info bg-info-bg",
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
          tone: "border-ink-600 bg-ink-850",
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
    if (!el) {
      // Phase B chat-declutter (UI/UX review HIGH): a Timeline pin
      // whose target message is filtered out of the transcript would
      // silently no-op pre-fix, leaving the operator wondering whether
      // the click registered. ``onScrollMissed`` lets the parent (the
      // page, which owns the filter state) surface a recovery —
      // typically by clearing the filter and re-trying. Without a
      // handler we still log so the next operator can see the silent
      // no-op in their browser console.
      console.warn(
        `[timeline] msg-${id} not in DOM — likely hidden by an active transcript filter`,
      );
      onScrollMissed?.(id);
      return;
    }
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
    <div
      aria-labelledby="timeline-heading"
      className="flex min-h-0 flex-col gap-2 p-3 text-sm"
    >
      {/* Visually-hidden heading — the parent ``CollapsibleRailPanel``
          renders the visible "TIMELINE" chrome, but screen readers
          still benefit from the section being labeled inside the
          accordion body. */}
      <h3
        id="timeline-heading"
        className="sr-only"
      >
        Timeline · {items.length} {items.length === 1 ? "event" : "events"}
      </h3>
      {items.length === 0 ? (
        <p className="mono text-[10px] uppercase tracking-[0.04em] text-ink-400">
          Key beats appear here as the AI logs them.
        </p>
      ) : (
        <ol className="flex flex-col gap-2 overflow-y-auto pr-1">
          {items.map((it) => (
            <li key={it.id} className={`rounded-r-1 border ${it.tone}`}>
              <button
                type="button"
                onClick={() => scrollTo(it.id)}
                aria-label={`Jump to ${it.title} in the transcript`}
                className="flex w-full flex-col gap-0.5 px-2 py-1.5 text-left hover:bg-ink-750 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal"
                title="Click to scroll the transcript to this moment."
              >
                <header className="mono flex items-center justify-between text-[10px] uppercase tracking-[0.16em] text-ink-300">
                  <span>{it.tag}</span>
                  <span className="tabular-nums text-ink-400">{it.ts}</span>
                </header>
                <p className="text-xs font-semibold text-ink-050">{it.title}</p>
                {it.body && it.body !== it.title ? (
                  <p className="line-clamp-2 text-[11px] text-ink-300">{it.body}</p>
                ) : null}
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
