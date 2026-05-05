import { FormEvent, ReactNode, useState } from "react";
import { RoleView, ScenarioPlan, api } from "../../api/client";
import { Eyebrow } from "../brand/Eyebrow";

/**
 * Step 5 (Invite players) panel for the setup wizard. Brand mock
 * reference: ``AppLobby`` in design/handoff/source/app-screens.jsx
 * (lines 786-888).
 *
 * Layout (≥ 960 px):
 *   ┌────────────────────────┬─────────────────────┐
 *   │ Helper copy            │  Scenario sidecar:  │
 *   │ ┌────────────────────┐ │  - Plan title       │
 *   │ │ Wide role rows:    │ │  - Roster counts    │
 *   │ │  CODE | name | ●   │ │  - Status hint      │
 *   │ │  | actions...      │ │                     │
 *   │ │ + ADD ROLE form    │ │                     │
 *   │ └────────────────────┘ │                     │
 *   └────────────────────────┴─────────────────────┘
 *
 * Per the issue #113 acceptance criterion, this is intentionally
 * wider + less dense than the in-session ``<RolesPanel/>`` (which
 * lives in a 240 px sidebar). The action handlers (copy / kick /
 * remove / add) call the same ``api.*`` functions ``<RolesPanel/>``
 * does — we render in a different layout, not via different state.
 */
const COPIED_FLASH_MS = 2000;

interface Props {
  sessionId: string;
  creatorToken: string;
  roles: RoleView[];
  busy: boolean;
  plan: ScenarioPlan | null;
  playerCount: number;
  connectedRoleIds: ReadonlySet<string>;
  onRoleAdded: () => void;
  onRoleChanged: () => void;
  onError: (msg: string) => void;
}

