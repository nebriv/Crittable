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
  /** Issue #162: current "hidden from AI" state of the message. The
   *  menu's mute toggle reads this for the checked state. */
  hiddenFromAi: boolean;
  /** Issue #162: invoked when the operator flips the mute toggle.
   *  The page calls the REST endpoint and the WS broadcast lands a
   *  ``message_hidden_from_ai_changed`` event for the local tab. */
  onToggleHiddenFromAi: (next: boolean) => void;
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
  hiddenFromAi,
  onToggleHiddenFromAi,
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
  // doesn't paint it off-screen. Issue #162: the mute toggle adds one
  // more row below the workstream list — height budget bumped to
  // account for the extra section header + entry.
  //
  // Sub-agent review HIGH H-1: the prior `top = Math.min(...)` could
  // resolve to a negative number on a viewport shorter than MENU_H
  // (mobile / small popup window) — the header would paint above the
  // top of the viewport. Wrap with ``Math.max(8, ...)`` so the menu
  // is always at least 8px from the top edge; on a too-short viewport
  // the bottom edge spills off, which is recoverable (scroll), unlike
  // a clipped header.
  const MENU_W = 240;
  const MENU_H = Math.min(
    80 + (workstreams.length + 1) * 32 + 32,
    window.innerHeight - 16,
  );
  const left = Math.max(
    8,
    Math.min(position.x, window.innerWidth - MENU_W - 8),
  );
  const top = Math.max(
    8,
    Math.min(position.y, window.innerHeight - MENU_H - 8),
  );

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Message actions"
      className="fixed z-40 flex min-w-[220px] flex-col rounded-r-2 border border-ink-500 bg-ink-850 py-1 shadow-2xl"
      style={{ left, top }}
    >
      <header className="mono px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-ink-300">
        Move to workstream
      </header>
      {/*
        UI/UX review HIGH H1: per W3C ARIA, ``aria-checked`` is valid
        only on ``role="menuitemradio"`` / ``"menuitemcheckbox"``,
        not on a plain ``"menuitem"``. The radio variant is the right
        fit here: exactly one workstream is current per message, so
        the radiogroup semantics announce "Containment, 2 of 3,
        checked" the way a screen-reader user expects.
      */}
      <div role="group" aria-label="Workstream targets">
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
      </div>
      {workstreams.length === 0 ? (
        <p className="mono px-3 py-2 text-[10px] uppercase tracking-[0.10em] text-ink-500">
          No workstreams declared
        </p>
      ) : null}
      {/* Issue #162: per-message AI mute toggle. Lives in the same
          right-click menu so the operator's authz check (creator OR
          message-author) and the trigger affordance stay consolidated.
          The divider keeps the two sections visually distinct — moving
          a message between workstreams is a categorization action, the
          mute is a visibility action, and the menu treats them as
          separate columns of the same surface. */}
      <div
        role="separator"
        aria-orientation="horizontal"
        className="my-1 border-t border-ink-700"
      />
      <header className="mono px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-ink-300">
        Visibility
      </header>
      <button
        type="button"
        role="menuitemcheckbox"
        data-menuitem="1"
        data-testid="hidden-from-ai-toggle"
        aria-checked={hiddenFromAi}
        onClick={() => {
          onToggleHiddenFromAi(!hiddenFromAi);
          onClose();
        }}
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          const root = e.currentTarget.closest("[role='menu']");
          const items = Array.from(
            root?.querySelectorAll<HTMLButtonElement>(
              "button[data-menuitem='1']",
            ) ?? [],
          );
          const idx = items.indexOf(e.currentTarget);
          const nextIdx =
            e.key === "ArrowDown"
              ? (idx + 1) % items.length
              : (idx - 1 + items.length) % items.length;
          items[nextIdx]?.focus();
        }}
        className={`flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-ink-800 focus-visible:bg-ink-800 focus-visible:outline-none ${
          hiddenFromAi ? "text-ink-050" : "text-ink-200"
        }`}
      >
        <span
          aria-hidden="true"
          className={`mono inline-block h-2.5 w-2.5 shrink-0 rounded-r-0 border ${
            hiddenFromAi
              ? "border-signal bg-signal"
              : "border-ink-400 bg-transparent"
          }`}
        />
        <span className="flex-1">Hidden from AI</span>
        {hiddenFromAi ? (
          <span aria-hidden="true" className="mono text-[10px] text-signal">
            ON
          </span>
        ) : null}
      </button>
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
      role="menuitemradio"
      data-menuitem="1"
      onClick={onSelect}
      onKeyDown={(e) => {
        // Basic arrow-down/up nav within the menu. We query from the
        // ``role="menu"`` ancestor (closest match) rather than the
        // immediate parent so the radio-group wrapper added in the
        // H1 a11y fix doesn't fragment the navigation set.
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const root = e.currentTarget.closest("[role='menu']");
        const items = Array.from(
          root?.querySelectorAll<HTMLButtonElement>(
            "button[data-menuitem='1']",
          ) ?? [],
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
