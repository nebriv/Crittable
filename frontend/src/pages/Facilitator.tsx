import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { TableScroll } from "../components/TableScroll";
import {
  api,
  CostSnapshot,
  DecisionLogEntry,
  RoleView,
  ScenarioPlan,
  SessionSnapshot,
} from "../api/client";
import { Composer } from "../components/Composer";
import { CriticalEventBanner } from "../components/CriticalEventBanner";
import { DecisionLogPanel } from "../components/DecisionLogPanel";
import { GodModePanel } from "../components/GodModePanel";
import { RightSidebar } from "../components/RightSidebar";
import { RolesPanel } from "../components/RolesPanel";
import { SessionActivityPanel } from "../components/SessionActivityPanel";
import { SetupChat } from "../components/SetupChat";
import { Transcript } from "../components/Transcript";
import { buildImpersonateOptions } from "../lib/proxy";
import { useStickyScroll } from "../lib/useStickyScroll";
import { ServerEvent, WsClient } from "../lib/ws";

export type Phase = "intro" | "setup" | "ready" | "play" | "ended";

interface CreatorState {
  sessionId: string;
  token: string;
  creatorRoleId: string;
  joinUrl: string;
}

const NUDGE_PROPOSE = "I think we have enough context. Please draft the scenario plan now.";

// Receiver-side typing indicator timings — kept in sync with
// Play.tsx (see the long comment there). Issue #77 + UI/UX
// review M-1: 4.5 s TTL + 0.5 s linger after explicit stop,
// paired with the 1 Hz heartbeat sender in Composer.
const TYPING_VISIBLE_MS = 4500;
const TYPING_FADE_HEAD_START_MS = TYPING_VISIBLE_MS - 500;

/**
 * Sample setup answers prefilled when the operator toggles "Dev mode" on
 * the intro page. Mirrors the backend's ``_default_dev_plan`` ransomware
 * brief so the resulting plan is consistent end-to-end.
 *
 * Split into four short sections (scenario / team / environment /
 * constraints) so the AI gets structured context up front and the
 * setup dialogue can move past the boilerplate questions faster.
 */
const DEV_SETUP_PREFILL = {
  scenario:
    "Ransomware via compromised vendor portal at a mid-size regional bank. " +
    "Finance laptops are encrypting; attribution is unclear; a vendor that " +
    "was publicly breached two weeks ago shares a service account that was " +
    "never rotated. The team has ~90 minutes of simulated time to contain, " +
    "decide on regulator/comms posture, and respond to an attacker demand.",
  team:
    "CISO (lead, on-call), IR Lead (3 yrs exp, on-call), SOC Analyst " +
    "(L1, on-call), Legal (corp counsel, business hours only), Comms " +
    "(internal-comms lead, on retainer). No dedicated threat-intel role.",
  environment:
    "Hybrid: 70% Microsoft 365 + Azure AD + on-prem AD; 30% on-prem " +
    "Windows file shares. EDR: Microsoft Defender for Endpoint. SIEM: " +
    "Sentinel. IdP: Entra ID. Crown jewels: customer PII, daily ACH " +
    "batches, internal audit reports. Month-end finance close in progress.",
  constraints:
    "No real CVE / exploit code. Avoid law-enforcement specifics " +
    "(jurisdictional differences). Keep regulator framing US-state-AG " +
    "+ FFIEC / OCC. Do NOT ask the team to invent attacker attribution.",
};

/**
 * Combine the four setup sections into a single seed string the backend
 * already knows how to handle (``scenario_prompt``). Sections that the
 * operator left blank are dropped entirely so the AI doesn't see empty
 * headers it has to interpret.
 */
function _composeScenarioPrompt(parts: typeof DEV_SETUP_PREFILL): string {
  const sections: [string, string][] = [
    ["SCENARIO BRIEF", parts.scenario],
    ["TEAM", parts.team],
    ["ENVIRONMENT", parts.environment],
    ["CONSTRAINTS / AVOID", parts.constraints],
  ];
  return sections
    .filter(([, body]) => body.trim().length > 0)
    .map(([title, body]) => `${title}\n${body.trim()}`)
    .join("\n\n");
}

