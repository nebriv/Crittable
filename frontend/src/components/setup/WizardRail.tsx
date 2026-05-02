import { Eyebrow } from "../brand/Eyebrow";

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
 * The rail is purely presentational — `current` and `done` are
 * computed by the parent (`SetupWizard`) from the frontend phase
 * (intro / setup / ready) plus user navigation through the 3
 * pre-creation steps. Steps after `current` render dimmed; `done`
 * steps get a signal-blue ✓ marker.
 */
export const WIZARD_STEPS = [
  { id: 1, name: "Scenario" },
  { id: 2, name: "Environment" },
  { id: 3, name: "Roles" },
  { id: 4, name: "Injects & schedule" },
  { id: 5, name: "Invite players" },
  { id: 6, name: "Review & launch" },
] as const;

export type WizardStepId = (typeof WIZARD_STEPS)[number]["id"];

interface Props {
  current: WizardStepId;
  /** Set of step ids the user has completed (rendered with a ✓). */
  done: Set<WizardStepId>;
}

export function WizardRail({ current, done }: Props) {
  return (
    <aside
      className="dotgrid"
      style={{
        background: "var(--ink-850)",
        borderRight: "1px solid var(--ink-600)",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <a
        href="/"
        aria-label="Crittable home"
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

      <div
        style={{
          marginTop: 6,
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        {WIZARD_STEPS.map((s) => {
          const isCurrent = s.id === current;
          const isDone = done.has(s.id);
          const c = isDone
            ? "var(--ink-300)"
            : isCurrent
              ? "var(--signal)"
              : "var(--ink-500)";
          return (
            <div
              key={s.id}
              style={{
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
              }}
            >
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
                >
                  ✓
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
