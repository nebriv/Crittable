import { FormEvent, useState } from "react";
import { RoleView, api } from "../api/client";

interface Props {
  sessionId: string;
  creatorToken: string;
  roles: RoleView[];
  busy: boolean;
  onRoleAdded: () => void;
  onRoleChanged: () => void;
  onError: (msg: string) => void;
}

/**
 * Creator-only role manager: add a role, copy a role's join link, kick
 * (revoke + reissue), or remove a role entirely. Each per-role action is
 * a single round-trip; the join URL is rendered inline + auto-copied.
 */
export function RolesPanel({
  sessionId,
  creatorToken,
  roles,
  busy,
  onRoleAdded,
  onRoleChanged,
  onError,
}: Props) {
  const [newRole, setNewRole] = useState("");
  const [linksByRole, setLinksByRole] = useState<Record<string, string>>({});
  const [hint, setHint] = useState<string | null>(null);
  const origin = window.location.origin;

  function flash(message: string) {
    setHint(message);
    setTimeout(() => setHint(null), 2500);
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!newRole.trim()) return;
    try {
      const r = await api.addRole(sessionId, creatorToken, { label: newRole.trim() });
      const url = `${origin}/play/${sessionId}/${encodeURIComponent(r.token)}`;
      setLinksByRole((s) => ({ ...s, [r.role_id]: url }));
      await navigator.clipboard?.writeText(url).catch(() => undefined);
      setNewRole("");
      flash(`Added "${r.label}" — join link copied`);
      onRoleAdded();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function copyExistingLink(roleId: string) {
    try {
      const r = await api.reissueRole(sessionId, creatorToken, roleId);
      const url = `${origin}/play/${sessionId}/${encodeURIComponent(r.token)}`;
      setLinksByRole((s) => ({ ...s, [roleId]: url }));
      await navigator.clipboard?.writeText(url).catch(() => undefined);
      flash("Join link copied to clipboard");
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function kick(roleId: string, label: string) {
    if (
      !confirm(
        `Kick the player using "${label}"? Their tab will be disconnected and a new join link will be generated.`,
      )
    ) {
      return;
    }
    try {
      const r = await api.revokeRole(sessionId, creatorToken, roleId);
      const url = `${origin}/play/${sessionId}/${encodeURIComponent(r.token)}`;
      setLinksByRole((s) => ({ ...s, [roleId]: url }));
      await navigator.clipboard?.writeText(url).catch(() => undefined);
      flash(`Kicked. New join link copied — share with the replacement.`);
      onRoleChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(roleId: string, label: string) {
    if (!confirm(`Remove the "${label}" role from this session?`)) return;
    try {
      await api.removeRole(sessionId, creatorToken, roleId);
      setLinksByRole((s) => {
        const out = { ...s };
        delete out[roleId];
        return out;
      });
      flash(`Removed "${label}".`);
      onRoleChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded border border-slate-700 bg-slate-900 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs uppercase tracking-widest text-slate-300">Roles</h3>
        <span className="text-xs text-slate-400">{roles.length} seated</span>
      </div>

      <ul className="flex flex-col gap-2">
        {roles.map((r) => (
          <li
            key={r.id}
            className="flex flex-col gap-1 rounded border border-slate-700 bg-slate-950 p-2"
          >
            <div className="flex items-baseline justify-between gap-2">
              <div className="flex items-baseline gap-2">
                <span className="font-semibold">{r.label}</span>
                {r.display_name ? (
                  <span className="text-xs text-slate-300">{r.display_name}</span>
                ) : null}
                {r.is_creator ? (
                  <span className="text-xs text-amber-300" title="Creator">
                    ★
                  </span>
                ) : null}
              </div>
              {!r.is_creator ? (
                <div className="flex flex-wrap gap-1">
                  <button
                    type="button"
                    onClick={() => copyExistingLink(r.id)}
                    disabled={busy}
                    className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                    title="Re-mint and copy the join link without invalidating any existing tabs."
                  >
                    Copy link
                  </button>
                  <button
                    type="button"
                    onClick={() => kick(r.id, r.label)}
                    disabled={busy}
                    className="rounded border border-amber-600 px-2 py-0.5 text-xs text-amber-300 hover:bg-amber-900/30 disabled:opacity-50"
                    title="Disconnect anyone using the current link and issue a new link."
                  >
                    Kick &amp; reissue
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(r.id, r.label)}
                    disabled={busy}
                    className="rounded border border-red-600 px-2 py-0.5 text-xs text-red-300 hover:bg-red-900/30 disabled:opacity-50"
                    title="Remove this role from the session."
                  >
                    Remove
                  </button>
                </div>
              ) : null}
            </div>
            {linksByRole[r.id] ? (
              <p className="break-all rounded bg-slate-900 p-1 text-xs text-emerald-300">
                {linksByRole[r.id]}
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      <form onSubmit={add} className="flex flex-col gap-2 border-t border-slate-700 pt-3">
        <label className="text-xs uppercase tracking-widest text-slate-300">Add role</label>
        <input
          value={newRole}
          onChange={(e) => setNewRole(e.target.value)}
          placeholder="IR Lead"
          className="w-full rounded border border-slate-700 bg-slate-950 p-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
        />
        <button
          type="submit"
          disabled={busy || !newRole.trim()}
          className="rounded bg-sky-600 px-2 py-1 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-50"
        >
          Add role
        </button>
      </form>

      {hint ? <p className="text-xs text-emerald-300">{hint}</p> : null}
    </div>
  );
}
