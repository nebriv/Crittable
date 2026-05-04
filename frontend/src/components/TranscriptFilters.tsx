import { CSSProperties } from "react";
import { MessageView, WorkstreamView } from "../api/client";
import {
  DEFAULT_FILTER,
  FilterState,
  QualityFilter,
  countFilters,
  countHiddenMentions,
  isDefaultFilter,
} from "../lib/transcriptFilters";
import { colorForWorkstream } from "../lib/workstreamPalette";

interface Props {
  /** Full (unfiltered) message list. Used to compute pill counts. */
  messages: MessageView[];
  workstreams: WorkstreamView[];
  selfRoleId: string | null;
  state: FilterState;
  onChange: (next: FilterState) => void;
}

interface PillProps {
  label: string;
  count: number;
  active: boolean;
  tone: "default" | "warn" | "crit";
  onClick: () => void;
  ariaLabel?: string;
}

function FilterPill({ label, count, active, tone, onClick, ariaLabel }: PillProps) {
  const toneClasses: Record<typeof tone, { active: string; idle: string }> = {
    default: {
      active:
        "border-signal-deep bg-signal-tint text-signal-bright",
      idle: "border-ink-500 bg-ink-700 text-ink-200 hover:border-ink-400 hover:text-ink-100",
    },
    warn: {
      active: "border-warn bg-warn-bg text-warn",
      idle: "border-ink-500 bg-ink-700 text-ink-200 hover:border-warn hover:text-warn",
    },
    crit: {
      active: "border-crit bg-crit-bg text-crit",
      idle: "border-ink-500 bg-ink-700 text-ink-200 hover:border-crit hover:text-crit",
    },
  };
  const cls = active ? toneClasses[tone].active : toneClasses[tone].idle;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={ariaLabel ?? `${label} (${count})`}
      className={`mono inline-flex items-center gap-1.5 rounded-r-1 border px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.10em] leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-1 focus-visible:ring-offset-ink-900 ${cls}`}
    >
      <span>{label}</span>
      <span
        className="rounded-r-1 bg-ink-900/40 px-1 py-0.5 text-[10px] tabular-nums"
        aria-hidden="true"
      >
        {count}
      </span>
    </button>
  );
}

interface TrackPillProps {
  ws: WorkstreamView;
  count: number;
  active: boolean;
  color: string;
  onToggle: () => void;
}

function TrackPill({ ws, count, active, color, onToggle }: TrackPillProps) {
  // User-persona review H1: keep the color swatch visible in BOTH
  // states. Pre-fix the active state dropped the swatch, leaving the
  // operator with no recall cue for "which color is this track" right
  // when the mapping matters most (when filtering on it). Now the
  // swatch + label always renders together — the active vs idle
  // distinction is signaled by the border color + tinted background
  // alone.
  const styles: CSSProperties = active
    ? {
        borderColor: color,
        background: `color-mix(in oklch, ${color} 16%, transparent)`,
        color,
      }
    : {};
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      aria-label={`${ws.label} (${count})`}
      style={styles}
      className={`mono inline-flex items-center gap-1.5 rounded-r-1 border px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.10em] leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-1 focus-visible:ring-offset-ink-900 ${
        active
          ? ""
          : "border-ink-500 bg-ink-700 text-ink-200 hover:border-ink-300 hover:text-ink-050"
      }`}
    >
      <span
        aria-hidden="true"
        className="inline-block h-2.5 w-2.5 shrink-0 rounded-r-0"
        style={{ background: color }}
      />
      <span>#{ws.label}</span>
      <span
        className="rounded-r-1 bg-ink-900/40 px-1 py-0.5 text-[10px] tabular-nums"
        aria-hidden="true"
      >
        {count}
      </span>
    </button>
  );
}

