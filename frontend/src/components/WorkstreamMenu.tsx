import { useEffect, useRef } from "react";

import { WorkstreamView } from "../api/client";
import { colorForWorkstream } from "../lib/workstreamPalette";

interface Props {
  /** Open at this client-coordinate. Always set when the menu is
   *  visible; null toggles it closed. */
  position: { x: number; y: number } | null;
  /** Currently-selected workstream for the message under the cursor.
   *  Null = the message is unscoped (#main). Highlighted with a check
   *  in the menu. */
  current: string | null;
  workstreams: WorkstreamView[];
  /** Called when the operator picks a target. ``null`` = move back to
   *  ``#main``. */
  onPick: (next: string | null) => void;
  onClose: () => void;
}

/**
 * Right-click contextmenu for manual workstream override
 * (chat-declutter polish). Renders absolutely positioned at the
 * click point. Closes on:
 *   - escape key,
 *   - any mousedown outside the menu,
 *   - selection of an item.
 *
 * Keyboard accessibility: the menu is reachable from the keyboard via
 * the per-message "..." button on each highlightable bubble (separate
 * affordance — see ``Transcript.tsx``). The menu itself has tabIndex on
 * each entry so arrow-key nav works once it's open.
 *
 * Authz is enforced server-side (creator OR message-author). The
 * caller decides whether to render the trigger at all — this menu
 * trusts it. A submission against a forbidden message returns 403
 * from the route, and the page surfaces the error via its toast.
 */
export function WorkstreamMenu({
  position,
  current,
  workstreams,
  onPick,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Close on outside-click / escape. ``onClose`` is the page's
  // "tear down the menu" callback.
  useEffect(() => {
    if (!position) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    function onDown(e: MouseEvent) {
      if (!ref.current) return;
      if (e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [position, onClose]);

  // Focus first item on open so screen readers announce the menu and
  // arrow-key nav is immediately usable.
  useEffect(() => {
    if (!position) return;
    const first = ref.current?.querySelector<HTMLButtonElement>(
      "button[data-menuitem='1']",
    );
    first?.focus();
  }, [position]);

  if (!position) return null;
  const declaredOrder = workstreams.map((w) => w.id);

  // Clamp the menu inside the viewport so a click near the right edge
  // doesn't paint it off-screen.
  const MENU_W = 220;
  const MENU_H = Math.min(40 + (workstreams.length + 1) * 32, window.innerHeight - 16);
  const left = Math.min(position.x, window.innerWidth - MENU_W - 8);
  const top = Math.min(position.y, window.innerHeight - MENU_H - 8);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Move message to workstream"
      className="fixed z-40 flex min-w-[200px] flex-col rounded-r-2 border border-ink-500 bg-ink-850 py-1 shadow-2xl"
      style={{ left, top }}
    >
      <header className="mono px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-ink-300">
        Move to workstream
      </header>
      <MenuItem
        label="#main (unscoped)"
        active={current === null}
        color="var(--ink-500)"
        onSelect={() => {
          onPick(null);
          onClose();
        }}
      />
      {workstreams.map((ws) => (
        <MenuItem
          key={ws.id}
          label={`#${ws.label}`}
          active={current === ws.id}
          color={colorForWorkstream(ws.id, declaredOrder)}
          onSelect={() => {
            onPick(ws.id);
            onClose();
          }}
        />
      ))}
      {workstreams.length === 0 ? (
        <p className="mono px-3 py-2 text-[10px] uppercase tracking-[0.10em] text-ink-500">
          No workstreams declared
        </p>
      ) : null}
    </div>
  );
}

function MenuItem({
  label,
  active,
  color,
  onSelect,
}: {
  label: string;
  active: boolean;
  color: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-menuitem="1"
      onClick={onSelect}
      onKeyDown={(e) => {
        // Basic arrow-down/up nav within the menu.
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const items = Array.from(
          (e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
            "button[data-menuitem='1']",
          ) ?? []),
        );
        const idx = items.indexOf(e.currentTarget);
        const nextIdx =
          e.key === "ArrowDown"
            ? (idx + 1) % items.length
            : (idx - 1 + items.length) % items.length;
        items[nextIdx]?.focus();
      }}
      aria-checked={active}
      className={`flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-ink-800 focus-visible:bg-ink-800 focus-visible:outline-none ${
        active ? "text-ink-050" : "text-ink-200"
      }`}
    >
      <span
        aria-hidden="true"
        className="inline-block h-2.5 w-2.5 shrink-0 rounded-r-0"
        style={{ background: color }}
      />
      <span className="flex-1">{label}</span>
      {active ? (
        <span aria-hidden="true" className="mono text-[10px] text-signal">
          ✓
        </span>
      ) : null}
    </button>
  );
}
