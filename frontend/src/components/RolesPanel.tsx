import { FormEvent, useEffect, useRef, useState } from "react";
import { RoleView, api } from "../api/client";
import { MarkReadyButton } from "./brand/MarkReadyButton";

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
   * visible. Drives the blue (active) vs muted-ink (joined but
   * tabbed away) color of the status dot. A role in
   * ``connectedRoleIds`` but not in this set is shown as
   * joined-but-idle. Idle used to render in warn (amber) but was
   * demoted to a muted ink tone — "tab not focused" is a status, not
   * a warning, and yellow is reserved for the awaiting-response cue
   * to keep "your turn" the only amber signal on screen.
   */
  focusedRoleIds: ReadonlySet<string>;
  /**
   * Decoupled-ready (PR #209): the set of role_ids that have signaled
   * ready on the current turn (snapshot value, overlaid with any
   * pending optimistic flips at the page level). Roles outside this
   * set show as not-yet-ready in the rail; roles inside it show a
   * ``READY ✓`` tag. The Mark Ready toggle is rendered for every
   * ACTIVE role so the creator can also toggle on behalf of an
   * absent player (subject_role_id impersonation).
   */
  readyRoleIds: ReadonlySet<string>;
  /**
   * The set of role_ids on the current turn's active set. The Mark
   * Ready button is rendered (and enabled) only for active roles —
   * marking an off-turn role ready would be a no-op the backend
   * rejects with ``not_active_role`` anyway.
   */
  activeRoleIds: ReadonlySet<string>;
  /**
   * Fired when the creator clicks any roster row's Mark Ready toggle.
   * For their own row, ``subjectRoleId`` is the creator's role; for
   * an active impersonation row, it's the targeted role. Parent owns
   * the ``client_seq`` counter, the ``set_ready`` WS dispatch, and
   * the optimistic-flip overlay.
   */
  onMarkReady?: (subjectRoleId: string, next: boolean) => void;
  /**
   * The creator's own role_id, used to render the self vs.
   * impersonation variants of ``<MarkReadyButton>`` distinctly.
   */
  selfRoleId: string;
  /** Disabled (with tooltip) when the WS is closed or the session
   *  isn't ``AWAITING_PLAYERS``. Renders the buttons greyed out. */
  markReadyEnabled: boolean;
  /** Tooltip surfaced when ``markReadyEnabled=false``. */
  markReadyDisabledReason?: string;
  /**
   * Set of role_ids whose ``set_ready`` is in-flight (parent has a
   * pending optimistic-flip entry waiting on ack/reject/broadcast).
   * Each row's ``<MarkReadyButton>`` gets ``inFlight=true`` while the
   * subject is in this set — surfaces a subtle pulse + ``aria-busy``
   * so a creator slamming the button knows the server hasn't acked
   * yet. UI/UX review MEDIUM M2.
   */
  pendingMarkReadySubjects?: ReadonlySet<string>;
}

/**
 * Two-click confirm pattern for destructive admin actions. First click
 * arms the button (label flips to ``CONFIRM <ACTION>?`` and the row
 * paints in the action's tone); second click within ``ARM_TIMEOUT_MS``
 * actually fires. Click anywhere else, press Escape, or wait the
 * timeout out and the row reverts.
 *
 * Replaces the previous ``confirm()`` browser dialog (which was easy
 * to dismiss via Enter / Space muscle memory and had no in-document
 * visual lead-in). Inline confirm keeps the cursor on the same row
 * the user was already aiming at, and the timeout means a creator
 * who clicked the wrong KICK doesn't have to do anything except
 * pause for the ``ARM_TIMEOUT_MS`` window (currently 4 seconds) to
 * recover. Don't quote the duration as a literal — it'll drift the
 * moment the constant changes (Copilot review on PR #213 caught
 * exactly this drift in an earlier comment that said "two seconds").
 *
 * The Mark Ready button sits on its own row above the destructive
 * row so a fat-finger on a kick can't bleed into a ready toggle (or
 * vice versa). The motivation for the visual separation is the
 * user's explicit ask in PR #213 — the user requested guards on
 * KICK / REMOVE because the new Mark Ready button would land
 * physically adjacent to them.
 */
