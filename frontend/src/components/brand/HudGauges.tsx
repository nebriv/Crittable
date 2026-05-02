import { RailHeader } from "./RailHeader";

/**
 * Brand-mock <PressureGauge> + the <RightRail> "HUD" panel that wraps
 * three of them. Lifted from /tmp/brand-source/handoff/source/app-screens.jsx
 * lines 37-63 (PressureGauge) and 498-503 (the HUD panel).
 *
 * THESE ARE PLACEHOLDERS — the user explicitly asked to keep them
 * visible but not wire them to live data. The wrapper carries
 * ``data-placeholder="1"`` so any future "wire it up" engineer can
 * grep for it, and the panel's RailHeader subtitle reads PLACEHOLDER
 * (warn-toned) instead of the brand mock's "live" so it's obvious at
 * a glance that the bars aren't real.
 */

interface GaugeProps {
  /** 0..1 — fill fraction. Drives the threshold tone. */
  value: number;
  label: string;
}

function PressureGauge({ value, label }: GaugeProps) {
  const pct = Math.round(value * 100);
  const tone = value > 0.75 ? "crit" : value > 0.55 ? "warn" : "signal";
  const color =
    tone === "crit"
      ? "var(--crit)"
      : tone === "warn"
        ? "var(--warn)"
        : "var(--signal)";
  const TICK_COUNT = 30;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <div
          className="mono"
          style={{
            fontSize: 10,
            color: "var(--ink-300)",
            letterSpacing: "0.18em",
            fontWeight: 600,
          }}
        >
          {label}
        </div>
        <div
          className="mono"
          style={{
            fontSize: 13,
            color,
            fontWeight: 700,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {pct}%
        </div>
      </div>
      <div
        style={{ display: "flex", gap: 2, height: 14 }}
        aria-hidden="true"
      >
        {Array.from({ length: TICK_COUNT }).map((_, i) => {
          const fraction = i / TICK_COUNT;
          const active = fraction < value;
          const tickColor = active
            ? fraction > 0.8
              ? "var(--crit)"
              : fraction > 0.55
                ? "var(--warn)"
                : "var(--signal)"
            : "var(--ink-700)";
          return (
            <div
              key={i}
              style={{ flex: 1, background: tickColor, borderRadius: 1 }}
            />
          );
        })}
      </div>
    </div>
  );
}

interface PanelProps {
  className?: string;
}

/**
 * The 3-gauge HUD panel — drop-in for the right rail. Static demo
 * values mirror the brand mock (0.62 / 0.34 / 0.18). Wrap in any
 * scroll container; the panel itself is fixed-height.
 */
export function HudGauges({ className }: PanelProps) {
  return (
    <div
      className={className}
      data-placeholder="1"
      style={{ display: "flex", flexDirection: "column" }}
    >
      <RailHeader title="HUD" subtitle="placeholder" subtitleTone="warn" />
      <div
        style={{
          padding: 14,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          borderBottom: "1px solid var(--ink-600)",
        }}
      >
        <PressureGauge value={0.62} label="MGMT PRESSURE" />
        <PressureGauge value={0.34} label="CONTAINMENT" />
        <PressureGauge value={0.18} label="BURN RATE" />
      </div>
    </div>
  );
}
