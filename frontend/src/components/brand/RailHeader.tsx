import type { ReactNode } from "react";

/**
 * Brand-mock <RailHeader> — section header for left-rail / right-rail
 * panels. Lifted from /tmp/brand-source/handoff/source/app-screens.jsx
 * lines 162-180. Uppercase mono title on the left, optional small mono
 * subtitle on the right.
 *
 * ``inline`` drops the bottom divider for nested headers (e.g. TURN
 * STATE inside the same panel as ROLES).
 */
interface Props {
  title: string;
  subtitle?: ReactNode;
  inline?: boolean;
  /** Optional tone override on the subtitle (e.g. ``warn`` for PLACEHOLDER). */
  subtitleTone?: "default" | "signal" | "warn";
}

export function RailHeader({ title, subtitle, inline, subtitleTone }: Props) {
  const subtitleColor =
    subtitleTone === "signal"
      ? "var(--signal)"
      : subtitleTone === "warn"
        ? "var(--warn)"
        : "var(--ink-400)";
  return (
    <div
      style={{
        padding: inline ? "0 0 4px" : "14px 16px 10px",
        borderBottom: inline ? "none" : "1px solid var(--ink-600)",
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 8,
      }}
    >
      <div
        className="mono"
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: "var(--ink-200)",
          letterSpacing: "0.22em",
        }}
      >
        {title}
      </div>
      {subtitle ? (
        <div
          className="mono"
          style={{
            fontSize: 10,
            color: subtitleColor,
            letterSpacing: "0.04em",
          }}
        >
          {subtitle}
        </div>
      ) : null}
    </div>
  );
}
