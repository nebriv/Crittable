import type { CSSProperties, ReactNode } from "react";
import { SiteHeader } from "./SiteHeader";

type Tone = "neutral" | "warn";

const TONE_BORDER: Record<Tone, string> = {
  neutral: "var(--ink-600)",
  warn: "var(--warn)",
};

/**
 * Full-screen, single-card interstitial chrome shared by the invite gate
 * and the at-capacity notice (and any future one-card screen). Both used
 * to render the identical ``<main> / <SiteHeader> / <section> / card
 * <div>`` stack inline with the same brand tokens; the only differences
 * were the card border colour and the ARIA role. Extracting it keeps the
 * card geometry (maxWidth / marginTop / padding / radius) and the ink
 * tokens in one place so a brand tweak lands once instead of drifting
 * between copy/pasted style blocks (PR #256 review).
 */
export function CenteredCard({
  tone = "neutral",
  role,
  children,
}: {
  /** Border accent: ``neutral`` (ink) for ordinary cards, ``warn`` for
   *  attention states like at-capacity. */
  tone?: Tone;
  /** Passed through to the card container (e.g. ``"alert"`` for the
   *  at-capacity notice so screen readers announce it). */
  role?: string;
  children: ReactNode;
}) {
  const cardStyle: CSSProperties = {
    width: "100%",
    maxWidth: 480,
    marginTop: "8vh",
    padding: 24,
    background: "var(--ink-800)",
    border: `1px solid ${TONE_BORDER[tone]}`,
    borderRadius: 4,
  };
  return (
    <main
      className="grid min-h-screen grid-cols-1"
      style={{ background: "var(--ink-900)" }}
    >
      <SiteHeader />
      <section
        className="flex flex-1 items-start justify-center overflow-auto p-5 lg:p-8"
        style={{ minHeight: 0 }}
      >
        <div role={role} className="flex flex-col gap-5" style={cardStyle}>
          {children}
        </div>
      </section>
    </main>
  );
}
