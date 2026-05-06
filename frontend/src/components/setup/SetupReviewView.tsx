import { RoleView, ScenarioPlan } from "../../api/client";
import { Eyebrow } from "../brand/Eyebrow";

/**
 * Step 6 (Review & launch) panel for the setup wizard. Brand mock
 * reference: ``AppLobby`` sidecar in app-screens.jsx (the
 * "scenario · ready" card with the START SESSION CTA).
 *
 * Reached when both gates are clear: plan finalized AND ≥ 2 player
 * roles. The wizard's own ``current`` memo decides step 5 vs 6, so
 * by the time this renders the user can launch — the START SESSION
 * button is the panel's primary CTA, owned by the panel rather
 * than the bottom action bar (which is hidden during wizard chrome).
 *
 * The launch sidecar warns when not every seat has actually joined
 * (i.e. SEATED-but-UNJOINED). The warning is informational, not a
 * gate — solo testing via proxy still requires a one-click launch
 * from an empty lobby. ``onBackToLobby`` (when supplied) renders a
 * "← Back to lobby" affordance so the creator can hop into the
 * step-5 lobby view to copy a missing invite link without
 * abandoning the launch screen.
 */
interface Props {
  roles: RoleView[];
  plan: ScenarioPlan;
  playerCount: number;
  connectedRoleIds: ReadonlySet<string>;
  busy: boolean;
  onStart: () => void;
  onBackToLobby?: () => void;
}

