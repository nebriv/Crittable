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
 */
interface Props {
  roles: RoleView[];
  plan: ScenarioPlan;
  playerCount: number;
  connectedRoleIds: ReadonlySet<string>;
  busy: boolean;
  onStart: () => void;
}

export function SetupReviewView(props: Props) {
  const joinedCount = props.roles.filter((r) =>
    props.connectedRoleIds.has(r.id),
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
