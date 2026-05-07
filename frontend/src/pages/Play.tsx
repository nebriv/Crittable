import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, SessionSnapshot } from "../api/client";
import { Composer } from "../components/Composer";
// Wave 1 (issue #134): the creator's WaitingChip is the canonical
// "N of M ready" component. Player view also surfaces it so a first-
// time player gets the same readiness signal the creator does — without
// it, players don't know whether to keep discussing or wait for the AI
// (Product review HIGH).
import { WaitingChip } from "./Facilitator";
import { CriticalEventBanner } from "../components/CriticalEventBanner";
import { HighlightActionPopover } from "../components/HighlightActionPopover";
import { RightSidebar } from "../components/RightSidebar";
import { RoleRoster } from "../components/RoleRoster";
import { SharedNotepad } from "../components/SharedNotepad";
import { Transcript } from "../components/Transcript";
import { TranscriptFilters } from "../components/TranscriptFilters";
import { WorkstreamMenu } from "../components/WorkstreamMenu";
import {
  DEFAULT_FILTER,
  FilterState,
  filterMessages,
} from "../lib/transcriptFilters";
import { DieLoader } from "../components/brand/DieLoader";
import { CollapsibleRailPanel } from "../components/brand/CollapsibleRailPanel";
import { HudGauges } from "../components/brand/HudGauges";
import { confirmLeaveSession } from "../lib/leaveGuard";
import { isMidSessionJoiner } from "../lib/proxy";
import { classifySnapshotError } from "../lib/snapshotError";
import { useSessionTitle } from "../lib/useSessionTitle";
import { useStickyScroll } from "../lib/useStickyScroll";
import { useTabFocusReporter } from "../lib/useTabFocusReporter";
import { ServerEvent, WsClient } from "../lib/ws";

interface Props {
  sessionId: string;
  token: string;
}

const DISPLAY_NAME_KEY = "atf-display-name";

