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
  /**
   * Server-reported set of role_ids whose tabs are currently connected
   * via WebSocket. Surfaces as a green/grey dot per row so the creator
   * can tell whether an invited player has actually opened the link.
   * See issue #52.
   */
  connectedRoleIds?: ReadonlySet<string>;
}

/**
 * Creator-only role manager: add a role, copy a role's join link, kick
 * (revoke + reissue), or remove a role entirely. Each per-role action is
 * a single round-trip; copies go straight to the clipboard with a
 * transient "Copied!" badge on the originating button — no token ever
 * renders on screen (issue #82, screenshare hijack risk).
 */
const COPIED_FLASH_MS = 2000;

export function RolesPanel({
  sessionId,
  creatorToken,
  roles,
  busy,
  onRoleAdded,
  onRoleChanged,
  onError,
  connectedRoleIds,
}: Props) {
  const [newRole, setNewRole] = useState("");
  // Set of role_ids whose Copy/Add/Kick button is currently flashing
  // "Copied!". Holds no token data — copies happen inside the handler
  // via navigator.clipboard, never via React state.
  const [copiedRoleIds, setCopiedRoleIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Inline confirmation hint shown beneath the form (success, e.g.
  // "Link for SOC Analyst copied"). Lives at the bottom of the panel
  // so a creator with eyes on the form / Slack still sees confirmation
  // even if they missed the in-button "Copied!" flash.
  const [hint, setHint] = useState<string | null>(null);
  // Inline error hint (clipboard denied, etc.) — kept in-panel rather
  // than bubbling through onError so the message lives next to the
  // button the user just clicked. Server-side failures still bubble
  // via onError so the page-level error banner surfaces them.
  const [errorHint, setErrorHint] = useState<string | null>(null);
  // Live-region announcement (sr-only). The in-button "Copied!" flash
  // is now a *visual* affordance: the button keeps the static
  // accessible name "Copy link" so screen readers don't double-
  // announce when the label flips for two seconds.
  const [announcement, setAnnouncement] = useState("");
  const origin = window.location.origin;

  function flash(message: string) {
    setHint(message);
    setErrorHint(null);
    setTimeout(() => {
      setHint((cur) => (cur === message ? null : cur));
    }, 2500);
  }

  function flashError(message: string) {
    setErrorHint(message);
    setHint(null);
    setTimeout(() => {
      setErrorHint((cur) => (cur === message ? null : cur));
    }, 4000);
  }

  function markCopied(roleId: string, label: string) {
    setCopiedRoleIds((prev) => {
      const next = new Set(prev);
      next.add(roleId);
      return next;
    });
    setAnnouncement(`Join link for ${label} copied to clipboard.`);
    setTimeout(() => {
      setCopiedRoleIds((prev) => {
        if (!prev.has(roleId)) return prev;
        const next = new Set(prev);
        next.delete(roleId);
        return next;
      });
    }, COPIED_FLASH_MS);
  }

  async function writeUrl(url: string): Promise<boolean> {
    try {
      await navigator.clipboard?.writeText(url);
      return true;
    } catch (err) {
      console.warn("[RolesPanel] clipboard write failed", err);
      return false;
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!newRole.trim()) return;
    try {
      const r = await api.addRole(sessionId, creatorToken, { label: newRole.trim() });
      const url = `${origin}/play/${sessionId}/${encodeURIComponent(r.token)}`;
      const ok = await writeUrl(url);
      setNewRole("");
      if (ok) {
        markCopied(r.role_id, r.label);
        flash(`Added "${r.label}" — join link copied.`);
      } else {
        flashError(
          `Added "${r.label}", but copying the link failed. Use the new "Copy link" button on the row.`,
        );
      }
      onRoleAdded();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function copyExistingLink(roleId: string, label: string) {
    try {
      const r = await api.reissueRole(sessionId, creatorToken, roleId);
      const url = `${origin}/play/${sessionId}/${encodeURIComponent(r.token)}`;
      const ok = await writeUrl(url);
      if (ok) {
        markCopied(roleId, label);
        flash(`Join link for ${label} copied.`);
      } else {
        flashError(
          "Could not copy link to clipboard. Check browser permissions.",
        );
      }
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
      const ok = await writeUrl(url);
      if (ok) {
        markCopied(roleId, label);
        flash(`Kicked. New join link for ${label} copied — share with the replacement.`);
      } else {
        flashError(
          `Kicked ${label}, but copying the new link failed. Click "Copy link" on the row to retry.`,
        );
      }
      onRoleChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(roleId: string, label: string) {
    if (!confirm(`Remove the "${label}" role from this session?`)) return;
    try {
      await api.removeRole(sessionId, creatorToken, roleId);
      setCopiedRoleIds((prev) => {
        if (!prev.has(roleId)) return prev;
        const next = new Set(prev);
        next.delete(roleId);
        return next;
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
        <span className="text-xs text-slate-400">
          {roles.length} seated
          {connectedRoleIds
            ? ` · ${
                roles.filter((r) => connectedRoleIds.has(r.id)).length
              } joined`
            : null}
        </span>
      </div>
      {connectedRoleIds ? (
        <p
          className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400"
          aria-hidden="true"
        >
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
            joined
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-slate-500" />
            link not opened yet
          </span>
        </p>
      ) : null}

      <ul className="flex flex-col gap-2">
        {roles.map((r) => {
          const isOnline = connectedRoleIds?.has(r.id) ?? false;
          return (
          <li
            key={r.id}
            className="flex flex-col gap-1 rounded border border-slate-700 bg-slate-950 p-2"
          >
            <div className="flex items-baseline justify-between gap-2">
              <div className="flex items-baseline gap-2">
                {connectedRoleIds ? (
                  <span
                    aria-hidden="true"
                    title={isOnline ? "Joined" : "Hasn’t opened the join link yet"}
                    className={
                      "inline-block h-2 w-2 shrink-0 self-center rounded-full " +
                      (isOnline ? "bg-emerald-400" : "bg-slate-500")
                    }
                  />
                ) : null}
                <span className="font-semibold">{r.label}</span>
                {r.display_name ? (
                  <span className="text-xs text-slate-300">{r.display_name}</span>
                ) : null}
                {r.is_creator ? (
                  <span className="text-xs text-amber-300" title="Creator">
                    ★
                  </span>
                ) : null}
                {connectedRoleIds && !isOnline && !r.is_creator ? (
                  <span className="text-[11px] text-slate-500">not joined</span>
                ) : null}
                {connectedRoleIds ? (
                  <span className="sr-only">
                    {isOnline ? "online" : "offline"}
                  </span>
                ) : null}
              </div>
              {!r.is_creator ? (
                <div className="flex flex-wrap gap-1">
                  <button
                    type="button"
                    onClick={() => copyExistingLink(r.id, r.label)}
                    disabled={busy}
                    aria-label="Copy join link"
                    className={
                      "rounded border px-2 py-0.5 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 disabled:opacity-50 " +
                      (copiedRoleIds.has(r.id)
                        ? "border-emerald-500 bg-emerald-900/40 text-emerald-100"
                        : "border-slate-700 text-slate-200 hover:bg-slate-800")
                    }
                    title="Re-mint and copy the join link without invalidating any existing tabs."
                  >
                    {/* Visual flash only — accessible name stays
                        "Copy join link" via aria-label so screen
                        readers don't double-announce when the label
                        flips for 2s. The audible confirmation comes
                        from the panel-level live region below. */}
                    <span aria-hidden="true">
                      {copiedRoleIds.has(r.id) ? "Copied!" : "Copy link"}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => kick(r.id, r.label)}
                    disabled={busy}
                    className="rounded border border-amber-600 px-2 py-0.5 text-xs text-amber-300 hover:bg-amber-900/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300 disabled:opacity-50"
                    title="Disconnect anyone using the current link and issue a new link."
                  >
                    Kick &amp; reissue
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(r.id, r.label)}
                    disabled={busy}
                    className="rounded border border-red-600 px-2 py-0.5 text-xs text-red-300 hover:bg-red-900/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-300 disabled:opacity-50"
                    title="Remove this role from the session."
                  >
                    Remove
                  </button>
                </div>
              ) : null}
            </div>
          </li>
          );
        })}
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
          className="rounded bg-sky-600 px-2 py-1 text-xs font-semibold text-white hover:bg-sky-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 disabled:opacity-50"
        >
          Add role
        </button>
      </form>

      {hint ? (
        <p className="text-xs text-emerald-300" data-testid="roles-panel-hint">
          {hint}
        </p>
      ) : null}
      {errorHint ? (
        <p className="text-xs text-red-300" data-testid="roles-panel-error">
          {errorHint}
        </p>
      ) : null}
      {/* Visually-hidden live region for assistive tech. The in-button
          "Copied!" flash is purely visual; accessible-name double-
          announce was the bug — this is the single source of audible
          confirmation. */}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
