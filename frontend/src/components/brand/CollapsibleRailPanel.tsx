import { useState, type ReactNode } from "react";

/**
 * Right-rail panel wrapper that keeps the brand RailHeader pattern but
 * adds a collapse/expand affordance. Mounts as a ``section`` with the
 * standard ink-850 / ink-600 chrome; the body is hidden when collapsed
 * so the panel takes only its header height (~36px).
 *
 * Designed to share the rail with several stacked panels — the user
 * collapses the ones they aren't using and the next-stacked panel
 * reclaims the vertical space (right-rail is ``overflow-y-auto`` so a
 * single expanded notepad can grow as far as the viewport allows).
 *
 * The header chevron is the brand mono ``▼`` / ``▶``: small, square,
 * no animation. ``localStorage`` persistence is opt-in via
 * ``persistKey`` so a user who collapses the placeholder HUD on Tab A
 * doesn't have to re-collapse it on Tab B.
 */
interface Props {
  title: string;
  /** Optional short label rendered after the title (e.g. ``placeholder``). */
  subtitle?: ReactNode;
  /** Subtitle tone — ``warn`` is the brand "this is a stub" hue. */
  subtitleTone?: "default" | "signal" | "warn";
  /** Initial state on first render. Default: expanded. */
  defaultCollapsed?: boolean;
  /** localStorage key to persist collapse state across reloads. */
  persistKey?: string;
  children: ReactNode;
}

export function CollapsibleRailPanel({
  title,
  subtitle,
  subtitleTone,
  defaultCollapsed = false,
  persistKey,
  children,
}: Props) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (persistKey) {
      try {
        const stored = window.localStorage.getItem(persistKey);
        if (stored === "1") return true;
        if (stored === "0") return false;
      } catch {
        /* localStorage unavailable; fall through to default */
      }
    }
    return defaultCollapsed;
  });

  const subtitleColor =
    subtitleTone === "signal"
      ? "var(--signal)"
      : subtitleTone === "warn"
        ? "var(--warn)"
        : "var(--ink-400)";

  function toggle(): void {
    const next = !collapsed;
    setCollapsed(next);
    if (persistKey) {
      try {
        window.localStorage.setItem(persistKey, next ? "1" : "0");
      } catch {
        /* localStorage unavailable; transient state */
      }
    }
  }

  return (
    <section className="flex min-h-0 flex-col rounded-r-3 border border-ink-600 bg-ink-850">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={toggle}
        className="mono flex items-baseline justify-between gap-2 px-4 py-3 text-left hover:bg-ink-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal"
        style={{ borderBottom: collapsed ? "none" : "1px solid var(--ink-600)" }}
      >
        <span className="flex items-baseline gap-2">
          <span
            aria-hidden="true"
            className="text-[9px] leading-none text-ink-300"
          >
            {collapsed ? "▶" : "▼"}
          </span>
          <span
            className="text-[10px] font-bold uppercase tracking-[0.22em] text-ink-200"
          >
            {title}
          </span>
        </span>
        {subtitle ? (
          <span
            className="mono text-[10px]"
            style={{ color: subtitleColor, letterSpacing: "0.04em" }}
          >
            {subtitle}
          </span>
        ) : null}
      </button>
      {collapsed ? null : (
        <div className="flex min-h-0 flex-col">{children}</div>
      )}
    </section>
  );
}