const ARM_TIMEOUT_MS = 4000;

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
  joined_idle: "bg-ink-300",
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
  readyRoleIds,
  activeRoleIds,
  onMarkReady,
  selfRoleId,
  markReadyEnabled,
  markReadyDisabledReason,
  pendingMarkReadySubjects,
}: Props) {
  // Inline 2-click confirm state. ONE row may be armed at a time; a
  // second ``arm()`` call replaces the first (the corresponding test
  // ``arming KICK on row A and KICK on row B disarms row A`` pins
  // this behavior). The string value is ``${action}:${roleId}`` so a
  // single field encodes both "which row?" and "which action?",
  // letting the per-button render branch on either ``armed === kickKey``
  // or ``armed === removeKey``. The single-armed-at-a-time invariant
  // is intentional: arming two destructive actions simultaneously
  // would multiply the surface area of "what am I about to confirm?"
  // for no real workflow benefit. ``timer`` is held in a ref so
  // re-renders mid-arm don't reset the countdown. (Copilot review on
  // PR #213 caught the prior comment that implied multi-arm support.)
  const [armed, setArmed] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function arm(key: string) {
    setArmed(key);
    if (armTimer.current) clearTimeout(armTimer.current);
    armTimer.current = setTimeout(() => {
      setArmed((cur) => (cur === key ? null : cur));
      armTimer.current = null;
    }, ARM_TIMEOUT_MS);
  }
  function disarm() {
    if (armTimer.current) {
      clearTimeout(armTimer.current);
      armTimer.current = null;
    }
    setArmed(null);
  }
  // Escape disarm + click-outside disarm — wired only while a row is
  // armed so the listeners aren't a permanent allocation. Without
  // these, a keyboard-only creator who armed KICK and changed their
  // mind had no way to back out except waiting 4 s — UI/UX review
  // BLOCK B1. The listeners attach at the document level so a click
  // anywhere outside the panel disarms, mirroring the affordance the
  // browser's native ``confirm()`` dialog provided (Esc / click-out).
  useEffect(() => {
    if (!armed) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        console.debug("[RolesPanel] disarmed via Escape", { armed });
        disarm();
      }
    }
    function onPointerDown(e: PointerEvent) {
      // Don't disarm on clicks that landed on the armed button itself
      // — that's the confirm path. ``data-armed-key`` is set on every
      // armed button so the lookup is O(1) regardless of how many
      // buttons render.
      const target = e.target as HTMLElement | null;
      const armedNode = target?.closest?.("[data-armed-key]") as
        | HTMLElement
        | null;
      if (armedNode?.dataset.armedKey === armed) return;
      console.debug("[RolesPanel] disarmed via outside click", { armed });
      disarm();
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [armed]);
  // Cleanup on unmount — without this the setTimeout would still fire
  // after the component is gone (no observable effect, but a noisy
  // React strict-mode warning during dev about state-on-unmounted).
  useEffect(() => {
    return () => {
      if (armTimer.current) {
        clearTimeout(armTimer.current);
        armTimer.current = null;
      }
    };
  }, []);
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
    // Two-click guard: first click arms; this branch only fires on
    // the second click (or a programmatic call from the keyboard
    // path, which doesn't currently exist). The previous
    // ``confirm()`` dialog was easy to dismiss-by-Enter and offered
    // no in-document lead-in — replaced with an inline armed state
    // (button label flips, row tints) so the creator's eye is
    // already on the action they're about to confirm.
    disarm();
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
    // Two-click guard — see ``kick`` above for the rationale.
    disarm();
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
            className="inline-block h-2 w-2 rounded-full bg-ink-300"
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
          const isActiveRole = activeRoleIds.has(r.id);
          const isReadyRole = readyRoleIds.has(r.id);
          const isSelfRole = r.id === selfRoleId;
          const kickKey = `kick:${r.id}`;
          const removeKey = `remove:${r.id}`;
          const kickArmed = armed === kickKey;
          const removeArmed = armed === removeKey;
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
                  <span className="text-xs text-signal" title="Creator">
                    ★
                  </span>
                ) : null}
                {/* User-persona review MEDIUM M3: drop the inline
                    "READY ✓" tag for active roles — the
                    ``<MarkReadyButton>`` directly below already
                    surfaces the same state with its own checkmark.
                    Two checkmarks an inch apart for the same fact
                    just clutters the rail. The tag is kept for
                    inactive roles that retain a pinned ready flag
                    (rare; covered by the catch-all below). */}
                {!isActiveRole && isReadyRole ? (
                  <span
                    className="mono shrink-0 rounded-r-1 border border-signal bg-signal-tint px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] text-signal"
                    title="Marked ready"
                  >
                    READY ✓
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
              <span className="sr-only">
                {`Status: ${dotTitle}${isActiveRole && isReadyRole ? ", marked ready" : ""}${isActiveRole && !isReadyRole ? ", not yet ready" : ""}`}
              </span>
            </div>
            {/*
              ACTIONS block — Mark Ready (when active) + Admin row
              (Copy/Kick/Remove for non-creators). Single dashed
              divider separates actions from the role-card header;
              within the block, Mark Ready and the admin row share
              ``gap-1.5`` instead of stacking another divider so the
              card reads as one cohesive zone instead of three. The
              fat-finger guard is now: (a) Mark Ready sits on its
              own line at full width above the admin chiplets, and
              (b) the admin chiplets themselves use the inline
              2-click arm-and-confirm. Two dividers per card felt
              busy; one feels load-bearing.
            */}
            {(isActiveRole && onMarkReady) || !r.is_creator ? (
              <div className="flex flex-col gap-1.5 border-t border-dashed border-ink-600 pt-2">
                {isActiveRole && onMarkReady ? (
                  <MarkReadyButton
                    isReady={isReadyRole}
                    enabled={markReadyEnabled}
                    onToggle={(next) => onMarkReady(r.id, next)}
                    variant={isSelfRole ? "self" : "impersonate"}
                    subjectLabel={r.label}
                    disabledReason={markReadyDisabledReason}
                    inFlight={
                      pendingMarkReadySubjects?.has(r.id) ?? false
                    }
                  />
                ) : null}
                {!r.is_creator ? (
                  // Admin chiplets — KICK / REMOVE use the inline
                  // 2-click arm-and-confirm; COPY LINK is one-click
                  // (non-destructive, copies straight to clipboard).
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
                  onClick={() => {
                    if (kickArmed) {
                      void kick(r.id, r.label);
                    } else {
                      arm(kickKey);
                    }
                  }}
                  disabled={busy}
                  // ``data-armed-key`` lets the document-level
                  // pointer-down listener identify the armed button
                  // as the confirm target so its OWN click doesn't
                  // disarm before the click handler fires. The
                  // ``aria-pressed`` semantic was dropped here (UI/UX
                  // review HIGH H2) — the armed state isn't a sticky
                  // toggle, it's a 4 s confirm window. Description
                  // moves to ``aria-describedby`` via an sr-only
                  // span below the row.
                  data-armed-key={kickArmed ? kickKey : undefined}
                  aria-describedby={kickArmed ? `${kickKey}-help` : undefined}
                  className={
                    "mono rounded-r-1 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.10em] hover:bg-warn-bg focus-visible:outline focus-visible:outline-2 focus-visible:outline-warn disabled:opacity-50 " +
                    (kickArmed
                      ? "border border-warn bg-warn-bg text-warn"
                      : "border border-warn text-warn")
                  }
                  title={
                    kickArmed
                      ? "Click again to confirm — disconnects the player and mints a fresh link. Esc or click outside to cancel."
                      : "Disconnect anyone using the current link and issue a new link. Click to arm; click again to confirm."
                  }
                >
                  {kickArmed ? "CONFIRM KICK?" : "KICK"}
                </button>
                {kickArmed ? (
                  <span id={`${kickKey}-help`} className="sr-only">
                    Click again within four seconds to confirm. Press
                    Escape or click outside to cancel.
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    if (removeArmed) {
                      void remove(r.id, r.label);
                    } else {
                      arm(removeKey);
                    }
                  }}
                  disabled={busy}
                  data-armed-key={removeArmed ? removeKey : undefined}
                  aria-describedby={
                    removeArmed ? `${removeKey}-help` : undefined
                  }
                  className={
                    "mono rounded-r-1 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.10em] hover:bg-crit-bg focus-visible:outline focus-visible:outline-2 focus-visible:outline-crit disabled:opacity-50 " +
                    (removeArmed
                      ? "border border-crit bg-crit-bg text-crit"
                      : "border border-crit text-crit")
                  }
                  title={
                    removeArmed
                      ? "Click again to confirm — removes this role from the session entirely. Esc or click outside to cancel."
                      : "Remove this role from the session. Click to arm; click again to confirm."
                  }
                >
                  {removeArmed ? "CONFIRM REMOVE?" : "REMOVE"}
                </button>
                {removeArmed ? (
                  <span id={`${removeKey}-help`} className="sr-only">
                    Click again within four seconds to confirm. Press
                    Escape or click outside to cancel.
                  </span>
                ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </li>
          );
        })}
      </ul>
      {/* Live region announces armed state to AT users so a
          screen-reader operator hears "Kick armed — confirm within
          four seconds" the moment they trigger it. UI/UX review
          HIGH H3. ``key={armed}`` forces React to remount on each
          arm so a same-key arm-then-disarm-then-arm announces every
          time. We deliberately omit ``role="status"`` here — the
          existing copy-link sr-only confirmation already owns that
          role within this panel; ``aria-live="polite"`` on a plain
          span still triggers the announcement and avoids
          ``getByRole("status")`` collisions in tests. */}
      {armed ? (
        <span
          key={armed}
          aria-live="polite"
          className="sr-only"
          data-testid="armed-announcement"
        >
          {armed.startsWith("kick:")
            ? "Kick armed. Click the kick button again within four seconds to confirm, or press Escape to cancel."
            : "Remove armed. Click the remove button again within four seconds to confirm, or press Escape to cancel."}
        </span>
      ) : null}

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
