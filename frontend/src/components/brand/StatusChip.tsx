import type { CSSProperties, ReactNode } from "react";

/**
 * Brand-mock <StatusChip> — small mono pill with optional label + value.
 * Lifted verbatim from /tmp/brand-source/handoff/source/app-screens.jsx
 * lines 14-35. Five tones; mono uppercase chrome.
 */
export type ChipTone = "default" | "signal" | "crit" | "warn" | "info";

interface Props {
  /** Mono uppercase eyebrow (rendered at 70% opacity). Optional. */
  label?: ReactNode;
  /** Main value (rendered with tabular-nums). */
  value: ReactNode;
  tone?: ChipTone;
  /** Default true. Set false for sans-serif labels (e.g. role names). */
  mono?: boolean;
  /** Pass-through for layout overrides (e.g. ``flex-1``). */
  className?: string;
  style?: CSSProperties;
  title?: string;
}

const TONES: Record<
  ChipTone,
  { bg: string; fg: string; border: string }
> = {
  default: {
    bg: "var(--ink-700)",
    fg: "var(--ink-100)",
    border: "var(--ink-500)",
  },
  signal: {
    bg: "var(--signal-tint)",
    fg: "var(--signal)",
    border: "var(--signal-deep)",
  },
  crit: { bg: "var(--crit-bg)", fg: "var(--crit)", border: "var(--crit)" },
  warn: { bg: "var(--warn-bg)", fg: "var(--warn)", border: "var(--warn)" },
  info: { bg: "var(--info-bg)", fg: "var(--info)", border: "var(--info)" },
};

export function StatusChip({
  label,
  value,
  tone = "default",
  mono = true,
  className,
  style,
  title,
}: Props) {
  const t = TONES[tone];
  return (
    <div
      className={`${mono ? "mono" : "sans"}${className ? ` ${className}` : ""}`}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 8px",
        borderRadius: 2,
        background: t.bg,
        color: t.fg,
        border: `1px solid ${t.border}`,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.04em",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {label != null ? <span style={{ opacity: 0.7 }}>{label}</span> : null}
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}
