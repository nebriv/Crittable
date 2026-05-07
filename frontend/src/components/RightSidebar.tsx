import {
  useCallback,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

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

  // UI/UX review BLOCK B2: ARIA APG tablist contract requires
  // arrow-key + home/end keyboard navigation across tabs. Without it
  // a keyboard-only user tabs into the active button and is trapped.
  // Roving-tabindex pattern: only the active tab is in the natural
  // tab order; arrow keys move focus + selection, and Tab leaves
  // the tablist into the panel body.
  const onTablistKey = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>, idPrefix: string): void => {
      const idx = TABS.findIndex((t) => t.id === active);
      let nextIdx = idx;
      if (e.key === "ArrowRight") nextIdx = (idx + 1) % TABS.length;
      else if (e.key === "ArrowLeft")
        nextIdx = (idx - 1 + TABS.length) % TABS.length;
      else if (e.key === "Home") nextIdx = 0;
      else if (e.key === "End") nextIdx = TABS.length - 1;
      else return;
      e.preventDefault();
      const nextTab = TABS[nextIdx];
      selectTab(nextTab.id);
      const el = document.getElementById(`${idPrefix}-tab-${nextTab.id}`);
      el?.focus();
    },
    [active],
  );

  return (
    <>
      {/*
        Page-level layout (Play.tsx / Facilitator.tsx) already wraps
        this in a page-level <aside> that gives us:
          1. HUD panel (collapsible)
          2. RightSidebar (this component)
        We add the third section (tabs) + the notepad slot inside the
        component's own <aside>. Critical: the inner <aside> takes
        ``flex-1`` of the page-level aside so a tall tab body doesn't
        push the notepad out of the viewport. Within this inner aside,
        the section fills remaining space (``flex-1 min-h-0``) and its
        BODY div is the only ``overflow-y-auto`` — so:
          - The tablist stays pinned at the top of the section
            (it's outside the body's scroll context).
          - Tab content scrolls internally.
          - The notepad sits at its intrinsic height below the
            section, always visible at the bottom of the rail.
      */}
      <aside className="hidden flex-col gap-4 lg:flex lg:min-h-0 lg:flex-1 lg:pr-1">
        <section className="flex min-h-0 flex-1 flex-col rounded-r-3 border border-ink-600 bg-ink-850">
          {/*
            ``sticky top-0`` keeps the tablist visible when the
            page-level <aside> scrolls (a tall HUD + expanded notepad
            can push the section's top above the visible viewport).
            Pre-fix, participants reported being "stuck on Action
            items" because the tabs scrolled out of view with the
            outer aside and they couldn't reach Artifacts / Timeline.
            Safe to combine with the tabpanel's internal
            ``overflow-y-auto`` below — the H2 regression that caused
            this to be reverted (PR #158 follow-up) only happened when
            the tabpanel had no internal scroll, which let a tall
            body push the notepad off screen.
          */}
          <div
            role="tablist"
            aria-label="Right sidebar"
            onKeyDown={(e) => onTablistKey(e, "rail")}
            className="sticky top-0 z-10 flex rounded-t-3 border-b border-ink-600 bg-ink-850 text-[11px]"
          >
            {TABS.map((tab) => (
              <RailTabButton
                key={tab.id}
                tab={tab}
                active={active === tab.id}
                idPrefix="rail"
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
      {/*
        Mobile: collapses into a <details> block. UI/UX review BLOCK
        B1: the mobile tab buttons MUST use a different id prefix
        (``mrail`` here) than the desktop ones — both trees are in the
        DOM at all viewport sizes (CSS only hides the inactive one),
        and duplicate ids break ``aria-labelledby`` resolution + AT
        navigation.
      */}
      <details
        className="rounded-r-3 border border-ink-600 bg-ink-850 lg:hidden"
      >
        <summary className="mono cursor-pointer px-3 py-2 text-[10px] font-bold uppercase tracking-[0.22em] text-ink-300">
          ARTIFACTS · ACTIONS · TIMELINE &amp; NOTES
        </summary>
        <div className="flex flex-col gap-3 border-t border-dashed border-ink-600 p-3">
          <div
            role="tablist"
            aria-label="Right sidebar (mobile)"
            onKeyDown={(e) => onTablistKey(e, "mrail")}
            className="flex border-b border-ink-600 text-[11px]"
          >
            {TABS.map((tab) => (
              <RailTabButton
                key={tab.id}
                tab={tab}
                active={active === tab.id}
                idPrefix="mrail"
                onSelect={() => selectTab(tab.id)}
              />
            ))}
          </div>
          <div
            id={`mrail-panel-${active}`}
            role="tabpanel"
            aria-labelledby={`mrail-tab-${active}`}
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
  idPrefix,
  onSelect,
}: {
  tab: { id: RailTab; label: string };
  active: boolean;
  /** ``"rail"`` for desktop, ``"mrail"`` for mobile — both trees stay
   *  in the DOM regardless of viewport, so unique id prefixes are
   *  required to keep ``aria-labelledby`` / ``aria-controls`` valid
   *  per the W3C ARIA APG tablist pattern. */
  idPrefix: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={`${idPrefix}-tab-${tab.id}`}
      aria-selected={active}
      aria-controls={`${idPrefix}-panel-${tab.id}`}
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
