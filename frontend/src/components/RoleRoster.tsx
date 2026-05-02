import { RoleView } from "../api/client";

interface Props {
  roles: RoleView[];
  activeRoleIds: string[];
  selfRoleId: string | null;
  /**
   * Server-reported set of role_ids whose tabs are currently connected
   * over WebSocket. ``undefined`` hides the online dot entirely (older
   * call sites that don't pipe presence through). See issue #52.
   */
  connectedRoleIds?: ReadonlySet<string>;
}

export function RoleRoster({ roles, activeRoleIds, selfRoleId, connectedRoleIds }: Props) {
  const isLarge = roles.length > 8;
  const active = new Set(activeRoleIds);
  const sorted = [...roles].sort((a, b) => Number(active.has(b.id)) - Number(active.has(a.id)));
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
                    className="ml-1 text-warn"
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
              <span className="sr-only">{isOnline ? "online" : "offline"}</span>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