// Receiver-side typing config. ``TYPING_VISIBLE_MS`` is how long
// an indicator survives after the most recent ``typing_start``
// arrival before the cutoff sweep evicts it. ``TYPING_FADE_HEAD_START_MS``
// is the head start applied when ``typing_stop`` arrives —
// linger after explicit stop = ``TYPING_VISIBLE_MS - TYPING_FADE_HEAD_START_MS``.
//
// Issue #77 + UI/UX review M-1: 4.5 s TTL paired with the 1 Hz
// sender heartbeat tolerates two dropped beats without flicker
// (was 3.5 s = one drop). Important on flaky cellular where
// 2-packet bursts of loss are common. Head start 4 s leaves a
// 0.5 s linger after explicit stop; combined with the sender's
// 2.5 s idle window that gives ~3 s wall-clock from last
// keystroke to chip removal — within the user's "2-3 seconds
// after they stop typing" ask in the issue body.
const TYPING_VISIBLE_MS = 4500;
const TYPING_FADE_HEAD_START_MS = TYPING_VISIBLE_MS - 500;

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
  // Labeled status from the turn driver, e.g. recovery pass 2/3.
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
  // Wave 3 (issue #69) AI-pause toggle round-trip flag. Disables the
  // creator's "Pause AI / Resume AI" button while the POST is in
  // flight so a rapid double-click doesn't fire two contradictory
  // requests (the second of which would race the first's broadcast).
  // The button label flips off the snapshot's ``ai_paused`` flag —
  // not off this in-flight gate — so a stuck request never lies
  // about the actual pause state to the operator.
  const [pauseInFlight, setPauseInFlight] = useState(false);
  // Issue #76 transition cue: when the participant exits the JoinIntro
  // waiting variant (state goes SETUP/BRIEFING → AWAITING_PLAYERS) the
  // page used to hard-cut to the chat layout, leaving a screen-reader
  // user with no signal that the screen they were on is gone. This
  // flag drives a transient "Session has started" banner shown for
  // ~4s on the first render of the main view after the transition.
  const [sessionStartedFlash, setSessionStartedFlash] = useState(false);
  const wasWaitingRef = useRef(false);
  // Issue #80 bonus: tracks the previous value of the joiner-chip
  // predicate so the boundary log only fires on the false→true edge.
  // Pre-fix the log fired every time the WS replaced ``snapshot``
  // (multiple times per turn) — too noisy in production.
  const wasShowingMidSessionChipRef = useRef(false);
  const wsRef = useRef<WsClient | null>(null);
  // Mirror the WS client into reactive state too. ``wsRef`` is a
  // mutable ref — assigning to it does NOT trigger a re-render, which
  // means downstream consumers gated on ``wsRef.current`` (e.g. the
  // SharedNotepad slot in the right rail) never see the transition
  // from null → connected unless something else nudges React. The
  // creator path nudges plenty (godMode, plan edits); the player path
  // can sit idle and the notepad never mounts. Issue surfaced during
  // manual smoke for #98.
  const [wsClient, setWsClient] = useState<WsClient | null>(null);
  // Phase B chat-declutter (docs/plans/chat-decluttering.md §4.7):
  // local filter state for the TranscriptFilters component above the
  // chat. Quality is single-valued (All / @Me / Critical); track set
  // is multi-select OR within the set, AND-combined with quality.
  // Default = ``"all" + empty set`` = no filtering = identical
  // behavior to the pre-Phase-B chat.
  const [transcriptFilter, setTranscriptFilter] =
    useState<FilterState>(DEFAULT_FILTER);
  // Chat-declutter polish: workstream-override contextmenu state. The
  // menu is rendered as a portal-like fixed div in this page so its
  // position survives transcript scroll. Closed when ``null``.
  const [overrideMenu, setOverrideMenu] = useState<{
    messageId: string;
    workstreamId: string | null;
    x: number;
    y: number;
  } | null>(null);
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
      const value = typeof parsed.role_id === "string" ? parsed.role_id : null;
      if (!value) {
        console.warn("[play] token payload missing role_id field", {
          session_id: sessionId,
        });
      }
      return value;
    } catch (err) {
      // Decode failure is load-bearing for several gates (notepad,
      // highlight popover, mention-self filtering). Without a log
      // line here a "notepad never mounted" report is opaque — the
      // gate condition ``wsClient && selfRoleId`` would silently
      // hold null forever. (Issue #4 in the May 2026 UI sweep.)
      console.warn("[play] selfRoleId decode failed", {
        session_id: sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }, [token, sessionId]);

  // Snapshot fetch runs unconditionally so the join-intro page can
  // show the player's role label + scenario context (was: gated on
  // displayName, which meant the intro page had nothing to render).
  useEffect(() => {
    refreshSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, token]);

  // WS lifecycle status. Mirrored to ``useTabFocusReporter`` so the
  // current focus state is re-pushed on every (re)connect — the server
  // assumes a fresh connection is focused, so a tab that was
  // backgrounded before a transient disconnect would otherwise show as
  // active in the creator's roster after reconnect.
  const [wsStatus, setWsStatus] = useState<
    | "connecting"
    | "open"
    | "closed"
    | "error"
    | "kicked"
    | "rejected"
    | "session-gone"
  >("connecting");

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
      onStatus: (s) => setWsStatus(s),
    });
    ws.connect();
    wsRef.current = ws;
    setWsClient(ws);
    return () => {
      ws.close();
      setWsClient(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayName, sessionId, token]);

  // Boundary log for the notepad / highlight-popover mount gate. Both
  // are gated on ``wsClient && selfRoleId`` — a "notepad never loaded"
  // bug report needs to distinguish "WS never opened" from "selfRoleId
  // decode failed" from "both are fine, so the bug is downstream".
  // Pure debug log; only fires when the gate flips, so it doesn't
  // crowd the production console. (Issue #4 in the May 2026 UI sweep.)
  useEffect(() => {
    console.debug("[play] notepad gate", {
      session_id: sessionId,
      ws_connected: Boolean(wsClient),
      self_role_id_present: Boolean(selfRoleId),
      will_mount: Boolean(wsClient && selfRoleId),
    });
  }, [wsClient, selfRoleId, sessionId]);

  // Report this tab's focus / visibility state so the creator's
  // RolesPanel can show this player as engaged (blue) vs tabbed away
  // (yellow). Gated on ``displayName`` because the WS itself is — no
  // point firing focus events into a closed socket.
  useTabFocusReporter(wsRef, Boolean(displayName), wsStatus);

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
        // Clear the labeled status AND the in-flight call set when
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
      case "ai_pause_state_changed":
        // Wave 3 (issue #69): the creator flipped the AI-pause flag.
        // Refresh the snapshot so ``snapshot.ai_paused`` (and the
        // banner / button label / silenced indicators that read off
        // it) update without waiting for the next state_changed
        // event. Also drop the in-flight gate so the creator's
        // toggle is interactable again — the round-trip completed
        // when this broadcast landed.
        console.info("[play] ai pause state", evt.paused);
        setPauseInFlight(false);
        refreshSnapshot();
        break;
      case "message_workstream_changed":
        // Chat-declutter polish: a creator or message-author manually
        // re-tagged a single message via the contextmenu. Refresh the
        // snapshot so the colored stripe + filter pill counts converge
        // without waiting for the next turn boundary.
        console.info(
          "[play] message workstream changed",
          { id: evt.message_id, workstream_id: evt.workstream_id },
        );
        refreshSnapshot();
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
      const msg = err instanceof Error ? err.message : String(err);
      const terminal = classifySnapshotError(msg);
      if (terminal === "kicked") {
        console.info("[play] snapshot 401 — treating as kicked", { msg });
        setWsStatus("kicked");
        return;
      }
      if (terminal === "session-gone") {
        console.info("[play] snapshot 404/410 — treating as session-gone", {
          msg,
        });
        setWsStatus("session-gone");
        return;
      }
      setError(msg);
    }
  }

  function handleSubmit(
    text: string,
    intent: "ready" | "discuss",
    mentions: string[],
  ) {
    setError(null);
    // Pin the chat to the bottom on the next render so the player sees
    // their own message commit, even if they happened to be reading
    // earlier content. Mirrors what every chat client does on send.
    forceScrollToBottom();
    try {
      wsRef.current?.send({
        type: "submit_response",
        content: text,
        // Wave 1 (issue #134): per-submission intent gates the
        // ready-quorum advance. The Composer always sets this; never
        // omit on the wire — the backend rejects payloads without it.
        intent,
        // Wave 2: structural mention list from the composer's marks.
        // Plain ``@<role>`` entries surface the @-highlight to the
        // addressed role; the literal ``"facilitator"`` token (alias
        // ``@ai`` / ``@gm`` resolved client-side) triggers the
        // server-side ``run_interject`` mini-turn.
        mentions,
      });
      // Issue #78: confirm out-of-turn submits inline so the user
      // doesn't think "did it post? did the AI hear me?" while waiting
      // on the active roles. ``isMyTurn`` is computed from the snapshot
      // at render time, so capturing it here is correct for the just-
      // sent submission.
      //
      // Wave 2 replaces the legacy trailing-``?`` heuristic with the
      // structural ``@facilitator`` mention. If the player explicitly
      // routed the message at the AI we know an interject is coming;
      // otherwise the message just lands as a sidebar comment the AI
      // will read on its next turn.
      //
      // User-Persona review HIGH: the no-mention copy is the canonical
      // teaching moment for the new mechanic — a first-time player
      // sending an off-turn comment learns here that ``@facilitator``
      // (or aliases) is how to demand an inline reply. Without this
      // copy, players who used to rely on the trailing-``?`` heuristic
      // bounce off the empty sidebar with no path forward.
      if (!isMyTurn) {
        const willInterject = mentions.includes("facilitator");
        setNotice(
          willInterject
            ? "Posted as a sidebar — @facilitator was tagged, so the AI will reply inline."
            : "Posted as a sidebar — the AI will see this on its next turn. Need an answer now? Tag @facilitator (or @ai).",
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Rate-limit the "send dropped" log to once per WS-state
  // transition: with the 1 Hz heartbeat (issue #77) a closed WS
  // could otherwise produce ~60 logs/min during a typing burst,
  // which is the noise the prior silent-catch was avoiding.
  // QA logging review HIGH: silent swallows are bugs even on a
  // hot path — log once per state edge, not once per call.
  const typingSendErrLoggedRef = useRef(false);
  // ``useCallback(fn, [])`` gives ``handleTypingChange`` a stable identity
  // across re-renders (Play re-renders on every WS event). Without it the
  // ``useEffect([onTypingChange])`` cleanup in Composer fires on *every*
  // re-render, canceling the pending-start timer and leaving its ref as a
  // stale truthy integer — which permanently blocks new typing sessions for
  // the rest of the session (issue #77 regression).
  const handleTypingChange = useCallback((t: boolean) => {
    const ws = wsRef.current;
    if (!ws) {
      // WS ref is null — the WS hasn't connected yet, or
      // ConnectionManager torched it after a 4401 / spectator
      // boundary. ``ws?.send(...)`` would silently no-op and the
      // catch below would never fire (Copilot review on PR #99).
      // Log the drop here on the false-true edge.
      if (!typingSendErrLoggedRef.current) {
        console.debug("[play] typing send dropped (WS not connected)", {
          typing: t,
        });
        typingSendErrLoggedRef.current = true;
      }
      return;
    }
    try {
      ws.send({ type: t ? "typing_start" : "typing_stop" });
      typingSendErrLoggedRef.current = false;
    } catch (err) {
      if (!typingSendErrLoggedRef.current) {
        console.debug("[play] typing send dropped (WS likely closed)", {
          message: err instanceof Error ? err.message : String(err),
        });
        typingSendErrLoggedRef.current = true;
      }
    }
  // Empty deps array is intentional: ``wsRef`` and ``typingSendErrLoggedRef``
  // are React refs (stable identity across renders) — accessing ``.current``
  // inside the callback reads the latest value without needing them as deps.
  }, []);

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

  async function handlePauseToggle(currentlyPaused: boolean) {
    // Wave 3 (issue #69): creator-only toggle. The button is rendered
    // only when ``isSelfCreator`` is true; backend ``require_creator``
    // is the authoritative gate. ``pauseInFlight`` blocks rapid
    // double-clicks. The label flips off the snapshot's ``ai_paused``
    // rather than off this in-flight flag so a stuck request never
    // paints the wrong pause state.
    if (pauseInFlight) {
      console.warn("[play] pause toggle in-flight — ignoring rapid click");
      return;
    }
    setPauseInFlight(true);
    try {
      if (currentlyPaused) {
        console.info("[play] resuming AI");
        await api.resumeAi(sessionId, token);
      } else {
        console.info("[play] pausing AI");
        await api.pauseAi(sessionId, token);
      }
      // Optimistic snapshot refresh keeps the banner / button label
      // honest even if the WS ``ai_pause_state_changed`` broadcast is
      // missed (replay-buffer eviction during a stress test, WS
      // reconnect mid-toggle, etc.). The WS handler will also flip
      // these on the live path — both writes are idempotent.
      await refreshSnapshot();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[play] pause toggle failed", msg);
      setError(`Pause toggle failed: ${msg}`);
    } finally {
      // Clear the in-flight gate on every outcome — success, failure,
      // and the rare case where the API resolves but the WS event
      // never arrives. Without this, a single dropped broadcast
      // leaves the toggle disabled forever.
      setPauseInFlight(false);
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

  // Issue #80 bonus: log when the mid-session-joiner chip is on
  // screen. Pure boundary log — without it, "Bridget got the chip
  // but shouldn't have" has no telemetry trail. Effect lives ABOVE
  // the early returns so the hook count is stable across renders;
  // the predicate guards on snapshot existing.
  //
  // The full ``snapshot`` object is in the dep array (it's a single
  // reference that gets replaced on every WS event), but the log
  // itself is gated on the previous-value ref so it only fires on
  // the false→true edge — pre-fix it churned a line on every
  // turn-message arrival even when the chip was already on screen.
  // ``console.debug`` (not info) keeps this out of production
  // console noise; the boundary log is for operators inspecting a
  // stuck-chip report.
  useEffect(() => {
    let show = false;
    if (snapshot && selfRoleId) {
      const myRoleHere = snapshot.roles.find((r) => r.id === selfRoleId);
      const activeIds = snapshot.current_turn?.active_role_ids ?? [];
      show = isMidSessionJoiner({
        sessionState: snapshot.state,
        iAmActive: activeIds.includes(selfRoleId),
        messages: snapshot.messages,
        selfRoleId,
        selfRoleKind: myRoleHere?.kind,
        selfIsCreator: myRoleHere?.is_creator ?? false,
      });
    }
    if (show && !wasShowingMidSessionChipRef.current) {
      console.debug("[play] mid-session-joiner chip on", {
        session_id: sessionId,
        role_id: selfRoleId,
        session_state: snapshot?.state,
      });
    } else if (!show && wasShowingMidSessionChipRef.current) {
      console.debug("[play] mid-session-joiner chip off", {
        session_id: sessionId,
        role_id: selfRoleId,
        session_state: snapshot?.state,
      });
    }
    wasShowingMidSessionChipRef.current = show;
  }, [snapshot, selfRoleId, sessionId]);

  // Issue #76 transition cue: detect the SETUP/READY/BRIEFING →
  // AWAITING_PLAYERS flip and surface a transient "Session started"
  // banner so the participant has an explicit acknowledgement that
  // their JoinIntro screen was replaced (UI/UX review HIGH: pre-fix
  // the page hard-cut and a screen-reader user had no signal).
  // READY is included here so a player who joined during the lobby
  // (waiting on the creator to click Start) gets the same banner as
  // one who joined during SETUP — without it, the banner would only
  // fire for the lucky few who arrived before plan finalisation.
  useEffect(() => {
    const isWaitingNow =
      snapshot?.state === "SETUP" ||
      snapshot?.state === "READY" ||
      snapshot?.state === "BRIEFING";
    const wasWaiting = wasWaitingRef.current;
    // Always update the ref before any conditional return — pre-fix
    // the early `return` left ``wasWaitingRef.current`` stuck at
    // ``true`` after the first flash, so a later state cycle (e.g.
    // AWAITING_PLAYERS → AI_PROCESSING returning ``isWaitingNow ===
    // false`` again) could re-trigger the banner. Update first,
    // then decide whether to fire.
    wasWaitingRef.current = isWaitingNow;
    if (wasWaiting && !isWaitingNow && Boolean(effectiveDisplayName)) {
      console.info("[play] session started — exiting waiting variant", {
        session_id: sessionId,
        new_state: snapshot?.state,
      });
      setSessionStartedFlash(true);
      const id = window.setTimeout(() => setSessionStartedFlash(false), 4000);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [snapshot?.state, effectiveDisplayName, sessionId]);

  // Browser-tab title cue. The pending dot lights up only when the
  // local participant is the one holding the exercise up — backgrounded
  // tabs surface that via the OS tab strip without sound or browser
  // notifications. The state label adds context for the foregrounded
  // case ("Briefing", "AI thinking", "Ended"). Derived unconditionally
  // above the early returns so the hook count is stable across renders;
  // ``snapshot === null`` collapses to just ``Crittable``.
  const titleSignal = useMemo(() => {
    if (!snapshot) return { pending: false, state: null as string | null };
    const activeIds = snapshot.current_turn?.active_role_ids ?? [];
    const submittedIds = snapshot.current_turn?.submitted_role_ids ?? [];
    const iAmActive = selfRoleId !== null && activeIds.includes(selfRoleId);
    const iHaveSubmitted =
      selfRoleId !== null && submittedIds.includes(selfRoleId);
    const aiThinking =
      snapshot.state !== "ENDED" &&
      snapshot.current_turn?.status !== "errored" &&
      (aiCalls.size > 0 ||
        streamingActive ||
        snapshot.state === "AI_PROCESSING" ||
        snapshot.state === "BRIEFING" ||
        snapshot.current_turn?.status === "processing");
    const pending = iAmActive && !iHaveSubmitted && !aiThinking;
    let state: string | null = null;
    // Order matters: check ENDED first (terminal), then "your turn"
    // (highest-priority foreground signal), then phase-specific labels
    // that are MORE specific than "AI thinking" (BRIEFING is a
    // sub-state of aiThinking but the label is more informative),
    // then generic AI thinking, then post-submit waiting, then the
    // remaining phase fallbacks. Every backend SessionState
    // (CREATED / SETUP / READY / BRIEFING / AWAITING_PLAYERS /
    // AI_PROCESSING / ENDED) gets a label so a fresh session doesn't
    // fall through to a bare "Crittable".
    if (snapshot.state === "ENDED") state = "Ended";
    else if (pending) state = "Your turn";
    else if (snapshot.state === "BRIEFING") state = "Briefing";
    else if (aiThinking) state = "AI thinking";
    else if (iHaveSubmitted) state = "Submitted";
    else if (snapshot.state === "AWAITING_PLAYERS") state = "Waiting on roles";
    else if (snapshot.state === "SETUP") state = "Setup";
    else if (snapshot.state === "READY") state = "Ready";
    else if (snapshot.state === "CREATED") state = "Initializing";
    return { pending, state };
  }, [snapshot, selfRoleId, aiCalls.size, streamingActive]);
  useSessionTitle(titleSignal);

  // Issue #76: a participant who has submitted their display name but
  // arrived while the creator is still drafting the plan was previously
  // dropped onto the main page with a blank transcript and a disabled
  // composer pinned to the bottom — "looks funny with a chat box and
  // all the blank space" (issue comment). Hold them on JoinIntro
  // instead, with the form swapped for a "Waiting for the facilitator
  // to start" panel + tip carousel. Auto-resolves the moment the
  // session transitions to AWAITING_PLAYERS / AI_PROCESSING / etc.
  //
  // READY is included so a player who joins during the lobby phase
  // (after plan finalisation, before the creator clicks Start) sees
  // the same waiting variant — pre-fix they fell through to the
  // empty-transcript chat view, and were then yanked BACK to a
  // waiting screen the moment the creator hit Start (state went
  // READY → BRIEFING). Holding them on JoinIntro across the full
  // SETUP → READY → BRIEFING arc removes that jarring round-trip.
  const isWaitingForSessionStart =
    snapshot?.state === "SETUP" ||
    snapshot?.state === "READY" ||
    snapshot?.state === "BRIEFING";

  // Issue #127: terminal WS close codes must short-circuit BEFORE
  // the JoinIntro guard. Pre-fix a kicked player who reopened the
  // URL with localStorage cleared landed on JoinIntro forever
  // because the WS connect was gated on ``displayName`` and the
  // snapshot fetch silently 401'd into a generic error. Render the
  // dead-end view here regardless of whether we know their name.
  if (
    wsStatus === "kicked" ||
    wsStatus === "rejected" ||
    wsStatus === "session-gone"
  ) {
    const headline =
      wsStatus === "kicked"
        ? "JOIN LINK REVOKED"
        : wsStatus === "session-gone"
          ? "SESSION NOT FOUND"
          : "CONNECTION REJECTED";
    const body =
      wsStatus === "kicked"
        ? "The facilitator removed this seat. Ask them for a new join link."
        : wsStatus === "session-gone"
          ? "The exercise this link points to has ended or expired. Ask the facilitator to create a new session."
          : "The server refused this connection. If you forwarded this link from another window, try opening it directly.";
    return (
      <main className="dotgrid flex min-h-screen items-center justify-center bg-ink-900 px-6 text-ink-200">
        <div
          role="alert"
          aria-live="assertive"
          className="card mono flex max-w-md flex-col gap-3 p-6 text-center"
          style={{
            borderColor: "var(--crit)",
            background: "var(--ink-850)",
          }}
        >
          <h1
            className="mono text-[12px] font-bold uppercase tracking-[0.22em]"
            style={{ color: "var(--crit)" }}
          >
            {headline}
          </h1>
          <p className="text-[12px] leading-relaxed text-ink-300">{body}</p>
          <a
            href="/"
            autoFocus
            className="btn mt-2 inline-flex items-center justify-center self-center px-4 py-2 text-[11px] font-bold uppercase tracking-[0.16em] focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal"
          >
            Return home
          </a>
        </div>
      </main>
    );
  }

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
        planTitle={snapshot?.plan_title ?? null}
        planSummary={snapshot?.plan_summary ?? null}
        sessionState={snapshot?.state}
        snapshotLoaded={snapshot !== null}
        snapshotError={snapshot === null ? error : null}
        hasName={Boolean(effectiveDisplayName)}
        joinedDisplayName={effectiveDisplayName}
        // Subtract the local participant from the count — UI/UX
        // review: pre-fix "1 seat joined" was just *me*, which read
        // as lonely on a cue meant to signal "the room is filling
        // up". Floor at 0 in case presence hasn't yet seen self.
        joinedSeatCount={Math.max(
          0,
          presence.size - (selfRoleId && presence.has(selfRoleId) ? 1 : 0),
        )}
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
      <main className="dotgrid flex min-h-screen items-center justify-center bg-ink-900 text-ink-300">
        <DieLoader label="Connecting to session" size={96} />
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
  // than "the AI is normalizing its tool call". The full breadcrumb
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
  // Wave 1 (issue #134): per-role ready signal. The composer surfaces
  // whether the local participant is currently marked ready; the HUD
  // counts "N of M ready" off this list (distinct from
  // ``submittedRoleIds`` which counts every message a role has spoken
  // on the turn — including discussion contributions that don't yet
  // flip the AI to advance).
  const readyRoleIds = snapshot.current_turn?.ready_role_ids ?? [];
  const iAmActive = selfRoleId !== null && activeRoleIds.includes(selfRoleId);
  const iHaveSubmitted = selfRoleId !== null && submittedRoleIds.includes(selfRoleId);
  const iAmReady = selfRoleId !== null && readyRoleIds.includes(selfRoleId);
  // "My turn" = the engine is waiting on me to signal ready. Wave 1
  // changes this from "I haven't submitted" to "I haven't yet signaled
  // ready" so the composer stays available for follow-up discussion
  // submissions even after a first message lands. The composer's
  // primary button still flips to "Walk back ready" via the
  // ``isCurrentlyReady`` prop when ``iAmReady`` is true, so a player
  // who marked ready prematurely can re-open discussion.
  const isMyTurn = iAmActive && !iAmReady;
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
  // Wave 1: "still pending" now means "not yet ready" rather than
  // "not yet submitted". A teammate who's posting discussion messages
  // is still pending from the AI's perspective (the turn won't advance
  // until they signal ready); reading off ``readyRoleIds`` keeps the
  // wait copy in lock-step with the actual gate.
  //
  // Issue #168 (role-groups): a multi-role any-of group reads as
  // "either Paul or Lawrence" rather than "Paul, Lawrence" — only ONE
  // member of an open group needs to ready for the group to close, so
  // rendering it as a flat list misleads the player about who must
  // act. We compute ``otherPendingGroups`` per-group and join the
  // group strings with commas. Single-role groups still read
  // verbatim ("Ben"); multi-role groups join with " or "
  // ("Paul or Lawrence"); a fully-closed group disappears so the
  // copy doesn't say "still waiting on" a group that's done.
  const labelById = new Map(snapshot.roles.map((r) => [r.id, r.label] as const));
  const activeGroups = snapshot.current_turn?.active_role_groups ?? [];
  const otherPendingGroups: string[] = [];
  for (const group of activeGroups) {
    const groupHasReady = group.some((id) => readyRoleIds.includes(id));
    if (groupHasReady) continue; // Group already closed; nothing to wait on.
    const memberLabels = group
      .filter((id) => id !== selfRoleId)
      .map((id) => labelById.get(id) ?? id);
    if (memberLabels.length === 0) continue;
    otherPendingGroups.push(memberLabels.join(" or "));
  }
  const otherPending = otherPendingGroups; // Compatibility alias.
  // Issue #78: composer is enabled for any participant whenever the
  // session is ``AWAITING_PLAYERS`` so out-of-turn comments / follow-
  // ups can land in the transcript. Spectators stay locked out (the WS
  // layer would reject anyway). ``ENDED`` / ``AI_PROCESSING`` /
  // ``BRIEFING`` are also disabled — the backend would reject those on
  // submit, so disabling client-side is just early UX.
  const composerEnabled =
    isPlayer && snapshot.state === "AWAITING_PLAYERS";
  // Wave 2: roster the composer's @-popover offers. Excludes the
  // local participant (a player ``@``-ing themself is never useful)
  // and spectators (they aren't addressable beats). The synthetic
  // ``@facilitator`` entry is rendered by the popover itself — do
  // NOT add it here. Plain const (not ``useMemo``) because this
  // file has early-return branches above; a hook below them would
  // violate the rules-of-hooks. The filter+map cost on a small
  // role list is negligible compared to the per-render WS-event
  // churn this page already absorbs.
  const mentionRoster = snapshot.roles
    .filter((r) => r.id !== selfRoleId && r.kind !== "spectator")
    .map((r) => ({
      target: r.id,
      insertLabel: r.label,
      displayLabel: r.label,
      secondary: r.display_name ?? undefined,
    }));
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
  // Issue #80 bonus: re-derive the mid-session-joiner chip flag for
  // the render block. The predicate's log breadcrumb fires from a
  // hook declared *above* the early returns (so the hook count is
  // stable across renders) — this re-compute is a cheap pure call
  // that the React reconciler memo-deduplicates.
  const showMidSessionJoinerChip = isMidSessionJoiner({
    sessionState: snapshot.state,
    iAmActive,
    messages: snapshot.messages,
    selfRoleId,
    selfRoleKind: myRole?.kind,
    selfIsCreator: myRole?.is_creator ?? false,
  });

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
    <main className="flex min-h-screen flex-col bg-ink-900 lg:h-screen lg:min-h-0 lg:overflow-hidden">
      {/* Brand chrome — same lockup pattern as the Facilitator view but
          stripped to read-only context. The session ID is mono so the
          player can quote it back to support. */}
      <header
        role="banner"
        className="border-b border-ink-600 bg-ink-850 px-5"
        style={{ minHeight: 48 }}
      >
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-3 py-2">
          <a
            href="/"
            aria-label="Crittable home"
            className="inline-flex items-center"
            title="Crittable"
            onClick={confirmLeaveSession}
          >
            <img
              src="/logo/svg/lockup-crittable-dark-transparent.svg"
              alt="Crittable"
              height={28}
              // Tailwind preflight resets ``img { height: auto }``;
              // inline style wins. Same trick on every lockup/mark.
              style={{ height: 28 }}
              className="block"
            />
          </a>
          <span className="h-6 w-px bg-ink-600" aria-hidden="true" />
          <span className="mono text-[10px] font-bold uppercase tracking-[0.22em] text-ink-300">
            PLAYER
          </span>
          {myRole ? (
            <span className="mono inline-flex items-center gap-1 rounded-r-1 border border-signal-deep bg-signal-tint px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-signal">
              <span className="opacity-70">ROLE</span>
              <span className="tabular-nums">{myRole.label}</span>
            </span>
          ) : null}
          <span className="mono text-[12px] text-ink-300">
            SESSION{" "}
            <span className="font-semibold text-ink-100 tabular-nums">
              {sessionId.slice(0, 8)}
            </span>
          </span>
          <span className="ml-auto mono text-[11px] uppercase tracking-[0.16em] text-ink-400">
            {displayName ?? ""}
          </span>
        </div>
      </header>

      {sessionStartedFlash ? (
        <div
          role="status"
          aria-live="assertive"
          data-testid="session-started-flash"
          className="border-b border-signal-deep bg-signal-tint px-4 py-2 text-center mono text-[11px] font-bold uppercase tracking-[0.18em] text-signal"
        >
          ● SESSION STARTED — YOU'RE IN
        </div>
      ) : null}
      {criticalBanner ? (
        <CriticalEventBanner
          {...criticalBanner}
          onAcknowledge={() => setCriticalBanner(null)}
        />
      ) : null}
      {/*
        Wave 3 (issue #69): session-wide pause banner. Visible to all
        participants for the duration of the pause so a player who
        ``@facilitator``s after pause-on understands why the AI didn't
        reply. ``role="status"`` + ``aria-live="polite"`` (not
        assertive) — the banner narrates a session-state change, not
        an interrupt-the-user warning. Distinct from the warn-toned
        ``current_turn.status === "errored"`` banner below, which
        announces a recoverable engine error.

        UI/UX review HIGH on this PR: the wrapper is **always
        mounted** (with empty content when not paused) so screen
        readers announce both the pause-on and the resume-off
        transitions — most ATs only fire ``aria-live`` on text
        changes inside an existing live region, not on node
        unmount. With the wrapper conditionally rendered, AT users
        got the "AI facilitator is paused" announce but no
        "facilitator resumed" follow-up.

        ``aria-label`` on the ``<code>`` element is a screen-reader
        hint: NVDA / JAWS read backticked code as the literal
        characters ("at facilitator"), but iOS VoiceOver routinely
        strips punctuation and reads it as "facilitator". The
        explicit aria-label keeps the pronunciation consistent.
      */}
      <div
        role="status"
        aria-live="polite"
        data-testid="ai-pause-banner"
        className={
          snapshot.ai_paused === true
            ? "border-b border-info bg-info-bg px-4 py-2 text-center mono text-[11px] uppercase tracking-[0.10em] text-info shadow"
            : "sr-only"
        }
      >
        {snapshot.ai_paused === true ? (
          <>
            AI facilitator is paused by the creator.{" "}
            <code aria-label="at facilitator">@facilitator</code>{" "}
            mentions land in the transcript but won't trigger an AI reply.
          </>
        ) : (
          ""
        )}
      </div>
      {snapshot.state === "ENDED" ? (
        <div
          role="status"
          aria-live="polite"
          className="border-b border-signal-deep bg-signal-tint px-4 py-3 text-center text-sm font-semibold text-signal"
        >
          Exercise complete. Thanks for participating — your facilitator can download the AAR.
        </div>
      ) : snapshot.current_turn?.status === "errored" ? (
        <div
          role="status"
          aria-live="polite"
          className="border-b border-warn bg-warn-bg px-4 py-3 text-center text-sm font-semibold text-warn"
        >
          The AI facilitator paused — your facilitator has been notified and
          can resume the exercise.
        </div>
      ) : isMyTurn ? (
        <div
          role="status"
          aria-live="assertive"
          className="border-b border-signal bg-signal px-4 py-2 text-center mono text-[12px] font-bold uppercase tracking-[0.18em] text-ink-900 shadow-lg"
        >
          ● YOUR TURN — {myRole?.label} ({displayName})
        </div>
      ) : iHaveSubmitted ? (
        <div
          role="status"
          aria-live="polite"
          className="border-b border-ink-600 bg-ink-800 px-4 py-2 text-center mono text-[11px] uppercase tracking-[0.10em] text-ink-200 shadow"
        >
          ✓ SUBMITTED AS {myRole?.label} ({displayName}) ·{" "}
          {otherPending.length > 0
            ? `Waiting on ${otherPending.join(", ")}.`
            : "Waiting for the AI."}
        </div>
      ) : showMidSessionJoinerChip ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="mid-session-joiner-chip"
          className="border-l-4 border-info bg-ink-800 px-4 py-2 text-xs text-ink-200 shadow"
        >
          <span aria-hidden="true" className="mr-1.5 text-info">
            ⤴
          </span>
          Just joined? You'll be brought into the next turn — sit
          tight, the current beat is finishing up.
        </div>
      ) : null}
      <div className="grid w-full flex-1 grid-cols-1 gap-3 p-3 lg:min-h-0 lg:grid-cols-[220px_minmax(0,1fr)_320px] lg:overflow-hidden xl:grid-cols-[240px_minmax(0,1fr)_400px] 2xl:grid-cols-[260px_minmax(0,1fr)_minmax(440px,28%)]">
        <aside className="flex flex-col gap-3 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
          <RoleRoster
            roles={snapshot.roles}
            activeRoleIds={activeRoleIds}
            selfRoleId={selfRoleId}
            connectedRoleIds={presence}
          />
          <div className="flex flex-col gap-2 rounded-r-3 border border-ink-600 bg-ink-850 p-3">
            <span className="mono text-[10px] font-bold uppercase tracking-[0.22em] text-ink-300">
              ESCAPE HATCHES
            </span>
            <button
              onClick={handleForceAdvance}
              disabled={forceAdvanceCooldown}
              aria-disabled={forceAdvanceCooldown}
              className="mono rounded-r-1 border border-warn px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-warn hover:bg-warn-bg focus-visible:outline focus-visible:outline-2 focus-visible:outline-warn disabled:cursor-not-allowed disabled:opacity-50"
            >
              {forceAdvanceCooldown
                ? "Force-advance (cooling)"
                : "Force-advance turn"}
            </button>
            {isSelfCreator ? (
              <button
                onClick={() => handlePauseToggle(snapshot.ai_paused === true)}
                disabled={pauseInFlight}
                aria-disabled={pauseInFlight}
                aria-pressed={snapshot.ai_paused === true}
                className="mono rounded-r-1 border border-info px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-info hover:bg-info-bg focus-visible:outline focus-visible:outline-2 focus-visible:outline-info disabled:cursor-not-allowed disabled:opacity-50"
              >
                {snapshot.ai_paused === true ? "Resume AI" : "Pause AI"}
              </button>
            ) : null}
            {isSelfCreator ? (
              <button
                onClick={handleEnd}
                className="mono rounded-r-1 border border-crit px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-crit hover:bg-crit-bg focus-visible:outline focus-visible:outline-2 focus-visible:outline-crit"
              >
                End session
              </button>
            ) : null}
          </div>
        </aside>
        <section className="flex min-w-0 flex-col gap-2 lg:min-h-0 lg:overflow-hidden">
          {/*
            On desktop the Composer must stay pinned at the bottom of the
            section regardless of how long the transcript grows — issue #56
            reported that invited users had no scroll region and the page
            just got taller and taller. We split the section the same way
            Facilitator.tsx does: the transcript scrolls inside its own
            region while Composer + notice + error live below as a
            shrink-0 footer.
          */}
          <TranscriptFilters
            messages={snapshot.messages}
            workstreams={snapshot.workstreams ?? []}
            selfRoleId={selfRoleId}
            state={transcriptFilter}
            onChange={setTranscriptFilter}
          />
          <div
            ref={scrollRegionRef}
            className="flex min-w-0 flex-col gap-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1"
          >
            <Transcript
              messages={filterMessages(
                snapshot.messages,
                transcriptFilter,
                selfRoleId,
              )}
              roles={snapshot.roles}
              workstreams={snapshot.workstreams ?? []}
              aiThinking={showAiThinking}
              aiStatusLabel={
                aiStatusLabel ?? (streamingActive ? "Typing…" : undefined)
              }
              typingRoleIds={Object.keys(typing).filter((rid) => rid !== selfRoleId)}
              highlightLastAi={isMyTurn}
              selfRoleId={selfRoleId}
              onMessageContextMenu={({ messageId, workstreamId, x, y }) =>
                setOverrideMenu({ messageId, workstreamId, x, y })
              }
              selfAuthoredRoleIds={
                selfRoleId ? new Set([selfRoleId]) : null
              }
              viewerIsCreator={
                snapshot.roles.find((r) => r.id === selfRoleId)?.is_creator ?? false
              }
            />
          </div>
          {/* "New messages below" chip — appears when a message arrives
              while the user has scrolled up to re-read. Clicking it
              re-pins to the bottom. Mirrors the standard chat-app
              pattern (Slack / Discord) so an unpinned user knows
              there's content below without being yanked off whatever
              they were reading. The chip uses ``bg-signal-bright``
              (the brand accent's hover tier) so it reads as a
              call-to-action distinct from the surrounding chat
              tones — AI bubbles are signal-tinted left-bordered,
              player bubbles are signal-tinted only when "you", and
              the warn-toned "your turn" banner sits directly below
              the composer. The bright signal tier is the only token
              not already used in passive chrome at this density,
              which keeps the chip legible during a busy turn. */}
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
                className="mono pointer-events-auto -mt-12 mb-1 rounded-r-pill border border-signal bg-signal-bright px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.10em] text-ink-900 animate-chip-pulse hover:bg-signal motion-reduce:animate-none motion-reduce:shadow-lg motion-reduce:ring-2 motion-reduce:ring-signal/30"
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
                miss without scrolling back to the top banner.

                The chip is now the only amber thing on the play
                surface (yellow used to live in @YOU badges, mention
                borders, action items, decision pins, idle-tab dots,
                creator stars, etc. — all moved off warn so this chip
                stops competing). ``border-2`` weight + the
                ``warn-chip-pulse`` outward ring make it the
                unmistakable "your turn" cue in peripheral vision.
                Typography mirrors the top banner (mono uppercase
                tracking) so the two cues read as one signal. The
                pulse animation respects ``prefers-reduced-motion``
                via the media query in ``index.css``. */}
            {snapshot.state !== "ENDED" && isMyTurn ? (
              // No ``role="status"`` / ``aria-live`` here — the top
              // ``● YOUR TURN`` banner is already an assertive live
              // region (``aria-live="assertive"`` at the page-top
              // banner around line 1259) and per WAI-ARIA an
              // assertive + polite region pair fires both
              // announcements when both update simultaneously. The
              // chip is purely visual reinforcement at the composer
              // edge of the viewport for users who scrolled past the
              // top banner; sighted users see it, screen-reader
              // users got the assertive announce from the top
              // banner — adding a second live region just doubles
              // the announcement and trains AT users to ignore both
              // (UI/UX review MEDIUM finding on this PR).
              <div
                aria-hidden="true"
                className="mono rounded-r-1 border-2 border-warn bg-warn-bg px-3 py-2 text-center text-xs font-bold uppercase tracking-[0.14em] leading-tight text-warn break-words animate-warn-chip-pulse motion-reduce:animate-none"
              >
                ● YOUR TURN — {myRole?.label ?? "you"}
              </div>
            ) : null}
            {/* Wave 1 (issue #134): readiness chip for players. Renders
                the same "N of M ready" the creator sees so a first-time
                player can tell the team is still mid-discussion vs the
                AI is about to fire. Hidden when the session ended. */}
            {snapshot.state === "AWAITING_PLAYERS" ? (
              <WaitingChip
                activeRoleIds={activeRoleIds}
                submittedRoleIds={submittedRoleIds}
                readyRoleIds={readyRoleIds}
                roles={snapshot.roles}
              />
            ) : null}
            <Composer
              enabled={composerEnabled}
              label={composerLabel}
              placeholder={placeholder}
              onSubmit={handleSubmit}
              onTypingChange={handleTypingChange}
              submitErrorEpoch={submitErrorEpoch}
              isCurrentlyReady={iAmReady}
              // Wave 1: out-of-turn / interjection submissions don't
              // participate in the ready quorum (the backend records
              // them with ``intent=None`` and they never touch
              // ``ready_role_ids``). Hide the discuss button so the
              // affordance only shows where it's load-bearing.
              hideDiscussButton={!iAmActive}
              mentionRoster={mentionRoster}
            />
            {notice ? (
              <p
                role="status"
                aria-live="polite"
                className="rounded border border-ink-500/60 bg-ink-800/60 px-2 py-1 text-xs text-ink-200"
              >
                {notice}{" "}
                <button
                  type="button"
                  onClick={() => setNotice(null)}
                  className="ml-1 underline hover:text-ink-100"
                >
                  dismiss
                </button>
              </p>
            ) : null}
            {error ? <p className="text-sm text-crit" role="alert">{error}</p> : null}
          </div>
        </section>
        <aside className="flex flex-col gap-3 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
          <CollapsibleRailPanel
            title="HUD"
            persistKey="crittable.rail.hud.collapsed"
            defaultCollapsed
          >
            <HudGauges />
          </CollapsibleRailPanel>
          <RightSidebar
            messages={snapshot.messages}
            roles={snapshot.roles}
            workstreams={snapshot.workstreams ?? []}
            // Phase B chat-declutter: clear the transcript filter
            // when a Timeline pin's target is hidden, then the user
            // can click the pin again. UI/UX review HIGH — pre-fix
            // was a silent no-op that read as "the app is broken".
            onScrollMissed={() => setTranscriptFilter(DEFAULT_FILTER)}
            notepad={
              wsClient && selfRoleId ? (
                <SharedNotepad
                  sessionId={sessionId}
                  token={token}
                  ws={wsClient}
                  isCreator={
                    snapshot.roles.find((r) => r.id === selfRoleId)?.is_creator ?? false
                  }
                  sessionStartedAt={snapshot.created_at}
                  selfRoleId={selfRoleId}
                  selfDisplayName={
                    snapshot.roles.find((r) => r.id === selfRoleId)?.display_name ??
                    snapshot.roles.find((r) => r.id === selfRoleId)?.label ??
                    "(unknown)"
                  }
                />
              ) : null
            }
          />
        </aside>
      </div>
      {selfRoleId && wsClient ? (
        <HighlightActionPopover
          sessionId={sessionId}
          roleId={selfRoleId}
          token={token}
        />
      ) : null}
      <WorkstreamMenu
        position={
          overrideMenu ? { x: overrideMenu.x, y: overrideMenu.y } : null
        }
        current={overrideMenu?.workstreamId ?? null}
        workstreams={snapshot.workstreams ?? []}
        onPick={async (next) => {
          if (!overrideMenu) return;
          try {
            await api.overrideMessageWorkstream(
              sessionId,
              token,
              overrideMenu.messageId,
              next,
            );
          } catch (err) {
            const text = err instanceof Error ? err.message : String(err);
            console.warn("[play] workstream override failed", text);
            setError(text);
          }
        }}
        onClose={() => setOverrideMenu(null)}
      />
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
  /** AI-generated scenario name (``plan.title``) — short headline like
   *  "Phishing-led ransomware". ``null`` before the plan exists. */
  planTitle: string | null;
  /** AI-generated 1-2 sentence executive summary. ``null`` before the
   *  plan exists. */
  planSummary: string | null;
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
  "Focus on your reasoning — the AAR captures decisions and rationale, not right-vs-wrong scoring.",
  "Nothing to add on a turn? Hit READY — NOTHING TO ADD instead of typing filler — keeps the team's pace up.",
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
  planTitle,
  planSummary,
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
    hasName &&
    (sessionState === "SETUP" ||
      sessionState === "READY" ||
      sessionState === "BRIEFING");
  // Log the variant so a "stuck on JoinIntro" report has a clear
  // trail. ``console.debug`` (not info) so the breadcrumb doesn't
  // crowd the production console — pair of enter+exit lines keyed
  // on ``isWaitingVariant`` so the operator can see when the user
  // *left* the waiting state, not just when they entered it.
  useEffect(() => {
    console.debug("[play] join-intro variant enter", {
      session_id: sessionId,
      session_state: sessionState,
      has_name: hasName,
      variant: isWaitingVariant ? "waiting" : "form",
    });
    return () => {
      console.debug("[play] join-intro variant exit", {
        session_id: sessionId,
        was_variant: isWaitingVariant ? "waiting" : "form",
      });
    };
  }, [sessionId, sessionState, hasName, isWaitingVariant]);
  // Rotate the tip carousel only while the waiting variant is on
  // screen. Cleared on unmount or variant flip so we don't churn
  // setTimeout calls in the form variant. Per-tip dwell scales with
  // tip length — UI/UX review flagged 7s as borderline for the
  // longest tip; the divisor of 14 is "comfortable" reading speed
  // (~14 chars/sec, accommodating non-native speakers and dyslexic
  // readers — slower than the 200-250 wpm "fluent silent reading"
  // benchmark on purpose). With a 7s floor and the current 5-tip
  // array, dwell ranges 7–10s.
  useEffect(() => {
    if (!isWaitingVariant) return;
    const dwellMs = Math.max(
      WAITING_TIP_ROTATE_MS,
      Math.ceil(WAITING_TIPS[tipIndex].length / 14) * 1000,
    );
    const id = setTimeout(() => {
      setTipIndex((i) => (i + 1) % WAITING_TIPS.length);
    }, dwellMs);
    return () => clearTimeout(id);
  }, [isWaitingVariant, tipIndex]);

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

  // Render strategy for the SCENARIO BRIEF panel:
  //   * brief data present → show title + summary
  //   * brief absent + still pre-play → show "being prepared" placeholder
  //     so the join-page doesn't read as "did I get the wrong link?"
  //   * brief absent + ENDED → hide
  // Truthy check (not ``!== null``) so empty strings — which Pydantic
  // defaults ``executive_summary`` to and the model can emit — collapse
  // the panel cleanly instead of rendering an empty SCENARIO BRIEF
  // chrome. ``plan.title`` and ``plan.executive_summary`` are the only
  // plan fields safe to show every participant; the rest stays
  // creator-only.
  const briefHasContent = Boolean(planTitle) || Boolean(planSummary);
  const sessionEnded = sessionState === "ENDED";
  const briefPending = !briefHasContent && !sessionEnded;
  const briefVisible = briefHasContent || briefPending;

  const isSpectator = roleKind === "spectator";

  // Snapshot-error branch: the snapshot fetch failed (network blip,
  // expired token). Pre-fix the page rendered forever with a generic
  // header and no error explanation, leading the user to bounce. Now
  // we surface the failure inline with a Retry button.
  if (snapshotError && !snapshotLoaded) {
    return (
      <main className="dotgrid flex min-h-screen items-center justify-center bg-ink-900 p-6 text-ink-100">
        <article
          className="flex w-full max-w-md flex-col gap-4 rounded-r-3 border border-crit/60 bg-ink-850 p-8 shadow-xl"
          aria-labelledby="join-intro-error-heading"
        >
          <div className="flex items-center gap-3">
            <img
              src="/logo/svg/lockup-crittable-dark-transparent.svg"
              alt="Crittable"
              height={28}
              // Tailwind preflight resets ``img { height: auto }``;
              // inline style wins. Same trick on every lockup/mark.
              style={{ height: 28 }}
              className="block"
            />
          </div>
          <h1
            id="join-intro-error-heading"
            className="mono text-[12px] font-bold uppercase tracking-[0.20em] text-crit"
          >
            ● COULDN'T LOAD THE SESSION
          </h1>
          <p className="text-sm text-ink-200">
            We tried to fetch the session details and got an error. The
            most common causes are: the join link has expired, the
            session was ended by the facilitator, or your network blipped.
          </p>
          <p
            role="alert"
            className="mono rounded-r-1 border border-crit bg-crit-bg p-2 text-xs text-crit"
          >
            {snapshotError}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="mono self-end rounded-r-1 bg-signal px-4 py-2 text-[11px] font-bold uppercase tracking-[0.16em] text-ink-900 hover:bg-signal-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal-bright"
          >
            RETRY
          </button>
        </article>
      </main>
    );
  }

  // Snapshot-loading branch: render the brand DieLoader so the user
  // gets a strong "the system's working on it" cue (animated mark)
  // rather than a flat text spinner.
  if (!snapshotLoaded) {
    return (
      <main
        className="dotgrid flex min-h-screen items-center justify-center bg-ink-900 p-6"
        role="status"
        aria-busy="true"
        aria-label="Loading session"
      >
        <DieLoader label="Loading session" size={96} />
      </main>
    );
  }

  return (
    <main className="dotgrid flex min-h-screen items-start justify-center bg-ink-900 p-6 py-8 text-ink-100 sm:items-center">
      <article
        className="flex w-full max-w-2xl flex-col gap-6 rounded-r-3 border border-ink-600 bg-ink-850 p-8 shadow-xl"
        aria-labelledby="join-intro-heading"
      >
        <header className="flex flex-col gap-2">
          <div className="flex items-center gap-3 mb-2">
            <img
              src="/logo/svg/lockup-crittable-dark-transparent.svg"
              alt="Crittable"
              height={32}
              style={{ height: 32 }}
              className="block"
            />
          </div>
          <p className="mono text-[11px] font-bold uppercase tracking-[0.22em] text-signal">
            JOIN SESSION{isSpectator ? " · SPECTATOR" : ""}
          </p>
          <h1
            id="join-intro-heading"
            className="break-words text-2xl font-semibold text-ink-050 tracking-[-0.02em]"
          >
            {roleLabel
              ? isSpectator
                ? `You're joining as a spectator (${roleLabel})`
                : `You're invited as ${roleLabel}`
              : "Join the tabletop exercise"}
          </h1>
          {briefVisible ? (
            <section
              aria-labelledby="brief-heading"
              className="mt-2 rounded-r-2 border-l-2 border-signal bg-ink-800 p-3 leading-relaxed"
            >
              <h2
                id="brief-heading"
                className="mono text-[10px] font-bold uppercase tracking-[0.20em] text-signal mb-1"
              >
                SCENARIO BRIEF
              </h2>
              {briefPending ? (
                <p className="text-[13px] italic text-ink-300">
                  The facilitator is still preparing the scenario brief.
                </p>
              ) : null}
              {planTitle ? (
                <p className="text-base font-semibold text-ink-050">{planTitle}</p>
              ) : null}
              {planSummary ? (
                <p
                  className={
                    planTitle
                      ? "mt-1 text-[13px] text-ink-200"
                      : "text-[13px] text-ink-200"
                  }
                >
                  {planSummary}
                </p>
              ) : null}
            </section>
          ) : null}
        </header>

        <section aria-labelledby="how-to-play-heading" className="flex flex-col gap-2">
          <h2
            id="how-to-play-heading"
            className="mono text-[11px] font-bold uppercase tracking-[0.22em] text-ink-300"
          >
            {isSpectator ? "HOW TO WATCH" : "HOW TO PLAY"}
          </h2>
          {isSpectator ? (
            <ul className="flex flex-col gap-2 text-sm leading-relaxed text-ink-200">
              <li>
                <span className="font-semibold text-ink-100">You're in read-only mode.</span>{" "}
                You'll see the full transcript, the AI's narration, and
                player responses live, but your composer stays disabled.
                The AI will not call on you to respond.
              </li>
              <li>
                <span className="font-semibold text-ink-100">No active-role chip will appear.</span>{" "}
                The "Awaiting your response" cue is for active
                players only.
              </li>
              <li>
                <span className="font-semibold text-ink-100">After-action report (AAR).</span>{" "}
                When the facilitator ends the session you'll be able to
                download the markdown AAR from the same screen.
              </li>
            </ul>
          ) : (
            <ul className="flex flex-col gap-2 text-sm leading-relaxed text-ink-200">
              <li>
                <span className="font-semibold text-ink-100">Type how you'd respond on the job.</span>{" "}
                Plain English. To address a teammate, type{" "}
                <span className="mono rounded-r-1 border border-ink-500 bg-ink-800 px-1 text-[11px] text-ink-100">@</span>
                {" "}— a roster will pop up. To get the AI's attention
                directly (sidebar question, clarification), tag{" "}
                <span className="mono rounded-r-1 border border-ink-500 bg-ink-800 px-1 text-[11px] text-ink-100">@facilitator</span>
                {" "}(aliases{" "}
                <span className="mono rounded-r-1 border border-ink-500 bg-ink-800 px-1 text-[11px] text-ink-100">@ai</span>
                {", "}
                <span className="mono rounded-r-1 border border-ink-500 bg-ink-800 px-1 text-[11px] text-ink-100">@gm</span>
                ) and the AI will reply inline.
              </li>
              <li>
                <span className="font-semibold text-ink-100">Ask for what you'd actually have.</span>{" "}
                Logs, alerts, packet captures, threat intel, screenshots —
                say "what does Defender show?" or "pull the auth logs"
                and the AI will produce realistic synthetic data.
              </li>
              <li>
                <span className="font-semibold text-ink-100">Push back, propose alternatives, or hand off.</span>{" "}
                Disagree with a teammate? Say so. Want to bring in
                another role ("loop in Legal")? Just say it. The AI
                tracks decisions and handoffs.
              </li>
              <li>
                <span className="font-semibold text-ink-100">When it's your turn,</span>{" "}
                the input box at the bottom unlocks and a pulsing{" "}
                <span className="mono rounded-r-1 border-2 border-warn bg-warn-bg px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-warn">
                  ● YOUR TURN
                </span>{" "}
                chip appears above the composer. The most recent AI
                message is also outlined in amber so you can spot
                what to react to.
              </li>
              <li>
                <span className="font-semibold text-ink-100">Submit, discuss, or pass.</span>{" "}
                <span className="mono rounded-r-1 border border-signal-deep bg-ink-800 px-1.5 py-0.5 text-[10px] font-bold uppercase text-signal">
                  SUBMIT &amp; READY →
                </span>{" "}
                posts your reply AND marks you ready — the AI advances
                once everyone is ready.{" "}
                <span className="mono rounded-r-1 border border-ink-400 bg-ink-800 px-1.5 py-0.5 text-[10px] font-bold uppercase text-ink-100">
                  STILL DISCUSSING →
                </span>{" "}
                posts but keeps your seat open for follow-ups. Nothing
                to add this turn?{" "}
                <span className="mono rounded-r-1 border border-ink-400 bg-ink-800 px-1.5 py-0.5 text-[10px] font-bold uppercase text-ink-100">
                  READY — NOTHING TO ADD →
                </span>{" "}
                marks you ready without forcing filler — useful when a
                teammate already covered your angle.
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
             rotating tip carousel so they have something to read.

             ARIA: ``role="status"`` lives on the section so AT
             initially announces the variant, but ``aria-live`` is
             scoped to the rotating tip element only (UI/UX review:
             putting aria-live on the whole section caused the
             headline + role + seat count to re-announce on every
             7-10s tip rotation, which is noise). */
          <section
            aria-labelledby="waiting-heading"
            data-testid="join-intro-waiting"
            className="flex flex-col gap-4 rounded-r-3 border border-signal-deep bg-signal-tint p-5"
            role="status"
          >
            <div className="flex items-center gap-4">
              {/* Brand die animation as the loading icon. ``aria-hidden``
                  because the heading carries the screen-reader text. */}
              <div aria-hidden="true">
                <DieLoader size={56} label={null} />
              </div>
              <h2
                id="waiting-heading"
                className="text-sm font-semibold text-signal-bright leading-relaxed"
              >
                {sessionState === "BRIEFING"
                  ? "The AI is preparing the scenario brief…"
                  : sessionState === "READY"
                    ? joinedDisplayName
                      ? `Welcome, ${joinedDisplayName} — your facilitator is finalising the lobby and will start shortly…`
                      : "Your facilitator is finalising the lobby and will start shortly…"
                    : joinedDisplayName
                      ? `Welcome, ${joinedDisplayName} — waiting for your facilitator to start the scenario…`
                      : "Waiting for your facilitator to start the scenario…"}
              </h2>
            </div>
            {roleLabel ? (
              <p className="text-sm text-ink-200">
                You're seated as{" "}
                <span className="font-semibold text-ink-100">{roleLabel}</span>
                {joinedDisplayName ? (
                  <>
                    {" "}
                    <span className="mono text-ink-400">
                      ({joinedDisplayName})
                    </span>
                  </>
                ) : null}
                . You'll be brought in automatically when it begins.
              </p>
            ) : null}
            {joinedSeatCount > 0 ? (
              <p className="mono text-[11px] uppercase tracking-[0.10em] text-ink-400">
                {joinedSeatCount === 1
                  ? "● 1 OTHER SEAT CONNECTED"
                  : `● ${joinedSeatCount} OTHER SEATS CONNECTED`}
              </p>
            ) : null}
            <div
              className="rounded-r-2 border border-ink-600 bg-ink-900 p-3"
              data-testid="join-intro-tip"
            >
              <p className="flex items-center justify-between mono text-[10px] font-bold uppercase tracking-[0.20em] text-ink-400">
                <span>WHILE YOU WAIT</span>
                <span aria-hidden="true" className="tabular-nums">
                  {tipIndex + 1} / {WAITING_TIPS.length}
                </span>
              </p>
              <p
                className="mt-1 text-sm leading-relaxed text-ink-200"
                aria-live="polite"
              >
                {WAITING_TIPS[tipIndex]}
              </p>
            </div>
          </section>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <label
              htmlFor="display-name"
              className="mono text-[10px] font-bold uppercase tracking-[0.20em] text-signal"
            >
              YOUR DISPLAY NAME
            </label>
            {roleExistingDisplayName ? (
              <p className="mono text-[11px] uppercase tracking-[0.04em] text-ink-400">
                Welcome back — your saved name is pre-filled. Click BEGIN
                to rejoin.
              </p>
            ) : null}
            <input
              id="display-name"
              disabled={submitting}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Bridget"
              maxLength={64}
              className="rounded-r-1 border border-ink-600 bg-ink-900 p-3 text-sm text-ink-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal-deep focus:border-signal-deep disabled:cursor-not-allowed disabled:opacity-60"
            />
            {error ? (
              <p className="mono text-[11px] uppercase tracking-[0.04em] text-crit" role="alert">
                {error}
              </p>
            ) : null}
            {sessionEnded ? (
              <p className="mono text-[11px] uppercase tracking-[0.04em] text-warn" role="status">
                ⚠ This session has already ended. You can still join in
                read-only mode.
              </p>
            ) : null}
            <button
              type="submit"
              disabled={submitting || !name.trim()}
              className="mono mt-2 self-stretch rounded-r-1 bg-signal px-4 py-3 text-[12px] font-bold uppercase tracking-[0.20em] text-ink-900 hover:bg-signal-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal-bright disabled:cursor-not-allowed disabled:opacity-60 sm:self-end sm:px-6"
            >
              {submitting ? "JOINING…" : "BEGIN →"}
            </button>
          </form>
        )}
      </article>
    </main>
  );
}
