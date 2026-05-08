import { RoleView } from "../api/client";
import { MarkReadyButton } from "./brand/MarkReadyButton";

interface Props {
  roles: RoleView[];
  activeRoleIds: string[];
  selfRoleId: string | null;
  /**
   * Decoupled-ready (PR #209): per-turn ready set from the snapshot's
   * current_turn — overlaid with any pending optimistic flips upstream
   * before being passed in here. A role's row shows a green ``READY``
   * tag when present; if it's ``selfRoleId`` AND active, the
   * ``<MarkReadyButton>`` below the roster lets the player toggle.
   */
  readyRoleIds?: ReadonlySet<string>;
  /**
   * Fired when the local participant clicks the rail Mark Ready
   * button. The argument is the desired NEW ready state. Parent owns
   * the ``client_seq`` counter and the ``set_ready`` WS dispatch —
   * keeping that one level up means a ``ready_changed`` broadcast for
   * an unrelated role doesn't have to touch this component's state.
   * Omitted when the page can't currently toggle (spectator,
   * non-active role, WS closed) — the button stays rendered but
   * disabled with a tooltip explaining why.
   */
  onSelfMarkReady?: (next: boolean) => void;
  /** Reason the Mark Ready button is disabled (tooltip copy). */
  selfMarkReadyDisabledReason?: string;
  /**
   * True while the local viewer's own ``set_ready`` is in flight —
   * the subtle pulse hints "the server hasn't acked yet" so the user
   * doesn't double-click and burn their flip-cap budget.
   */
  selfMarkReadyInFlight?: boolean;
  /**
   * Server-reported set of role_ids whose tabs are currently connected
   * over WebSocket. ``undefined`` hides the online dot entirely (older
   * call sites that don't pipe presence through). See issue #52.
   */
  connectedRoleIds?: ReadonlySet<string>;
}

export function RoleRoster({
  roles,
  activeRoleIds,
  selfRoleId,
  connectedRoleIds,
  readyRoleIds,
  onSelfMarkReady,
  selfMarkReadyDisabledReason,
  selfMarkReadyInFlight = false,
}: Props) {
  const isLarge = roles.length > 8;
  const active = new Set(activeRoleIds);
  const ready = readyRoleIds ?? new Set<string>();
  const sorted = [...roles].sort((a, b) => Number(active.has(b.id)) - Number(active.has(a.id)));
  const selfIsActive = selfRoleId !== null && active.has(selfRoleId);
  const selfIsReady = selfRoleId !== null && ready.has(selfRoleId);
  // The Mark Ready button shows for every active turn — even if the
  // local viewer isn't on the active set, so they see why their seat
  // is parked. The button itself is only ENABLED when the viewer IS
  // active; a spectator or off-turn player gets the disabled state
  // with a "Not on the active turn" tooltip.
  const showMarkReady =
    selfRoleId !== null && onSelfMarkReady !== undefined && active.size > 0;
  return (
    <aside
      aria-label="Role roster"
      className="flex flex-col gap-2 rounded-r-3 border border-ink-600 bg-ink-850 p-3"
    >
      <h3 className="mono text-[10px] font-bold uppercase tracking-[0.22em] text-ink-300">
        ROSTER · {sorted.length} {sorted.length === 1 ? "ROLE" : "ROLES"}
      </h3>
      <ul
        className={
          isLarge ? "flex flex-wrap gap-1" : "flex flex-col gap-1.5"
        }
      >
        {sorted.map((r) => {
          const isActive = active.has(r.id);
          const isSelf = r.id === selfRoleId;
          const isOnline = connectedRoleIds?.has(r.id) ?? false;
          const isRoleReady = ready.has(r.id);
          return (
            <li
              key={r.id}
              className={
                "flex items-center gap-2 rounded-r-1 border px-2 py-1.5 text-[11px] " +
                (isActive
                  ? "border-signal-deep bg-signal-tint text-ink-050"
                  : "border-ink-600 bg-ink-800 text-ink-200")
              }
            >
              {connectedRoleIds ? (
                <span
                  aria-hidden="true"
                  title={isOnline ? "Joined" : "Not yet joined"}
                  className={
                    "inline-block h-2 w-2 shrink-0 rounded-full " +
                    (isOnline ? "bg-signal" : "bg-ink-500")
                  }
                />
              ) : null}
              <span className="min-w-0 flex-1 truncate">
                <span className="mono font-bold uppercase tracking-[0.06em]">
                  {r.label}
                </span>
                {r.display_name ? (
                  <span className="ml-1 text-ink-400">· {r.display_name}</span>
                ) : null}
                {r.is_creator ? (
                  <span
                    className="ml-1 text-signal"
                    title="Session creator"
                    aria-label="creator"
                  >
                    ★
                  </span>
                ) : null}
                {isSelf ? (
                  <span className="mono ml-1 text-[9px] font-bold uppercase tracking-[0.16em] text-signal">
                    · YOU
                  </span>
                ) : null}
                {connectedRoleIds && !isOnline ? (
                  <span className="mono ml-1 text-[9px] uppercase text-ink-500">
                    · NOT JOINED
                  </span>
                ) : null}
              </span>
              {isActive && isRoleReady ? (
                <span
                  className="mono shrink-0 rounded-r-1 border border-signal bg-signal-tint px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] text-signal"
                  title="Marked ready for this turn"
                >
                  READY ✓
                </span>
              ) : null}
              <span className="sr-only">
                {isOnline ? "online" : "offline"}
                {isActive && isRoleReady ? ", marked ready" : ""}
                {isActive && !isRoleReady ? ", not yet ready" : ""}
              </span>
            </li>
          );
        })}
      </ul>
      {showMarkReady ? (
        <div className="flex flex-col gap-1.5 border-t border-dashed border-ink-600 pt-2">
          <MarkReadyButton
            isReady={selfIsReady}
            enabled={selfIsActive}
            onToggle={(next) => onSelfMarkReady?.(next)}
            inFlight={selfMarkReadyInFlight}
            disabledReason={
              selfMarkReadyDisabledReason ??
              (!selfIsActive
                ? "You aren't on the active turn — Mark Ready isn't your call this beat."
                : undefined)
            }
          />
          {/* User-persona MEDIUM M2: "quorum" is operator-jargon for
              a first-time CISO. Plain copy reads sensibly and matches
              the tooltip in MarkReadyButton ("AI advances once every
              active role is ready"). */}
          <p className="mono text-[9px] uppercase tracking-[0.10em] text-ink-400">
            Once every active seat is ready, the AI moves on.
          </p>
        </div>
      ) : null}
    </aside>
  );
}
