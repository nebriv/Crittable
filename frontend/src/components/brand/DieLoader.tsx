import type { CSSProperties } from "react";

/**
 * Brand loading indicator — uses the animated mark SVG (the d6 rolling
 * through its 6 encounter states) as the loading icon. Reserved for
 * "the app is doing something visible to the user that's worth waiting
 * for" surfaces: initial page load, JoinIntro waiting room, AAR
 * generation. Don't sprinkle this everywhere — the brand mark is the
 * one hero asset and it loses meaning if it competes with itself.
 *
 * For small in-flow indicators (e.g. "AI is typing…"), keep using the
 * <ChatIndicator> bouncing-dots pattern. This component is for whole-
 * screen / whole-region wait states only.
 *
 * ``size`` defaults to 96 (works well centered on a viewport-filling
 * surface). ``label`` is the mono caption beneath; pass ``null`` to
 * suppress.
 */
interface Props {
  size?: number;
  label?: string | null;
  className?: string;
  style?: CSSProperties;
}

export function DieLoader({ size = 96, label = "Loading…", className, style }: Props) {
  return (
    <div
      className={className}
      role="status"
      aria-live="polite"
      style={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 14,
        ...style,
      }}
    >
      {/* GIF rather than SMIL-driven SVG — Firefox + Safari don't loop
          the SVG variant reliably. Pick the smallest GIF that beats
          ``size`` so the rendered pixels are crisp without paying for
          the 1024 px tier on every loading screen. */}
      <picture>
        <source
          media="(prefers-reduced-motion: reduce)"
          srcSet="/logo/svg/mark-encounter-01-dark.svg"
        />
        <img
          src={
            size <= 96
              ? "/logo/gif/mark-animated-128-dark.gif"
              : size <= 192
                ? "/logo/gif/mark-animated-256-dark.gif"
                : "/logo/gif/mark-animated-512-dark.gif"
          }
          alt=""
          width={size}
          height={size}
          style={{ display: "block" }}
        />
      </picture>
      {label != null ? (
        <span
          className="mono"
          style={{
            fontSize: 11,
            color: "var(--ink-300)",
            letterSpacing: "0.20em",
            fontWeight: 600,
            textTransform: "uppercase",
          }}
        >
          {label}
        </span>
      ) : null}
    </div>
  );
}