export function Facilitator() {
  const [state, setState] = useState<CreatorState | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  // Multi-section setup intro. Each section is optional except
  // ``scenario`` which is required by the backend. The four sections
  // are combined into a single ``scenario_prompt`` string at submit
  // time so the API surface doesn't need to change. Pre-fix the intro
  // had a single textarea; operators were either leaving the AI to
  // ask 5+ setup questions OR pasting a wall of text into one box.
  const [setupParts, setSetupParts] = useState({
    scenario: "",
    team: "",
    environment: "",
    constraints: "",
  });
  const [creatorLabel, setCreatorLabel] = useState("CISO");
  const [creatorDisplayName, setCreatorDisplayName] = useState("");
  // Issue #61: roles to invite, declared *before* the session is created
  // so the operator doesn't have to add seats one-by-one in the lobby.
  // These are auto-created via ``api.addRole`` immediately after the
  // session is created. Operators can still add/remove roles dynamically
  // from the Roles panel during setup or play.
  const SETUP_ROLE_DEFAULTS = ["IR Lead", "Legal", "Comms"] as const;
  const [setupRoles, setSetupRoles] = useState<string[]>([
    ...SETUP_ROLE_DEFAULTS,
  ]);
  const [setupRoleDraft, setSetupRoleDraft] = useState("");
  // Dev-mode toggle on the intro page: prefills a known scenario + creator
  // identity, and on submit auto-skips the AI setup dialogue so testers
  // bypass the 5–30 s setup loop. Use only for local QA.
  const [devMode, setDevMode] = useState(false);
  const [setupReply, setSetupReply] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<"connecting" | "open" | "closed" | "error">("connecting");

  // Live AI text streaming was producing visible mid-flight rewrites:
  // the green "streaming…" bubble showed concatenated chunks, then the
  // final ``message_complete`` body sometimes diverged (model writes a
  // short rationale + a separate broadcast; chunk text is the rationale,
  // final body is the broadcast). The creator read that as the AI
  // silently rewriting itself. We now ignore chunk content and only
  // show a "Typing…" indicator until the final message lands.
  // ``streamingActive`` tracks whether some chunks are arriving so the
  // indicator label can read "Typing…" vs. "Thinking…".
  const [streamingActive, setStreamingActive] = useState(false);
  const [criticalBanner, setCriticalBanner] = useState<{
    severity: string;
    headline: string;
    body: string;
  } | null>(null);
  const [cost, setCost] = useState<CostSnapshot | null>(null);
  const [godMode, setGodMode] = useState(false);
  // Page-level state for the AAR popup so a single "View AAR" button in
  // the top SessionActionBar is the only surface that opens it. Pre-fix
  // the sidebar had a "Download AAR" that bypassed the popup AND the
  // chat area had a duplicate "Show AAR report" button — two competing
  // CTAs for the same task.
  const [showAarPopup, setShowAarPopup] = useState(false);
  // role_id -> last typing-true timestamp (ms). Filtered to "currently typing"
  // by the consuming components which check freshness < 4s.
  const [typing, setTyping] = useState<Record<string, number>>({});
  // role_ids whose tabs are currently connected. Server-pushed via the
  // ``presence`` / ``presence_snapshot`` WS events. See issue #52 — the
  // creator needs to know which invites have actually been opened
  // before kicking off the exercise.
  const [presence, setPresence] = useState<Set<string>>(() => new Set());
  // Real-time AI-thinking tracking — same shape as Play.tsx. ``aiCalls``
  // maps in-flight LLM ``call_id`` → tier (``setup`` / ``play`` / ``aar``
  // / ``guardrail`` / ``interject``) from ``ai_thinking`` boundary
  // events; ``aiStatus`` carries the labelled phase/attempt/recovery
  // breadcrumb the turn-driver emits at known points. Together they let
  // the operator distinguish "thinking" from "stuck" during the
  // strict-retry loop and see interject / setup / AAR work that doesn't
  // change ``session.state`` (issue #63). The tier is what powers the
  // top-bar ``LLM: <tier>`` chip (round 4 of issue #62) — the operator
  // wanted to see *which* tier is currently active, not just that
  // *something* is in flight, so they can spot e.g. guardrail spikes
  // separately from play-tier turns.
  const [aiCalls, setAiCalls] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [aiStatus, setAiStatus] = useState<{
    phase: "play" | "interject" | "setup" | "briefing" | "aar";
    attempt?: number;
    budget?: number;
    recovery?: string | null;
    forRoleId?: string | null;
  } | null>(null);
  // 3-second client-side cooldown on force-advance — paired with the
  // backend in-flight gate in ``manager.force_advance``. See issue #63.
  const [forceAdvanceCooldown, setForceAdvanceCooldown] = useState(false);
  // Live AI decision rationale stream (issue #55). Entries arrive via
  // ``decision_logged`` events as the AI calls
  // ``record_decision_rationale``; on snapshot refresh we replace the
  // local state with the canonical server list to avoid drift if a
  // WebSocket frame was missed during reconnect.
  const [decisionLog, setDecisionLog] = useState<DecisionLogEntry[]>([]);
  // Issue #62 round 3 — per-bar telemetry. ``lastEventAt`` is bumped on
  // every incoming WS frame so the top bar can render "Last: Xs ago",
  // which fills the diagnostic gap between the binary ``ws: open`` pill
  // (the socket is up) and "is anything actually flowing?". A frozen
  // counter is a strong signal the backend went quiet even when TCP is
  // still healthy. ``connectionCount`` is server-pushed via the existing
  // ``presence`` / ``presence_snapshot`` events and tells the creator
  // how many tabs are currently watching the session.
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [connectionCount, setConnectionCount] = useState<number | null>(null);
  const wsRef = useRef<WsClient | null>(null);
  const forceAdvanceTimerRef = useRef<number | null>(null);
  // Rate-limit the typing-send-dropped log to one line per WS
  // state edge (issue #77 logging fix; see ``handleTypingChange``).
  const typingSendErrLoggedRef = useRef(false);
  useEffect(() => {
    return () => {
      if (forceAdvanceTimerRef.current !== null) {
        window.clearTimeout(forceAdvanceTimerRef.current);
        forceAdvanceTimerRef.current = null;
      }
    };
  }, []);
  // Wraps the chat scroll region so we can auto-pin the latest message
  // to the bottom on each new arrival. The hook also force-pins on the
  // initial mount (so refreshing mid-exercise lands on the latest
  // beat — issue #79) and exposes ``forceScrollToBottom()`` for local
  // user actions (submit / proxy / force-advance) that should always
  // jump to the bottom regardless of scroll slack. The slack-based
  // "only if near bottom" rule still applies for incoming messages
  // from other roles.

  const phase: Phase = useMemo(() => {
    if (!snapshot) return "intro";
    if (snapshot.state === "ENDED") return "ended";
    if (snapshot.state === "SETUP") return "setup";
    if (snapshot.state === "READY") return "ready";
    return "play";
  }, [snapshot]);

  useEffect(() => {
    if (snapshot) {
      console.info("[facilitator] phase", {
        phase,
        backendState: snapshot.state,
        currentTurn: snapshot.current_turn,
        roleCount: snapshot.roles.length,
        hasPlan: Boolean(snapshot.plan),
        messageCount: snapshot.messages.length,
        setupNoteCount: snapshot.setup_notes?.length ?? 0,
      });
    }
  }, [phase, snapshot]);

  useEffect(() => {
    if (error) console.warn("[facilitator] error surfaced", error);
  }, [error]);

  // ----------------------------------------------------- create session
  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    setBusyMessage(
      devMode
        ? "Dev mode: drafting the plan and starting the exercise…"
        : "Creating session and starting AI setup dialogue…",
    );
    try {
      const created = await api.createSession({
        scenario_prompt: _composeScenarioPrompt(setupParts),
        creator_label: creatorLabel,
        creator_display_name: creatorDisplayName,
        // Dev mode skips the AI auto-greet AND installs the default
        // plan in the SAME request. Saves an LLM call and avoids the
        // bare-text-leak failure mode that pollutes the play
        // transcript with setup-style assistant prose.
        skip_setup: devMode,
      });
      // Don't log the response object — it carries the creator token in
      // ``creator_token`` and ``creator_join_url``. Log only non-secret IDs.
      console.info("[facilitator] session created", {
        sessionId: created.session_id,
        creatorRoleId: created.creator_role_id,
        devMode,
      });
      setState({
        sessionId: created.session_id,
        token: created.creator_token,
        creatorRoleId: created.creator_role_id,
        joinUrl: created.creator_join_url,
      });
      // Issue #61: auto-create any pre-declared invitee roles before the
      // operator lands on the lobby. De-duped against the creator's own
      // label so an operator who left the suggestions list intact and
      // *also* picked one of those labels for themselves doesn't get a
      // duplicate seat. Dev mode skips this — it has its own SOC Analyst
      // helper seat below.
      if (!devMode) {
        const creatorLabelTrim = creatorLabel.trim().toLowerCase();
        const seen = new Set<string>([creatorLabelTrim]);
        const labelsToAdd = setupRoles
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .filter((label) => {
            const k = label.toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        for (const label of labelsToAdd) {
          setBusyMessage(`Adding role "${label}"…`);
          try {
            await api.addRole(created.session_id, created.creator_token, {
              label,
              kind: "player",
            });
          } catch (roleErr) {
            console.warn("[facilitator] failed to add role", label, roleErr);
            setError(
              `Created the session but failed to add role "${label}": ` +
                (roleErr instanceof Error ? roleErr.message : String(roleErr)) +
                ". You can add it manually from the Roles panel.",
            );
          }
        }
        if (labelsToAdd.length > 0) {
          console.info("[facilitator] pre-created roles", {
            count: labelsToAdd.length,
          });
        }
      }
      if (devMode) {
        // ``start_session`` requires ≥ 2 player roles. Dev mode auto-
        // adds a SOC Analyst seat so the operator can solo-test via the
        // ``Respond as`` dropdown. The role is a normal player — the
        // operator can kick + reissue / remove it like any other.
        setBusyMessage("Dev mode: adding SOC Analyst seat…");
        await api.addRole(created.session_id, created.creator_token, {
          label: "SOC Analyst",
          display_name: "Dev Bot",
          kind: "player",
        });
        // Auto-start the exercise: by the time the user lands on the
        // play screen the AI's first beat is already in the transcript
        // (``/start`` runs the play turn synchronously). Restores the
        // pre-multi-prompt one-click dev flow.
        setBusyMessage("Dev mode: AI drafting the first beat…");
        await api.start(created.session_id, created.creator_token);
        console.info("[facilitator] dev mode auto-started exercise");
      }
      const snap = await api.getSession(created.session_id, created.creator_token);
      setSnapshot(snap);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setBusyMessage(null);
    }
  }

  // ------------------------------------------------------- WS connection
  useEffect(() => {
    if (!state) return;
    const ws = new WsClient({
      sessionId: state.sessionId,
      token: state.token,
      onEvent: handleEvent,
      onStatus: (s) => setWsStatus(s),
    });
    ws.connect();
    wsRef.current = ws;
    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.sessionId, state?.token]);

  function handleEvent(evt: ServerEvent) {
    // Top-bar "Last: Xs ago" — bump on every frame regardless of type.
    // We *don't* try to filter to "interesting" events here because the
    // signal we're surfacing is "is the connection delivering anything?";
    // typing pings, heartbeats and presence updates are all valid
    // liveness evidence.
    setLastEventAt(Date.now());
    switch (evt.type) {
      case "message_chunk":
        // Ignore chunk content; the typing indicator is enough.
        // ``message_complete`` will refresh the snapshot and paint the
        // final body via the same MarkdownBody path everything else
        // uses, so what the creator sees in the chat matches what's
        // persisted (and what players see). Idempotent set — no
        // stale-closure guard needed.
        setStreamingActive(true);
        break;
      case "message_complete":
        setStreamingActive(false);
        refreshSnapshot();
        break;
      case "state_changed":
        refreshSnapshot();
        // Reconnect safety-net: ``ai_thinking`` events are
        // ``record=False`` so a reconnect during an LLM call wouldn't
        // replay the matching ``active=false`` event. ``state_changed``
        // IS recorded in the replay buffer, so this is the anchor
        // point that guarantees ``aiCalls`` and ``aiStatus`` reset
        // when the engine actually moves to a non-busy state.
        if (evt.state !== "AI_PROCESSING" && evt.state !== "BRIEFING") {
          setAiStatus(null);
          setAiCalls(new Map());
        }
        break;
      case "turn_changed":
      case "plan_proposed":
      case "plan_finalized":
      case "plan_edited":
        refreshSnapshot();
        break;
      case "participant_renamed":
        // Player set their display_name via the join intro. Refresh so
        // the updated name appears in transcript headers + roster.
        // Logged separately from the lump-in case above per CLAUDE.md
        // "Log state transitions in pages" rule.
        console.info("[facilitator] participant renamed", evt);
        refreshSnapshot();
        break;
      case "ai_thinking":
        // Reference-counted concurrent calls (guardrail + interject can
        // overlap). Add/remove by call_id so the indicator only clears
        // when ALL calls have ended. Tier is retained so the top-bar
        // ``LLM: <tier>`` chip can show *what* is in flight, not just
        // *that* something is — a guardrail call layered on top of a
        // play turn shows as ``LLM: guardrail+play`` rather than the
        // operator having to guess from the transcript.
        setAiCalls((prev) => {
          const next = new Map(prev);
          if (evt.active) next.set(evt.call_id, evt.tier);
          else next.delete(evt.call_id);
          return next;
        });
        console.debug(
          "[facilitator] ai_thinking",
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
        console.debug("[facilitator] ai_status", {
          phase: evt.phase,
          recovery: evt.recovery,
        });
        break;
      case "critical_event":
        setCriticalBanner({ severity: evt.severity, headline: evt.headline, body: evt.body });
        break;
      case "cost_updated":
        setCost(evt.cost as unknown as CostSnapshot);
        break;
      case "decision_logged":
        setDecisionLog((prev) => {
          // De-dupe defensively in case the snapshot fetch and the WS
          // frame race during a reconnect.
          if (prev.some((e) => e.id === evt.entry.id)) return prev;
          return [...prev, evt.entry];
        });
        break;
      case "presence":
        setPresence((prev) => {
          const next = new Set(prev);
          if (evt.active) next.add(evt.role_id);
          else next.delete(evt.role_id);
          return next;
        });
        if (typeof evt.connection_count === "number") {
          setConnectionCount(evt.connection_count);
        }
        break;
      case "presence_snapshot":
        setPresence(new Set(evt.role_ids));
        if (typeof evt.connection_count === "number") {
          setConnectionCount(evt.connection_count);
        }
        break;
      case "typing":
        setTyping((prev) => {
          const next = { ...prev };
          if (evt.typing) {
            next[evt.role_id] = Date.now();
          } else if (evt.role_id in next) {
            // Don't yank the indicator on ``typing_stop`` — schedule a
            // graceful fade so it persists ~1.5s after the sender goes
            // quiet. See issue #53; the immediate-delete behavior was
            // the source of the on/off flash.
            next[evt.role_id] = Date.now() - TYPING_FADE_HEAD_START_MS;
          }
          return next;
        });
        break;
      case "aar_status_changed":
        // The EndedView polls /export.md too; this just nudges the snapshot
        // refresh so the AAR-status pill updates immediately.
        refreshSnapshot();
        break;
      case "guardrail_blocked":
        // Pre-fix the creator's Facilitator view ignored this event entirely
        // — submissions silently disappeared. Surface it as an error toast
        // so the operator at minimum sees *why* their message vanished.
        console.warn("[facilitator] guardrail blocked", evt.verdict, evt.message);
        setError(`Submission blocked (${evt.verdict}): ${evt.message}`);
        break;
      case "submission_truncated":
        // Don't escalate to error — the message DID post.
        console.info("[facilitator] submission truncated", evt);
        break;
      case "error":
        setError(evt.message);
        break;
      default:
        break;
    }
  }

  // Expire stale typing entries so the indicator disappears even if a
  // ``typing_stop`` got dropped. See issue #53 for the timing rationale —
  // we want a stable ~3s on-screen window per typing burst, with no
  // flashing between bursts.
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

  // Auto-scroll the chat region to the bottom when the message count
  // or streaming buffer grows. The hook handles three cases: initial
  // mount with content (pin unconditionally so a refreshed tab lands
  // on the latest beat), incoming content with the operator near the
  // bottom (follow the chat down), and local-action force-scroll
  // (``forceScrollToBottom()`` below — submit / proxy / force-advance
  // always pin regardless of slack so the operator sees their action
  // commit). Pre-fix the local-action latch was a stick: once any
  // submit fired, the slack check was bypassed forever and the
  // operator could no longer scroll up to re-read older beats.
  const messageCount = snapshot?.messages.length ?? 0;
  // ``streamingActive`` is a pin trigger (the streamed AI bubble grows
  // and a pinned operator should follow it down) but NOT an unread
  // trigger — the chip should only appear when an actual new message
  // lands, not when the typing indicator flips on / off. Pass a
  // narrowed unread-deps tuple to gate that.
  const {
    scrollRef: scrollRegionRef,
    forceScrollToBottom,
    hasUnreadBelow,
  } = useStickyScroll(
    [messageCount, streamingActive],
    [messageCount],
  );

  async function refreshSnapshot() {
    if (!state) return;
    try {
      const snap = await api.getSession(state.sessionId, state.token);
      setSnapshot(snap);
      if (snap.decision_log) {
        setDecisionLog(snap.decision_log);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function callSetup(content: string, busyText: string) {
    if (!state || !content.trim()) return;
    setError(null);
    setBusy(true);
    setBusyMessage(busyText);
    try {
      await api.setupReply(state.sessionId, state.token, content.trim());
      await refreshSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setBusyMessage(null);
    }
  }

  async function handleSetupReply(e: FormEvent) {
    e.preventDefault();
    if (!setupReply.trim()) return;
    const content = setupReply.trim();
    setSetupReply("");
    await callSetup(content, "AI is thinking — drafting the next setup question…");
  }

  /**
   * "Looks ready" button: force progress toward a finalized plan.
   * - If a draft plan already exists → finalize directly (skip the AI loop).
   * - Otherwise → nudge the AI to propose, then auto-finalize if it does.
   */
  async function handleLooksReady() {
    if (!state || !snapshot) return;
    setError(null);
    if (snapshot.plan) {
      await handleApprovePlan();
      return;
    }
    setBusy(true);
    setBusyMessage("Asking the AI to draft the plan…");
    try {
      const reply = await api.setupReply(state.sessionId, state.token, NUDGE_PROPOSE);
      const snap = await api.getSession(state.sessionId, state.token);
      setSnapshot(snap);
      if (snap.plan) {
        setBusyMessage("Plan drafted — finalizing…");
        await api.setupFinalize(state.sessionId, state.token);
        const after = await api.getSession(state.sessionId, state.token);
        setSnapshot(after);
      } else {
        // Disambiguate the failure mode using server-side diagnostics
        // so the operator knows whether to raise max_tokens, share more
        // context, or report a model regression. Without this every
        // failure looked identical in the UI.
        const diags = reply.diagnostics ?? [];
        const truncated = diags.find((d) => d.kind === "llm_truncated");
        const rejected = diags.find((d) => d.kind === "tool_use_rejected");
        let message: string;
        if (truncated) {
          message =
            `The AI's plan call was truncated (${truncated.tier ?? "setup"} tier hit max_tokens). ` +
            (truncated.hint ?? "Raise LLM_MAX_TOKENS_SETUP and retry.");
        } else if (rejected) {
          const tool = rejected.name ?? "tool";
          message = `The AI tried to call ${tool} but the engine rejected it: ${rejected.reason ?? "see backend logs"}`;
        } else {
          message =
            "The AI didn't propose a plan yet. Try once more, or share a bit more context first.";
        }
        setError(message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setBusyMessage(null);
    }
  }

  /** Direct finalize using the existing draft plan — no AI call. */
  async function handleApprovePlan() {
    if (!state) return;
    setError(null);
    setBusy(true);
    setBusyMessage("Finalizing plan and moving to the lobby…");
    try {
      await api.setupFinalize(state.sessionId, state.token);
      const snap = await api.getSession(state.sessionId, state.token);
      setSnapshot(snap);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setBusyMessage(null);
    }
  }

  /** Dev-only shortcut: install a default plan and skip setup entirely. */
  async function handleSkipSetup() {
    if (!state) return;
    if (
      !confirm(
        "Skip the AI setup dialogue and use a generic default plan? Use this for testing only.",
      )
    ) {
      return;
    }
    setError(null);
    setBusy(true);
    setBusyMessage("Skipping setup with a default plan…");
    try {
      await api.setupSkip(state.sessionId, state.token);
      const snap = await api.getSession(state.sessionId, state.token);
      setSnapshot(snap);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setBusyMessage(null);
    }
  }

  async function handleNewSession() {
    if (!state) {
      // Already on intro screen.
      return;
    }
    if (snapshot && snapshot.state !== "ENDED") {
      if (
        !confirm(
          "Start a new session? The current exercise will be ended (no AAR will be generated automatically).",
        )
      ) {
        return;
      }
      try {
        await api.endSession(state.sessionId, state.token, "ended via 'new session'");
      } catch {
        // Swallow — best-effort cleanup. The user wants to move on.
      }
    }
    console.info("[facilitator] reset to intro");
    wsRef.current?.close();
    wsRef.current = null;
    setState(null);
    setSnapshot(null);
    setStreamingActive(false);
    setCriticalBanner(null);
    setDecisionLog([]);
    setPresence(new Set());
    setCost(null);
    setLastEventAt(null);
    setConnectionCount(null);
    setSetupReply("");
    setError(null);
  }

  async function handleStart() {
    if (!state) return;
    setBusy(true);
    setBusyMessage("Starting session — AI is opening the briefing…");
    try {
      await api.start(state.sessionId, state.token);
      await refreshSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setBusyMessage(null);
    }
  }

  async function handleSubmit(text: string, asRoleId?: string) {
    if (!state) return;
    // Force scroll-to-bottom on the next render so the user sees their
    // own message commit. Mirrors what every chat client does on send.
    forceScrollToBottom();
    try {
      if (asRoleId && asRoleId !== state.creatorRoleId) {
        // Creator impersonation — go through the REST proxy endpoint so
        // the backend records the correct role_id (the WS submit_response
        // is hard-pinned to the connection's own role).
        console.info("[facilitator] proxy submit", { asRoleId });
        await api.adminProxyRespond(state.sessionId, state.token, asRoleId, text);
        return;
      }
      if (!wsRef.current) return;
      wsRef.current.send({ type: "submit_response", content: text });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // ``useCallback(fn, [])`` gives ``handleTypingChange`` a stable identity
  // across re-renders (Facilitator re-renders on every WS event). Without it
  // the ``useEffect([onTypingChange])`` cleanup in Composer fires on *every*
  // re-render, cancelling the pending-start timer and leaving its ref as a
  // stale truthy integer — which permanently blocks new typing sessions for
  // the rest of the session (issue #77 regression).
  const handleTypingChange = useCallback((typing: boolean) => {
    const ws = wsRef.current;
    if (!ws) {
      // WS ref is null (not yet connected, or torn down after
      // creator-token revoke). Without an explicit check the
      // optional-chain ``ws?.send(...)`` would silently no-op
      // and the catch below would never fire — Copilot review
      // on PR #99.
      if (!typingSendErrLoggedRef.current) {
        console.debug(
          "[facilitator] typing send dropped (WS not connected)",
          { typing },
        );
        typingSendErrLoggedRef.current = true;
      }
      return;
    }
    try {
      ws.send({ type: typing ? "typing_start" : "typing_stop" });
      typingSendErrLoggedRef.current = false;
    } catch (err) {
      // Rate-limited log per WS-state edge (issue #77 — 1 Hz
      // heartbeat would otherwise produce ~60 logs/min through a
      // closed WS during a typing burst).
      if (!typingSendErrLoggedRef.current) {
        console.debug("[facilitator] typing send dropped (WS likely closed)", {
          message: err instanceof Error ? err.message : String(err),
        });
        typingSendErrLoggedRef.current = true;
      }
    }
  // Empty deps array is intentional: ``wsRef`` and ``typingSendErrLoggedRef``
  // are React refs (stable identity across renders) — accessing ``.current``
  // inside the callback reads the latest value without needing them as deps.
  // Listing them would cause the lint rule to flag them anyway since refs
  // are excluded from exhaustive-deps by convention.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleForceAdvance() {
    if (!state) return;
    // Client-side cooldown: prevents the triple-banner cascade visible
    // in the issue #63 screenshot when a frustrated operator double- or
    // triple-clicks. The backend gate in ``manager.force_advance``
    // (refuses while a play-tier LLM call is in flight) is the
    // authoritative protection; this is just a UX courtesy so a healthy
    // session doesn't dispatch three rapid requests.
    if (forceAdvanceCooldown) {
      console.warn("[facilitator] force-advance suppressed (cooldown)");
      return;
    }
    setForceAdvanceCooldown(true);
    forceAdvanceTimerRef.current = window.setTimeout(() => {
      setForceAdvanceCooldown(false);
      forceAdvanceTimerRef.current = null;
    }, 3000);
    setBusy(true);
    setBusyMessage("Force-advancing turn — AI is drafting the next beat…");
    forceScrollToBottom();
    try {
      await api.forceAdvance(state.sessionId, state.token);
      await refreshSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setBusyMessage(null);
    }
  }

  async function handleEnd() {
    if (!state) return;
    if (!confirm("End the session? This generates the AAR and closes the exercise.")) return;
    setBusy(true);
    setBusyMessage("Ending session…");
    try {
      await api.endSession(state.sessionId, state.token, "ended by creator");
      await refreshSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setBusyMessage(null);
    }
  }

  // ----------------------------------------------------- render
  if (phase === "intro") {
    const onToggleDevMode = (next: boolean) => {
      setDevMode(next);
      if (next) {
        // Prefill only sections the user hasn't typed into. Lets a tester
        // partially customise (e.g. tweak the team list) and still get
        // the rest of the boilerplate filled.
        setSetupParts((cur) => ({
          scenario: cur.scenario.trim() ? cur.scenario : DEV_SETUP_PREFILL.scenario,
          team: cur.team.trim() ? cur.team : DEV_SETUP_PREFILL.team,
          environment: cur.environment.trim() ? cur.environment : DEV_SETUP_PREFILL.environment,
          constraints: cur.constraints.trim() ? cur.constraints : DEV_SETUP_PREFILL.constraints,
        }));
        if (!creatorDisplayName.trim()) {
          setCreatorDisplayName("Dev Tester");
        }
      }
    };
    const setPart = (key: keyof typeof setupParts) => (value: string) =>
      setSetupParts((cur) => ({ ...cur, [key]: value }));
    return (
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-8">
        <h1 className="text-2xl font-semibold">New tabletop exercise</h1>
        <p className="text-sm text-slate-400">
          Give the facilitator AI a few sections of context up front so it
          can skip the boilerplate questions. Only the scenario brief is
          required; richer answers shorten the setup dialogue.
        </p>
        <ol className="flex flex-col gap-1 rounded border border-slate-700 bg-slate-900 p-3 text-xs text-slate-300">
          <li className="text-[11px] uppercase tracking-widest text-slate-400">
            What to expect
          </li>
          <li>1. <span className="text-slate-200">Setup</span> — the AI reads what you wrote below, asks 1–3 follow-up questions, then drafts a plan you can edit, approve, or skip.</li>
          <li>2. <span className="text-slate-200">Invite</span> — copy a per-role join link to each participant; you can also play one of the roles yourself.</li>
          <li>3. <span className="text-slate-200">Run</span> — the AI narrates beats, throws injects, and yields turns to specific roles. Typical session: 30–60 min.</li>
          <li>4. <span className="text-slate-200">After-action</span> — when you end the session, the AI generates a markdown report with per-role scores and a transcript.</li>
        </ol>
        <form onSubmit={handleCreate} className="flex flex-col gap-3">
          <div className="flex items-start gap-2 rounded border border-amber-600/60 bg-amber-950/30 p-2 text-xs text-amber-100">
            <label className="flex items-center gap-2 font-semibold">
              <input
                type="checkbox"
                checked={devMode}
                onChange={(e) => onToggleDevMode(e.target.checked)}
                aria-describedby="dev-mode-hint"
              />
              Dev mode
            </label>
            <span id="dev-mode-hint" className="text-[12px] text-amber-100/90">
              Prefills all four sections with a known ransomware brief +
              "Dev Tester" display name and skips the AI setup dialogue.
              Use this for local QA only.
            </span>
          </div>
          <label className="text-xs uppercase tracking-widest text-slate-400">
            Scenario brief <span className="text-rose-400">*</span>
          </label>
          <textarea
            value={setupParts.scenario}
            onChange={(e) => setPart("scenario")(e.target.value)}
            rows={3}
            required
            placeholder="What happened, when, at what severity. e.g. 'Ransomware via vendor portal at a regional bank, finance laptops encrypting, ~90 min of simulated time.'"
            className="rounded border border-slate-700 bg-slate-900 p-2 text-sm"
          />
          <label className="text-xs uppercase tracking-widest text-slate-400">
            About your team
          </label>
          <textarea
            value={setupParts.team}
            onChange={(e) => setPart("team")(e.target.value)}
            rows={3}
            placeholder="Roles + seniority + on-call posture. e.g. 'CISO (lead, on-call), IR Lead (3 yrs), SOC L1, Legal (business hours).' Optional — leave blank to let the AI ask."
            className="rounded border border-slate-700 bg-slate-900 p-2 text-sm"
          />
          <label className="text-xs uppercase tracking-widest text-slate-400">
            About your environment
          </label>
          <textarea
            value={setupParts.environment}
            onChange={(e) => setPart("environment")(e.target.value)}
            rows={3}
            placeholder="Stack, IdP, EDR/SIEM, crown jewels, regulatory regime. e.g. 'Microsoft 365 + Azure AD, Defender + Sentinel, customer PII + ACH, FFIEC / state-AG.' Optional."
            className="rounded border border-slate-700 bg-slate-900 p-2 text-sm"
          />
          <label className="text-xs uppercase tracking-widest text-slate-400">
            Constraints / things to avoid
          </label>
          <textarea
            value={setupParts.constraints}
            onChange={(e) => setPart("constraints")(e.target.value)}
            rows={2}
            placeholder="Hard NOs, learning objectives, pacing tolerance. e.g. 'No real CVEs; keep regulator framing US-state-AG; don't invent attacker attribution.' Optional."
            className="rounded border border-slate-700 bg-slate-900 p-2 text-sm"
          />
          <div className="grid grid-cols-2 gap-3">
            <input
              value={creatorLabel}
              onChange={(e) => setCreatorLabel(e.target.value)}
              required
              placeholder="Your role label (e.g. CISO)"
              className="rounded border border-slate-700 bg-slate-900 p-2 text-sm"
            />
            <input
              value={creatorDisplayName}
              onChange={(e) => setCreatorDisplayName(e.target.value)}
              required
              placeholder="Your display name"
              className="rounded border border-slate-700 bg-slate-900 p-2 text-sm"
            />
          </div>
          {(() => {
            // Helpers shared between the Add-role button and the Enter
            // shortcut. Extracted so the trim/dedup logic lives in one
            // place — duplicating it across the two handlers was flagged
            // as a regression footgun in code review.
            const addRoleLabel = (next: string) => {
              const trimmed = next.trim();
              if (!trimmed) return;
              if (
                setupRoles.some((r) => r.toLowerCase() === trimmed.toLowerCase())
              ) {
                setSetupRoleDraft("");
                return;
              }
              setSetupRoles((cur) => [...cur, trimmed]);
              setSetupRoleDraft("");
            };
            // Surface the silent dedupe-against-creator-label case: if the
            // operator picks "IR Lead" as their own role label and leaves
            // it in the suggestions, it'll be filtered out at create
            // time. Tell them up front rather than letting the seat go
            // missing without explanation.
            const creatorLabelLower = creatorLabel.trim().toLowerCase();
            const dedupeWithCreator = creatorLabelLower
              ? setupRoles.find((r) => r.toLowerCase() === creatorLabelLower)
              : undefined;
            const defaultsMatch =
              setupRoles.length === SETUP_ROLE_DEFAULTS.length &&
              SETUP_ROLE_DEFAULTS.every((d, i) => setupRoles[i] === d);
            return (
              <fieldset className="flex flex-col gap-2 rounded border border-slate-700 bg-slate-900 p-3">
                <legend className="px-1 text-xs uppercase tracking-widest text-slate-400">
                  Roles to invite
                </legend>
                <p className="text-[11px] text-slate-400">
                  Add the seats other participants will fill. Each role
                  gets its own join link in the lobby — you'll copy and
                  share the link yourself. You can also add or remove
                  roles later from the Roles panel.
                </p>
                {setupRoles.length > 0 ? (
                  <ul className="flex flex-wrap gap-1.5">
                    {setupRoles.map((label, idx) => (
                      <li
                        key={`${label}-${idx}`}
                        className="inline-flex items-center gap-1 rounded border border-slate-600 bg-slate-950 py-0.5 pl-2 pr-0.5 text-xs text-slate-200"
                      >
                        <span>{label}</span>
                        <button
                          type="button"
                          onClick={() =>
                            setSetupRoles((cur) =>
                              cur.filter((_, i) => i !== idx),
                            )
                          }
                          aria-label={`Remove ${label}`}
                          className="rounded px-1.5 py-0.5 text-slate-400 hover:bg-slate-800 hover:text-red-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300"
                          title={`Remove ${label}`}
                        >
                          <span aria-hidden="true">×</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[11px] italic text-slate-500">
                    No invitee roles yet. You'll need at least 1 invitee
                    (you + 1 = 2 player seats) before the exercise can
                    start.
                  </p>
                )}
                {dedupeWithCreator ? (
                  <p
                    role="status"
                    className="text-[11px] text-amber-300"
                  >
                    You're playing "{dedupeWithCreator}", so it won't be
                    auto-added as a separate invitee.
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <input
                    value={setupRoleDraft}
                    onChange={(e) => setSetupRoleDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addRoleLabel(setupRoleDraft);
                      }
                    }}
                    placeholder="e.g. IR Lead — press Enter to add another"
                    aria-label="New role label"
                    className="flex-1 rounded border border-slate-700 bg-slate-950 p-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300"
                  />
                  <button
                    type="button"
                    onClick={() => addRoleLabel(setupRoleDraft)}
                    disabled={!setupRoleDraft.trim()}
                    className="rounded border border-slate-600 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 disabled:opacity-50"
                  >
                    Add role
                  </button>
                </div>
                <div className="flex flex-wrap gap-3 text-[11px] text-slate-400">
                  {setupRoles.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => setSetupRoles([])}
                      className="text-slate-400 underline hover:text-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300"
                    >
                      Clear all
                    </button>
                  ) : null}
                  {!defaultsMatch ? (
                    <button
                      type="button"
                      onClick={() => setSetupRoles([...SETUP_ROLE_DEFAULTS])}
                      className="text-slate-400 underline hover:text-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300"
                    >
                      Reset to defaults
                    </button>
                  ) : null}
                </div>
              </fieldset>
            );
          })()}
          <button
            type="submit"
            disabled={busy}
            className="self-start rounded bg-sky-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Creating…" : devMode ? "Create session (dev fast-skip)" : "Create session"}
          </button>
        </form>
        {busyMessage ? (
          <p className="text-sm text-sky-300" role="status" aria-live="polite">
            {busyMessage}
          </p>
        ) : null}
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
      </main>
    );
  }

  if (!state || !snapshot) return null;

  const activeRoleIds = snapshot.current_turn?.active_role_ids ?? [];
  const isMyTurn = activeRoleIds.includes(state.creatorRoleId);
  const playerCount = snapshot.roles.filter((r) => r.kind === "player").length;

  return (
    <main className="flex min-h-screen flex-col lg:h-screen lg:min-h-0 lg:overflow-hidden">
      {criticalBanner ? (
        <CriticalEventBanner
          {...criticalBanner}
          canAcknowledge={isMyTurn}
          onAcknowledge={() => setCriticalBanner(null)}
        />
      ) : null}
      {/* Issue #62 (round 2): consolidated top bar — debug telemetry +
          phase CTA + meta actions on a single row. See ``TopBar`` for
          layout rationale. */}
      <TopBar
        phase={phase}
        backendState={snapshot.state}
        wsStatus={wsStatus}
        godMode={godMode}
        onToggleGodMode={() => setGodMode((g) => !g)}
        onStart={handleStart}
        onForceAdvance={handleForceAdvance}
        onEnd={handleEnd}
        onNewSession={handleNewSession}
        onViewAar={() => setShowAarPopup(true)}
        playerCount={playerCount}
        hasFinalizedPlan={Boolean(snapshot.plan)}
        aarStatus={snapshot.aar_status ?? null}
        busy={busy}
        turnIndex={snapshot.current_turn?.index ?? null}
        rationaleCount={decisionLog.length}
        connectionCount={connectionCount}
        lastEventAt={lastEventAt}
        cost={cost ?? snapshot.cost}
        messageCount={snapshot.messages.length}
        activeTiers={(() => {
          // De-dupe tiers across overlapping calls and sort for a stable
          // chip label. Empty set → idle. The chip itself decides how to
          // render the empty case; we pass an empty array.
          const seen = new Set<string>();
          for (const tier of aiCalls.values()) seen.add(tier);
          return Array.from(seen).sort();
        })()}
      />
      <div className="mx-auto grid w-full max-w-7xl flex-1 grid-cols-1 gap-4 p-4 lg:min-h-0 lg:grid-cols-[280px_1fr_280px] lg:overflow-hidden">
        <aside className="flex flex-col gap-4 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
          <RolesPanel
            sessionId={state.sessionId}
            creatorToken={state.token}
            roles={snapshot.roles}
            busy={busy}
            onRoleAdded={refreshSnapshot}
            onRoleChanged={refreshSnapshot}
            onError={setError}
            connectedRoleIds={presence}
          />
          {snapshot.current_turn?.active_role_ids?.length ? (
            <ActiveRolesHint
              activeRoleIds={activeRoleIds}
              roles={snapshot.roles}
            />
          ) : null}
          <SessionActivityPanel
            sessionId={state.sessionId}
            creatorToken={state.token}
            roles={snapshot.roles}
            onForceAdvance={handleForceAdvance}
            busy={busy || forceAdvanceCooldown}
          />
          <DecisionLogPanel entries={decisionLog} />
        </aside>

        <section className="flex min-w-0 flex-col gap-3 lg:min-h-0 lg:overflow-hidden">
          {/*
            Every phase view (setup / ready / ended / play) renders inside the
            same scrollable region. Pre-fix the wrapping ``<div>`` only
            existed for play/ended, so the READY phase's plan-JSON dump and
            the SETUP chat both got clipped on desktop with no scrollbar —
            an operator literally couldn't reach the "Approve plan" button.
          */}
          {/*
            Scroll region: holds whatever scrolls within a phase. For
            setup/ready/ended this is the entire phase content. For play
            the *transcript only* lives here so the Composer (a sibling
            below) stays pinned to the bottom of the section regardless
            of how long the chat grows. Pre-fix the Composer was nested
            *inside* this scroller, which buried the Submit button as
            soon as the transcript outgrew the viewport.
          */}
          <div
            ref={scrollRegionRef}
            className="flex min-w-0 flex-col gap-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1"
          >
          {phase === "setup" ? (
            <SetupView
              snapshot={snapshot}
              setupReply={setupReply}
              setSetupReply={setSetupReply}
              onSubmit={handleSetupReply}
              onLooksReady={handleLooksReady}
              onApprovePlan={handleApprovePlan}
              onSkipSetup={handleSkipSetup}
              onPickOption={(opt) => callSetup(opt, "Sending your selection to the AI…")}
              busy={busy}
              busyMessage={busyMessage}
            />
          ) : null}
          {phase === "ready" ? (
            <ReadyView plan={snapshot.plan} sessionId={state.sessionId} />
          ) : null}
          {phase === "ended" ? (
            <EndedView
              sessionId={state.sessionId}
              token={state.token}
            />
          ) : null}
          {phase === "play" || phase === "ended" ? (
            <>
              {phase === "play" && snapshot.current_turn?.status === "errored" ? (
                // Mirror the player-side amber banner inside the chat area
                // for the creator. The sidebar activity panel also shows
                // this with an inline force-advance button — the chat-area
                // banner is the next-action affordance for an operator
                // who's reading the transcript and didn't notice the
                // sidebar update.
                <div
                  role="status"
                  aria-live="polite"
                  className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded border border-amber-700/60 bg-amber-950/40 p-3 text-sm text-amber-100"
                >
                  <span>
                    The AI failed to yield via a tool. Click below to nudge
                    it forward, or end the session.
                  </span>
                  <button
                    type="button"
                    onClick={handleForceAdvance}
                    disabled={busy || forceAdvanceCooldown}
                    aria-disabled={busy || forceAdvanceCooldown}
                    className="rounded border border-emerald-500 bg-emerald-900/30 px-3 py-1 text-xs font-semibold text-emerald-100 hover:bg-emerald-700/40 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {forceAdvanceCooldown ? "AI: take next beat (cooling down)" : "AI: take next beat"}
                  </button>
                </div>
              ) : null}
              <Transcript
                messages={snapshot.messages}
                roles={snapshot.roles}
                aiThinking={
                  // Authoritative: any LLM call boundary in flight, or
                  // an active stream, lights the typing indicator. The
                  // state-based predicate is the reconnect-time safety
                  // net (``ai_thinking`` events are non-replayed).
                  snapshot.current_turn?.status !== "errored" &&
                  (aiCalls.size > 0 ||
                    streamingActive ||
                    (phase === "play" &&
                      (snapshot.state === "AI_PROCESSING" ||
                        snapshot.state === "BRIEFING" ||
                        snapshot.current_turn?.status === "processing")))
                }
                aiStatusLabel={(() => {
                  // Operator surface — keep the engineering detail
                  // (``missing_yield`` / ``missing_drive``) so a CISO
                  // running the exercise can correlate the indicator
                  // with the activity panel + audit feed. Participant
                  // copy in Play.tsx hides the jargon.
                  if (!aiStatus) return undefined;
                  if (aiStatus.phase === "play" && aiStatus.recovery) {
                    const a = aiStatus.attempt ?? "?";
                    const b = aiStatus.budget ?? "?";
                    const kind = aiStatus.recovery.replace(/_/g, " ");
                    return `Recovery pass ${a}/${b} (${kind})`;
                  }
                  if (aiStatus.phase === "interject") {
                    const role = snapshot.roles.find(
                      (r) => r.id === aiStatus.forRoleId,
                    );
                    return `Replying to ${role?.label ?? "a participant"}`;
                  }
                  if (aiStatus.phase === "briefing") return "Briefing the team";
                  if (aiStatus.phase === "setup") return "Preparing the scenario";
                  if (aiStatus.phase === "aar")
                    return "Drafting the after-action report";
                  return undefined;
                })()}
                typingRoleIds={Object.keys(typing).filter(
                  (rid) => rid !== state.creatorRoleId,
                )}
                // Pair the latest-AI amber ring with the participant
                // path. ``isMyTurn`` here is the creator-as-active-role
                // version (line ~1072: ``activeRoleIds.includes(state.creatorRoleId)``).
                // Pre-fix the prop was simply not passed on the creator
                // surface, so the ring never appeared even when the
                // creator was on the active set — an asymmetry the user
                // flagged as a regression on the same screen as the
                // scroll bug.
                highlightLastAi={isMyTurn}
              />
            </>
          ) : null}
          {error ? <p className="text-sm text-red-400">{error}</p> : null}
          </div>
          {/* "New messages below" chip — appears when content arrives
              while the operator has scrolled up to re-read. Clicking
              it re-pins to the bottom. Mirrors the standard chat-app
              pattern (Slack / Discord) so an unpinned operator knows
              there's content below without being yanked off whatever
              they were reading. See the Play.tsx counterpart for the
              colour-choice rationale: solid sky to stay distinct from
              the amber awaiting-response banner that often sits
              directly below. */}
          {phase === "play" && hasUnreadBelow ? (
            // Live-region semantics on the wrapper, not the button —
            // see Play.tsx counterpart for the ARIA APG rationale.
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
          {phase === "play" ? (
            // Composer + WaitingChip live OUTSIDE the scroll region so they
            // stay pinned at the bottom of the section regardless of
            // transcript length. ``shrink-0`` here is what keeps Submit
            // reachable on a 30-message exercise.
            <div className="shrink-0">
              {/* Operator-action busy chip — moved out of the top bar so
                  the "is the AI thinking or stuck?" signal sits where
                  the operator's eye already is during a turn. */}
              <BusyChip busy={busy} message={busyMessage} />
              {!isMyTurn && snapshot.current_turn?.active_role_ids?.length ? (
                <WaitingChip
                  activeRoleIds={activeRoleIds}
                  submittedRoleIds={
                    snapshot.current_turn?.submitted_role_ids ?? []
                  }
                  roles={snapshot.roles}
                />
              ) : null}
              {(() => {
                // Creator-only "respond as" dropdown. See
                // ``buildImpersonateOptions`` for the filter logic
                // (issue #80 — sources from the full roster so a
                // mid-session role-add appears immediately, with an
                // "(off-turn)" suffix when the role isn't on the
                // current turn's active set).
                const impersonateOptions = buildImpersonateOptions({
                  roles: snapshot.roles,
                  activeRoleIds,
                  submittedRoleIds:
                    snapshot.current_turn?.submitted_role_ids ?? [],
                });
                const selfRole = snapshot.roles.find(
                  (r) => r.id === state.creatorRoleId,
                );
                // Issue #78: the creator can post any time the session
                // is awaiting players — even when they're not on the
                // active set. Out-of-turn submissions land as
                // interjections (transcript only, no turn advance).
                // ``!busy`` keeps double-submits during an in-flight
                // creator action (force-advance, end-session) out of
                // the queue.
                const composerEnabled =
                  snapshot.state === "AWAITING_PLAYERS" && !busy;
                const canSelfSpeak = isMyTurn && !busy;
                const canProxy = impersonateOptions.length > 0 && !busy;
                return (
                  <>
                    {canProxy && impersonateOptions.length > 0 ? (
                      // One-line hint addressing the user-agent CRITICAL —
                      // a fresh creator should know WHY a "Respond as"
                      // dropdown just appeared and that it's optional.
                      <p className="mb-1 text-[11px] text-slate-400">
                        Tip: {impersonateOptions.length === 1 ? "1 role hasn't" : `${impersonateOptions.length} roles haven't`}{" "}
                        joined yet — share their invite link, or use
                        "Respond as" to answer for them while solo-testing.
                      </p>
                    ) : null}
                    <Composer
                      enabled={composerEnabled}
                      label={
                        canSelfSpeak
                          ? "Your turn"
                          : canProxy
                            ? "Respond as / sidebar"
                            : composerEnabled
                              ? "Add a comment"
                              : "Your message"
                      }
                      placeholder={
                        canSelfSpeak
                          ? "You are an active role. Make your decision."
                          : canProxy
                            ? "Add a comment, or use 'Respond as' to answer for a pending role."
                            : composerEnabled
                              ? "Add a comment anytime — it lands in the transcript."
                              : "Waiting for the AI / other roles."
                      }
                      onSubmit={handleSubmit}
                      onTypingChange={handleTypingChange}
                      impersonateOptions={impersonateOptions}
                      selfLabel={selfRole?.label}
                    />
                  </>
                );
              })()}
            </div>
          ) : null}
        </section>

        <RightSidebar
          messages={snapshot.messages}
          roles={snapshot.roles}
          notesStorageKey={(() => {
            const role = snapshot.roles.find((r) => r.id === state.creatorRoleId);
            const v = role?.token_version ?? 0;
            return `atf-notes:${state.sessionId}:${state.creatorRoleId}:v${v}`;
          })()}
        />
      </div>
      {godMode ? (
        <GodModePanel
          sessionId={state.sessionId}
          creatorToken={state.token}
          onClose={() => setGodMode(false)}
        />
      ) : null}
      {showAarPopup ? (
        <AARPopup
          sessionId={state.sessionId}
          token={state.token}
          onClose={() => setShowAarPopup(false)}
        />
      ) : null}
    </main>
  );
}

/**
 * Issue #62 (round 2): single consolidated top bar that combines the
 * pre-merge ``StatusBar`` (debug pills + God Mode) with the
 * ``SessionActionBar`` (phase CTA / supporting buttons / "Start a new
 * session"). Two stacked bars wasted vertical space and read as
 * redundant; one bar with the CTA on the left and debug telemetry on the
 * right keeps every datum we surface today while halving the chrome
 * height. Mobile lets the bar wrap naturally — content rolls onto
 * additional rows but still sits at the top of the viewport.
 *
 * Layout:
 *   [title] [phase CTA] [supporting buttons] [helper text]
 *                          ml-auto →
 *   [state pill] [ws pill] [build SHA] [God Mode] [Start a new session]
 *
 * The "AI is thinking…" / generic-busy chip lives next to the Composer
 * (see ``BusyChip`` below) per the operator's instruction to keep the
 * stuck-vs-thinking signal at the bottom of the transcript where their
 * eye already is during a turn.
 */
export function TopBar(props: {
  phase: Phase;
  backendState: string;
  wsStatus: "connecting" | "open" | "closed" | "error";
  godMode: boolean;
  onToggleGodMode: () => void;
  // Session-action props (was SessionActionBar):
  onStart: () => void;
  onForceAdvance: () => void;
  onEnd: () => void;
  onNewSession: () => void;
  /** Opens the single AAR popup (which contains the actual Download button). */
  onViewAar: () => void;
  playerCount: number;
  hasFinalizedPlan: boolean;
  /** "pending" | "generating" | "ready" | "failed" — null while loading. */
  aarStatus: string | null;
  busy: boolean;
  // Round 3 telemetry — see ``Facilitator`` state for source-of-truth
  // notes. Each prop is optional / nullable so the bar still renders
  // before the first WS frame / snapshot fetch lands.
  /** ``snapshot.current_turn?.index`` — null when no turn is active. */
  turnIndex: number | null;
  /** ``decisionLog.length`` — count of AI rationale entries logged. */
  rationaleCount: number;
  /** Server-pushed total open WS tabs on this session, or null if unknown. */
  connectionCount: number | null;
  /** ``Date.now()`` of the last received WS frame; null until first frame. */
  lastEventAt: number | null;
  /** Latest cost snapshot — drives the click-to-expand chip. */
  cost: CostSnapshot | null;
  /** ``snapshot.messages.length`` — raw message-count debug telemetry. */
  messageCount: number;
  /** Sorted, de-duped LLM tiers currently in flight (e.g. ``["play"]``,
   *  ``["guardrail", "play"]``). Empty array = idle. Source: every
   *  ``ai_thinking`` event carries a ``tier``; ``Facilitator`` retains
   *  the mapping per ``call_id``. */
  activeTiers: string[];
}) {
  const wsColour =
    props.wsStatus === "open"
      ? "text-emerald-300"
      : props.wsStatus === "connecting"
        ? "text-amber-300"
        : "text-red-300";
  const canStart =
    (props.phase === "ready" || props.phase === "setup") &&
    props.hasFinalizedPlan &&
    props.playerCount >= 2;
  // ``Last: Xs ago`` chip — re-render once a second so the displayed
  // delta stays fresh without bumping component state from outside. We
  // tick a meaningless integer; React diffs the rendered string. The
  // 1 s cadence matches the resolution of the data we have (Date.now()
  // is millisecond-precise but a sub-second indicator would just look
  // jittery).
  //
  // Depend on the *boolean* presence of a timestamp rather than its
  // value: ``lastEventAt`` is bumped on every WS frame (including
  // typing pings + heartbeats), so a value-dep would tear down and
  // re-create the timer hundreds of times a minute under load. The
  // boolean only flips once (null → number on first frame), so the
  // interval is created exactly once per session. The timer reads the
  // latest timestamp from ``props`` on each tick via ``lastEventLabel``
  // below, which closes over ``props`` afresh on every render.
  const hasLastEvent = props.lastEventAt !== null;
  const [, _setTick] = useState(0);
  useEffect(() => {
    if (!hasLastEvent) return;
    const id = setInterval(() => _setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [hasLastEvent]);
  const lastEventLabel = props.lastEventAt === null
    ? "—"
    : (() => {
        const ms = Math.max(0, Date.now() - props.lastEventAt);
        if (ms < 1000) return "<1s ago";
        const s = Math.floor(ms / 1000);
        if (s < 60) return `${s}s ago`;
        const m = Math.floor(s / 60);
        if (m < 60) return `${m}m ago`;
        return `${Math.floor(m / 60)}h ago`;
      })();

  return (
    <header
      role="banner"
      className="border-b border-slate-800 bg-slate-900/70 px-4 py-2 text-xs"
    >
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-2">
        {/* Left cluster: title + phase-conditional primary actions. The
            CTA sits early in the row so an LTR reader's eye lands on the
            verb before the debug pills. */}
        <span className="font-semibold uppercase tracking-widest text-slate-400">
          Facilitator
        </span>

        {props.phase === "ready" || props.phase === "setup" ? (
          <>
            <button
              type="button"
              onClick={props.onStart}
              disabled={!canStart || props.busy}
              className="rounded bg-emerald-600 px-3 py-1 text-sm font-semibold text-white hover:bg-emerald-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
              title={
                !props.hasFinalizedPlan
                  ? "Finalize the plan first"
                  : props.playerCount < 2
                    ? "Add at least 2 player roles"
                    : ""
              }
            >
              Start session
            </button>
            <span className="text-slate-400">
              Players: {props.playerCount} (need ≥ 2 to start)
            </span>
          </>
        ) : null}

        {props.phase === "play" ? (
          <>
            <button
              type="button"
              onClick={props.onForceAdvance}
              disabled={props.busy}
              className="rounded border border-emerald-500 bg-emerald-900/30 px-3 py-1 text-sm font-semibold text-emerald-100 hover:bg-emerald-700/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:opacity-50"
              title="Hand the turn to the AI now. Use when conversation has stalled OR when one player is unresponsive."
            >
              AI: take next beat
            </button>
            <button
              type="button"
              onClick={props.onEnd}
              disabled={props.busy}
              className="rounded border border-red-500 px-3 py-1 text-sm font-semibold text-red-300 hover:bg-red-900/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-300 disabled:opacity-50"
            >
              End session
            </button>
          </>
        ) : null}

        {props.phase === "ended"
          ? (() => {
              if (props.aarStatus === "ready") {
                return (
                  <button
                    type="button"
                    onClick={props.onViewAar}
                    className="rounded bg-emerald-600 px-3 py-1 text-sm font-semibold text-white hover:bg-emerald-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300"
                  >
                    View AAR
                  </button>
                );
              }
              if (props.aarStatus === "failed") {
                return (
                  <span
                    role="status"
                    className="inline-flex items-center gap-1 rounded border border-red-500/60 bg-red-950/30 px-2 py-0.5 text-red-200"
                  >
                    AAR failed — see Retry in main panel.
                  </span>
                );
              }
              return (
                <span
                  role="status"
                  aria-live="polite"
                  className="inline-flex items-center gap-1.5 rounded bg-slate-800/80 px-2 py-0.5 text-slate-300"
                >
                  <span
                    aria-hidden="true"
                    className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400"
                  />
                  AAR generating… (~30 s)
                </span>
              );
            })()
          : null}

        {/* Right cluster: debug telemetry + meta actions. Wrapped in its
            own container so ``ml-auto`` reliably pushes the whole group
            to the row's end (and stays grouped when the row wraps on
            mobile). Per operator request, every debug datum currently
            shown is preserved — only the layout changed. */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Turn / message / rationale / tabs / last-event chips. All
              read straight off existing snapshot + WS state; no extra
              round-trip. Useful for "what's happening?" diagnostics
              while the app is under active development. */}
          <span
            className="rounded bg-slate-800 px-2 py-0.5 text-slate-200"
            title="Current turn index from snapshot.current_turn.index"
          >
            T#{props.turnIndex ?? "—"}
          </span>
          <span
            className="rounded bg-slate-800 px-2 py-0.5 text-slate-200"
            title="Total messages on the session (snapshot.messages.length)"
          >
            {props.messageCount} msgs
          </span>
          <span
            className="rounded bg-slate-800 px-2 py-0.5 text-slate-200"
            title="AI rationale entries logged via record_decision_rationale"
          >
            Rationale: {props.rationaleCount}
          </span>
          <span
            className="rounded bg-slate-800 px-2 py-0.5 text-slate-200"
            title="Total open WebSocket tabs watching this session (server-reported)"
          >
            Tabs: {props.connectionCount ?? "—"}
          </span>
          <span
            className="rounded bg-slate-800 px-2 py-0.5 text-slate-300"
            title="Time since the last WebSocket frame arrived. Stalls here mean the connection is silent even if ws: open."
          >
            Last: {lastEventLabel}
          </span>
          {/* LLM tier chip (#9). When idle the chip stays present (just
              de-emphasised) so the bar layout doesn't reflow on every
              call boundary; when active it goes amber + bold so the
              operator's eye picks it up while glancing across the bar. */}
          {props.activeTiers.length > 0 ? (
            <span
              className="rounded bg-amber-900/40 px-2 py-0.5 font-semibold text-amber-200"
              role="status"
              aria-live="polite"
              title={`Active LLM call(s) — tier${props.activeTiers.length === 1 ? "" : "s"}: ${props.activeTiers.join(", ")}.`}
            >
              LLM: {props.activeTiers.join("+")}
            </span>
          ) : (
            <span
              className="rounded bg-slate-800 px-2 py-0.5 text-slate-500"
              title="No LLM call currently in flight."
            >
              LLM: idle
            </span>
          )}
          {/* Cost: click-to-expand chip. The summary shows the dollar
              amount; the disclosure body shows the token breakdown
              (mirrors the old sidebar CostMeter, but inline). Native
              <details> gives focus management + Esc-to-collapse for
              free; the popup positions absolutely so it overlays the
              page chrome below the bar without pushing layout. */}
          <CostChip cost={props.cost} />
          <span className={wsColour}>● ws: {props.wsStatus}</span>
          <span className="rounded bg-slate-800 px-2 py-0.5 text-slate-200">
            state: {props.backendState} · phase: {props.phase}
          </span>
          {/* Build identification — surfaced so a creator filing a bug
              report can tell us which version they're on without opening
              DevTools. Vite injects ``__ATF_GIT_SHA__`` at build time. */}
          <span
            className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[10px] text-slate-400"
            title={`Build: ${__ATF_GIT_SHA__} · ${__ATF_BUILD_TS__}`}
          >
            v {__ATF_GIT_SHA__}
          </span>
          <button
            type="button"
            onClick={props.onToggleGodMode}
            aria-pressed={props.godMode}
            className={
              "rounded border px-2 py-0.5 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-300 " +
              (props.godMode
                ? "border-purple-500 bg-purple-700/40 text-purple-100"
                : "border-purple-700/40 text-purple-300 hover:bg-purple-900/30")
            }
            title="Toggle full debug overlay (audit log, system prompt, etc). Creator-only."
          >
            {props.godMode ? "● God Mode" : "○ God Mode"}
          </button>
          <button
            type="button"
            onClick={props.onNewSession}
            disabled={props.busy}
            className="rounded border border-slate-600 px-2 py-0.5 text-slate-300 hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-300 disabled:opacity-50"
            title="End the current session (if any) and return to the new-session form."
          >
            Start a new session
          </button>
        </div>
      </div>
    </header>
  );
}

/**
 * Operator-action busy chip. Pre-merge this lived in the top bar; the
 * operator preferred it pinned near the transcript bottom (where their
 * eye is during a turn) so it reads as a "is the AI stuck or thinking?"
 * signal rather than disappearing into the chrome at the top of the
 * page. Renders nothing when no operation is in flight.
 */
function BusyChip({ busy, message }: { busy: boolean; message: string | null }) {
  if (!busy) return null;
  return (
    <span
      role="status"
      aria-live="polite"
      className="mb-1 inline-flex shrink-0 items-center gap-2 self-start rounded bg-sky-900/40 px-2 py-1 text-xs text-sky-200"
    >
      <Spinner /> {message ?? "Working…"}
    </span>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-sky-400 border-t-transparent"
    />
  );
}

/**
 * Top-bar cost chip with a click-to-expand disclosure (Anthropic
 * plan-usage popup style). Replaces the old ``CostMeter`` sidebar card —
 * the dollar number now lives in the always-visible debug strip and
 * clicking it reveals the token breakdown that previously took up a
 * fixed sidebar slot. Native ``<details>`` gives keyboard + screen
 * reader behavior for free; ``open`` is internal to the element.
 */
function CostChip({ cost }: { cost: CostSnapshot | null }) {
  if (!cost) {
    // Render a placeholder chip so the bar's column count is stable
    // before the first ``cost_updated`` arrives. The "Cost: $—" form
    // also tells the creator the channel exists but is empty rather
    // than missing.
    return (
      <span
        className="rounded bg-slate-800 px-2 py-0.5 text-slate-400"
        title="No cost data yet — first LLM call will populate this."
      >
        Cost: $—
      </span>
    );
  }
  return (
    <details className="relative">
      <summary
        className="cursor-pointer list-none rounded bg-slate-800 px-2 py-0.5 font-semibold text-emerald-300 hover:bg-slate-700/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300"
        title="Cumulative Anthropic API spend for this session. Click to expand the token breakdown."
      >
        Cost: ${cost.estimated_usd.toFixed(4)}
      </summary>
      {/* Absolutely-positioned popover so the disclosure body doesn't
          push siblings around when toggled. ``z-20`` keeps it above the
          page grid; matching the bar's right-side anchor lets it expand
          left without leaving the viewport. */}
      <div className="absolute right-0 top-full z-20 mt-1 w-72 rounded border border-slate-700 bg-slate-900 p-3 text-xs text-slate-200 shadow-lg">
        <p className="mb-1 uppercase tracking-widest text-slate-400">
          Cost — token breakdown
        </p>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
          <dt className="text-slate-400">Input</dt>
          <dd className="text-right text-slate-100">
            {cost.input_tokens.toLocaleString()}
          </dd>
          <dt className="text-slate-400">Output</dt>
          <dd className="text-right text-slate-100">
            {cost.output_tokens.toLocaleString()}
          </dd>
          <dt className="text-slate-400">Cache read</dt>
          <dd className="text-right text-slate-100">
            {cost.cache_read_tokens.toLocaleString()}
          </dd>
          <dt className="text-slate-400">Cache create</dt>
          <dd className="text-right text-slate-100">
            {cost.cache_creation_tokens.toLocaleString()}
          </dd>
          <dt className="font-semibold text-emerald-300">Estimated</dt>
          <dd className="text-right font-semibold text-emerald-300">
            ${cost.estimated_usd.toFixed(4)}
          </dd>
        </dl>
        <p className="mt-2 text-[10px] leading-tight text-slate-500">
          Charged to the operator's Anthropic key. Cumulative for this
          session.
        </p>
      </div>
    </details>
  );
}

function ActiveRolesHint({
  activeRoleIds,
  roles,
}: {
  activeRoleIds: string[];
  roles: RoleView[];
}) {
  const labels = activeRoleIds
    .map((id) => roles.find((r) => r.id === id)?.label ?? id)
    .join(", ");
  return (
    <div className="rounded border border-emerald-700/40 bg-emerald-950/30 p-2 text-xs text-emerald-200">
      <p className="uppercase tracking-widest text-emerald-300">Active</p>
      <p>{labels || "(none)"}</p>
    </div>
  );
}

/**
 * Pinned above the Composer when *other* roles still owe a response. Names
 * the actor we're blocked on so the screen doesn't look frozen, with a
 * smaller ``(N of M)`` tail for at-a-glance count.
 *
 * Issue #88: previously rendered amber-on-amber (read as "warning") and
 * exposed a per-role "Copy invite" button that duplicated the Copy link
 * affordance already in the Roles panel. The tone is now neutral slate
 * matching the rest of the awaiting-state banners; copy/issuing links is
 * handled exclusively by the Roles panel.
 */
export function WaitingChip({
  activeRoleIds,
  submittedRoleIds,
  roles,
}: {
  activeRoleIds: string[];
  submittedRoleIds: string[];
  roles: RoleView[];
}) {
  const submitted = new Set(submittedRoleIds);
  const pending = activeRoleIds.filter((id) => !submitted.has(id));
  if (pending.length === 0) return null;
  const labels = pending.map((id) => {
    const r = roles.find((x) => x.id === id);
    if (!r) return id;
    return r.display_name ? `${r.label} (${r.display_name})` : r.label;
  });
  let phrase: string;
  if (labels.length === 1) {
    phrase = `Waiting on ${labels[0]} to respond.`;
  } else if (labels.length === 2) {
    phrase = `Waiting on ${labels[0]} and ${labels[1]}.`;
  } else {
    const head = labels.slice(0, 2).join(", ");
    phrase = `Waiting on ${head} and ${labels.length - 2} more.`;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-2 flex items-center gap-2 rounded bg-slate-800 px-2 py-1 text-xs text-slate-200"
    >
      <span>{phrase}</span>
      <span className="text-slate-400">
        ({pending.length} of {activeRoleIds.length})
      </span>
    </div>
  );
}


/**
 * Issue #62: horizontal action bar pinned just below the StatusBar so the
 * primary phase-appropriate CTA (Start / Force-advance / End / View AAR /
 * New session) is always reachable on narrow viewports. Pre-fix the same
 * controls lived at the bottom of the left sidebar — on a 493×943
 * viewport the Start button was below the fold, requiring a scroll past
 * the entire role roster + activity panel to reach it.
 */
function SetupView({
  snapshot,
  setupReply,
  setSetupReply,
  onSubmit,
  onLooksReady,
  onApprovePlan,
  onSkipSetup,
  onPickOption,
  busy,
  busyMessage,
}: {
  snapshot: SessionSnapshot;
  setupReply: string;
  setSetupReply: (s: string) => void;
  onSubmit: (e: FormEvent) => void;
  onLooksReady: () => void;
  onApprovePlan: () => void;
  onSkipSetup: () => void;
  onPickOption: (option: string) => void;
  busy: boolean;
  busyMessage: string | null;
}) {
  const hasPlan = Boolean(snapshot.plan);
  const notes = snapshot.setup_notes ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold">Setup dialogue</h2>
        <p className="text-xs text-slate-400">
          Answer the AI's questions briefly. When you have shared enough background, click{" "}
          <em>"Looks ready — propose the plan"</em> to nudge it to draft. Once a plan is on the
          table, click <em>"Approve plan"</em> to commit it.
        </p>
      </div>

      {notes.length === 0 && !busy ? (
        <p className="rounded border border-amber-700 bg-amber-950/40 p-3 text-xs text-amber-200">
          No setup messages yet. The AI usually responds in 5–20 seconds. If nothing appears soon,
          check the backend container logs — the most common causes are a missing
          <code className="mx-1 rounded bg-slate-900 px-1">ANTHROPIC_API_KEY</code> or a network
          issue reaching the Anthropic API.
        </p>
      ) : null}

      <SetupChat notes={notes} busy={busy} onPickOption={onPickOption} />

      {/* Operator-action busy chip — pinned with the reply form so the
          "is the AI thinking?" signal stays where the operator's eye is.
          See the play-phase BusyChip above the Composer for the same
          pattern. */}
      <BusyChip busy={busy} message={busyMessage} />

      <form onSubmit={onSubmit} className="flex flex-col gap-2">
        <textarea
          value={setupReply}
          onChange={(e) => setSetupReply(e.target.value)}
          rows={3}
          placeholder="Type your reply to the AI…"
          disabled={busy}
          className="rounded border border-slate-700 bg-slate-900 p-2 text-sm disabled:opacity-50"
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={busy || !setupReply.trim()}
            className="rounded bg-sky-600 px-3 py-1 text-sm font-semibold text-white disabled:opacity-50"
          >
            Send reply
          </button>
          {hasPlan ? (
            // A draft plan exists — only one action (finalize) is meaningful.
            <button
              type="button"
              onClick={onApprovePlan}
              disabled={busy}
              className="rounded bg-emerald-600 px-3 py-1 text-sm font-semibold text-white hover:bg-emerald-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:opacity-50"
              title="Commits the existing draft plan immediately (no AI call)."
            >
              Approve &amp; start lobby
            </button>
          ) : (
            <button
              type="button"
              onClick={onLooksReady}
              disabled={busy}
              className="rounded border border-emerald-600 px-3 py-1 text-sm font-semibold text-emerald-300 hover:bg-emerald-700/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:opacity-50"
              title="Asks the AI to draft a plan; auto-finalizes it if one comes back."
            >
              Looks ready — propose the plan
            </button>
          )}
          <button
            type="button"
            onClick={onSkipSetup}
            disabled={busy}
            className="ml-auto rounded border border-dashed border-slate-700 px-3 py-1 text-xs text-slate-500 opacity-70 hover:opacity-100 hover:bg-slate-800 disabled:opacity-50"
            title="Dev/testing only: skip the AI setup dialogue and use a generic default plan."
          >
            Skip setup (dev only)
          </button>
        </div>
      </form>

      {hasPlan ? <PlanPreview plan={snapshot.plan!} sessionId={snapshot.id} /> : null}
    </div>
  );
}

function PlanPreview({ plan, sessionId }: { plan: ScenarioPlan; sessionId?: string }) {
  return (
    <details className="rounded border border-emerald-700/60 bg-emerald-950/20 p-2 text-xs" open>
      <summary className="cursor-pointer text-emerald-300">
        Proposed plan: {plan.title}
      </summary>
      <div className="mt-2">
        <PlanView plan={plan} sessionId={sessionId} />
      </div>
    </details>
  );
}

/**
 * Readable structured plan view with optional spoiler-hide.
 *
 * The plan was previously dumped as ``JSON.stringify`` which (a) clipped on
 * narrow viewports and (b) spoiled every upcoming inject for the creator.
 * The creator is the only one who sees the plan in any case (it's
 * creator-only by ``visible_messages`` filtering), but as the operator
 * they may still want to play "fresh" alongside the team.
 *
 * Default: title, executive_summary, key_objectives, guardrails,
 * success_criteria, and out_of_scope are visible. ``narrative_arc`` and
 * ``injects`` are spoiler-hidden behind a Reveal toggle whose state is
 * persisted in localStorage so it carries across reloads.
 */
function PlanView({
  plan,
  sessionId,
}: {
  plan: ScenarioPlan;
  /**
   * Optional session id used to scope the spoiler-reveal preference.
   * Without this the preference would persist across sessions and a
   * creator who screen-shares with their team after a previous solo
   * test would silently spoil the next plan. Per-session scoping makes
   * each new exercise reset to the safe (hidden) default while still
   * respecting the user's choice within the current session.
   */
  sessionId?: string;
}) {
  const storageKey = sessionId
    ? `atf-plan-reveal:${sessionId}`
    : "atf-plan-reveal";
  const [reveal, setReveal] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });
  function toggleReveal() {
    setReveal((cur) => {
      const next = !cur;
      try {
        window.localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        /* localStorage may be disabled; preference is best-effort. */
      }
      return next;
    });
  }
  return (
    <article className="flex flex-col gap-4 text-sm text-slate-100">
      <header>
        <h3 className="text-lg font-semibold text-emerald-100">{plan.title}</h3>
      </header>

      {plan.executive_summary ? (
        <section className="flex flex-col gap-1">
          <h4 className="text-xs uppercase tracking-widest text-slate-400">
            Executive summary
          </h4>
          <ReactMarkdown
            skipHtml
            remarkPlugins={[remarkGfm]}
            components={{
              p: ({ children }) => (
                <p className="whitespace-pre-wrap leading-relaxed">{children}</p>
              ),
              strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
              em: ({ children }) => <em className="italic">{children}</em>,
            }}
          >
            {plan.executive_summary}
          </ReactMarkdown>
        </section>
      ) : null}

      {plan.key_objectives.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h4 className="text-xs uppercase tracking-widest text-slate-400">Key objectives</h4>
          <ul className="ml-4 list-disc space-y-0.5">
            {plan.key_objectives.map((o, i) => (
              <li key={i}>{o}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {plan.guardrails.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h4 className="text-xs uppercase tracking-widest text-slate-400">Guardrails</h4>
          <ul className="ml-4 list-disc space-y-0.5">
            {plan.guardrails.map((o, i) => (
              <li key={i}>{o}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {plan.success_criteria.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h4 className="text-xs uppercase tracking-widest text-slate-400">
            Success criteria
          </h4>
          <ul className="ml-4 list-disc space-y-0.5">
            {plan.success_criteria.map((o, i) => (
              <li key={i}>{o}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {plan.out_of_scope.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h4 className="text-xs uppercase tracking-widest text-slate-400">Out of scope</h4>
          <ul className="ml-4 list-disc space-y-0.5">
            {plan.out_of_scope.map((o, i) => (
              <li key={i}>{o}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {plan.narrative_arc.length > 0 || plan.injects.length > 0 ? (
        <section className="flex flex-col gap-2 rounded border border-amber-700/40 bg-amber-950/20 p-2">
          <header className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-xs uppercase tracking-widest text-amber-200">
              Narrative arc &amp; injects
            </h4>
            <button
              type="button"
              onClick={toggleReveal}
              className="rounded border border-amber-500/60 px-2 py-0.5 text-xs font-semibold text-amber-100 hover:bg-amber-900/30"
              aria-pressed={reveal}
              title={
                reveal
                  ? "Switch to participant mode — hide upcoming injects so you can play fresh."
                  : "Switch to facilitator mode — show upcoming injects so you can pace the meeting."
              }
            >
              {reveal ? "Switch to participant mode" : "Switch to facilitator mode"}
            </button>
          </header>
          {!reveal ? (
            <p className="text-xs text-amber-200/80">
              <span className="font-semibold">Participant mode.</span>{" "}
              Hidden so you can play through fresh. {plan.narrative_arc.length}{" "}
              beat{plan.narrative_arc.length === 1 ? "" : "s"}, {plan.injects.length}{" "}
              inject{plan.injects.length === 1 ? "" : "s"} planned. Switch to
              facilitator mode if you need to pace the meeting block.
            </p>
          ) : (
            <>
              {plan.narrative_arc.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <p className="text-[11px] uppercase tracking-widest text-amber-200/80">
                    Narrative arc
                  </p>
                  <ol className="ml-4 list-decimal space-y-1">
                    {plan.narrative_arc.map((b) => (
                      <li key={b.beat}>
                        <span className="font-semibold">{b.label}</span>
                        {b.expected_actors.length > 0 ? (
                          <span className="ml-1 text-slate-400">
                            — {b.expected_actors.join(", ")}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}
              {plan.injects.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <p className="text-[11px] uppercase tracking-widest text-amber-200/80">
                    Injects
                  </p>
                  <ul className="ml-4 list-disc space-y-1">
                    {plan.injects.map((inj, i) => (
                      <li key={i}>
                        <span className="text-slate-400">[{inj.trigger}]</span>{" "}
                        <span className="text-slate-400">({inj.type})</span>{" "}
                        {inj.summary}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : null}
    </article>
  );
}

function EndedView({ sessionId, token }: { sessionId: string; token: string }) {
  // ``expired`` = backend evicted the session after EXPORT_RETENTION_MIN —
  // the AAR is gone for good. Distinct from ``failed`` (transient generation
  // error, retry is meaningful) so we don't surface a Retry button that
  // would itself 404.
  type AARState = "generating" | "ready" | "failed" | "expired";
  const [aarState, setAarState] = useState<AARState>("generating");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // Poll the export endpoint with HEAD-style behavior: if 425, keep
  // polling. If 200, mark ready (the popup will fetch the body on open).
  // If 410, mark expired (retention window elapsed). If 5xx, mark failed.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const res = await fetch(
          `/api/sessions/${sessionId}/export.md?token=${encodeURIComponent(token)}`,
        );
        if (cancelled) return;
        if (res.status === 200) {
          setAarState("ready");
          return;
        }
        if (res.status === 425) {
          setAarState("generating");
          // Build-time tunable; default 2500ms.
          timer = setTimeout(tick, __ATF_AAR_POLL_MS__);
          return;
        }
        if (res.status === 410) {
          setAarState("expired");
          return;
        }
        setAarState("failed");
        try {
          setErrMsg((await res.text()).slice(0, 200));
        } catch {
          setErrMsg(`HTTP ${res.status}`);
        }
      } catch (err) {
        if (cancelled) return;
        setErrMsg(err instanceof Error ? err.message : String(err));
        timer = setTimeout(tick, 5000);
      }
    }
    // Only run the polling loop while we believe AAR is still in flight.
    // Retry-on-failure flips the local state back to "generating" which
    // re-runs this effect (via the dep array below) and restarts polling.
    if (aarState !== "failed") {
      tick();
    }
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, token, aarState]);

  return (
    <div
      className="flex flex-col gap-3 rounded border border-emerald-700/60 bg-emerald-950/30 p-4"
      role="status"
      aria-live="polite"
    >
      <h2 className="text-lg font-semibold text-emerald-200">
        Session ended — exercise complete
      </h2>
      {aarState === "generating" ? (
        <p className="inline-flex items-center gap-2 text-sm text-emerald-100">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 animate-ping rounded-full bg-emerald-400"
          />
          Generating after-action report (this can take 30–60 s)…
        </p>
      ) : aarState === "ready" ? (
        <p className="text-sm text-emerald-100">
          After-action report is ready. Use{" "}
          <span className="font-semibold">View AAR</span> in the sidebar
          Controls to read it (the popup contains a Download .md button).
          The report includes the full transcript, per-role scores, the
          frozen scenario plan, and the audit log.
        </p>
      ) : aarState === "expired" ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-amber-200">
            This after-action report has expired and is no longer
            available.
          </p>
          <p className="text-xs text-amber-100/80">
            Sessions are purged from server memory after the configured
            retention window (<code>EXPORT_RETENTION_MIN</code>, default
            60 minutes) to limit data retention. There is no recovery — to
            preserve a future AAR, download the <code>.md</code> file
            before the window elapses.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-red-300">
            AAR generation failed{errMsg ? `: ${errMsg}` : ""}.
          </p>
          <p className="text-xs text-red-200/80">
            Most failures are transient (model timeout, rate limit). Click
            Retry — if it keeps failing, check the backend logs or contact
            your operator.
          </p>
          <button
            type="button"
            onClick={async () => {
              setAarState("generating");
              setErrMsg(null);
              try {
                await api.adminRetryAar(sessionId, token);
                console.info("[facilitator] AAR retry kicked");
              } catch (err) {
                setAarState("failed");
                setErrMsg(err instanceof Error ? err.message : String(err));
              }
            }}
            className="self-start rounded bg-amber-600 px-3 py-1 text-sm font-semibold text-white hover:bg-amber-500"
          >
            Retry AAR generation
          </button>
        </div>
      )}
    </div>
  );
}

function AARPopup({
  sessionId,
  token,
  onClose,
}: {
  sessionId: string;
  token: string;
  onClose: () => void;
}) {
  const [body, setBody] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const downloadHref = `/api/sessions/${sessionId}/export.md?token=${encodeURIComponent(token)}`;

  // Fetch the markdown body once when the popup mounts.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(downloadHref);
        if (cancelled) return;
        if (!res.ok) {
          // 410 Gone = backend evicted the session after the retention
          // window. Surface a plain-English message instead of "HTTP 410".
          if (res.status === 410) {
            setErr(
              "This after-action report has expired and is no longer available — sessions are purged after the configured retention window.",
            );
          } else {
            setErr(`HTTP ${res.status}`);
          }
          return;
        }
        const text = await res.text();
        if (!cancelled) setBody(text);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // downloadHref is derived from sessionId/token; safe to depend on them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, token]);

  // Use the native <dialog> element so we get focus-trap + Esc-to-close
  // for free, matching God Mode's pattern.
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (!dlg.open) dlg.showModal();
    const onCancel = () => onClose();
    dlg.addEventListener("cancel", onCancel);
    return () => dlg.removeEventListener("cancel", onCancel);
  }, [onClose]);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className="m-auto flex h-[90vh] w-[min(900px,95vw)] flex-col rounded-lg border border-slate-700 bg-slate-900 p-0 text-slate-100 backdrop:bg-black/60"
      aria-labelledby="aar-popup-heading"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800 bg-slate-950/70 p-3">
        <h3 id="aar-popup-heading" className="text-sm font-semibold text-emerald-200">
          After-action report
        </h3>
        <div className="flex items-center gap-2">
          <a
            href={downloadHref}
            rel="noopener"
            download
            className="rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-500"
          >
            Download .md
          </a>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-slate-600 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800"
          >
            Close
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4 text-sm leading-relaxed">
        {err ? (
          <p className="text-red-300">Failed to load AAR: {err}</p>
        ) : body == null ? (
          <p className="text-slate-400">Loading…</p>
        ) : (
          <article className="text-slate-100">
            <ReactMarkdown
              skipHtml
              // GFM = tables / strikethrough / autolinks / task lists. The
              // AAR generator emits per-role score tables, so without this
              // they render as raw pipe text.
              remarkPlugins={[remarkGfm]}
              components={{
                h1: ({ children }) => (
                  <h1 className="mb-3 mt-4 text-xl font-semibold text-emerald-100">{children}</h1>
                ),
                h2: ({ children }) => (
                  <h2 className="mb-2 mt-4 text-lg font-semibold text-emerald-100">{children}</h2>
                ),
                h3: ({ children }) => (
                  <h3 className="mb-2 mt-3 text-base font-semibold text-emerald-200">{children}</h3>
                ),
                h4: ({ children }) => (
                  <h4 className="mb-1 mt-3 text-sm font-semibold text-emerald-200">{children}</h4>
                ),
                p: ({ children }) => <p className="mb-3 whitespace-pre-wrap">{children}</p>,
                ul: ({ children }) => <ul className="mb-3 ml-5 list-disc space-y-1">{children}</ul>,
                ol: ({ children }) => <ol className="mb-3 ml-5 list-decimal space-y-1">{children}</ol>,
                li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                em: ({ children }) => <em className="italic">{children}</em>,
                blockquote: ({ children }) => (
                  <blockquote className="mb-3 border-l-4 border-slate-700 pl-3 italic text-slate-300">
                    {children}
                  </blockquote>
                ),
                code: ({ children }) => (
                  <code className="rounded bg-slate-800 px-1 py-0.5 text-[0.85em]">{children}</code>
                ),
                pre: ({ children }) => (
                  <pre className="mb-3 overflow-auto rounded bg-slate-950 p-2 text-[0.85em]">
                    {children}
                  </pre>
                ),
                hr: () => <hr className="my-4 border-slate-700" />,
                a: ({ href, children }) => (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-sky-300 underline"
                  >
                    {children}
                  </a>
                ),
                del: ({ children }) => (
                  <del className="text-slate-400 line-through">{children}</del>
                ),
                table: ({ children }) => (
                  <TableScroll>
                    <table className="min-w-full border-collapse text-xs">{children}</table>
                  </TableScroll>
                ),
                thead: ({ children }) => (
                  <thead className="bg-slate-900/60">{children}</thead>
                ),
                tr: ({ children }) => (
                  <tr className="border-b border-slate-800">{children}</tr>
                ),
                th: ({ children }) => (
                  <th className="border border-slate-700 px-2 py-1 text-left font-semibold">
                    {children}
                  </th>
                ),
                td: ({ children }) => (
                  <td className="border border-slate-800 px-2 py-1 align-top">
                    {children}
                  </td>
                ),
              }}
            >
              {body}
            </ReactMarkdown>
          </article>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-800 bg-slate-950/70 p-3">
        <a
          href={downloadHref}
          rel="noopener"
          download
          className="rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-500"
        >
          Download .md
        </a>
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-slate-600 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800"
        >
          Close
        </button>
      </div>
    </dialog>
  );
}


function ReadyView({
  plan,
  sessionId,
}: {
  plan: SessionSnapshot["plan"];
  sessionId?: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Plan finalized — ready to start</h2>
      {plan ? (
        <div className="rounded border border-slate-700 bg-slate-900 p-3">
          <PlanView plan={plan} sessionId={sessionId} />
        </div>
      ) : null}
      <p className="text-sm text-slate-400">Add at least 2 roles, then click "Start session".</p>
    </div>
  );
}