export function SetupLobbyView(props: Props) {
  const [newRole, setNewRole] = useState("");
  const [copiedRoleIds, setCopiedRoleIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const origin = window.location.origin;
  const joinedCount = props.roles.filter((r) =>
    props.connectedRoleIds.has(r.id),
  ).length;
  const needPlayers = props.playerCount < 2;
  const needPlan = !props.plan;

  function markCopied(roleId: string) {
    setCopiedRoleIds((prev) => new Set(prev).add(roleId));
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
    if (typeof navigator.clipboard?.writeText !== "function") {
      console.warn("[SetupLobbyView] clipboard API unavailable");
      return false;
    }
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch (err) {
      console.warn("[SetupLobbyView] clipboard write failed", err);
      return false;
    }
  }

  // Both surface (a) the page-level error banner via ``onError`` AND
  // (b) a console.warn breadcrumb. Per CLAUDE.md's logging rules,
  // every page-level setError call should be paired with a
  // matching console.warn so a user pasting their console into a bug
  // report has the failure context.
  function reportError(action: string, err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[SetupLobbyView] ${action} failed`, msg, err);
    props.onError(msg);
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    if (!newRole.trim()) return;
    try {
      const r = await api.addRole(props.sessionId, props.creatorToken, {
        label: newRole.trim(),
      });
      const url = `${origin}/play/${props.sessionId}/${encodeURIComponent(r.token)}`;
      const ok = await writeUrl(url);
      setNewRole("");
      if (ok) markCopied(r.role_id);
      props.onRoleAdded();
    } catch (err) {
      reportError("add role", err);
    }
  }

  async function handleCopy(roleId: string) {
    try {
      const r = await api.reissueRole(
        props.sessionId,
        props.creatorToken,
        roleId,
      );
      const url = `${origin}/play/${props.sessionId}/${encodeURIComponent(r.token)}`;
      if (await writeUrl(url)) markCopied(roleId);
    } catch (err) {
      reportError("reissue role", err);
    }
  }

  async function handleKick(roleId: string, label: string) {
    if (
      !confirm(
        `Kick the player using "${label}"? Their tab will be disconnected and a new join link will be generated.`,
      )
    ) {
      return;
    }
    try {
      const r = await api.revokeRole(
        props.sessionId,
        props.creatorToken,
        roleId,
      );
      const url = `${origin}/play/${props.sessionId}/${encodeURIComponent(r.token)}`;
      if (await writeUrl(url)) markCopied(roleId);
      props.onRoleChanged();
    } catch (err) {
      reportError("revoke role", err);
    }
  }

  async function handleRemove(roleId: string, label: string) {
    if (!confirm(`Remove the "${label}" role from this session?`)) return;
    try {
      await api.removeRole(props.sessionId, props.creatorToken, roleId);
      props.onRoleChanged();
    } catch (err) {
      reportError("remove role", err);
    }
  }

  return (
    // Stack to a single column below ``md`` so a narrow viewport
    // doesn't wrap the sidecar BELOW the role list at unpredictable
    // widths — at ``md`` and up restore the brand-mock 1.2fr/1fr
    // layout.
    <div
      className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,1.2fr)_minmax(280px,1fr)] md:items-start"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
        <p
          className="sans"
          style={{
            margin: 0,
            fontSize: 14,
            color: "var(--ink-300)",
            lineHeight: 1.55,
            maxWidth: 720,
          }}
        >
          Share each role's join link. Players land on a per-role
          briefing — they don't pick a seat from a list. Add or remove
          seats here too; the change is live for everyone in the lobby.
        </p>
        <h2
          className="sans"
          style={{
            margin: 0,
            fontSize: 18,
            fontWeight: 600,
            color: "var(--ink-050)",
          }}
        >
          Lobby · {joinedCount} of {props.roles.length} joined
        </h2>
        <div
          style={{
            background: "var(--ink-850)",
            border: "1px solid var(--ink-600)",
            borderRadius: 4,
          }}
        >
          {props.roles.map((r, i) => (
            <LobbyRow
              key={r.id}
              role={r}
              joined={props.connectedRoleIds.has(r.id)}
              copied={copiedRoleIds.has(r.id)}
              busy={props.busy}
              last={i === props.roles.length - 1}
              onCopy={() => handleCopy(r.id)}
              onKick={() => handleKick(r.id, r.label)}
              onRemove={() => handleRemove(r.id, r.label)}
            />
          ))}
        </div>
        <form
          onSubmit={handleAdd}
          style={{
            display: "flex",
            gap: 8,
            alignItems: "stretch",
          }}
        >
          <input
            type="text"
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            placeholder="e.g. Threat Intel"
            aria-label="New role label"
            style={{
              flex: 1,
              background: "var(--ink-900)",
              border: "1px solid var(--ink-600)",
              borderRadius: 2,
              padding: "10px 14px",
              color: "var(--ink-100)",
              fontFamily: "var(--font-sans)",
              fontSize: 13,
              outline: "none",
            }}
          />
          <button
            type="submit"
            disabled={props.busy || !newRole.trim()}
            className="mono"
            style={{
              background: "var(--signal)",
              color: "var(--ink-900)",
              border: "none",
              padding: "0 22px",
              borderRadius: 2,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.18em",
              cursor: props.busy || !newRole.trim() ? "not-allowed" : "pointer",
              opacity: props.busy || !newRole.trim() ? 0.5 : 1,
            }}
          >
            + ADD ROLE
          </button>
        </form>
      </div>
      <aside
        aria-label="Lobby summary"
        className="md:sticky md:top-0"
        style={{
          background: "var(--ink-850)",
          border: "1px solid var(--ink-600)",
          borderRadius: 4,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <Eyebrow color="var(--signal)">
          {needPlan ? "scenario · drafting" : "scenario · ready"}
        </Eyebrow>
        <div
          className="sans"
          style={{ fontSize: 18, color: "var(--ink-050)", fontWeight: 600 }}
        >
          {props.plan?.title ?? "Plan still drafting…"}
        </div>
        <SidecarStat label="ROLES SEATED" value={String(props.roles.length)} />
        <SidecarStat label="JOINED" value={`${joinedCount} of ${props.roles.length}`} />
        <SidecarStat label="PLAYERS" value={String(props.playerCount)} />
        {props.plan ? (
          <>
            <SidecarStat label="INJECTS" value={String(props.plan.injects.length)} />
            <SidecarStat
              label="OBJECTIVES"
              value={String(props.plan.key_objectives.length)}
            />
          </>
        ) : null}
        <div
          className="mono"
          style={{
            marginTop: 4,
            padding: "10px 12px",
            background:
              needPlan || needPlayers ? "var(--warn-bg)" : "var(--signal-tint)",
            border: `1px solid ${needPlan || needPlayers ? "var(--warn)" : "var(--signal-deep)"}`,
            borderRadius: 3,
            fontSize: 11,
            color: needPlan || needPlayers ? "var(--warn)" : "var(--signal)",
            letterSpacing: "0.06em",
            lineHeight: 1.5,
          }}
        >
          {needPlan
            ? "Plan not finalized yet — finish setup in step 04."
            : needPlayers
              ? `Need at least 2 player roles before launch (currently ${props.playerCount}).`
              : "Ready — advance to step 06 to review and launch."}
        </div>
      </aside>
    </div>
  );
}

function LobbyRow({
  role,
  joined,
  copied,
  busy,
  last,
  onCopy,
  onKick,
  onRemove,
}: {
  role: RoleView;
  joined: boolean;
  copied: boolean;
  busy: boolean;
  last: boolean;
  onCopy: () => void;
  onKick: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      style={{
        padding: "14px 18px",
        borderBottom: last ? "none" : "1px solid var(--ink-600)",
        display: "flex",
        alignItems: "center",
        gap: 16,
        flexWrap: "wrap",
      }}
    >
      <div
        className="mono"
        style={{
          minWidth: 96,
          fontSize: 12,
          fontWeight: 700,
          color: "var(--ink-100)",
          letterSpacing: "0.10em",
          textTransform: "uppercase",
          wordBreak: "break-word",
        }}
        title={role.label}
      >
        {role.label}
      </div>
      <div style={{ flex: 1, minWidth: 120 }}>
        <div
          className="sans"
          style={{
            fontSize: 14,
            color: role.display_name ? "var(--ink-100)" : "var(--ink-400)",
            fontWeight: 500,
            wordBreak: "break-word",
          }}
        >
          {role.display_name ?? "— pending invite —"}
          {role.is_creator ? (
            <span
              className="mono"
              style={{
                color: "var(--signal)",
                marginLeft: 8,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.18em",
              }}
            >
              · YOU
            </span>
          ) : null}
        </div>
      </div>
      <span
        className="mono"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 10px",
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.16em",
          background: joined ? "var(--signal-tint)" : "var(--ink-800)",
          border: `1px solid ${joined ? "var(--signal-deep)" : "var(--ink-500)"}`,
          color: joined ? "var(--signal)" : "var(--ink-300)",
          borderRadius: 2,
        }}
        title={joined ? "Player has opened the join link" : "Join link not opened yet"}
      >
        <span aria-hidden="true">{joined ? "●" : "◐"}</span>
        {joined ? "JOINED" : "INVITE"}
      </span>
      {!role.is_creator ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={onCopy}
            disabled={busy}
            aria-label={`Copy join link for ${role.label}`}
            className="mono"
            style={{
              background: copied ? "var(--signal-tint)" : "transparent",
              color: copied ? "var(--signal)" : "var(--ink-200)",
              border: `1px ${joined ? "solid" : "dashed"} ${copied ? "var(--signal)" : "var(--ink-500)"}`,
              padding: "5px 12px",
              borderRadius: 2,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.16em",
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.5 : 1,
            }}
            title="Re-mint and copy this role's join link."
          >
            {copied ? "COPIED!" : joined ? "COPY LINK" : "+ COPY INVITE"}
          </button>
          {joined ? (
            <button
              type="button"
              onClick={onKick}
              disabled={busy}
              className="mono"
              style={{
                background: "transparent",
                color: "var(--warn)",
                border: "1px solid var(--warn)",
                padding: "5px 12px",
                borderRadius: 2,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.16em",
                cursor: busy ? "not-allowed" : "pointer",
                opacity: busy ? 0.5 : 1,
              }}
              title="Disconnect anyone using the current link and issue a new link."
            >
              KICK
            </button>
          ) : null}
          <button
            type="button"
            onClick={onRemove}
            disabled={busy}
            className="mono"
            style={{
              background: "transparent",
              color: "var(--crit)",
              border: "1px solid var(--crit)",
              padding: "5px 12px",
              borderRadius: 2,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.16em",
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.5 : 1,
            }}
            title="Remove this role from the session."
          >
            REMOVE
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SidecarStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div
      className="mono"
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        fontSize: 11,
        color: "var(--ink-300)",
        letterSpacing: "0.10em",
      }}
    >
      <span>{label}</span>
      <span
        className="tabular-nums"
        style={{ color: "var(--ink-100)", fontWeight: 600 }}
      >
        {value}
      </span>
    </div>
  );
}
