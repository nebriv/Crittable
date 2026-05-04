import type { ReactNode } from "react";

import { MessageView, RoleView } from "../api/client";
import { CollapsibleRailPanel } from "./brand/CollapsibleRailPanel";
import { Timeline } from "./Timeline";

interface Props {
  messages: MessageView[];
  roles: RoleView[];
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

/**
 * Desktop: an always-visible right column. Mobile: collapsed into a
 * ``<details>`` block so the chat stays the primary surface and the user
 * isn't burying scrolling beneath several hundred px of side panels.
 *
 * The Timeline is rendered inside a ``CollapsibleRailPanel`` so users
 * can collapse it to give the notepad more vertical space (sessions
 * with few or zero pinned beats produce a small Timeline panel that
 * still ate ~60px of header chrome under the previous layout).
 */
export function RightSidebar({
  messages,
  roles,
  notepad,
  onScrollMissed,
}: Props) {
  return (
    <>
      <aside className="hidden flex-col gap-4 lg:flex lg:min-h-0 lg:overflow-y-auto lg:pr-1">
        <CollapsibleRailPanel
          title="TIMELINE"
          persistKey="crittable.rail.timeline.collapsed"
        >
          <Timeline
            messages={messages}
            roles={roles}
            onScrollMissed={onScrollMissed}
          />
        </CollapsibleRailPanel>
        {notepad ?? null}
      </aside>
      <details
        className="rounded-r-3 border border-ink-600 bg-ink-850 lg:hidden"
        // Closed by default on mobile; players open when they want the sidebar.
      >
        <summary className="mono cursor-pointer px-3 py-2 text-[10px] font-bold uppercase tracking-[0.22em] text-ink-300">
          TIMELINE &amp; NOTES
        </summary>
        <div className="flex flex-col gap-3 border-t border-dashed border-ink-600 p-3">
          <Timeline
            messages={messages}
            roles={roles}
            onScrollMissed={onScrollMissed}
          />
          {notepad ?? null}
        </div>
      </details>
    </>
  );
}
