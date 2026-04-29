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
    <aside aria-label="Role roster" className="flex flex-col gap-2">
      <h3 className="text-xs uppercase tracking-widest text-slate-400">Roster</h3>
      <ul
        className={
          isLarge
            ? "flex flex-wrap gap-1"
            : "flex flex-col gap-1"
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
                "flex items-center gap-2 rounded border px-2 py-1 text-xs " +
                (isActive
                  ? "border-emerald-400 bg-emerald-700/30 text-emerald-50"
                  : "border-slate-700 bg-slate-900 text-slate-300")
              }
            >
              {connectedRoleIds ? (
                <span
                  aria-hidden="true"
                  title={isOnline ? "Joined" : "Not yet joined"}
                  className={
                    "inline-block h-2 w-2 shrink-0 rounded-full " +
                    (isOnline ? "bg-emerald-400" : "bg-slate-500")
                  }
                />
              ) : null}
              <span className="min-w-0 flex-1 truncate">
                <span className="font-semibold">{r.label}</span>
                {r.display_name ? <span className="ml-1 text-slate-400">· {r.display_name}</span> : null}
                {r.is_creator ? <span className="ml-1 text-amber-300">★</span> : null}
                {isSelf ? <span className="ml-1 text-sky-300">(you)</span> : null}
                {connectedRoleIds && !isOnline ? (
                  <span className="ml-1 text-slate-500">· not joined</span>
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
