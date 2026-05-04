import { useState, type ReactNode } from "react";

import { MessageView, RoleView, WorkstreamView } from "../api/client";
import { Timeline } from "./Timeline";
import { ArtifactsRail } from "./ArtifactsRail";
import { ActionItemsRail } from "./ActionItemsRail";

interface Props {
  messages: MessageView[];
  roles: RoleView[];
  /**
   * Phase B chat-declutter: declared workstreams for this session.
   * Used by the Artifacts rail to render colored track-bar stripes
   * on each pinned card so the operator's filter-by-track mental
   * model carries through to the rail. Empty list = no
   * categorization (everything renders with the slate fallback).
   */
  workstreams?: WorkstreamView[];
  /**
   * Optional notepad slot — passed in from the page so RightSidebar
   * stays free of session/token concerns. Issue #98 swaps the legacy
   * per-player ``NotesPanel`` (localStorage-only) for the shared
   * Yjs-backed ``SharedNotepad``; this slot accepts whichever shape
   * the page wants to mount, so future surfaces (per-role private
   * scratchpad in v2, etc.) can drop in without changing this file.
   */
  notepad?: ReactNode;
  /**
   * Phase B chat-declutter: forwarded to ``Timeline`` so the parent
   * page can clear an active filter when a Timeline-pin click would
   * otherwise dead-no-op against a hidden message. Optional.
   */
  onScrollMissed?: (messageId: string) => void;
}

type RailTab = "artifacts" | "actions" | "timeline";

const TABS: { id: RailTab; label: string }[] = [
  { id: "artifacts", label: "Artifacts" },
  { id: "actions", label: "Action items" },
  { id: "timeline", label: "Timeline" },
];

const PERSIST_KEY = "crittable.rail.activeTab";

/**
 * Right rail — chat-declutter polish (iter-4).
 *
 * Replaces the prior single-section TIMELINE panel with a 3-tab
 * surface mirroring the iter-4 mockup
 * (`docs/mockups/chat-declutter/e-hybrid.html` on the
 * `claude/threaded-replies-investigation-1eekS` branch). Tabs:
 *
 *   - **Artifacts** — pinned cards: substantial ``share_data`` calls
 *     and persistence findings. The "what did we capture?" view.
 *   - **Action items** — open / in-progress TODOs derived from
 *     `address_role` + `pose_choice` calls. The "what's owed?" view.
 *   - **Timeline** — chronological mix: track-opens, critical injects,
 *     pinned beats. The "what happened, in order?" view.
 *
 * The shared notepad still mounts below the tabbed surface; the
 * existing collaborative-notepad work from PR #115 is untouched. The
 * tabs themselves persist their selection via localStorage so the
 * operator's choice survives a tab refresh.
 *
 * Mobile: collapsed into a `<details>` block so the chat stays the
 * primary surface. Each tab's body re-uses the same component as
 * desktop — keyboard nav and aria semantics are identical.
 */
export function RightSidebar({
  messages,
  roles,
  workstreams,
  notepad,
  onScrollMissed,
}: Props) {
  const [active, setActive] = useState<RailTab>(() => {
    try {
      const stored = window.localStorage.getItem(PERSIST_KEY);
      if (stored === "artifacts" || stored === "actions" || stored === "timeline") {
        return stored;
      }
    } catch {
      /* localStorage unavailable */
    }
    return "artifacts";
  });

  function selectTab(next: RailTab): void {
    setActive(next);
    try {
      window.localStorage.setItem(PERSIST_KEY, next);
    } catch {
      /* transient */
    }
  }

  const body = renderTabBody(active, {
    messages,
    roles,
    workstreams: workstreams ?? [],
    onScrollMissed,
  });

  return (
    <>
      <aside className="hidden flex-col gap-4 lg:flex lg:min-h-0 lg:overflow-y-auto lg:pr-1">
        <section
          className="flex min-h-0 flex-col rounded-r-3 border border-ink-600 bg-ink-850"
          style={{ flex: "1 1 0" }}
        >
          <div
            role="tablist"
            aria-label="Right sidebar"
            className="flex border-b border-ink-600 text-[11px]"
          >
            {TABS.map((tab) => (
              <RailTabButton
                key={tab.id}
                tab={tab}
                active={active === tab.id}
                onSelect={() => selectTab(tab.id)}
              />
            ))}
          </div>
          <div
            id={`rail-panel-${active}`}
            role="tabpanel"
            aria-labelledby={`rail-tab-${active}`}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto"
          >
            {body}
          </div>
        </section>
        {notepad ?? null}
      </aside>
      <details
        className="rounded-r-3 border border-ink-600 bg-ink-850 lg:hidden"
        // Closed by default on mobile; players open when they want the sidebar.
      >
        <summary className="mono cursor-pointer px-3 py-2 text-[10px] font-bold uppercase tracking-[0.22em] text-ink-300">
          ARTIFACTS · ACTIONS · TIMELINE &amp; NOTES
        </summary>
        <div className="flex flex-col gap-3 border-t border-dashed border-ink-600 p-3">
          <div
            role="tablist"
            aria-label="Right sidebar (mobile)"
            className="flex border-b border-ink-600 text-[11px]"
          >
            {TABS.map((tab) => (
              <RailTabButton
                key={tab.id}
                tab={tab}
                active={active === tab.id}
                onSelect={() => selectTab(tab.id)}
              />
            ))}
          </div>
          <div
            id={`rail-panel-mobile-${active}`}
            role="tabpanel"
            aria-labelledby={`rail-tab-${active}`}
          >
            {body}
          </div>
          {notepad ?? null}
        </div>
      </details>
    </>
  );
}

function renderTabBody(
  tab: RailTab,
  props: {
    messages: MessageView[];
    roles: RoleView[];
    workstreams: WorkstreamView[];
    onScrollMissed?: (messageId: string) => void;
  },
): ReactNode {
  if (tab === "artifacts") {
    return (
      <ArtifactsRail
        messages={props.messages}
        roles={props.roles}
        workstreams={props.workstreams}
        onScrollMissed={props.onScrollMissed}
      />
    );
  }
  if (tab === "actions") {
    return (
      <ActionItemsRail
        messages={props.messages}
        roles={props.roles}
        workstreams={props.workstreams}
        onScrollMissed={props.onScrollMissed}
      />
    );
  }
  return (
    <Timeline
      messages={props.messages}
      roles={props.roles}
      onScrollMissed={props.onScrollMissed}
    />
  );
}

function RailTabButton({
  tab,
  active,
  onSelect,
}: {
  tab: { id: RailTab; label: string };
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={`rail-tab-${tab.id}`}
      aria-selected={active}
      aria-controls={`rail-panel-${tab.id}`}
      tabIndex={active ? 0 : -1}
      onClick={onSelect}
      className={`mono flex-1 px-2 py-2 font-semibold uppercase tracking-[0.10em] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal ${
        active
          ? "border-b-2 border-signal text-ink-050"
          : "border-b-2 border-transparent text-ink-400 hover:text-ink-100"
      }`}
    >
      {tab.label}
    </button>
  );
}