export function TranscriptFilters({
  messages,
  workstreams,
  selfRoleId,
  state,
  onChange,
}: Props) {
  const declaredOrder = workstreams.map((ws) => ws.id);
  const counts = countFilters(messages, declaredOrder, selfRoleId);
  const hidden = countHiddenMentions(messages, state, selfRoleId);

  function setQuality(q: QualityFilter) {
    onChange({ quality: q, tracks: state.tracks });
  }
  function toggleTrack(id: string) {
    const next = new Set(state.tracks);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange({ quality: state.quality, tracks: next });
  }
  function clearAll() {
    onChange(DEFAULT_FILTER);
  }

  const showAllVisible = !isDefaultFilter(state);
  const trackPillsVisible = workstreams.length > 0;
  // Plan §4.7 + iter-3 noise feedback: hard cap is 8 workstreams. We
  // wrap the pills in flex-wrap so a 6-7-pill row degrades gracefully
  // before any overflow popover is needed; UI/UX review specifically
  // asked we don't let 5+ workstreams force a horizontal scroll.

  // Build the active-filter description used by the screen-reader
  // announcement on the hidden-mentions banner. Operator-voice short
  // form, no marketing copy.
  const activeDescription = describeFilter(state, workstreams);

  return (
    <div
      className="flex shrink-0 flex-col gap-2 border-b border-ink-700 bg-ink-850 px-3 py-2"
      role="group"
      aria-label="Transcript filters"
    >
      <div className="flex flex-wrap items-center gap-2">
        <FilterPill
          label="All"
          count={counts.all}
          active={state.quality === "all"}
          tone="default"
          onClick={() => setQuality("all")}
        />
        <FilterPill
          label="@Me"
          count={counts.me}
          active={state.quality === "me"}
          tone="warn"
          onClick={() => setQuality("me")}
          ariaLabel={`Mentions of you (${counts.me})`}
        />
        <FilterPill
          label="Critical"
          count={counts.critical}
          active={state.quality === "critical"}
          tone="crit"
          onClick={() => setQuality("critical")}
        />
        {showAllVisible ? (
          <button
            type="button"
            onClick={clearAll}
            className="mono ml-auto rounded-r-1 border border-transparent px-2 py-1 text-[11px] font-bold uppercase tracking-[0.10em] leading-none text-signal hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-1 focus-visible:ring-offset-ink-900"
            aria-label="Clear all transcript filters"
          >
            Reset filters
          </button>
        ) : null}
      </div>
      {trackPillsVisible ? (
        <div
          className="flex flex-wrap items-center gap-2"
          role="group"
          aria-label="Workstream filters — combined with the quality pill above (any selected track is shown)"
        >
          <span
            className="mono text-[10px] font-bold uppercase tracking-[0.16em] text-ink-400"
            // sr-only-equivalent: hide the visual word from AT
            // (replaced by the role="group" aria-label above), but
            // keep the visual hint for sighted users.
            aria-hidden="true"
          >
            AND TRACKS:
          </span>
          {workstreams.map((ws) => (
            <TrackPill
              key={ws.id}
              ws={ws}
              count={counts.perTrack[ws.id] ?? 0}
              active={state.tracks.has(ws.id)}
              color={colorForWorkstream(ws.id, declaredOrder)}
              onToggle={() => toggleTrack(ws.id)}
            />
          ))}
        </div>
      ) : null}
      {hidden > 0 ? (
        <div
          role="status"
          aria-live="polite"
          className="flex flex-wrap items-center gap-2 rounded-r-1 border border-info bg-info-bg px-2.5 py-1.5 text-[12px] text-info"
        >
          <span aria-hidden="true">ⓘ</span>
          <span>
            {hidden} @-mention{hidden === 1 ? "" : "s"} for you hidden by the
            current filter
            {activeDescription ? ` (${activeDescription})` : ""}
          </span>
          {/*
            User-persona review H3: a single "Show all" was a nuke
            button — clearing my Comms-track focus to find a
            Containment mention. The "Show those" affordance jumps
            directly to the @Me filter (clearing the other quality
            filter and any track filters), so the operator can read
            the missed mentions and then return to their previous
            filter manually. Two distinct exits beat one.
          */}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                onChange({ quality: "me", tracks: new Set<string>() })
              }
              className="mono rounded-r-1 border border-info px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.10em] leading-none text-info hover:bg-ink-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-1 focus-visible:ring-offset-ink-900"
              aria-label="Switch filter to mentions of you"
            >
              Show those
            </button>
            <button
              type="button"
              onClick={clearAll}
              className="mono rounded-r-1 border border-info px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.10em] leading-none text-info hover:bg-ink-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-1 focus-visible:ring-offset-ink-900"
              aria-label="Clear all transcript filters"
            >
              Reset filters
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function describeFilter(
  state: FilterState,
  workstreams: WorkstreamView[],
): string {
  const parts: string[] = [];
  if (state.quality === "me") parts.push("@Me");
  else if (state.quality === "critical") parts.push("Critical");
  for (const ws of workstreams) {
    if (state.tracks.has(ws.id)) parts.push(`#${ws.label}`);
  }
  return parts.join(", ");
}
