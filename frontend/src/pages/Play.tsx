import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api, SessionSnapshot } from "../api/client";
import { Composer } from "../components/Composer";
import { CriticalEventBanner } from "../components/CriticalEventBanner";
import { RightSidebar } from "../components/RightSidebar";
import { RoleRoster } from "../components/RoleRoster";
import { Transcript } from "../components/Transcript";
import { isMidSessionJoiner } from "../lib/proxy";
import { useStickyScroll } from "../lib/useStickyScroll";
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

  // Snapshot fetch runs unconditionally so the join-intro page can
  // show the player's role label + scenario context (was: gated on
  // displayName, which meant the intro page had nothing to render).
  useEffect(() => {
    refreshSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, token]);

  // WebSocket is gated on displayName because we want the intro page
  // to be a clean read-only landing — opening the WS before the user
  // has acknowledged the role brief produces "Player joined" pings
  // that read as them being present when they haven't actually
  // engaged yet.
  useEffect(() => {
    if (!displayName) return;
    const ws = new WsClient({
      sessionId,
      token,
      onEvent: (evt) => handleEvent(evt),
    });
    ws.connect();
    wsRef.current = ws;
    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayName, sessionId, token]);

  function handleEvent(evt: ServerEvent) {
    switch (evt.type) {
      case "message_chunk":
        // Ignore chunk content; we only render the final message after
        // ``message_complete``. Flip the streaming flag so the typing
        // indicator can read "Typing…" while chunks are flowing.
        // ``setStreamingActive(true)`` is idempotent — React bails out
        // on equal-value sets — so we don't guard against a stale
        // closure read of ``streamingActive`` here. (``WsClient``
        // captures ``onEvent`` once at mount, so any guard would be
        // reading stale state anyway.)
        setStreamingActive(true);
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
      case "participant_renamed":
        // Player set their display_name via the join intro (or any
        // future self-rename surface). Refresh the snapshot so the
        // updated name appears in transcript headers, the active-
        // role banner, and the roster.
        console.info("[play] participant renamed", evt);
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
  // streaming chunks arrive. ``useStickyScroll`` pins to the bottom on
  // the player's initial mount (so a participant joining mid-exercise
  // lands on the latest beat instead of the top of a long transcript —
  // issue #79) and on incoming content while they're within 120px of
  // the bottom. If they've scrolled up to re-read, their position is
  // left alone. A local submit force-pins so they always see their own
  // message commit.
  const messageCount = snapshot?.messages.length ?? 0;
  // ``streamingActive`` is a pin trigger (we want the AI's streamed
  // bubble to follow the user's pinned position as it grows) but NOT
  // an unread trigger — the chip should only appear when an actual
  // new message has landed, not when the typing indicator flips on /
  // off. Pass a narrowed unread-deps tuple to gate that.
  const {
    scrollRef: scrollRegionRef,
    forceScrollToBottom,
    hasUnreadBelow,
  } = useStickyScroll(
    [messageCount, streamingActive],
    [messageCount],
  );

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
    // Pin the chat to the bottom on the next render so the player sees
    // their own message commit, even if they happened to be reading
    // earlier content. Mirrors what every chat client does on send.
    forceScrollToBottom();
    try {
      wsRef.current?.send({ type: "submit_response", content: text });
      // Issue #78: confirm out-of-turn submits inline so the user
      // doesn't think "did it post? did the AI hear me?" while waiting
      // on the active roles. ``isMyTurn`` is computed from the snapshot
      // at render time, so capturing it here is correct for the just-
      // sent submission.
      //
      // Question-style submissions trip the backend ``run_interject``
      // side-channel and typically get an inline AI reply within a few
      // seconds, so the "AI will see this on its next turn" copy is
      // misleading for them. We approximate the backend's
      // ``_looks_like_question`` heuristic with a trimmed-trailing-?
      // check (the prefix path — "can we …" without a ? — is the
      // minority case; the generic "noted" copy still reads correctly
      // there if it ends up routed to the next turn instead of an
      // interject). Both branches deliver the same core reassurance
      // (your message landed; here's what happens next), differentiated
      // so the user isn't told "wait until next turn" when the AI is
      // already composing a reply.
      if (!isMyTurn) {
        const looksLikeQuestion = text.trim().endsWith("?");
        setNotice(
          looksLikeQuestion
            ? "Posted as a sidebar — if the AI reads this as a question it'll reply inline; otherwise it sees it on its next turn."
            : "Posted as a sidebar — the AI will see this on its next turn.",
        );
      }
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
    // Pin the chat to the bottom so the participant sees the AI's next
    // beat land. Mirrors Facilitator.tsx's force-advance behavior so
    // the "consistent for the creator and the user" half of issue #79
    // covers force-advance, not just submit.
    forceScrollToBottom();
    try {
      wsRef.current?.send({ type: "request_force_advance" });
    } catch (err) {
      console.warn("[play] force-advance send failed", err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleEnd() {
    // Issue #81: button is rendered only when the local participant is
    // the creator. Backend manager.end_session also gates by creator
    // role; this guard is just early UX. Left intact (rather than
    // inlined into the JSX onClick) so a future "request that the
    // creator end" flow can re-wire the same handler.
    try {
      wsRef.current?.send({ type: "request_end_session", reason: "ended by creator" });
    } catch (err) {
      console.warn("[play] end-session send failed", err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const myRoleFromSnapshot = snapshot?.roles.find((r) => r.id === selfRoleId);
  const serverDisplayName = myRoleFromSnapshot?.display_name ?? null;
  // Server is the source of truth; if it has a name we use that. Pre-
  // fix the gate looked at localStorage only, which meant: (a) a user
  // returning on a different browser (no localStorage entry) was
  // forced through JoinIntro again even though the server knew them;
  // (b) a user with a stale localStorage entry from before this
  // deploy skipped JoinIntro and never POSTed their name, so peers
  // saw the bare role label forever.
  const effectiveDisplayName = serverDisplayName ?? displayName;

  // Reconcile local ``displayName`` state with the server. Two
  // directions are possible:
  //
  // 1. **Server has it, local doesn't** — fresh browser / cleared
  //    localStorage / different device. Hydrate local from server
  //    so the rest of the UI ("Your turn — {role} ({name})") has a
  //    name to render. No network call.
  //
  // 2. **Local has it, server doesn't** — pre-server-persist deploy
  //    or a long-lived tab. Quietly POST the local name so peers see
  //    it. Best-effort; a failure just means the user might have
  //    to re-enter via JoinIntro on a future visit.
  //
  // Without this, case (1) leaves the active-role banner reading
  // "Your turn — Cybersecurity Manager ()" with empty parens, and
  // case (2) is the bug Copilot flagged: peers never see the name.
  useEffect(() => {
    if (!myRoleFromSnapshot) return;
    if (serverDisplayName && !displayName) {
      window.localStorage.setItem(
        `${DISPLAY_NAME_KEY}:${sessionId}`,
        serverDisplayName,
      );
      setDisplayName(serverDisplayName);
      return;
    }
    if (!serverDisplayName && displayName) {
      api.setSelfDisplayName(sessionId, token, displayName).catch((err) => {
        console.warn("[play] background display_name sync failed", {
          session_id: sessionId,
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }
    // ``myRoleFromSnapshot?.id`` keeps the effect from re-running on
    // unrelated snapshot churn (messages, turns, etc.).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverDisplayName, displayName, sessionId, token, myRoleFromSnapshot?.id]);

  // Issue #76: a participant who has submitted their display name but
  // arrived while the creator is still drafting the plan was previously
  // dropped onto the main page with a blank transcript and a disabled
  // composer pinned to the bottom — "looks funny with a chat box and
  // all the blank space" (issue comment). Hold them on JoinIntro
  // instead, with the form swapped for a "Waiting for the facilitator
  // to start" panel + tip carousel. Auto-resolves the moment the
  // session transitions to AWAITING_PLAYERS / AI_PROCESSING / etc.
  const isWaitingForSessionStart =
    snapshot?.state === "SETUP" || snapshot?.state === "BRIEFING";

  if (!effectiveDisplayName || isWaitingForSessionStart) {
    // Pre-fix this was a tiny "what's your name?" dialog that operators
    // routinely missed (the user's report — "I'm not sure if Bridget
    // was prompted to enter her name at all"). The intro page now
    // names the role, sets expectations for AI interaction, and
    // posts the entered name to the server so peers see it (was:
    // localStorage-only, invisible to other clients). When ``hasName``
    // is true but the session hasn't started, the form is replaced by
    // a spinner panel so the user has somewhere friendly to wait
    // (issue #76).
    return (
      <JoinIntro
        sessionId={sessionId}
        token={token}
        roleLabel={myRoleFromSnapshot?.label}
        roleKind={myRoleFromSnapshot?.kind}
        roleExistingDisplayName={serverDisplayName}
        scenarioPrompt={snapshot?.scenario_prompt}
        sessionState={snapshot?.state}
        snapshotLoaded={snapshot !== null}
        snapshotError={snapshot === null ? error : null}
        hasName={Boolean(effectiveDisplayName)}
        joinedDisplayName={effectiveDisplayName}
        joinedSeatCount={presence.size}
        onRetry={() => {
          setError(null);
          refreshSnapshot();
        }}
        onJoined={(name) => {
          window.localStorage.setItem(`${DISPLAY_NAME_KEY}:${sessionId}`, name);
          setDisplayName(name);
        }}
      />
    );
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
  // Fail closed: an undefined ``myRole`` (token's role_id missing from
  // snapshot.roles, e.g. mid-rehydrate) must NOT light up the composer.
  // The backend WS gate still rejects, but disabling here keeps the
  // loud red error banner off the screen during the brief gap.
  const isPlayer = !!myRole && myRole.kind !== "spectator";
  // Issue #81: only the creator gets the End-session affordance. Any
  // participant pressing it would have torn the exercise down for
  // everyone — backend now rejects that path too, but the button
  // shouldn't even render for non-creators.
  const isSelfCreator = myRole?.is_creator ?? false;
  const otherPending = activeRoleIds
    .filter((id) => id !== selfRoleId && !submittedRoleIds.includes(id))
    .map((id) => snapshot.roles.find((r) => r.id === id)?.label ?? id);
  // Issue #78: composer is enabled for any participant whenever the
  // session is ``AWAITING_PLAYERS`` so out-of-turn comments / follow-
  // ups can land in the transcript. Spectators stay locked out (the WS
  // layer would reject anyway). ``ENDED`` / ``AI_PROCESSING`` /
  // ``BRIEFING`` are also disabled — the backend would reject those on
  // submit, so disabling client-side is just early UX.
  const composerEnabled =
    isPlayer && snapshot.state === "AWAITING_PLAYERS";
  // "Your turn" stays as the at-a-glance label only when this viewer
  // is actually on the active set; otherwise we soften to "Add a
  // comment" so a non-active player typing into the still-enabled
  // composer doesn't read it as "this counts as my turn answer".
  const composerLabel = isMyTurn
    ? "Your turn"
    : iHaveSubmitted
      ? "Add a follow-up"
      : composerEnabled
        ? "Add a comment"
        : "Your message";
  // Plain-English placeholder copy — the user-persona review flagged
  // "interject" as jargon that reads as rude. We surface the
  // distinction (counts vs. sidebar) in the label + the post-submit
  // toast instead.
  const placeholder = isMyTurn
    ? "It's your turn — make your decision."
    : iHaveSubmitted && otherPending.length > 0
      ? `Submitted. You can add a follow-up while waiting on ${otherPending.join(", ")}.`
      : iHaveSubmitted
        ? "Submitted. You can add a follow-up while the AI replies."
        : composerEnabled
          ? otherPending.length > 0
            ? `Add a comment anytime — waiting on ${otherPending.join(", ")}.`
            : "Add a comment anytime — waiting for the AI."
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
      ) : isMidSessionJoiner({
        sessionState: snapshot.state,
        iAmActive,
        messages: snapshot.messages,
        selfRoleId,
      }) ? (
        // Issue #80 bonus: cue for a participant whose role was added
        // mid-session. See ``isMidSessionJoiner`` for the predicate;
        // here we just render the chip when it's true.
        <div
          role="status"
          aria-live="polite"
          data-testid="mid-session-joiner-chip"
          className="bg-slate-800 px-4 py-2 text-center text-xs text-slate-200 shadow"
        >
          Just joined? You'll be brought into the next turn — sit
          tight, the current beat is finishing up.
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
            {isSelfCreator ? (
              <button
                onClick={handleEnd}
                className="rounded border border-red-500 px-2 py-1 font-semibold text-red-300 hover:bg-red-900/30"
              >
                End session
              </button>
            ) : null}
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
          {/* "New messages below" chip — appears when a message arrives
              while the user has scrolled up to re-read. Clicking it
              re-pins to the bottom. Mirrors the standard chat-app
              pattern (Slack / Discord) so an unpinned user knows
              there's content below without being yanked off whatever
              they were reading. Solid sky/blue rather than amber:
              the "Awaiting your response" banner directly below uses
              amber, and an amber-on-slate chip blended into it. Sky
              is the only saturated color not already in the palette
              (amber=awaiting/critical, emerald=AI, red=critical,
              slate=system, sky-700/30=player bubbles — but the chip
              is solid sky-500 which reads as distinct from the
              translucent player-bubble border). */}
          {hasUnreadBelow ? (
            // Live-region semantics live on the wrapper, not the
            // button. Per ARIA APG: live regions should be applied to
            // a non-interactive container so screen readers announce
            // the surfaced text without misinterpreting the
            // interactive control as the announcement target. The
            // button stays a plain button.
            <div
              className="pointer-events-none flex shrink-0 justify-center"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <button
                type="button"
                onClick={forceScrollToBottom}
                className="pointer-events-auto -mt-12 mb-1 rounded-full border border-sky-300 bg-sky-500 px-4 py-1.5 text-xs font-semibold text-white animate-chip-pulse hover:bg-sky-400 motion-reduce:animate-none motion-reduce:shadow-lg motion-reduce:ring-2 motion-reduce:ring-sky-500/30"
              >
                New messages below ↓
              </button>
            </div>
          ) : null}
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
                // Polite (not assertive) because the top "Your turn"
                // banner already does an assertive announcement when
                // ``isMyTurn`` flips on. Two assertive regions firing
                // simultaneously trains screen-reader users to ignore
                // both. The chip is visual reinforcement; the polite
                // region is a quieter follow-up.
                aria-live="polite"
                className="rounded border border-amber-500/70 bg-amber-500/10 px-3 py-1.5 text-center text-xs font-semibold leading-tight text-amber-200 break-words"
              >
                ⚠ Awaiting your response — {myRole?.label ?? "you"}
              </div>
            ) : null}
            <Composer
              enabled={composerEnabled}
              label={composerLabel}
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

interface JoinIntroProps {
  sessionId: string;
  token: string;
  roleLabel?: string;
  /** ``"player"`` | ``"spectator"`` from the snapshot. Spectators get
   *  a read-only variant of the "How to play" copy because their
   *  composer never unlocks; the original copy promised
   *  participation-style interaction and confused them. */
  roleKind?: "player" | "spectator";
  roleExistingDisplayName: string | null;
  scenarioPrompt?: string;
  sessionState?: string;
  /** ``true`` once the snapshot fetch has resolved. Pre-fix the page
   *  rendered a generic header until the fetch completed, which let
   *  participants click Begin against an undefined role label.
   *  Now we render a loading skeleton until the snapshot lands. */
  snapshotLoaded: boolean;
  /** Surface for the snapshot fetch failure (network blip, expired
   *  token). Without this the page renders forever with no role
   *  label and no error explanation. */
  snapshotError: string | null;
  /** Retry handler for the snapshot-error branch. */
  onRetry: () => void;
  onJoined: (name: string) => void;
  /** Issue #76: the participant has submitted (or already had on the
   *  server) a display name, so the name+Begin form is unnecessary.
   *  When this is true AND the session is still SETUP/BRIEFING, we
   *  swap the form for a "Waiting for the facilitator to start"
   *  panel with a tip carousel. Otherwise it's the original form. */
  hasName?: boolean;
  /** Display name to show in the waiting-panel subhead. Only read
   *  when ``hasName`` is true. */
  joinedDisplayName?: string | null;
  /** Number of *other* roles the WS layer has reported as connected.
   *  Renders as "N seats joined" momentum cue in the waiting panel.
   *  Sourced from the parent's presence Set so it auto-updates as
   *  peers open their tabs. */
  joinedSeatCount?: number;
}

/**
 * Tip carousel content for the "joined, waiting for session to start"
 * variant of JoinIntro (issue #76). Each tip is short — the panel is
 * a wait state, not a tutorial — and rotates every ~7 seconds. Order
 * is intentional: introduces the conversational tone first, then
 * deepens into mechanics.
 */
const WAITING_TIPS: readonly string[] = [
  "When the AI throws an inject, ask clarifying questions before committing to an action.",
  "Want logs? Just ask — \"pull the auth logs\" or \"what does Defender show?\". The AI will produce realistic synthetic data.",
  "Disagree with a teammate? Say so. The AI tracks decisions and dissents in the AAR.",
  "Out of your lane? \"Loop in Legal\" or \"hand off to Comms\" — the AI will pivot the conversation.",
  "There's no scoring. The AAR captures decisions and rationale, not right-versus-wrong answers.",
];
const WAITING_TIP_ROTATE_MS = 7000;

/**
 * Replaces the prior tiny "what's your name?" dialog. The user reported
 * they had to verbally coach a participant on how to interact with the
 * AI ("ask it questions, push back, propose alternatives") — the old
 * modal didn't communicate any of that. This page:
 *
 * - Names the role they've been invited as so they don't have to read
 *   the URL or guess.
 * - Asks for a display name (was: localStorage only; now POSTs to the
 *   ``set_self_display_name`` endpoint so peers see the name).
 * - Lays out a short "How to play" guide so a participant who's never
 *   used a Claude-driven tabletop knows what kind of input the AI
 *   expects.
 *
 * The form is a single CTA — name + "Begin" — because the goal is to
 * ship the participant into the chat as fast as possible while still
 * giving them the prereq context.
 */
export function JoinIntro({
  sessionId,
  token,
  roleLabel,
  roleKind,
  roleExistingDisplayName,
  scenarioPrompt,
  sessionState,
  snapshotLoaded,
  snapshotError,
  onRetry,
  onJoined,
  hasName = false,
  joinedDisplayName = null,
  joinedSeatCount = 0,
}: JoinIntroProps) {
  const [name, setName] = useState(roleExistingDisplayName ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tip carousel index for the waiting variant (issue #76). Lives at
  // the top of the component (not inside a conditional) so React's
  // hook order rule is respected when the user transitions from the
  // form variant to the waiting variant inside a single mount.
  const [tipIndex, setTipIndex] = useState(0);
  const isWaitingVariant =
    hasName && (sessionState === "SETUP" || sessionState === "BRIEFING");
  // Log the variant so a "stuck on JoinIntro" report has a clear trail
  // — the gate decision lives in Play.tsx but it's the effective UI
  // state here that the user reports.
  useEffect(() => {
    console.info("[play] join-intro variant", {
      session_id: sessionId,
      session_state: sessionState,
      has_name: hasName,
      variant: isWaitingVariant ? "waiting" : "form",
    });
  }, [sessionId, sessionState, hasName, isWaitingVariant]);
  // Rotate the tip carousel only while the waiting variant is on
  // screen. Cleared on unmount or variant flip so we don't churn
  // setTimeout calls in the form variant.
  useEffect(() => {
    if (!isWaitingVariant) return;
    const id = setInterval(() => {
      setTipIndex((i) => (i + 1) % WAITING_TIPS.length);
    }, WAITING_TIP_ROTATE_MS);
    return () => clearInterval(id);
  }, [isWaitingVariant]);

  // Pre-fill the entered name from the snapshot when it lands (so a
  // returning player whose name is already on the server doesn't have
  // to retype it). Only runs when the snapshot just loaded — once
  // ``name`` has been edited, we don't clobber the user's typing.
  useEffect(() => {
    if (snapshotLoaded && !name && roleExistingDisplayName) {
      setName(roleExistingDisplayName);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotLoaded, roleExistingDisplayName]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Please enter a display name.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // Persist server-side first. If the network call fails we
      // surface the error and DON'T hand the user into the chat —
      // otherwise other participants would see them as the bare
      // role label and we'd silently lose their typed name.
      await api.setSelfDisplayName(sessionId, token, trimmed);
      console.info("[play] display_name set", {
        session_id: sessionId,
        name_chars: trimmed.length,
      });
      onJoined(trimmed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[play] setSelfDisplayName failed", {
        session_id: sessionId,
        message,
      });
      setError(`Could not save your name: ${message}`);
    } finally {
      // ``onJoined`` will dispose the JoinIntro on success, so the
      // ``submitting=false`` set never paints — but in StrictMode a
      // double-render or a tab-close mid-flight could leave the
      // button stuck disabled. Belt-and-braces.
      setSubmitting(false);
    }
  }

  // The scenario prompt is creator-authored seed text that's part of
  // the public session — it's not the AI-generated plan (that stays
  // hidden from non-creators). A short trimmed preview is fine for
  // setting the room expectation without spoiling injects.
  const scenarioPreview = scenarioPrompt
    ? scenarioPrompt.slice(0, 240).trim() + (scenarioPrompt.length > 240 ? "…" : "")
    : null;

  const sessionEnded = sessionState === "ENDED";
  const isSpectator = roleKind === "spectator";

  // Snapshot-error branch: the snapshot fetch failed (network blip,
  // expired token). Pre-fix the page rendered forever with a generic
  // header and no error explanation, leading the user to bounce. Now
  // we surface the failure inline with a Retry button.
  if (snapshotError && !snapshotLoaded) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 p-6 text-slate-100">
        <article
          className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-red-500/40 bg-slate-900 p-8 shadow-xl"
          aria-labelledby="join-intro-error-heading"
        >
          <h1 id="join-intro-error-heading" className="text-lg font-semibold text-red-300">
            Couldn't load the session
          </h1>
          <p className="text-sm text-slate-300">
            We tried to fetch the session details and got an error. The
            most common causes are: the join link has expired, the
            session was ended by the facilitator, or your network blipped.
          </p>
          <p
            role="alert"
            className="rounded border border-red-700/60 bg-red-950/40 p-2 text-xs text-red-200"
          >
            {snapshotError}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="self-end rounded bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300"
          >
            Retry
          </button>
        </article>
      </main>
    );
  }

  // Snapshot-loading branch: render a small skeleton until the fetch
  // resolves. Pre-fix the page painted with ``roleLabel === undefined``
  // → "Join the tabletop exercise" generic heading, then the role label
  // popped in 1-2s later, which let users click Begin against an
  // undefined role context.
  if (!snapshotLoaded) {
    return (
      <main
        className="flex min-h-screen items-center justify-center bg-slate-950 p-6 text-slate-300"
        role="status"
        aria-busy="true"
        aria-label="Loading session"
      >
        Loading session…
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-start justify-center bg-slate-950 p-6 py-8 text-slate-100 sm:items-center">
      <article
        className="flex w-full max-w-2xl flex-col gap-6 rounded-lg border border-slate-700 bg-slate-900 p-8 shadow-xl"
        aria-labelledby="join-intro-heading"
      >
        <header className="flex flex-col gap-2">
          <p className="text-xs uppercase tracking-widest text-emerald-400">
            Tabletop exercise — join{isSpectator ? " (spectator)" : ""}
          </p>
          <h1
            id="join-intro-heading"
            className="break-words text-2xl font-semibold"
          >
            {roleLabel
              ? isSpectator
                ? `You're joining as a spectator (${roleLabel})`
                : `You're invited as ${roleLabel}`
              : "Join the tabletop exercise"}
          </h1>
          {scenarioPreview ? (
            <p className="mt-2 rounded border border-slate-700 bg-slate-950/40 p-3 text-sm leading-relaxed text-slate-300">
              <span className="block text-[0.65rem] uppercase tracking-widest text-slate-400">
                Scenario brief
              </span>
              {scenarioPreview}
            </p>
          ) : null}
        </header>

        <section aria-labelledby="how-to-play-heading" className="flex flex-col gap-2">
          <h2
            id="how-to-play-heading"
            className="text-sm font-semibold uppercase tracking-widest text-slate-300"
          >
            {isSpectator ? "How to watch" : "How to play"}
          </h2>
          {isSpectator ? (
            <ul className="flex flex-col gap-2 text-sm leading-relaxed text-slate-200">
              <li>
                <span className="font-semibold">You're in read-only mode.</span>{" "}
                You'll see the full transcript, the AI's narration, and
                player responses live, but your composer stays disabled.
                The AI will not call on you to respond.
              </li>
              <li>
                <span className="font-semibold">No active-role chip will appear.</span>{" "}
                The amber "Awaiting your response" cue is for active
                players only.
              </li>
              <li>
                <span className="font-semibold">After-action report (AAR).</span>{" "}
                When the facilitator ends the session you'll be able to
                download the markdown AAR from the same screen.
              </li>
            </ul>
          ) : (
            <ul className="flex flex-col gap-2 text-sm leading-relaxed text-slate-200">
              <li>
                <span className="font-semibold">Type how you'd respond on the job.</span>{" "}
                Plain English — no special syntax. The AI is your facilitator;
                talk to it the way you'd talk to a colleague running the
                exercise.
              </li>
              <li>
                <span className="font-semibold">Ask for what you'd actually have.</span>{" "}
                Logs, alerts, packet captures, threat intel, screenshots —
                say "what does Defender show?" or "pull the auth logs"
                and the AI will produce realistic synthetic data.
              </li>
              <li>
                <span className="font-semibold">Push back, propose alternatives, or hand off.</span>{" "}
                Disagree with a teammate? Say so. Want to bring in
                another role ("loop in Legal")? Just say it. The AI
                tracks decisions and handoffs.
              </li>
              <li>
                <span className="font-semibold">When it's your turn,</span>{" "}
                the input box at the bottom unlocks and an amber{" "}
                <span className="rounded border border-amber-500/70 bg-amber-500/10 px-1.5 py-0.5 text-[0.7rem] font-semibold text-amber-200">
                  ⚠ Awaiting your response
                </span>{" "}
                chip appears. The most recent AI message is also
                outlined in amber so you can spot what to react to.
              </li>
            </ul>
          )}
        </section>

        {isWaitingVariant ? (
          /* Issue #76: form is replaced by a waiting panel once the
             user has a display name but the session hasn't started.
             Pre-fix the participant was bumped to the main view with
             a blank transcript and a disabled composer pinned at the
             bottom. Now they stay on this page with a friendly
             spinner, the role context they already have, and a
             rotating tip carousel so they have something to read. */
          <section
            aria-labelledby="waiting-heading"
            data-testid="join-intro-waiting"
            className="flex flex-col gap-3 rounded border border-emerald-700/40 bg-emerald-950/20 p-4"
            role="status"
            aria-live="polite"
          >
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-emerald-400 border-t-transparent"
              />
              <h2
                id="waiting-heading"
                className="text-sm font-semibold text-emerald-200"
              >
                {sessionState === "BRIEFING"
                  ? "The AI is preparing the scenario brief…"
                  : "Waiting for your facilitator to start the scenario…"}
              </h2>
            </div>
            {roleLabel && joinedDisplayName ? (
              <p className="text-sm text-slate-200">
                You're seated as{" "}
                <span className="font-semibold">{roleLabel}</span>{" "}
                <span className="text-slate-400">({joinedDisplayName})</span>
                . You'll be brought in automatically when it begins.
              </p>
            ) : null}
            {joinedSeatCount > 0 ? (
              <p className="text-xs text-slate-400">
                {joinedSeatCount === 1
                  ? "1 seat joined so far."
                  : `${joinedSeatCount} seats joined so far.`}
              </p>
            ) : null}
            <div
              className="rounded border border-slate-700 bg-slate-950/40 p-3"
              data-testid="join-intro-tip"
            >
              <p className="text-[0.65rem] uppercase tracking-widest text-slate-400">
                While you wait
              </p>
              <p className="mt-1 text-sm leading-relaxed text-slate-200">
                {WAITING_TIPS[tipIndex]}
              </p>
            </div>
          </section>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-2">
            <label
              htmlFor="display-name"
              className="text-xs uppercase tracking-widest text-slate-300"
            >
              Your display name (visible to the rest of the team)
            </label>
            {roleExistingDisplayName ? (
              <p className="text-xs text-slate-400">
                Welcome back — your saved name is pre-filled. Click Begin
                to rejoin, or edit if you'd like to change it.
              </p>
            ) : null}
            <input
              id="display-name"
              // ``autoFocus`` removed: screen-reader users would land
              // mid-form and miss the heading + "How to play" guide
              // (which is the whole point of this page). Sighted users
              // can tab into the input in one keystroke.
              // ``required`` removed: the JS guard + disabled-Begin
              // button already cover empty submission, and the browser
              // tooltip from native required would conflict with our
              // own error surface.
              // ``sessionEnded`` does NOT disable the input — the copy
              // below tells the user they can still join in read-only
              // mode after entering a name. Disabling the input made
              // that promise impossible to keep for first-time joiners
              // of an ENDED session.
              disabled={submitting}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Bridget"
              maxLength={64}
              className="rounded border border-slate-700 bg-slate-950 p-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
            />
            {error ? (
              <p className="text-sm text-red-400" role="alert">
                {error}
              </p>
            ) : null}
            {sessionEnded ? (
              <p className="text-sm text-amber-300" role="status">
                This session has already ended. You can still join in
                read-only mode after entering a name, but no new
                responses will be accepted.
              </p>
            ) : null}
            <button
              type="submit"
              disabled={submitting || !name.trim()}
              // Full-width tap target on mobile (avoids cramped right-
              // aligned button when the on-screen keyboard pushes the
              // viewport up); right-aligned on sm+.
              className="mt-2 self-stretch rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:opacity-60 sm:self-end"
            >
              {submitting ? "Joining…" : "Begin"}
            </button>
          </form>
        )}
      </article>
    </main>
  );
}