export function SetupReviewView(props: Props) {
  const joinedCount = props.roles.filter((r) =>
    props.connectedRoleIds.has(r.id),
  ).length;
  // ``unjoinedCount`` excludes the creator (always considered
  // present — they're the one looking at this screen). A non-zero
  // value means at least one invitee hasn't opened their join link
  // yet; the AI will see them as ``not_joined`` in Block 10 and
  // route around them. The warning text below makes that contract
  // explicit so the creator isn't surprised when their CISO never
  // gets directly addressed.
  const unjoinedCount = props.roles.filter(
    (r) => !r.is_creator && !props.connectedRoleIds.has(r.id),
  ).length;

  return (
    // Stack to a single column below ``md`` so the START SESSION
    // sidecar doesn't auto-wrap UNDER the plan summary at narrow
    // desktops (the prior layout pushed the primary CTA below the
    // fold). ``order`` keeps the launch sidecar visually first on
    // small viewports too.
    <div
      className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,1.2fr)_minmax(280px,1fr)] md:items-start"
    >
      <section
        // ``order-2 md:order-none`` pushes the plan summary BELOW
        // the launch sidecar on narrow viewports so START SESSION
        // is the first thing the operator sees (was below-the-fold
        // when the grid auto-wrapped pre-fix).
        className="order-2 md:order-none"
        style={{
          background: "var(--ink-850)",
          border: "1px solid var(--ink-600)",
          borderRadius: 4,
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 18,
          minWidth: 0,
        }}
      >
        <header style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Eyebrow color="var(--signal)">plan · finalized</Eyebrow>
          <h2
            className="sans"
            style={{
              margin: 0,
              fontSize: 22,
              fontWeight: 600,
              color: "var(--ink-050)",
              letterSpacing: "-0.01em",
              wordBreak: "break-word",
            }}
          >
            {props.plan.title}
          </h2>
        </header>
        {props.plan.executive_summary ? (
          <p
            className="sans"
            style={{
              margin: 0,
              fontSize: 13,
              color: "var(--ink-200)",
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
            }}
          >
            {props.plan.executive_summary}
          </p>
        ) : null}

        {props.plan.key_objectives.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <Eyebrow color="var(--ink-300)">key objectives</Eyebrow>
            <ul
              className="sans"
              style={{
                margin: 0,
                paddingLeft: 18,
                fontSize: 13,
                color: "var(--ink-100)",
                lineHeight: 1.55,
              }}
            >
              {props.plan.key_objectives.map((o, i) => (
                <li key={i}>{o}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Eyebrow color="var(--ink-300)">roster · {props.roles.length} seated</Eyebrow>
          <ul
            style={{
              margin: 0,
              padding: 0,
              listStyle: "none",
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
            }}
          >
            {props.roles.map((r) => {
              const joined = props.connectedRoleIds.has(r.id);
              return (
                <li
                  key={r.id}
                  className="mono"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "5px 10px",
                    background: "var(--ink-900)",
                    border: `1px solid ${joined ? "var(--signal-deep)" : "var(--ink-500)"}`,
                    borderRadius: 2,
                    fontSize: 11,
                    color: "var(--ink-100)",
                    letterSpacing: "0.06em",
                  }}
                  title={joined ? "Joined" : "Not joined yet"}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      display: "inline-block",
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: joined ? "var(--signal)" : "var(--ink-500)",
                    }}
                  />
                  {r.label}
                  {r.is_creator ? (
                    <span style={{ color: "var(--warn)" }} title="Creator">
                      ★
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <aside
        aria-label="Launch summary"
        // Sticky only at ``md`` and up — on small viewports the
        // sidecar is the first item in the column and stays in
        // normal flow above the plan summary.
        className="md:sticky md:top-0"
        style={{
          background: "var(--ink-850)",
          border: "1px solid var(--signal-deep)",
          borderRadius: 4,
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <Eyebrow color="var(--signal)">scenario · ready</Eyebrow>
        <div
          className="mono"
          style={{
            fontSize: 11,
            color: "var(--ink-300)",
            lineHeight: 1.7,
            letterSpacing: "0.04em",
          }}
        >
          {props.roles.length} ROLES · {props.playerCount} PLAYERS
          <br />
          {joinedCount} JOINED
          <br />
          {props.plan.injects.length} INJECTS QUEUED
          <br />
          {props.plan.key_objectives.length} OBJECTIVES
        </div>
        {/* Presence-aware warning: surface the SEATED-but-UNJOINED
            count so the creator knows the AI will treat those seats
            as empty. Non-blocking — the creator can still launch
            (proxy_submit_as covers the solo / mid-join case). The
            mono+warn styling matches the lobby view's status hint
            so the two sidecar messages read as the same family. */}
        {unjoinedCount > 0 ? (
          <div
            className="mono"
            role="status"
            // ``aria-atomic`` so a presence change mid-view (e.g. a
            // player opens the link while the creator is reading
            // this screen) re-announces the new count rather than
            // only the diff — politeness preserved (``role=status``
            // defaults to ``aria-live=polite``) but the message is
            // self-contained.
            aria-atomic="true"
            style={{
              padding: "10px 12px",
              background: "var(--warn-bg)",
              border: "1px solid var(--warn)",
              borderRadius: 3,
              fontSize: 10,
              color: "var(--warn)",
              letterSpacing: "0.06em",
              lineHeight: 1.5,
            }}
          >
            {unjoinedCount} of {props.roles.length - 1} invitee
            {unjoinedCount === 1 ? "" : "s"}{" "}
            {unjoinedCount === 1 ? "hasn’t" : "haven’t"} opened
            the join link yet. The AI will see those seats as
            <span style={{ fontWeight: 700 }}> not_joined </span>
            and route around them. You can launch anyway and proxy
            their replies, or hop back to the lobby to share invite
            links.
          </div>
        ) : null}
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={props.onStart}
          disabled={props.busy}
          className="mono"
          style={{
            background: "var(--signal)",
            color: "var(--ink-900)",
            border: "none",
            padding: "14px",
            borderRadius: 2,
            fontWeight: 700,
            fontSize: 13,
            letterSpacing: "0.20em",
            cursor: props.busy ? "not-allowed" : "pointer",
            opacity: props.busy ? 0.6 : 1,
          }}
        >
          {props.busy ? "STARTING…" : "START SESSION →"}
        </button>
        {/* Hop back to step 5 (Invite players) without losing this
            screen's launch context. Renders only when the parent
            wired ``onBackToLobby`` (the wizard exposes it; isolated
            previews / tests don't). Subtle styling so it doesn't
            compete with the primary START SESSION CTA. */}
        {props.onBackToLobby ? (
          <button
            type="button"
            onClick={props.onBackToLobby}
            disabled={props.busy}
            className="mono"
            // Explicit aria-label so screen-reader announcement
            // names the destination unambiguously when the launch
            // sidecar is read out of context. The visible label
            // uses ``←`` as a glyph; without an aria-label some
            // SRs would announce only "back to lobby" without the
            // wizard-step destination.
            aria-label="Back to lobby (Step 5: Invite players)"
            style={{
              background: "transparent",
              color: "var(--ink-300)",
              border: "1px dashed var(--ink-500)",
              padding: "8px",
              borderRadius: 2,
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.16em",
              cursor: props.busy ? "not-allowed" : "pointer",
              opacity: props.busy ? 0.5 : 1,
            }}
          >
            ← BACK TO LOBBY
          </button>
        ) : null}
        <div
          className="mono"
          style={{
            fontSize: 10,
            color: "var(--ink-400)",
            textAlign: "center",
            letterSpacing: "0.10em",
          }}
        >
          STATE → BRIEFING → AI_PROCESSING
        </div>
      </aside>
    </div>
  );
}
