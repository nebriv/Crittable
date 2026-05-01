import type { ReactNode } from "react";

/**
 * Brand-mock <Eyebrow> — small uppercase mono label that sits above
 * a sans headline. Used in app-screens.jsx for "step 03 · roles",
 * "your role · CSE", "after-action report", etc. Color is
 * configurable via the ``color`` prop (defaults to signal).
 */
interface Props {
  children: ReactNode;
  /** CSS color value. Defaults to ``var(--signal)``. */
  color?: string;
}

export function Eyebrow({ children, color = "var(--signal)" }: Props) {
  return (
    <div
      className="mono"
      style={{
        fontSize: 10,
        color,
        letterSpacing: "0.22em",
        fontWeight: 700,
        textTransform: "uppercase",
      }}
    >
      {children}
    </div>
  );
}
