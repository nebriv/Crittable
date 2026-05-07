import { confirmLeaveSession } from "../../lib/leaveGuard";
import { Eyebrow } from "../brand/Eyebrow";
import { WIZARD_STEPS, type WizardStepId } from "./wizardSteps";

/**
 * Setup-wizard left rail. Six steps mapped to the brand mock:
 *
 *   01 Scenario          (pre-creation form)
 *   02 Environment       (pre-creation form)
 *   03 Roles             (pre-creation form)
 *   04 Injects & schedule (post-creation: AI proposes plan)
 *   05 Invite players    (post-creation: lobby + join links)
 *   06 Review & launch   (post-creation: scenario summary + START SESSION)
 *
 * The rail is presentational + a few navigation hooks: ``onJumpToStep``
 * lets the parent surface back-nav for completed intro steps (1-3
 * before the session is created — once the session exists the steps
 * are derived from backend state and can't be rewound), and
 * ``onAbandonSession`` adds a destructive "ABANDON SESSION" button at
 * the bottom of the rail post-creation. Putting the destructive
 * action in the rail keeps it geographically distant from step 06's
 * START SESSION button (which lives in the main panel sidecar).
 *
 * Responsive behavior is owned by ``SetupWizard``'s parent grid:
 * below the ``lg`` breakpoint the grid switches from
 * ``[260px_1fr]`` to a single column so the rail stacks ABOVE the
 * panel as a vertical strip (NOT a horizontal top bar — the rail's
 * own children stay in column flow). At ``lg`` and up the rail
 * sits on the left as designed in the brand mock.
 */
interface Props {
  current: WizardStepId;
  /** Set of step ids the user has completed (rendered with a ✓). */
  done: Set<WizardStepId>;
  /**
   * Optional click handler for a step. Only wired by the parent for
   * intro-phase back-nav (steps 1-3 before session creation); always
   * undefined post-creation since the post-creation step is derived
   * from backend state and can't be rewound from the UI.
   */
  onJumpToStep?: (id: WizardStepId) => void;
  /** Bottom-of-rail "ABANDON SESSION" CTA — only rendered when a session exists. */
  onAbandonSession?: () => void;
}

export function WizardRail({ current, done, onJumpToStep, onAbandonSession }: Props) {
  return (
    <aside
      aria-label="Setup steps"
      className="dotgrid wizard-rail"
      style={{
        background: "var(--ink-850)",
        borderRight: "1px solid var(--ink-600)",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minWidth: 0,
      }}
    >
      <a
        href="/"
        aria-label="Crittable home"
        // Wizard chrome is the only chrome shown during setup/ready
        // (issue #113). An accidental click on the lockup would
        // silently destroy the operator's local session state (token,
        // sessionId, draft setup parts, in-flight reply) — the same
        // pattern Facilitator's TopBar / Play.tsx / AAR-popup lockups
        // already guard against with this helper.
        onClick={confirmLeaveSession}
        style={{
          display: "flex",
          alignItems: "center",
          padding: "0 4px 14px",
          textDecoration: "none",
        }}
      >
        <img
          src="/logo/svg/lockup-crittable-dark-transparent.svg"
          alt="Crittable"
          height={28}
          style={{ display: "block", height: 28 }}
        />
      </a>

      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          padding: "14px 8px 8px",
          borderTop: "1px solid var(--ink-600)",
        }}
      >
        <Eyebrow color="var(--ink-200)">SETUP</Eyebrow>
        <span
          className="mono"
          style={{
            fontSize: 11,
            color: "var(--ink-400)",
            letterSpacing: "0.04em",
          }}
        >
          {current} of {WIZARD_STEPS.length}
        </span>
      </div>

      <ol
        style={{
          marginTop: 6,
          display: "flex",
          flexDirection: "column",
          gap: 2,
          listStyle: "none",
          padding: 0,
        }}
      >
        {WIZARD_STEPS.map((s) => {
          const isCurrent = s.id === current;
          const isDone = done.has(s.id);
          const isClickable = Boolean(onJumpToStep) && (isDone || isCurrent);
          const c = isDone
            ? "var(--ink-300)"
            : isCurrent
              ? "var(--signal)"
              : "var(--ink-500)";
          const inner = (
            <>
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  color: c,
                  letterSpacing: "0.04em",
                  fontWeight: 700,
                }}
              >
                {String(s.id).padStart(2, "0")}
              </span>
              <span
                className="sans"
                style={{
                  fontSize: 13,
                  color: isCurrent
                    ? "var(--ink-100)"
                    : isDone
                      ? "var(--ink-200)"
                      : "var(--ink-400)",
                  fontWeight: isCurrent ? 600 : 400,
                }}
              >
                {s.name}
              </span>
              {isDone ? (
                <span
                  style={{
                    marginLeft: "auto",
                    color: "var(--signal)",
                    fontSize: 12,
                  }}
                  aria-hidden="true"
                >
                  ✓
                </span>
              ) : null}
            </>
          );
          const baseStyle = {
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 12px",
            borderRadius: 3,
            background: isCurrent
              ? "color-mix(in oklch, var(--signal) 8%, transparent)"
              : "transparent",
            border: isCurrent
              ? "1px solid var(--signal-deep)"
              : "1px solid transparent",
            width: "100%",
            textAlign: "left" as const,
            font: "inherit",
            color: "inherit",
          };
          return (
            <li key={s.id}>
              {isClickable ? (
                <button
                  type="button"
                  onClick={() => onJumpToStep!(s.id)}
                  aria-current={isCurrent ? "step" : undefined}
                  aria-label={`Step ${s.id}: ${s.name}${isDone ? " (completed)" : isCurrent ? " (current)" : ""}`}
                  style={{ ...baseStyle, cursor: "pointer" }}
                >
                  {inner}
                </button>
              ) : (
                <div
                  aria-current={isCurrent ? "step" : undefined}
                  style={baseStyle}
                >
                  {inner}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {onAbandonSession ? (
        <>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onAbandonSession}
            className="mono"
            style={{
              marginTop: 12,
              background: "transparent",
              color: "var(--ink-400)",
              border: "1px dashed var(--ink-500)",
              padding: "8px 12px",
              borderRadius: 2,
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.16em",
              cursor: "pointer",
            }}
            title="Discard the current draft session and return to the new-session form."
          >
            ABANDON SESSION
          </button>
        </>
      ) : null}
    </aside>
  );
}
