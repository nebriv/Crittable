import type { ReactNode } from "react";
import { StatusChip } from "./StatusChip";

/**
 * Brand-mock <AppTopBar> — the 56 px chrome shared by every screen.
 * Lifted from /tmp/brand-source/handoff/source/app-screens.jsx
 * lines 68-95.
 *
 * Layout: lockup · divider · SESSION label · STATE / TURN / ELAPSED chips
 *         · ml-auto · `right` slot · LIVE chip · avatar.
 *
 * The ``right`` slot is where each context drops its own meta chips
 * (creator: build SHA, God Mode, View AAR, …; player: nothing extra).
 * Pre-session contexts (the landing) pass session=null + state=null
 * to suppress the SESSION/STATE/TURN/ELAPSED group entirely.
 */
interface Props {
  /** Mono session id (e.g. "PROMETHEUS-09"). Null suppresses the entire session group. */
  session?: string | null;
  /** Backend state name for the STATE chip (e.g. "AWAITING_PLAYERS"). */
  state?: string | null;
  /** Turn index (e.g. 7). Null hides the TURN chip. */
  turn?: number | null;
  /** Elapsed wall-clock (e.g. "00:42:18"). Null hides the ELAPSED chip. */
  elapsed?: string | null;
  /** Live count display ("3 / 4"). Null hides the LIVE chip. */
  liveCount?: string | null;
  /** Avatar initials (1-3 chars). Null hides the avatar. */
  avatarInitials?: string | null;
  /** Optional right-slot children for context-specific meta chips. */
  right?: ReactNode;
}

export function SiteHeader({
  session,
  state,
  turn,
  elapsed,
  liveCount,
  avatarInitials,
  right,
}: Props) {
  const stateTone =
    state === "AWAITING_PLAYERS"
      ? "warn"
      : state === "ENDED"
        ? "default"
        : "signal";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "12px 20px",
        background: "var(--ink-850)",
        borderBottom: "1px solid var(--ink-600)",
        height: 56,
        boxSizing: "border-box",
        flexWrap: "wrap",
      }}
    >
      <a
        href="/"
        aria-label="Crittable home"
        style={{ display: "flex", alignItems: "center", textDecoration: "none" }}
      >
        <img
          src="/logo/svg/lockup-crittable-dark.svg"
          alt="Crittable"
          height={28}
          style={{ display: "block" }}
        />
      </a>
      {session ? (
        <>
          <div style={{ width: 1, height: 24, background: "var(--ink-600)" }} />
          <div className="mono" style={{ fontSize: 12, color: "var(--ink-300)" }}>
            SESSION{" "}
            <span style={{ color: "var(--ink-100)", fontWeight: 600 }}>
              {session}
            </span>
          </div>
          {state ? <StatusChip label="STATE" value={state} tone={stateTone} /> : null}
          {turn != null ? <StatusChip label="TURN" value={turn} /> : null}
          {elapsed ? <StatusChip label="ELAPSED" value={elapsed} /> : null}
        </>
      ) : null}
      <div style={{ flex: 1 }} />
      {right}
      {liveCount ? (
        <StatusChip label="● LIVE" value={liveCount} tone="signal" />
      ) : null}
      {avatarInitials ? (
        <div
          className="mono"
          style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            background: "var(--ink-700)",
            border: "1px solid var(--ink-500)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--ink-100)",
            fontSize: 11,
            fontWeight: 700,
            flexShrink: 0,
          }}
          title={avatarInitials}
        >
          {avatarInitials.slice(0, 2).toUpperCase()}
        </div>
      ) : null}
    </div>
  );
}
