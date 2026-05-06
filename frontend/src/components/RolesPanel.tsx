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
   * via WebSocket. Surfaces as a tri-state dot per row so the creator
   * can tell whether an invited player has actually opened the link
   * (vs. opened but tabbed away). See issue #52.
   */
  connectedRoleIds: ReadonlySet<string>;
  /**
   * Subset of ``connectedRoleIds`` whose tabs are currently focused /
   * visible. Drives the blue (active) vs yellow (joined but tabbed
   * away) color of the status dot. A role in ``connectedRoleIds`` but
   * not in this set is shown as joined-but-idle.
   */
  focusedRoleIds: ReadonlySet<string>;
}

type RoleStatus = "not_joined" | "joined_active" | "joined_idle";

function computeStatus(
  roleId: string,
  connected: ReadonlySet<string>,
  focused: ReadonlySet<string>,
): RoleStatus {
  if (!connected.has(roleId)) return "not_joined";
  if (focused.has(roleId)) return "joined_active";
  return "joined_idle";
}

const STATUS_DOT_CLASS: Record<RoleStatus, string> = {
  not_joined: "bg-ink-500",
  joined_active: "bg-signal",
  joined_idle: "bg-warn",
};

const STATUS_LABEL: Record<RoleStatus, string> = {
  not_joined: "Not joined",
  joined_active: "Active",
  joined_idle: "Joined, tab not active",
};

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
  focusedRoleIds,
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
  //
  // ``epoch`` increments on every announce(). Same-string assignments
  // would be a React no-op and screen readers wouldn't re-fire — the
  // counter is keyed onto the live-region span so React remounts it
  // each time, making AT treat each copy as a fresh announcement
  // even when the user copies the same role twice in a row.
  const [announcement, setAnnouncement] = useState<{ epoch: number; text: string }>(
    () => ({ epoch: 0, text: "" }),
  );

  function announce(text: string) {
    setAnnouncement((prev) => ({ epoch: prev.epoch + 1, text }));
  }
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
    announce(`Join link for ${label} copied to clipboard.`);
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
    // Optional chaining on `navigator.clipboard?.writeText` resolves
    // to `undefined` on browsers/contexts without the Clipboard API
    // (insecure contexts, older browsers, some embedded webviews).
    // Without an explicit availability check, the await would succeed
    // and we'd flash a false "Copied!" while the URL was never
    // actually written. Explicit check + return false routes through
    // the existing inline-error path.
    if (typeof navigator.clipboard?.writeText !== "function") {
      console.warn(
        "[RolesPanel] clipboard API unavailable (insecure context or unsupported browser)",
      );
      return false;
    }
    try {
      await navigator.clipboard.writeText(url);
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
    <div className="flex min-w-0 flex-col gap-3 rounded-r-3 border border-ink-600 bg-ink-850 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="mono text-[10px] font-bold uppercase tracking-[0.22em] text-ink-300">
          ROLES
        </h3>
        <span className="mono text-[10px] uppercase tracking-[0.04em] text-ink-400 tabular-nums">
          {(() => {
            const joined = roles.filter((r) => connectedRoleIds.has(r.id)).length;
            const active = roles.filter((r) => focusedRoleIds.has(r.id)).length;
            return `${roles.length} seated · ${joined} joined · ${active} active`;
          })()}
        </span>
      </div>
      {/* Legend is in the accessibility tree (so a screen-reader user
          gets the color↔meaning mapping the sighted user just saw);
          only the inert color swatches are ``aria-hidden``. */}
      <p className="mono flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] uppercase tracking-[0.06em] text-ink-400">
        <span className="inline-flex items-center gap-1">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 rounded-full bg-signal"
          />
          active
        </span>
        <span className="inline-flex items-center gap-1">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 rounded-full bg-warn"
          />
          tab not active
        </span>
        <span className="inline-flex items-center gap-1">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 rounded-full bg-ink-500"
          />
          not joined
        </span>
      </p>

      <ul className="flex flex-col gap-2">
        {roles.map((r) => {
          const status = computeStatus(r.id, connectedRoleIds, focusedRoleIds);
          const dotClass = STATUS_DOT_CLASS[status];
          const dotTitle = STATUS_LABEL[status];
          return (
          <li
            key={r.id}
            className="flex flex-col gap-2 rounded-r-1 border border-ink-600 bg-ink-800 p-2"
          >
            {/* Top row: name + display_name + creator star on the
                left; tri-state status dot pinned to the top-right
                corner. The pre-redesign layout collided the action
                buttons with the role name when the panel was narrow —
                the buttons wrapped over the label and the user
                couldn't read who the row belonged to. Buttons now
                live on their own row below (centered) so this row is
                always legible. */}
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="mono break-words font-bold uppercase tracking-[0.06em] text-ink-100">
                  {r.label}
                </span>
                {r.display_name ? (
                  <span className="break-words text-xs text-ink-200">
                    {r.display_name}
                  </span>
                ) : null}
                {r.is_creator ? (
                  <span className="text-xs text-warn" title="Creator">
                    ★
                  </span>
                ) : null}
              </div>
              <span
                aria-hidden="true"
                title={dotTitle}
                className={
                  "mt-1 inline-block h-3 w-3 shrink-0 rounded-full ring-1 ring-ink-900 " +
                  dotClass
                }
              />
              {/* ``Status: Active`` reads coherently in a screen
                  reader's role-card walk; bare "Active" without the
                  ``Status:`` prefix collapsed into the role label
                  ("SOC Analyst Active") with no semantic separation. */}
              <span className="sr-only">{`Status: ${dotTitle}`}</span>
            </div>
            {!r.is_creator ? (
              <div className="flex flex-wrap items-center justify-center gap-1">
                <button
                  type="button"
                  onClick={() => copyExistingLink(r.id, r.label)}
                  disabled={busy}
                  aria-label="Copy join link"
                  className={
                    "mono rounded-r-1 border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.10em] focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal disabled:opacity-50 " +
                    (copiedRoleIds.has(r.id)
                      ? "border-signal bg-signal-tint text-signal"
                      : "border-ink-500 text-ink-200 hover:border-signal hover:text-signal")
                  }
                  title="Re-mint and copy the join link without invalidating any existing tabs."
                >
                  {/* Visual flash only — accessible name stays
                      "Copy join link" via aria-label so screen
                      readers don't double-announce when the label
                      flips for 2s. The audible confirmation comes
                      from the panel-level live region below. */}
                  <span aria-hidden="true">
                    {copiedRoleIds.has(r.id) ? "COPIED!" : "COPY LINK"}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => kick(r.id, r.label)}
                  disabled={busy}
                  className="mono rounded-r-1 border border-warn px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.10em] text-warn hover:bg-warn-bg focus-visible:outline focus-visible:outline-2 focus-visible:outline-warn disabled:opacity-50"
                  title="Disconnect anyone using the current link and issue a new link."
                >
                  KICK
                </button>
                <button
                  type="button"
                  onClick={() => remove(r.id, r.label)}
                  disabled={busy}
                  className="mono rounded-r-1 border border-crit px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.10em] text-crit hover:bg-crit-bg focus-visible:outline focus-visible:outline-2 focus-visible:outline-crit disabled:opacity-50"
                  title="Remove this role from the session."
                >
                  REMOVE
                </button>
              </div>
            ) : null}
          </li>
          );
        })}
      </ul>

      <form onSubmit={add} className="flex flex-col gap-2 border-t border-dashed border-ink-600 pt-3">
        <label className="mono text-[10px] font-bold uppercase tracking-[0.20em] text-signal">+ ADD ROLE</label>
        <input
          value={newRole}
          onChange={(e) => setNewRole(e.target.value)}
          placeholder="IR Lead"
          className="w-full rounded-r-1 border border-ink-600 bg-ink-900 p-2 text-sm text-ink-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal-deep focus:border-signal-deep"
        />
        <button
          type="submit"
          disabled={busy || !newRole.trim()}
          className="mono rounded-r-1 bg-signal px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-ink-900 hover:bg-signal-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal-bright disabled:cursor-not-allowed disabled:opacity-50"
        >
          ADD ROLE →
        </button>
      </form>

      {hint ? (
        <p className="mono text-[10px] uppercase tracking-[0.06em] text-signal" data-testid="roles-panel-hint">
          {hint}
        </p>
      ) : null}
      {errorHint ? (
        <p className="mono text-[10px] uppercase tracking-[0.06em] text-crit" data-testid="roles-panel-error">
          {errorHint}
        </p>
      ) : null}
      {/* Visually-hidden live region for assistive tech. The in-button
          "Copied!" flash is purely visual; accessible-name double-
          announce was the bug — this is the single source of audible
          confirmation. ``key={epoch}`` forces React to remount on
          every announce() so AT re-fires even when the user copies
          the same role twice in a row (a same-string state set is a
          React no-op and screen readers wouldn't otherwise notice). */}
      <span
        key={announcement.epoch}
        className="sr-only"
        role="status"
        aria-live="polite"
      >
        {announcement.text}
      </span>
    </div>
  );
}
