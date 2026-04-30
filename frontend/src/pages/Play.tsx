import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api, SessionSnapshot } from "../api/client";
import { Composer } from "../components/Composer";
import { CriticalEventBanner } from "../components/CriticalEventBanner";
import { RightSidebar } from "../components/RightSidebar";
import { RoleRoster } from "../components/RoleRoster";
import { Transcript } from "../components/Transcript";
import { ServerEvent, WsClient } from "../lib/ws";

interface Props {
  sessionId: string;
  token: string;
}

const DISPLAY_NAME_KEY = "atf-display-name";

// Receiver-side typing config. ``TYPING_VISIBLE_MS`` is how long an
// indicator survives after the most recent ``typing_start`` arrival
// before the cutoff sweep evicts it. ``TYPING_FADE_HEAD_START_MS`` is
// the head start applied when ``typing_stop`` arrives — i.e. how long
// we keep the chip visible after the sender goes quiet. Together they
// keep the indicator on screen for ~3 seconds of actual conversation
// and prevent the on/off flash reported in issue #53.
const TYPING_VISIBLE_MS = 5000;
const TYPING_FADE_HEAD_START_MS = TYPING_VISIBLE_MS - 1500;

export function Play({ sessionId, token }: Props) {
  const [displayName, setDisplayName] = useState<string | null>(
    () => window.localStorage.getItem(`${DISPLAY_NAME_KEY}:${sessionId}`),
  );
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  // Live AI message-text streaming was producing visible mid-flight
  // revisions: chunks accumulated and rendered in a green "streaming…"
  // bubble, then on ``message_complete`` the bubble was replaced with
  // the final persisted markdown — which sometimes diverges from the
  // raw delta concatenation (different whitespace, tool wrappers, the
  // model emitting two short messages instead of one). Players read
  // that as the AI changing its mind. We now ignore chunk content
  // entirely and only show a typing indicator until the final message
  // lands. ``streamingActive`` tracks whether *some* chunks are still
  // arriving, so the indicator stays "Typing…" (vs. "Thinking…") at
  // that point — a small UX cue that the LLM is actively writing.
  const [streamingActive, setStreamingActive] = useState(false);
  const [criticalBanner, setCriticalBanner] = useState<{
    severity: string;
    headline: string;
    body: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Incrementing counter the Composer watches so it can restore the
  // last-attempted text on a submit-rejected error rather than letting
  // the textarea clear on optimistic-clear-then-fail.
  const [submitErrorEpoch, setSubmitErrorEpoch] = useState(0);
  // Non-error informational toast (e.g. submission was truncated but
  // posted). Distinct from ``error`` because that surface is rendered as
  // a red banner that reads as "your action failed".
  const [notice, setNotice] = useState<string | null>(null);
  const [typing, setTyping] = useState<Record<string, number>>({});
  // Set of role_ids whose tabs are currently connected via WebSocket.
  // Server-driven via ``presence`` / ``presence_snapshot`` events; see
  // issue #52. Used to render the green online dot in RoleRoster so the
  // creator can tell at a glance who has actually opened their join link.
  const [presence, setPresence] = useState<Set<string>>(() => new Set());
  // Real-time "AI is thinking" tracking. Set of in-flight LLM call_ids
  // collected from ``ai_thinking`` WS events. The set's non-emptiness is
  // the authoritative "is the engine working right now" boolean — used
  // alongside the existing state-based heuristic so the indicator lights
  // up even during interject / guardrail / setup / AAR (issue #63).
  const [aiCalls, setAiCalls] = useState<Set<string>>(() => new Set());
  // Labelled status from the turn driver, e.g. recovery pass 2/3.
  // ``phase: null`` (or null state itself) clears the label.
  const [aiStatus, setAiStatus] = useState<{
    phase: "play" | "interject" | "setup" | "briefing" | "aar";
    attempt?: number;
    budget?: number;
    recovery?: string | null;
    forRoleId?: string | null;
  } | null>(null);
  // 3-second client-side cooldown on force-advance — paired with the
  // backend in-flight gate. Prevents the triple-banner cascade from a
  // double/triple click (issue #63).
  const [forceAdvanceCooldown, setForceAdvanceCooldown] = useState(false);
  const wsRef = useRef<WsClient | null>(null);
  const scrollRegionRef = useRef<HTMLDivElement | null>(null);
  const forceAdvanceTimerRef = useRef<number | null>(null);

  // Determine self by inspecting snapshot.roles and matching the role with the
  // missing display_name (server doesn't echo our token; we use the snapshot
  // call for the role list and pick by token-bound role_id encoded in the URL).
  const selfRoleId = useMemo(() => {
    // Decode embedded role_id from the JWT-like itsdangerous payload front
    // (best-effort; the server is the source of truth).
    try {
      const head = token.split(".")[0];
      const padded = head + "=".repeat((4 - (head.length % 4)) % 4);
      const decoded = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
      const parsed = JSON.parse(decoded);
      return typeof parsed.role_id === "string" ? parsed.role_id : null;
    } catch {
      return null;
    }
  }, [token]);

  useEffect(() => {
    if (!displayName) return;
    const ws = new WsClient({
      sessionId,
      token,
      onEvent: (evt) => handleEvent(evt),
    });
    ws.connect();
    wsRef.current = ws;
    refreshSnapshot();
    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayName, sessionId, token]);

  function handleEvent(evt: ServerEvent) {
    switch (evt.type) {
      case "message_chunk":
        // Ignore chunk content; we only render the final message after
        // ``message_complete``. Flip the streaming flag so the typing
        // indicator can read "Typing…" while chunks are flowing.
        if (!streamingActive) setStreamingActive(true);
        break;
      case "message_complete":
        setStreamingActive(false);
        refreshSnapshot();
        break;
      case "state_changed":
        console.info("[play] state changed", evt);
        refreshSnapshot();
        // Clear the labelled status AND the in-flight call set when
        // leaving a busy state. ``ai_thinking`` events use
        // ``record=False``, so a reconnect during an LLM call won't
        // replay the matching ``active=false`` event — without this
        // safety net, ``aiCalls`` could be left non-empty forever and
        // pin the indicator on. ``state_changed`` IS recorded in the
        // replay buffer, so it's the right place to anchor the reset.
        if (evt.state !== "AI_PROCESSING" && evt.state !== "BRIEFING") {
          setAiStatus(null);
          setAiCalls(new Set());
        }
        break;
      case "turn_changed":
        console.info("[play] turn changed", evt);
        refreshSnapshot();
        break;
      case "critical_event":
        setCriticalBanner({ severity: evt.severity, headline: evt.headline, body: evt.body });
        break;
      case "guardrail_blocked":
        // Server now only emits this for ``prompt_injection`` (off_topic
        // is treated as on-topic). Surface verdict + message so the
        // player understands why their text didn't post.
        console.warn("[play] guardrail blocked", evt.verdict, evt.message);
        setError(`Blocked (${evt.verdict}): ${evt.message}`);
        break;
      case "submission_truncated":
        // Distinct from ``error`` — the message DID post, just clipped.
        // Shown as a slate info pill so the player doesn't think their
        // submission failed.
        console.info("[play] submission truncated", evt);
        setNotice(evt.message);
        break;
      case "presence":
        setPresence((prev) => {
          const next = new Set(prev);
          if (evt.active) next.add(evt.role_id);
          else next.delete(evt.role_id);
          return next;
        });
        break;
      case "presence_snapshot":
        setPresence(new Set(evt.role_ids));
        break;
      case "ai_thinking":
        // Reference-counted indicator. Concurrent LLM calls (guardrail
        // + interject) overlap by design, so we add/remove call_ids
        // rather than toggling a single boolean.
        setAiCalls((prev) => {
          const next = new Set(prev);
          if (evt.active) next.add(evt.call_id);
          else next.delete(evt.call_id);
          return next;
        });
        console.debug(
          "[play] ai_thinking",
          evt.active ? "add" : "remove",
          { tier: evt.tier, call_id: evt.call_id },
        );
        break;
      case "ai_status":
        if (evt.phase === null) {
          setAiStatus(null);
        } else {
          setAiStatus({
            phase: evt.phase,
            attempt: evt.attempt,
            budget: evt.budget,
            recovery: evt.recovery,
            forRoleId: evt.for_role_id ?? null,
          });
        }
        console.debug("[play] ai_status", { phase: evt.phase, recovery: evt.recovery });
        break;
      case "typing":
        setTyping((prev) => {
          const next = { ...prev };
          if (evt.typing) {
            // Refresh "last seen typing" so the indicator keeps living.
            next[evt.role_id] = Date.now();
          } else if (evt.role_id in next) {
            // Don't yank the indicator the instant we hear ``typing_stop``
            // — the sender already debounces for 3.5s of idle, so this
            // event is "done for now". Schedule a graceful fade by setting
            // last-seen back so the cutoff sweep removes it ~1.5s from now,
            // avoiding the flash reported in #53.
            next[evt.role_id] = Date.now() - TYPING_FADE_HEAD_START_MS;
          }
          return next;
        });
        break;
      case "error":
        setError(evt.message);
        // ``submit_response`` rejections (e.g. "role cannot submit on
        // this turn" when a turn changes between composer-open and
        // hitting Submit) used to silently clear the textarea — the
        // player's typed reply was gone. Bumping ``submitErrorEpoch``
        // tells the Composer to restore the last attempted text so
        // they can edit / retry / paste it elsewhere.
        if (evt.scope === "submit_response") {
          console.warn("[play] submit rejected — restoring composer text", evt);
          setSubmitErrorEpoch((n) => n + 1);
        }
        break;
      default:
        break;
    }
  }

  // Auto-scroll the chat region to the bottom when new messages or
  // streaming chunks arrive. If the player has scrolled up to re-read
  // an earlier beat (>120px from bottom) we leave their position alone
  // so the chat doesn't yank under them mid-read.
  const messageCount = snapshot?.messages.length ?? 0;
  useEffect(() => {
    const el = scrollRegionRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 120) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messageCount, streamingActive]);

  // Clean up the force-advance cooldown timer on unmount so a tab
  // close mid-cooldown doesn't fire setState on an unmounted component.
  useEffect(() => {
    return () => {
      if (forceAdvanceTimerRef.current !== null) {
        window.clearTimeout(forceAdvanceTimerRef.current);
        forceAdvanceTimerRef.current = null;
      }
    };
  }, []);

  // Expire stale typing entries.
  useEffect(() => {
    const id = setInterval(() => {
      setTyping((prev) => {
        const cutoff = Date.now() - TYPING_VISIBLE_MS;
        const next: Record<string, number> = {};
        let changed = false;
        for (const [k, v] of Object.entries(prev)) {
          if (v >= cutoff) next[k] = v;
          else changed = true;
        }
        return changed ? next : prev;
      });
    }, 750);
    return () => clearInterval(id);
  }, []);

  async function refreshSnapshot() {
    try {
      const snap = await api.getSession(sessionId, token);
      setSnapshot(snap);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleSubmit(text: string) {
    setError(null);
    try {
      wsRef.current?.send({ type: "submit_response", content: text });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleTypingChange(t: boolean) {
    try {
      wsRef.current?.send({ type: t ? "typing_start" : "typing_stop" });
    } catch {
      /* ignore — WS may have closed mid-typing. */
    }
  }

  function handleForceAdvance() {
    if (forceAdvanceCooldown) {
      console.warn("[play] force-advance suppressed (cooldown)");
      return;
    }
    setForceAdvanceCooldown(true);
    // Tracked in a ref so a tab-close mid-cooldown doesn't try to
    // setState on an unmounted component.
    forceAdvanceTimerRef.current = window.setTimeout(() => {
      setForceAdvanceCooldown(false);
      forceAdvanceTimerRef.current = null;
    }, 3000);
    try {
      wsRef.current?.send({ type: "request_force_advance" });
    } catch (err) {
      console.warn("[play] force-advance send failed", err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleEnd() {
    wsRef.current?.send({ type: "request_end_session", reason: "ended by participant" });
  }

  if (!displayName) {
    return <DisplayNameModal onSubmit={(name) => {
      window.localStorage.setItem(`${DISPLAY_NAME_KEY}:${sessionId}`, name);
      setDisplayName(name);
    }} />;
  }

  if (!snapshot) {
    return (
      <main className="flex min-h-screen items-center justify-center text-slate-400">
        Connecting…
      </main>
    );
  }

  // Build the displayed indicator from BOTH the LLM-call boundary
  // (``aiCalls``, authoritative) and the legacy state-based heuristic
  // below. The state-based fallback handles reconnects (``ai_thinking``
  // events are ``record=False``, so they don't replay) and any future
  // driver path that forgets to round-trip through the LLM client.
  const stateBasedAiThinking =
    snapshot.state !== "ENDED" &&
    snapshot.current_turn?.status !== "errored" &&
    (snapshot.state === "AI_PROCESSING" ||
      snapshot.state === "BRIEFING" ||
      snapshot.current_turn?.status === "processing");
  const showAiThinking = aiCalls.size > 0 || streamingActive || stateBasedAiThinking;
  // Compose a human-readable label from the most recent ``ai_status``
  // event. Falls back to "AI thinking…" when the engine hasn't told us
  // anything more specific. Participant-facing copy: we deliberately
  // hide the engineering jargon (``missing_yield`` / ``missing_drive``)
  // from non-operator viewers — they read as "the AI is broken" rather
  // than "the AI is normalising its tool call". The full breadcrumb
  // stays visible to the operator in Facilitator.tsx.
  const aiStatusLabel = (() => {
    if (!showAiThinking) return undefined;
    if (!aiStatus) return undefined;
    if (aiStatus.phase === "play" && aiStatus.recovery) {
      // Surface "Retrying" only on attempt ≥ 2 — the first attempt
      // hasn't actually retried anything yet.
      const a = aiStatus.attempt ?? 1;
      const b = aiStatus.budget ?? 1;
      if (a >= 2) return `Retrying (${a}/${b})`;
      return undefined;
    }
    if (aiStatus.phase === "interject") {
      // "Replying to <self>" is uncanny — render "Composing a reply"
      // when the AI is responding to the local participant.
      if (aiStatus.forRoleId && aiStatus.forRoleId === selfRoleId) {
        return "Composing a reply";
      }
      const role = snapshot?.roles.find((r) => r.id === aiStatus.forRoleId);
      if (!role) return "Composing a reply";
      return `Replying to ${role.label}`;
    }
    if (aiStatus.phase === "briefing") return "Briefing the team";
    if (aiStatus.phase === "setup") return "Preparing the scenario";
    if (aiStatus.phase === "aar") return "Drafting the after-action report";
    return undefined;
  })();
  const activeRoleIds = snapshot.current_turn?.active_role_ids ?? [];
  const submittedRoleIds = snapshot.current_turn?.submitted_role_ids ?? [];
  const iAmActive = selfRoleId !== null && activeRoleIds.includes(selfRoleId);
  const iHaveSubmitted = selfRoleId !== null && submittedRoleIds.includes(selfRoleId);
  // "My turn" = the engine is waiting on me right now. Pre-fix this only
  // checked the active set, so after a player submitted the green
  // "Your turn" banner stayed pinned at the top until the AI replied —
  // making it look like the submission hadn't gone through.
  const isMyTurn = iAmActive && !iHaveSubmitted;
  const myRole = snapshot.roles.find((r) => r.id === selfRoleId);
  const otherPending = activeRoleIds
    .filter((id) => id !== selfRoleId && !submittedRoleIds.includes(id))
    .map((id) => snapshot.roles.find((r) => r.id === id)?.label ?? id);
  const placeholder = isMyTurn
    ? "It's your turn — make your decision."
    : iHaveSubmitted && otherPending.length > 0
      ? `Submitted. Waiting on ${otherPending.join(", ")}.`
      : iHaveSubmitted
        ? "Submitted. Waiting on the AI to respond."
        : otherPending.length > 0
          ? `Waiting for ${otherPending.join(", ")}.`
          : "Waiting for the AI.";

  return (
    <main className="flex min-h-screen flex-col lg:h-screen lg:min-h-0 lg:overflow-hidden">
      {criticalBanner ? (
        <CriticalEventBanner
          {...criticalBanner}
          canAcknowledge={isMyTurn}
          onAcknowledge={() => setCriticalBanner(null)}
        />
      ) : null}
      {snapshot.state === "ENDED" ? (
        <div
          role="status"
          aria-live="polite"
          className="bg-emerald-800 px-4 py-3 text-center text-sm font-semibold text-emerald-50"
        >
          Exercise complete. Thanks for participating — your facilitator can download the AAR.
        </div>
      ) : snapshot.current_turn?.status === "errored" ? (
        // The AI failed to yield via a tool after strict retry. Without
        // this banner, players sit watching no progress and have no idea
        // what's happening — the activity panel that surfaces the error
        // is creator-only.
        <div
          role="status"
          aria-live="polite"
          className="bg-amber-900/70 px-4 py-3 text-center text-sm font-semibold text-amber-100"
        >
          The AI facilitator paused — your facilitator has been notified and
          can resume the exercise.
        </div>
      ) : isMyTurn ? (
        <div
          role="status"
          aria-live="assertive"
          className="bg-emerald-700 px-4 py-2 text-center text-sm font-semibold text-white shadow-lg"
        >
          Your turn — {myRole?.label} ({displayName})
        </div>
      ) : iHaveSubmitted ? (
        // Replace the "Your turn" banner with positive confirmation that
        // the submission landed, plus *who* we're now waiting on. Without
        // this the player sees their message in the chat but the
        // composer + banner state both look identical to "still my turn",
        // which the operator-as-tester just hit.
        <div
          role="status"
          aria-live="polite"
          className="bg-slate-800 px-4 py-2 text-center text-xs text-slate-200 shadow"
        >
          Submitted as {myRole?.label} ({displayName}).{" "}
          {otherPending.length > 0
            ? `Waiting on ${otherPending.join(", ")}.`
            : "Waiting for the AI to respond."}
        </div>
      ) : null}
      <div className="mx-auto grid w-full max-w-7xl flex-1 grid-cols-1 gap-4 p-4 lg:min-h-0 lg:grid-cols-[220px_1fr_280px] lg:overflow-hidden">
        <aside className="flex flex-col gap-4 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
          <RoleRoster
            roles={snapshot.roles}
            activeRoleIds={activeRoleIds}
            selfRoleId={selfRoleId}
            connectedRoleIds={presence}
          />
          <div className="flex flex-col gap-2 rounded border border-slate-700 bg-slate-900 p-2 text-xs">
            <button
              onClick={handleForceAdvance}
              disabled={forceAdvanceCooldown}
              aria-disabled={forceAdvanceCooldown}
              className="rounded border border-amber-500 px-2 py-1 font-semibold text-amber-200 hover:bg-amber-900/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {forceAdvanceCooldown
                ? "Force-advance turn (cooling down)"
                : "Force-advance turn"}
            </button>
            <button
              onClick={handleEnd}
              className="rounded border border-red-500 px-2 py-1 font-semibold text-red-300 hover:bg-red-900/30"
            >
              End session
            </button>
          </div>
        </aside>
        <section className="flex min-w-0 flex-col gap-3 lg:min-h-0 lg:overflow-hidden">
          {/*
            On desktop the Composer must stay pinned at the bottom of the
            section regardless of how long the transcript grows — issue #56
            reported that invited users had no scroll region and the page
            just got taller and taller. We split the section the same way
            Facilitator.tsx does: the transcript scrolls inside its own
            region while Composer + notice + error live below as a
            shrink-0 footer.
          */}
          <div
            ref={scrollRegionRef}
            className="flex min-w-0 flex-col gap-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1"
          >
            <Transcript
              messages={snapshot.messages}
              roles={snapshot.roles}
              aiThinking={showAiThinking}
              aiStatusLabel={
                aiStatusLabel ?? (streamingActive ? "Typing…" : undefined)
              }
              typingRoleIds={Object.keys(typing).filter((rid) => rid !== selfRoleId)}
              highlightLastAi={isMyTurn}
            />
          </div>
          <div className="flex shrink-0 flex-col gap-2">
            {/* Sticky pending-response chip immediately above the composer.
                When the AI addresses one role specifically (e.g. "Ben —
                what's your call?"), the OTHER roles in active_role_ids
                can't tell from their composer placeholder alone that
                they're being waited on too. This chip + the latest-AI
                message highlight (above) make the wait state hard to
                miss without scrolling back to the top banner. */}
            {snapshot.state !== "ENDED" && isMyTurn ? (
              <div
                role="status"
                aria-live="assertive"
                className="rounded border border-amber-500/70 bg-amber-500/10 px-3 py-1.5 text-center text-xs font-semibold text-amber-200"
              >
                ⚠ Awaiting your response — {myRole?.label ?? "you"}
              </div>
            ) : null}
            <Composer
              enabled={isMyTurn && snapshot.state !== "ENDED"}
              placeholder={placeholder}
              onSubmit={handleSubmit}
              onTypingChange={handleTypingChange}
              submitErrorEpoch={submitErrorEpoch}
            />
            {notice ? (
              <p
                role="status"
                aria-live="polite"
                className="rounded border border-slate-600/60 bg-slate-800/60 px-2 py-1 text-xs text-slate-200"
              >
                {notice}{" "}
                <button
                  type="button"
                  onClick={() => setNotice(null)}
                  className="ml-1 underline hover:text-slate-100"
                >
                  dismiss
                </button>
              </p>
            ) : null}
            {error ? <p className="text-sm text-red-400" role="alert">{error}</p> : null}
          </div>
        </section>
        <RightSidebar
          messages={snapshot.messages}
          roles={snapshot.roles}
          notesStorageKey={(() => {
            if (!selfRoleId) return null;
            const role = snapshot.roles.find((r) => r.id === selfRoleId);
            const v = role?.token_version ?? 0;
            return `atf-notes:${sessionId}:${selfRoleId}:v${v}`;
          })()}
        />
      </div>
    </main>
  );
}

function DisplayNameModal({ onSubmit }: { onSubmit: (name: string) => void }) {
  const [name, setName] = useState("");
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  // Use a native <dialog open> so the browser handles focus-trap +
  // background-inert + Escape semantics for free.
  useEffect(() => {
    const el = dialogRef.current;
    if (el && !el.open && typeof el.showModal === "function") {
      el.showModal();
    }
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit(name.trim());
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 p-6">
      <dialog
        ref={dialogRef}
        aria-labelledby="display-name-heading"
        aria-modal="true"
        className="rounded border border-slate-700 bg-slate-900 text-slate-100 backdrop:bg-slate-950/80"
      >
        <form
          onSubmit={submit}
          method="dialog"
          className="flex w-full max-w-md flex-col gap-3 p-6"
        >
          <h1 id="display-name-heading" className="text-lg font-semibold">
            Join the tabletop exercise
          </h1>
          <label className="text-xs uppercase tracking-widest text-slate-300" htmlFor="display-name">
            Your display name
          </label>
          <input
            id="display-name"
            autoFocus
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded border border-slate-700 bg-slate-950 p-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
          />
          <button
            type="submit"
            className="self-end rounded bg-sky-600 px-3 py-1 text-sm font-semibold text-white hover:bg-sky-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300"
          >
            Continue
          </button>
        </form>
      </dialog>
    </main>
  );
}
