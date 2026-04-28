import { MessageView, RoleView } from "../api/client";
import { NotesPanel } from "./NotesPanel";
import { Timeline } from "./Timeline";

interface Props {
  messages: MessageView[];
  roles: RoleView[];
  /**
   * localStorage key for the notepad. ``null`` skips the panel — used on the
   * Play page when the role-id can't be parsed from the token, since notes
   * keyed under "anonymous" would merge across players.
   */
  notesStorageKey: string | null;
}

/**
 * Desktop: an always-visible right column. Mobile: collapsed into a
 * ``<details>`` block so the chat stays the primary surface and the user
 * isn't burying scrolling beneath several hundred px of side panels.
 */
export function RightSidebar({ messages, roles, notesStorageKey }: Props) {
  return (
    <>
      <aside className="hidden flex-col gap-4 lg:flex min-h-0">
        <Timeline messages={messages} roles={roles} />
        {notesStorageKey ? <NotesPanel storageKey={notesStorageKey} /> : null}
      </aside>
      <details
        className="rounded border border-slate-700 bg-slate-900 lg:hidden"
        // Closed by default on mobile; players open when they want the sidebar.
      >
        <summary className="cursor-pointer px-3 py-2 text-xs uppercase tracking-widest text-slate-300">
          Timeline &amp; notes
        </summary>
        <div className="flex flex-col gap-3 border-t border-slate-700 p-3">
          <Timeline messages={messages} roles={roles} />
          {notesStorageKey ? <NotesPanel storageKey={notesStorageKey} /> : null}
        </div>
      </details>
    </>
  );
}
