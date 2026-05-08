import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  CostSnapshot,
  DecisionLogEntry,
  DEFAULT_SESSION_FEATURES,
  Difficulty,
  ScenarioPlan,
  SessionFeatures,
  SessionSnapshot,
} from "../api/client";
import { confirmLeaveSession } from "../lib/leaveGuard";
import { AarReportView } from "../components/AarReport";
import { Composer } from "../components/Composer";
import { CriticalEventBanner } from "../components/CriticalEventBanner";
import { DecisionLogPanel } from "../components/DecisionLogPanel";
import { ExportsPanel } from "../components/ExportsPanel";
import { GodModePanel } from "../components/GodModePanel";
import { RightSidebar } from "../components/RightSidebar";
import { RolesPanel } from "../components/RolesPanel";
import { SessionActivityPanel } from "../components/SessionActivityPanel";
import { SetupChat } from "../components/SetupChat";
import { Transcript } from "../components/Transcript";
import { TranscriptFilters } from "../components/TranscriptFilters";
import { WorkstreamMenu } from "../components/WorkstreamMenu";
import {
  DEFAULT_FILTER,
  FilterState,
  filterMessages,
} from "../lib/transcriptFilters";
import { BottomActionBar } from "../components/brand/BottomActionBar";
import { DieLoader } from "../components/brand/DieLoader";
import { CollapsibleRailPanel } from "../components/brand/CollapsibleRailPanel";
import { HudGauges } from "../components/brand/HudGauges";
import { TurnStateRail } from "../components/brand/TurnStateRail";
import { SetupWizard, type SetupRoleSlot } from "../components/setup/SetupWizard";
import { SetupLobbyView } from "../components/setup/SetupLobbyView";
import { SetupReviewView } from "../components/setup/SetupReviewView";
import { PlanView } from "../components/setup/PlanView";
import {
  buildImpersonateOptions,
  countUnjoinedImpersonateOptions,
} from "../lib/proxy";
import { useSessionTitle } from "../lib/useSessionTitle";
import { useStickyScroll } from "../lib/useStickyScroll";
import { useTabFocusReporter } from "../lib/useTabFocusReporter";
import { HighlightActionPopover } from "../components/HighlightActionPopover";
import { SharedNotepad } from "../components/SharedNotepad";
import { ServerEvent, WsClient } from "../lib/ws";
import { friendlyRejectionMessage } from "../lib/setReadyRejection";

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
  // Issue #61 + roles-page redesign: roles to invite, declared
  // *before* the session is created so the operator doesn't add seats
  // one-by-one in the lobby AND the AI sees the full roster on its
  // very first setup turn. These ship with the ``createSession`` body
  // as ``invitee_roles`` and are registered server-side before the
  // setup turn fires (see ``backend/app/api/routes.py``). Operators
  // can still add/remove roles dynamically from the Roles panel
  // during setup or play.
  //
  // Slot model (vs the old plain ``string[]``): each builtin slot
  // tracks Active/Off independently from the operator's custom rows
  // so toggling a row off doesn't lose the row from the UI — it just
  // stops being submitted. Custom rows added via the form below get
  // the same toggle. The mockup in
  // ``design/handoff/source/app-screens.jsx`` shows COM/EXE as
  // STANDBY (yellow); the user explicitly asked us to drop the
  // standby state for now. Defaulting those two to OFF (the original
  // implementation) read as broken to a CISO persona — Comms/Legal
  // is the *most* important non-technical seat in a real breach.
  // User-agent review HIGH#1 said: either re-introduce STANDBY or
  // ship them ACTIVE. We ship them ACTIVE; operators opt out via the
  // toggle.
  const SETUP_ROLE_BUILTINS: ReadonlyArray<SetupRoleSlot> = [
    {
      key: "IC",
      code: "IC",
      label: "Incident Commander",
      description: "Owns the response. Final call on tradeoffs.",
      active: true,
      builtin: true,
    },
    {
      key: "CSM",
      code: "CSM",
      label: "Cybersecurity Manager",
      description: "Coordinates engineering effort. Reports up.",
      active: true,
      builtin: true,
    },
    {
      key: "CSE",
      code: "CSE",
      label: "Cybersecurity Engineer",
      description: "Hands-on triage and containment.",
      active: true,
      builtin: true,
    },
    {
      key: "COM",
      code: "COM",
      label: "Comms / Legal",
      description: "External voice. Press, regulators, customers.",
      active: true,
      builtin: true,
    },
    {
      key: "EXE",
      code: "EXE",
      label: "Executive Sponsor",
      description: "C-suite. Activate when stakes escalate.",
      active: true,
      builtin: true,
    },
  ];
  const [setupRoleSlots, setSetupRoleSlots] = useState<SetupRoleSlot[]>(() =>
    SETUP_ROLE_BUILTINS.map((s) => ({ ...s })),
  );
  const [setupRoleDraft, setSetupRoleDraft] = useState("");
  // Creator-selected scenario tuning (issue #33). Picked on the
  // wizard's step 2 alongside environment / constraints — the UI
  // calls them "TUNING" — and frozen at session creation. Defaults
  // mirror the backend's ``SessionSettings`` (standard, 60min,
  // adversary + time + executive ON, media OFF) so an operator who
  // ignores the panel still gets a sensible balanced tabletop.
  const [difficulty, setDifficulty] = useState<Difficulty>("standard");
  const [durationMinutes, setDurationMinutes] = useState<number>(60);
  const [features, setFeatures] = useState<SessionFeatures>(() => ({
    ...DEFAULT_SESSION_FEATURES,
  }));
  // Step 5 → 6 advance flag for the post-creation wizard. Default
  // ``false``: after the plan is finalised the wizard lands on step
  // 5 (Invite players) so the creator can share join links and watch
  // the lobby fill up before reviewing. Flipped to ``true`` only when
  // the creator explicitly advances (rail click on step 6, or the
  // "ADVANCE TO REVIEW" affordance in the lobby's sidecar). Cleared
  // automatically when the snapshot leaves READY so a "abandon → new
  // session" flow doesn't carry stale advance state into the next
  // session. Lifted out of ``SetupWizard`` so ``SetupReviewView``
  // (rendered into the wizard's slot here) can request a hop back
  // without a complex prop chain.
  const [advancedToReview, setAdvancedToReview] = useState(false);
  // Dev-mode toggle on the intro page: prefills a known scenario + creator
  // identity, and on submit auto-skips the AI setup dialogue so testers
  // bypass the 5–30 s setup loop. Use only for local QA.
  //
  // Default flips ON when the backend has ``DEV_TOOLS_ENABLED=true``
  // — operators running with the dev-tools flag almost always want
  // the dev shortcuts too. The mount-time probe is a single
  // GET /api/dev/scenarios; a 404 (gate closed) leaves the toggle
  // unchecked, a 200 flips it on. Operator can still uncheck it
  // for any individual session.
  const [devMode, setDevMode] = useState(false);
  useEffect(() => {
    let canceled = false;
    (async () => {
      try {
        const body = await api.listScenarios();
        if (!canceled && !body.disabled) {
          setDevMode(true);
          console.info(
            "[facilitator] DEV_TOOLS_ENABLED detected on backend — defaulting devMode to true",
          );
        }
      } catch (err) {
        // Network error / unexpected status — leave devMode at false.
        // ``listScenarios`` already swallows the 404 path (gate
        // closed) into a normal response, so anything landing here
        // is genuinely surprising — log so the next operator
        // chasing "why didn't dev mode default on?" has a
        // breadcrumb in the console.
        console.warn(
          "[facilitator] dev-tools probe failed (devMode stays false)",
          err,
        );
      }
    })();
    return () => {
      canceled = true;
    };
  }, []);
  const [setupReply, setSetupReply] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  // Prominent in-chat indicator with the LOOKS-READY-specific label
  // ("Drafting scenario plan · typically 10–30 sec"). True from the
  // moment the operator clicks LOOKS READY → propose-the-plan until
  // the plan lands or an error surfaces. Distinct from ``busy``
  // because the chat-region DieLoader's *plan-specific* label is
  // honest only when we know a plan is imminent — i.e. the operator
  // explicitly asked for one. The implicit "AI is thinking" indicator
  // for regular pre-plan replies is owned by SetupView itself
  // (debounced; soft label) so quick chip-pick turns under ~1.5 s
  // never mount the heavy banner. See SetupView's
  // ``showImplicitThinkingBanner`` state for that branch.
  const [draftingPlan, setDraftingPlan] = useState(false);
  const [wsStatus, setWsStatus] = useState<"connecting" | "open" | "closed" | "error" | "kicked" | "rejected" | "session-gone">("connecting");

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
  // Subset of ``presence`` whose tabs are currently *focused* (foreground
  // visible). Drives the tri-state status dot in RolesPanel:
  //   gray   = not in presence (no tabs open)
  //   yellow = in presence but not in focused (joined but tabbed away)
  //   blue   = in both (joined and on the exercise)
  // Server-pushed via the ``focused`` field on ``presence`` /
  // ``focused_role_ids`` on ``presence_snapshot``.
  const [focusedRoleIds, setFocusedRoleIds] = useState<Set<string>>(
    () => new Set(),
  );
  // Issue #103 follow-up (Copilot review on PR #114): until the first
  // ``presence_snapshot`` lands the empty set above is indistinguishable
  // from "nobody has joined", and the "Tip: N roles haven't joined yet"
  // banner would briefly fire on initial load / reconnect even when
  // every role is actually connected. Tracked separately from the set
  // itself so other consumers (RolesPanel dot, RoleRoster online dot)
  // keep their existing presence-aware behavior. Reset to false on
  // session change and on every WS reconnect so a stale "ready" flag
  // can't outlive a dropped socket.
  const [presenceReady, setPresenceReady] = useState(false);
  // Real-time AI-thinking tracking — same shape as Play.tsx. ``aiCalls``
  // maps in-flight LLM ``call_id`` → tier (``setup`` / ``play`` / ``aar``
  // / ``guardrail`` / ``interject``) from ``ai_thinking`` boundary
  // events; ``aiStatus`` carries the labeled phase/attempt/recovery
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
  // Phase B chat-declutter (docs/plans/chat-decluttering.md §4.7):
  // creator-side filter state for the TranscriptFilters component
  // above the chat. Mirrors the player-side state in ``Play.tsx`` so
  // the same filter logic drives both surfaces.
  const [transcriptFilter, setTranscriptFilter] =
    useState<FilterState>(DEFAULT_FILTER);
  // Chat-declutter polish: workstream-override contextmenu state. The
  // creator can re-tag any message; the menu is rendered in this page
  // so its position survives transcript scroll. Closed when ``null``.
  const [overrideMenu, setOverrideMenu] = useState<{
    messageId: string;
    workstreamId: string | null;
    x: number;
    y: number;
  } | null>(null);
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
  // Mirror the WS client into reactive state — refs don't trigger
  // re-renders and downstream consumers (SharedNotepad slot,
  // HighlightActionPopover) need React to re-render once the client
  // exists. See the matching note in Play.tsx (issue #98 player view).
  const [wsClient, setWsClient] = useState<WsClient | null>(null);
  // Decoupled-ready (PR #209 follow-up): see Play.tsx for the full
  // contract. Same shape: monotonic ``client_seq`` counter, an
  // optimistic-flip overlay keyed by seq, and a transient banner
  // for ``set_ready_rejected`` reasons. Creator-side toggles also
  // include the impersonation path (``subject_role_id`` ≠ creator),
  // so the overlay tracks subject_role_id explicitly.
  const clientSeqRef = useRef(0);
  const [pendingReadyFlips, setPendingReadyFlips] = useState<
    Map<number, { subject_role_id: string; ready: boolean }>
  >(() => new Map());
  const [readyRejectionNotice, setReadyRejectionNotice] = useState<
    string | null
  >(null);
  // ``setTimeout`` handle for the auto-clear of ``readyRejectionNotice``.
  // QA review HIGH on PR #209 follow-up — same pattern as Play.tsx.
  const readyNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  function setReadyRejectionNoticeWithAutoClear(msg: string) {
    if (readyNoticeTimerRef.current !== null) {
      clearTimeout(readyNoticeTimerRef.current);
      readyNoticeTimerRef.current = null;
    }
    setReadyRejectionNotice(msg);
    readyNoticeTimerRef.current = setTimeout(() => {
      setReadyRejectionNotice((cur) => (cur === msg ? null : cur));
      readyNoticeTimerRef.current = null;
    }, 4000);
  }
  useEffect(() => {
    return () => {
      if (readyNoticeTimerRef.current !== null) {
        clearTimeout(readyNoticeTimerRef.current);
        readyNoticeTimerRef.current = null;
      }
    };
  }, []);
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

  // Drop the advance flag whenever we leave the "ready" wizard
  // phase. Without this, a creator who clicked through to step 6
  // and then started fresh (abandon → new session) would land back
  // on step 6 of the new session before the next plan was even
  // drafted. Cheap reset; runs at most once per phase transition.
  useEffect(() => {
    if (phase !== "ready" && advancedToReview) setAdvancedToReview(false);
  }, [phase, advancedToReview]);

  useEffect(() => {
    if (error) console.warn("[facilitator] error surfaced", error);
  }, [error]);

  // Browser-tab title cue. The pending dot lights up only when the
  // creator is the one holding the exercise up:
  //   - SETUP: AI just asked a question (last note is from "ai") and
  //     the creator hasn't answered yet (``!busy`` so we don't blink
  //     the dot during the in-flight POST).
  //   - READY: the plan is finalised and the creator must press Start.
  //   - PLAY: the creator's role is on the active set and the AI
  //     isn't already drafting.
  // The state label adds context for the foregrounded case ("Setup",
  // "Ready", "Briefing", "AI thinking", "Ended"). Hook is called
  // unconditionally above the early returns so the hook count is
  // stable across phase transitions; ``snapshot === null`` (intro
  // page) collapses to just ``Crittable``.
  const titleSignal = useMemo(() => {
    if (!snapshot) return { pending: false, state: null as string | null };
    const aiThinking =
      snapshot.state !== "ENDED" &&
      snapshot.current_turn?.status !== "errored" &&
      (aiCalls.size > 0 ||
        streamingActive ||
        snapshot.state === "AI_PROCESSING" ||
        snapshot.state === "BRIEFING" ||
        snapshot.current_turn?.status === "processing");
    if (snapshot.state === "ENDED") {
      return { pending: false, state: "Ended" };
    }
    if (snapshot.state === "CREATED") {
      // Pre-SETUP transient — covers the brief gap between session
      // create and the first AI question landing.
      return { pending: false, state: "Initializing" };
    }
    if (snapshot.state === "SETUP") {
      const notes = snapshot.setup_notes ?? [];
      const last = notes[notes.length - 1];
      const awaitingReply =
        notes.length > 0 && last?.speaker === "ai" && !busy && !aiThinking;
      // Sub-segment with "·" rather than another em-dash so we don't
      // render "Setup — AI thinking — Crittable" (two dashes).
      return {
        pending: awaitingReply,
        state: aiThinking ? "Setup · AI thinking" : "Setup",
      };
    }
    if (snapshot.state === "READY") {
      // Player view labels this same SessionState as "Ready" — keep
      // creator's longer "Ready to start" because the creator is the
      // one who must press the button, but stay in the same word
      // family so a player watching over the creator's shoulder sees
      // a consistent vocabulary.
      return { pending: !busy, state: "Ready to start" };
    }
    const activeIds = snapshot.current_turn?.active_role_ids ?? [];
    const submittedIds = snapshot.current_turn?.submitted_role_ids ?? [];
    const creatorRoleId = state?.creatorRoleId ?? null;
    const iAmActive =
      creatorRoleId !== null && activeIds.includes(creatorRoleId);
    const iHaveSubmitted =
      creatorRoleId !== null && submittedIds.includes(creatorRoleId);
    const myTurn = iAmActive && !iHaveSubmitted && !aiThinking;
    if (myTurn) return { pending: true, state: "Your turn" };
    // BRIEFING is a sub-state of aiThinking (the AI is composing the
    // briefing) — surface the more specific label before the generic
    // "AI thinking" branch, otherwise the BRIEFING case is dead code.
    if (snapshot.state === "BRIEFING") {
      return { pending: false, state: "Briefing" };
    }
    if (aiThinking) return { pending: false, state: "AI thinking" };
    if (iHaveSubmitted) return { pending: false, state: "Submitted" };
    if (snapshot.state === "AWAITING_PLAYERS") {
      return { pending: false, state: "Waiting on roles" };
    }
    return { pending: false, state: null };
  }, [snapshot, state?.creatorRoleId, busy, aiCalls.size, streamingActive]);
  useSessionTitle(titleSignal);

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
      // Compute the active invitee labels from the slot UI. The server
      // de-dupes vs the creator label, so we ship the active set as-is.
      const inviteeRoles = setupRoleSlots
        .filter((s) => s.active)
        .map((s) => ({ label: s.label.trim() }))
        .filter((r) => r.label.length > 0);
      const created = await api.createSession({
        scenario_prompt: _composeScenarioPrompt(setupParts),
        creator_label: creatorLabel,
        creator_display_name: creatorDisplayName,
        invitee_roles: inviteeRoles,
        // Dev mode skips the AI auto-greet AND installs the default
        // plan in the SAME request. Saves an LLM call and avoids the
        // bare-text-leak failure mode that pollutes the play
        // transcript with setup-style assistant prose.
        skip_setup: devMode,
        // Creator-selected scenario tuning chosen on Step 2 of the
        // wizard (the "TUNING" panel). The backend freezes these on
        // ``Session.settings`` and surfaces them into the setup +
        // play system prompts so the AI tunes facilitation without
        // re-asking — see ``_build_session_settings_block`` in
        // ``backend/app/llm/prompts.py``.
        settings: {
          difficulty,
          duration_minutes: durationMinutes,
          features,
        },
      });
      // Don't log the response object — it carries the creator token in
      // ``creator_token`` and ``creator_join_url``. Log only non-secret IDs.
      console.info("[facilitator] session created", {
        sessionId: created.session_id,
        creatorRoleId: created.creator_role_id,
        inviteeRoleCount: inviteeRoles.length,
        failedInviteeCount: created.failed_invitees.length,
        devMode,
      });
      // Surface per-row invitee failures (the previous silent-log
      // pattern left operators wondering why the lobby roster didn't
      // match the wizard). Skip purely-duplicate failures — those
      // are benign (the user picked the same label twice or it
      // collided with the creator label, which we already warn
      // about in the form). Anything else is a real failure the
      // operator needs to retry from the lobby.
      const realFailures = created.failed_invitees.filter(
        (f) => f.reason !== "duplicate",
      );
      if (realFailures.length > 0) {
        const summary = realFailures
          .map((f) => `"${f.label}" (${f.reason})`)
          .join(", ");
        console.warn(
          "[facilitator] invitee role registration partial failure",
          { failures: realFailures },
        );
        setError(
          `Session created, but these invitee roles failed: ${summary}. ` +
            "You can add them manually from the Roles panel.",
        );
      }
      setState({
        sessionId: created.session_id,
        token: created.creator_token,
        creatorRoleId: created.creator_role_id,
        joinUrl: created.creator_join_url,
      });
      if (devMode) {
        // ``start_session`` requires ≥ 2 player roles. Dev mode adds a
        // SOC Analyst backstop ONLY when the operator didn't pre-declare
        // any invitee seats — otherwise the wizard's choices already
        // cover the minimum. The seat is a normal player: the operator
        // can kick + reissue / remove it like any other.
        if (inviteeRoles.length === 0) {
          setBusyMessage("Dev mode: adding SOC Analyst seat…");
          await api.addRole(created.session_id, created.creator_token, {
            label: "SOC Analyst",
            display_name: "Dev Bot",
            kind: "player",
          });
        }
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
      onStatus: (s) => {
        setWsStatus(s);
        // Issue #103 follow-up: drop the "presence is authoritative"
        // flag whenever the socket isn't open, so the next reconnect
        // has to wait for a fresh ``presence_snapshot`` before the
        // tip can fire again.
        if (s !== "open") setPresenceReady(false);
      },
    });
    ws.connect();
    wsRef.current = ws;
    setWsClient(ws);
    return () => {
      ws.close();
      setWsClient(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.sessionId, state?.token]);

  // Report this tab's focus state to the server so the creator's own
  // row in the roster shows blue (active here) vs yellow (alt-tabbed
  // away). Same hook drives the equivalent send from Play.tsx so player
  // tabs paint the same way in this panel.
  useTabFocusReporter(wsRef, Boolean(state), wsStatus);

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
        // Decoupled-ready (PR #209 follow-up): per-turn flip cap →
        // any unresolved optimistic entry from the prior turn is
        // moot. Clear + log the count for diagnosability. QA review
        // HIGH + Security review MEDIUM.
        setPendingReadyFlips((prev) => {
          if (prev.size === 0) return prev;
          const seqs = Array.from(prev.keys());
          console.warn(
            "[facilitator] dropping stale ready flips on turn change",
            { count: prev.size, seqs, new_turn_index: evt.turn_index },
          );
          return new Map();
        });
        refreshSnapshot();
        break;
      case "plan_proposed":
      case "plan_finalized":
      case "plan_edited":
        refreshSnapshot();
        break;
      case "message_workstream_changed":
        // Chat-declutter polish: a creator or message-author manually
        // re-tagged a single message via the contextmenu. Refresh the
        // snapshot so the colored stripe + filter pill counts converge.
        console.info(
          "[facilitator] message workstream changed",
          { id: evt.message_id, workstream_id: evt.workstream_id },
        );
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
        setCost(evt.cost);
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
        setFocusedRoleIds((prev) => {
          const next = new Set(prev);
          // A role can only be focused if it's also active — the
          // ``active=false`` branch must guarantee removal even if
          // the server (incorrectly) sent ``focused=true`` alongside.
          if (evt.active && evt.focused) next.add(evt.role_id);
          else next.delete(evt.role_id);
          return next;
        });
        if (typeof evt.connection_count === "number") {
          setConnectionCount(evt.connection_count);
        }
        break;
      case "presence_snapshot":
        setPresence(new Set(evt.role_ids));
        setFocusedRoleIds(new Set(evt.focused_role_ids));
        setPresenceReady(true);
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
        if (evt.scope === "set_ready") {
          console.warn("[facilitator] set_ready protocol error", evt);
        }
        break;
      // Decoupled-ready (PR #209): broadcast that ANY role's ready
      // state flipped. Mirror Play.tsx — drop the matching
      // optimistic entry, then refresh so ``ready_role_ids`` updates.
      case "ready_changed":
        setPendingReadyFlips((prev) => {
          if (!prev.has(evt.client_seq)) return prev;
          const next = new Map(prev);
          next.delete(evt.client_seq);
          return next;
        });
        refreshSnapshot();
        break;
      case "set_ready_ack":
        setPendingReadyFlips((prev) => {
          if (!prev.has(evt.client_seq)) return prev;
          const next = new Map(prev);
          next.delete(evt.client_seq);
          return next;
        });
        break;
      case "set_ready_rejected": {
        setPendingReadyFlips((prev) => {
          if (!prev.has(evt.client_seq)) return prev;
          const next = new Map(prev);
          next.delete(evt.client_seq);
          return next;
        });
        // Defensive coercion — Security review LOW.
        const reason =
          typeof evt.reason === "string" ? evt.reason : "unknown";
        const friendly = friendlyRejectionMessage(reason, "creator");
        console.warn("[facilitator] set_ready rejected", evt);
        setReadyRejectionNoticeWithAutoClear(friendly);
        break;
      }
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
    // Note: this path does NOT set ``draftingPlan`` — that flag is
    // reserved for the LOOKS READY click where we know a plan is
    // imminent. The implicit-thinking banner (debounced, with a
    // softer "AI is thinking" label) is owned by SetupView itself
    // based on ``busy && !hasPlan && !draftingPlan``. See
    // ``SetupView``'s ``showImplicitThinkingBanner`` state.
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
    // Once a plan exists, the AI is revising it (re-calling
    // ``propose_scenario_plan`` per ``backend/app/llm/prompts.py``'s
    // "Iterate freely" directive), not drafting a new question. The
    // pre-plan message would mislead the operator into thinking the
    // revision request was ignored.
    const busyText = snapshot?.plan
      ? "AI is thinking — revising the plan…"
      : "AI is thinking — drafting the next setup question…";
    await callSetup(content, busyText);
  }

  /**
   * "Looks ready — propose the plan" button: nudge the AI to draft a
   * plan so the operator can review it in the PlanPanel. Does NOT
   * finalize — the operator commits the plan by clicking APPROVE &
   * START LOBBY in the PlanPanel, which routes through
   * ``handleApprovePlan`` → ``api.setupFinalize``. Auto-finalizing
   * here would skip the panel render and dump the operator on step 5
   * (the lobby) without ever seeing the plan, with no rail back-
   * navigation to recover.
   */
  async function handleLooksReady() {
    if (!state || !snapshot) return;
    setError(null);
    // Tab-background race: ``hasPlan`` hides the button in render, but
    // a plan that lands between paint and click leaves a stale button
    // reachable for one frame. Route to APPROVE in that case.
    if (snapshot.plan) {
      await handleApprovePlan();
      return;
    }
    setBusy(true);
    setDraftingPlan(true);
    console.debug("[facilitator] draftingPlan", { value: true, source: "looks-ready" });
    setBusyMessage("Drafting the scenario plan… typically 10–30 seconds.");
    console.info("[facilitator] looks_ready_clicked nudging plan");
    try {
      const reply = await api.setupReply(state.sessionId, state.token, NUDGE_PROPOSE);
      const snap = await api.getSession(state.sessionId, state.token);
      setSnapshot(snap);
      if (snap.plan) {
        console.info("[facilitator] plan_proposed awaiting_approve");
        setDraftingPlan(false);
        console.debug("[facilitator] draftingPlan", { value: false, source: "looks-ready-plan-landed" });
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
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[facilitator] looks_ready_failed", msg, err);
      setError(msg);
    } finally {
      setBusy(false);
      setBusyMessage(null);
      setDraftingPlan(false);
      console.debug("[facilitator] draftingPlan", { value: false, source: "looks-ready-finally" });
    }
  }

  /** Direct finalize using the existing draft plan — no AI call. */
  async function handleApprovePlan() {
    if (!state) return;
    setError(null);
    setBusy(true);
    setBusyMessage("Finalizing plan and moving to the lobby…");
    console.info("[facilitator] approve_plan_clicked finalizing");
    try {
      await api.setupFinalize(state.sessionId, state.token);
      const snap = await api.getSession(state.sessionId, state.token);
      setSnapshot(snap);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[facilitator] approve_plan_failed", msg, err);
      setError(msg);
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
    setPresenceReady(false);
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

  async function handleSubmit(
    text: string,
    mentions: string[],
    asRoleId?: string,
  ) {
    if (!state) return;
    // Force scroll-to-bottom on the next render so the user sees their
    // own message commit. Mirrors what every chat client does on send.
    forceScrollToBottom();
    try {
      if (asRoleId && asRoleId !== state.creatorRoleId) {
        // Creator impersonation — go through the REST proxy endpoint so
        // the backend records the correct role_id (the WS submit_response
        // is hard-pinned to the connection's own role).
        console.info("[facilitator] proxy submit", {
          asRoleId,
          mentions,
        });
        await api.adminProxyRespond(
          state.sessionId,
          state.token,
          asRoleId,
          text,
          mentions,
        );
        return;
      }
      if (!wsRef.current) return;
      wsRef.current.send({
        type: "submit_response",
        content: text,
        // Decoupled-ready (PR #209 follow-up): no ``intent`` field.
        // Submissions never advance the turn; the ready quorum is
        // closed via the dedicated ``set_ready`` event from
        // ``handleMarkReady`` below.
        // Wave 2: structural mention list from the composer's marks.
        // See ``Play.tsx::handleSubmit`` for the routing semantics.
        mentions,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Decoupled-ready (PR #209 follow-up): dispatch a ``set_ready`` for
  // any active role. ``subjectRoleId`` defaults to the creator's own
  // role; passing another active role's id is the impersonation path
  // (the creator marks an absent player ready on their behalf — the
  // backend records ``actor_role_id`` ≠ ``subject_role_id`` so the
  // audit log distinguishes). Same optimistic-flip + reconcile
  // contract as Play.tsx.
  function handleMarkReady(subjectRoleId: string, next: boolean) {
    const ws = wsRef.current;
    if (!ws || !state) {
      console.warn("[facilitator] mark-ready dropped — WS or state missing", {
        hasWs: !!ws,
        hasState: !!state,
        subjectRoleId,
      });
      return;
    }
    const seq = (clientSeqRef.current += 1);
    setPendingReadyFlips((prev) => {
      const out = new Map(prev);
      out.set(seq, { subject_role_id: subjectRoleId, ready: next });
      return out;
    });
    try {
      const payload: {
        type: "set_ready";
        ready: boolean;
        client_seq: number;
        subject_role_id?: string;
      } = { type: "set_ready", ready: next, client_seq: seq };
      // Only include ``subject_role_id`` for impersonation — for the
      // creator's own toggle the backend defaults it to ``role_id``
      // (the WS connection's bound role), so the field is redundant
      // and would just inflate the wire payload.
      if (subjectRoleId !== state.creatorRoleId) {
        payload.subject_role_id = subjectRoleId;
      }
      ws.send(payload);
      console.info("[facilitator] set_ready sent", {
        ready: next,
        client_seq: seq,
        subject_role_id: subjectRoleId,
        impersonating: subjectRoleId !== state.creatorRoleId,
      });
    } catch (err) {
      setPendingReadyFlips((prev) => {
        if (!prev.has(seq)) return prev;
        const out = new Map(prev);
        out.delete(seq);
        return out;
      });
      // Pass full err object so the console keeps the stack — QA
      // review HIGH.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[facilitator] set_ready send failed", {
        message: msg,
        err,
      });
      setReadyRejectionNoticeWithAutoClear(
        "Mark Ready dropped — connection to server lost. Retrying once it's back.",
      );
    }
  }

  // ``useCallback(fn, [])`` gives ``handleTypingChange`` a stable identity
  // across re-renders (Facilitator re-renders on every WS event). Without it
  // the ``useEffect([onTypingChange])`` cleanup in Composer fires on *every*
  // re-render, canceling the pending-start timer and leaving its ref as a
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
  // Wrap setDevMode so toggling on prefills any blank scenario sections —
  // preserves the pre-redesign behavior (Issue #?? originally added the
  // partial-prefill so testers could tweak one section and let the rest
  // of the boilerplate fill).
  const onToggleDevMode = (next: boolean) => {
    setDevMode(next);
    if (next) {
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

  if (phase === "intro") {
    return (
      <SetupWizard
        phase="intro"
        setupParts={setupParts}
        setSetupParts={setSetupParts}
        creatorLabel={creatorLabel}
        setCreatorLabel={setCreatorLabel}
        creatorDisplayName={creatorDisplayName}
        setCreatorDisplayName={setCreatorDisplayName}
        setupRoleSlots={setupRoleSlots}
        setSetupRoleSlots={setSetupRoleSlots}
        setupRoleDraft={setupRoleDraft}
        setSetupRoleDraft={setSetupRoleDraft}
        devMode={devMode}
        setDevMode={onToggleDevMode}
        busy={busy}
        busyMessage={busyMessage}
        error={error}
        onSubmit={handleCreate}
        difficulty={difficulty}
        setDifficulty={setDifficulty}
        durationMinutes={durationMinutes}
        setDurationMinutes={setDurationMinutes}
        features={features}
        setFeatures={setFeatures}
      />
    );
  }

  if (!state || !snapshot) return null;

  const activeRoleIds = snapshot.current_turn?.active_role_ids ?? [];
  const readyRoleIds = snapshot.current_turn?.ready_role_ids ?? [];
  // Decoupled-ready (PR #209 follow-up): overlay any pending
  // optimistic flips on the canonical snapshot. See Play.tsx for the
  // matching computation. The creator-side overlay also covers the
  // impersonation path — when the creator marks an absent player
  // ready on their behalf, that subject's row reflects the flip
  // before ``ready_changed`` arrives.
  const displayedReadyRoleIdsSet = (() => {
    if (pendingReadyFlips.size === 0) return new Set(readyRoleIds);
    const out = new Set(readyRoleIds);
    for (const entry of pendingReadyFlips.values()) {
      if (entry.ready) out.add(entry.subject_role_id);
      else out.delete(entry.subject_role_id);
    }
    return out;
  })();
  // Subjects with an in-flight ``set_ready`` (creator can have one
  // per active role at a time — own seat plus any impersonated
  // subjects). Drives the per-row pulse in ``<RolesPanel>``.
  // UI/UX review MEDIUM M2.
  const pendingMarkReadySubjects = (() => {
    if (pendingReadyFlips.size === 0) return new Set<string>();
    const out = new Set<string>();
    for (const entry of pendingReadyFlips.values()) {
      out.add(entry.subject_role_id);
    }
    return out;
  })();
  const activeRoleIdsSet = new Set(activeRoleIds);
  const iAmActive = activeRoleIdsSet.has(state.creatorRoleId);
  // Decoupled-ready (PR #209 follow-up): "My turn" simplifies to "I
  // am on the active role set." Ready is its own concern, closed via
  // the rail's per-role Mark Ready buttons (own row + impersonation
  // rows). The creator can drop comments / interjections at any
  // ``AWAITING_PLAYERS`` or ``AI_PROCESSING`` state.
  const isMyTurn = iAmActive;
  // Tooltip surfaced when Mark Ready is disabled. Single computation
  // shared across all rail rows. User-persona HIGH H3 + UI/UX H5:
  // celebrate when the local participant just closed the quorum;
  // call out WS reconnect explicitly so a stuck button has a cause.
  const markReadyDisabledReason = (() => {
    if (wsStatus !== "open")
      return "Reconnecting — Mark Ready re-opens once the connection is back.";
    if (snapshot.state === "AI_PROCESSING") {
      const allActiveReady =
        activeRoleIds.length > 0 &&
        activeRoleIds.every((id) => displayedReadyRoleIdsSet.has(id));
      if (allActiveReady) {
        return "Quorum closed — AI is responding. Mark Ready re-opens on the next beat.";
      }
      return "AI is responding to this beat — Mark Ready re-opens on the next turn.";
    }
    if (snapshot.state !== "AWAITING_PLAYERS")
      return "Mark Ready is only available during the play loop.";
    return undefined;
  })();
  const markReadyEnabled =
    snapshot.state === "AWAITING_PLAYERS" && wsStatus === "open";
  // Lifted from the composer IIFE so the "Awaiting your response"
  // banner can include the role-label suffix the player-side
  // awaiting-response banner in ``Play.tsx`` ships. Without the
  // suffix the creator-as-impersonator can't tell which of their
  // hats the AI is waiting on (UI/UX + User Agent review HIGH).
  const selfRole = snapshot.roles.find((r) => r.id === state.creatorRoleId);
  const playerCount = snapshot.roles.filter((r) => r.kind === "player").length;

  // Issue #113: keep the wizard chrome up through setup/ready so the
  // operator sees rail steps 04-06 instead of being dumped into the
  // in-session view the moment the session is created. Each post-
  // creation phase renders its own ``postCreationContent`` slot:
  //   - setup → existing <SetupView/> (AI dialogue + plan preview)
  //   - ready, plan unfinished or < 2 players → <SetupLobbyView/>
  //   - ready, plan finalized + ≥ 2 players → <SetupReviewView/>
  //     (owns its own START SESSION button — the BottomActionBar
  //      isn't rendered inside wizard chrome)
  // The wizard's internal ``current`` memo derives the same step
  // 5 vs 6 distinction for the rail highlight; we just have to pick
  // the matching panel content here.
  if (phase === "setup" || phase === "ready") {
    // Step 6 (Review & launch) renders only when the launch gates
    // are met (plan finalized + ≥ 2 player roles) AND the creator
    // has explicitly advanced via the rail or the lobby's
    // "REVIEW & LAUNCH" affordance. On the natural ready-phase
    // landing we drop into step 5 (the lobby) so the creator can
    // share join links first; the lobby itself owns the primary
    // START SESSION CTA so advancing to step 6 is optional, not
    // required.
    const launchReady =
      phase === "ready" && Boolean(snapshot.plan) && playerCount >= 2;
    const wizardReadyForReview = launchReady && advancedToReview;
    let postCreationContent;
    if (phase === "setup") {
      postCreationContent = (
        <SetupView
          snapshot={snapshot}
          setupReply={setupReply}
          setSetupReply={setSetupReply}
          onSubmit={handleSetupReply}
          onLooksReady={handleLooksReady}
          onApprovePlan={handleApprovePlan}
          onSkipSetup={handleSkipSetup}
          onPickOption={(opt) =>
            callSetup(opt, "Sending your selection to the AI…")
          }
          busy={busy}
          busyMessage={busyMessage}
          draftingPlan={draftingPlan}
        />
      );
    } else if (wizardReadyForReview && snapshot.plan) {
      postCreationContent = (
        <SetupReviewView
          roles={snapshot.roles}
          plan={snapshot.plan}
          playerCount={playerCount}
          connectedRoleIds={presence}
          busy={busy}
          onStart={handleStart}
          onBackToLobby={() => setAdvancedToReview(false)}
        />
      );
    } else {
      // Always wire the launch handler on the lobby once gates are
      // met — the lobby is the natural launch surface (advancing to
      // step 6 is optional). When gates aren't met the lobby's own
      // sidecar copy reads "Plan not finalized" / "Need at least 2
      // player roles" and the CTA stays suppressed. Also wire the
      // forward-advance handler so the lobby's sidecar can offer an
      // explicit "ADVANCE TO REVIEW" affordance once gates clear.
      const lobbyLaunchHandler = launchReady ? handleStart : undefined;
      const advanceToReviewHandler = launchReady
        ? () => setAdvancedToReview(true)
        : undefined;
      postCreationContent = (
        <SetupLobbyView
          sessionId={state.sessionId}
          creatorToken={state.token}
          roles={snapshot.roles}
          busy={busy}
          plan={snapshot.plan}
          playerCount={playerCount}
          connectedRoleIds={presence}
          onRoleAdded={refreshSnapshot}
          onRoleChanged={refreshSnapshot}
          onError={setError}
          onLaunchSession={lobbyLaunchHandler}
          onAdvanceToReview={advanceToReviewHandler}
        />
      );
    }
    return (
      <>
        {/* CriticalEventBanner has to render here too — the in-session
            <main> wrapper isn't reached during the setup/ready early
            return, so without this, ``critical_event`` WS frames
            during the lobby (e.g. an inject-as-warning, an admin
            interject) would set ``criticalBanner`` state and the user
            would never see it. Same component + dismiss handler as
            the in-session render below. */}
        {criticalBanner ? (
          <CriticalEventBanner
            {...criticalBanner}
            onAcknowledge={() => setCriticalBanner(null)}
          />
        ) : null}
        <SetupWizard
          phase={phase}
          setupParts={setupParts}
          setSetupParts={setSetupParts}
          creatorLabel={creatorLabel}
          setCreatorLabel={setCreatorLabel}
          creatorDisplayName={creatorDisplayName}
          setCreatorDisplayName={setCreatorDisplayName}
          setupRoleSlots={setupRoleSlots}
          setSetupRoleSlots={setSetupRoleSlots}
          setupRoleDraft={setupRoleDraft}
          setSetupRoleDraft={setSetupRoleDraft}
          devMode={devMode}
          setDevMode={onToggleDevMode}
          busy={busy}
          busyMessage={busyMessage}
          error={error}
          onSubmit={handleCreate}
          difficulty={difficulty}
          setDifficulty={setDifficulty}
          durationMinutes={durationMinutes}
          setDurationMinutes={setDurationMinutes}
          features={features}
          setFeatures={setFeatures}
          snapshot={snapshot}
          playerCount={playerCount}
          postCreationContent={postCreationContent}
          onAbandonSession={handleNewSession}
          advancedToReview={advancedToReview}
          setAdvancedToReview={setAdvancedToReview}
        />
      </>
    );
  }

  return (
    <main className="flex min-h-screen flex-col lg:h-screen lg:min-h-0 lg:overflow-hidden">
      {criticalBanner ? (
        <CriticalEventBanner
          {...criticalBanner}
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
      <div className="grid w-full flex-1 grid-cols-1 gap-3 p-3 lg:min-h-0 lg:grid-cols-[260px_minmax(0,1fr)_320px] lg:overflow-hidden xl:grid-cols-[280px_minmax(0,1fr)_400px] 2xl:grid-cols-[300px_minmax(0,1fr)_minmax(440px,28%)]">
        <aside className="flex flex-col gap-3 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
          <RolesPanel
            sessionId={state.sessionId}
            creatorToken={state.token}
            roles={snapshot.roles}
            busy={busy}
            onRoleAdded={refreshSnapshot}
            onRoleChanged={refreshSnapshot}
            onError={setError}
            connectedRoleIds={presence}
            focusedRoleIds={focusedRoleIds}
            readyRoleIds={displayedReadyRoleIdsSet}
            activeRoleIds={activeRoleIdsSet}
            onMarkReady={handleMarkReady}
            selfRoleId={state.creatorRoleId}
            markReadyEnabled={markReadyEnabled}
            markReadyDisabledReason={markReadyDisabledReason}
            pendingMarkReadySubjects={pendingMarkReadySubjects}
          />
          {readyRejectionNotice ? (
            // ``role="alert"`` + ``aria-live="assertive"`` so a
            // screen-reader hears the rejection as soon as it
            // surfaces. UI/UX review HIGH H4.
            <div
              role="alert"
              aria-live="assertive"
              className="mono rounded-r-1 border border-warn bg-warn-bg px-2 py-1 text-[10px] uppercase tracking-[0.04em] text-warn"
              data-testid="ready-rejection-notice"
            >
              {readyRejectionNotice}
            </div>
          ) : null}
          <div className="rounded-r-3 border border-ink-600 bg-ink-850">
            <TurnStateRail
              state={snapshot.state}
              progressPct={snapshot.current_turn?.progress_pct ?? null}
            />
          </div>
          <SessionActivityPanel
            sessionId={state.sessionId}
            creatorToken={state.token}
            roles={snapshot.roles}
            onForceAdvance={handleForceAdvance}
            busy={busy || forceAdvanceCooldown}
          />
          <ExportsPanel
            sessionId={state.sessionId}
            creatorToken={state.token}
          />
          <DecisionLogPanel entries={decisionLog} />
        </aside>

        <section className="flex min-w-0 flex-col gap-2 lg:min-h-0 lg:overflow-hidden">
          {/*
            Every phase view (setup / ready / ended / play) renders inside the
            same scrollable region. Pre-fix the wrapping ``<div>`` only
            existed for play/ended, so the READY phase's plan-JSON dump and
            the SETUP chat both got clipped on desktop with no scrollbar —
            an operator literally couldn't reach the "Approve plan" button.
          */}
          {/*
            Phase B chat-declutter (UI/UX review BLOCK):
            ``TranscriptFilters`` lives OUTSIDE the scroll region so the
            filter pills + hidden-mentions banner stay reachable as the
            creator scrolls down through the transcript. Pre-fix the
            component was nested inside ``scrollRegionRef`` and scrolled
            out of view mid-exercise — the player view (``Play.tsx``)
            already had this layout right; the creator view didn't.
          */}
          {phase === "play" ? (
            <TranscriptFilters
              messages={snapshot.messages}
              workstreams={snapshot.workstreams ?? []}
              selfRoleId={state.creatorRoleId}
              state={transcriptFilter}
              onChange={setTranscriptFilter}
            />
          ) : null}
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
          {/* Issue #113: setup + ready phases now render in the
              wizard chrome (see early-return above), not in this
              in-session 3-col layout. Only play / ended reach here. */}
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
                  className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded border border-warn bg-warn-bg p-3 text-sm text-warn"
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
                    className="rounded border border-signal bg-signal-tint px-3 py-1 text-xs font-semibold text-signal-100 hover:bg-signal-tint disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {forceAdvanceCooldown ? "AI: take next beat (cooling down)" : "AI: take next beat"}
                  </button>
                </div>
              ) : null}
              <Transcript
                messages={filterMessages(
                  snapshot.messages,
                  transcriptFilter,
                  state.creatorRoleId,
                )}
                roles={snapshot.roles}
                workstreams={snapshot.workstreams ?? []}
                onMessageContextMenu={({ messageId, workstreamId, x, y }) =>
                  setOverrideMenu({ messageId, workstreamId, x, y })
                }
                viewerIsCreator={true}
                selfAuthoredRoleIds={null}
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
                // Self-id so the creator's own player bubbles render
                // with the signal-tinted "you" variant.
                selfRoleId={state.creatorRoleId}
              />
            </>
          ) : null}
          {error ? <p className="text-sm text-crit">{error}</p> : null}
          </div>
          {/* "New messages below" chip — appears when content arrives
              while the operator has scrolled up to re-read. Clicking
              it re-pins to the bottom. Mirrors the standard chat-app
              pattern (Slack / Discord) so an unpinned operator knows
              there's content below without being yanked off whatever
              they were reading. See the Play.tsx counterpart for the
              color-choice rationale: solid sky to stay distinct from
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
                className="mono pointer-events-auto -mt-12 mb-1 rounded-r-pill border border-signal bg-signal-bright px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.10em] text-ink-900 animate-chip-pulse hover:bg-signal motion-reduce:animate-none motion-reduce:shadow-lg motion-reduce:ring-2 motion-reduce:ring-signal/30"
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
              {/* Mirror of the player-side chip on Play.tsx so the
                  creator-as-player gets the same at-a-glance "you are
                  on the hook" cue. Without this, a creator who is on
                  the active set but never typed anything has no visual
                  signal — only the small composer label changes —
                  and the user-agent review flagged this as a real
                  "did the AI freeze on me?" mystery during solo runs. */}
              {snapshot.state !== "ENDED" && isMyTurn ? (
                <div
                  role="status"
                  aria-live="polite"
                  className="mb-2 rounded border border-warn bg-warn-bg px-3 py-1.5 text-center text-xs font-semibold leading-tight text-warn break-words"
                >
                  ⚠ Awaiting your response — {selfRole?.label ?? "you"}
                </div>
              ) : null}
              {/* Decoupled-ready (PR #209 follow-up): per-role READY ✓
                  tags + the Mark Ready buttons in the rail now carry
                  the "who's ready vs still discussing?" signal that
                  ``WaitingChip`` used to surface. The compact "N of
                  M ready" summary is preserved by reading the same
                  set the rail uses. Hidden when the session ended. */}
              {snapshot.state === "AWAITING_PLAYERS" &&
              activeRoleIds.length > 0 ? (
                <p
                  role="status"
                  aria-live="polite"
                  className="mono mb-2 text-[10px] uppercase tracking-[0.06em] text-ink-300"
                >
                  {(() => {
                    const readyCount = activeRoleIds.filter((id) =>
                      displayedReadyRoleIdsSet.has(id),
                    ).length;
                    return `${readyCount} of ${activeRoleIds.length} ready · use Mark Ready in the rail when each role is done.`;
                  })()}
                </p>
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
                // ``selfRole`` is computed at the top of the render
                // so the "Awaiting your response" banner can use it;
                // the composer label below reads the same value.
                // Wave 2: roster the @-popover offers. Excludes the
                // creator's own role and spectators. Synthetic
                // facilitator entry is rendered by the popover itself.
                const mentionRoster = snapshot.roles
                  .filter(
                    (r) =>
                      r.id !== state.creatorRoleId &&
                      r.kind !== "spectator",
                  )
                  .map((r) => ({
                    target: r.id,
                    insertLabel: r.label,
                    displayLabel: r.label,
                    secondary: r.display_name ?? undefined,
                  }));
                // Decoupled-ready (PR #209 follow-up): the composer
                // stays editable across ``AI_PROCESSING`` so the
                // creator can drop interjections / side-comments
                // while the AI thinks. ``!busy`` keeps double-submits
                // during an in-flight creator action out of the
                // queue.
                const composerEnabled =
                  (snapshot.state === "AWAITING_PLAYERS" ||
                    snapshot.state === "AI_PROCESSING") &&
                  !busy;
                const canSelfSpeak = isMyTurn && !busy;
                const canProxy = impersonateOptions.length > 0 && !busy;
                // Issue #103: the tip used to fire whenever the
                // "Respond as" dropdown had any entries — but the
                // dropdown also includes joined-and-actively-playing
                // roles that simply haven't submitted on the current
                // turn. Only nudge the creator about invite links when
                // there's actually a player role with no live tabs.
                //
                // ``presenceReady`` (Copilot review on PR #114) keeps
                // the tip suppressed during the brief window between
                // WS connect and the first ``presence_snapshot`` —
                // without it, the empty initial set would briefly
                // count every joined role as "unjoined" on initial
                // load and on every reconnect, regressing into the
                // exact misleading behavior this issue fixed.
                const unjoinedImpersonateCount = presenceReady
                  ? countUnjoinedImpersonateOptions(impersonateOptions, presence)
                  : 0;
                return (
                  <>
                    {canProxy && unjoinedImpersonateCount > 0 ? (
                      // One-line hint addressing the user-agent CRITICAL —
                      // a fresh creator should know WHY a "Respond as"
                      // dropdown just appeared and that it's optional.
                      <p className="mb-1 text-[11px] text-ink-400">
                        Tip: {unjoinedImpersonateCount === 1 ? "1 role hasn't" : `${unjoinedImpersonateCount} roles haven't`}{" "}
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
                      mentionRoster={mentionRoster}
                    />
                  </>
                );
              })()}
            </div>
          ) : null}
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
            // Phase B chat-declutter: same recovery as the player path
            // — Timeline pin against a filtered-out message clears the
            // filter so the next click lands.
            onScrollMissed={() => setTranscriptFilter(DEFAULT_FILTER)}
            notepad={
              wsClient ? (
                <SharedNotepad
                  sessionId={state.sessionId}
                  token={state.token}
                  ws={wsClient}
                  isCreator={true}
                  sessionStartedAt={snapshot.created_at}
                  selfRoleId={state.creatorRoleId}
                  selfDisplayName={
                    snapshot.roles.find((r) => r.id === state.creatorRoleId)?.display_name ??
                    snapshot.roles.find((r) => r.id === state.creatorRoleId)?.label ??
                    "(creator)"
                  }
                />
              ) : null
            }
          />
        </aside>
      </div>
      {wsClient ? (
        <HighlightActionPopover
          sessionId={state.sessionId}
          roleId={state.creatorRoleId}
          token={state.token}
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
              state.sessionId,
              state.token,
              overrideMenu.messageId,
              next,
            );
          } catch (err) {
            const text = err instanceof Error ? err.message : String(err);
            console.warn("[facilitator] workstream override failed", text);
            setError(text);
          }
        }}
        onClose={() => setOverrideMenu(null)}
      />
      <BottomActionBar
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
          const seen = new Set<string>();
          for (const tier of aiCalls.values()) seen.add(tier);
          return Array.from(seen).sort();
        })()}
        // Issue #70: extra inputs for the multi-state LLM chip.
        // ``aiPaused`` from the snapshot covers reload after the
        // ``ai_pause_state_changed`` event has rolled out of the
        // replay buffer; ``recoveryStatus`` from the live ``aiStatus``
        // (set by the WS ``ai_status`` event the turn-driver emits at
        // each strict-retry attempt) drives the
        // ``LLM: recovering N/M (kind)`` label; ``turnErrored`` is
        // the sticky crit signal once the recovery budget is
        // exhausted (review pass: User Agent HIGH #3).
        aiPaused={Boolean(snapshot.ai_paused)}
        recoveryStatus={
          aiStatus && aiStatus.phase === "play" && aiStatus.recovery
            ? {
                kind: aiStatus.recovery,
                attempt: aiStatus.attempt,
                budget: aiStatus.budget,
              }
            : null
        }
        turnErrored={snapshot.current_turn?.status === "errored"}
        // Creator-frozen tuning chip — readable to every participant
        // (the field is part of the all-participants snapshot;
        // ``features`` is creator-only and intentionally not shown
        // here). Surfaces what the AI is calibrated against so a
        // creator who set HARD doesn't have to remember mid-session.
        difficulty={snapshot.settings.difficulty}
        durationMinutes={snapshot.settings.duration_minutes}
        buildSha={__ATF_GIT_SHA__}
        buildTs={__ATF_BUILD_TS__}
      />
      {godMode ? (
        <GodModePanel
          sessionId={state.sessionId}
          creatorToken={state.token}
          sessionState={snapshot?.state ?? "CREATED"}
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
  wsStatus: "connecting" | "open" | "closed" | "error" | "kicked" | "rejected" | "session-gone";
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
  // Brand chrome only — the dense operator telemetry + CTAs live in
  // <BottomActionBar/> at the foot of the in-session view. Layout:
  //   [lockup] | FACILITATOR · session-pill · STATE · TURN · ELAPSED
  //   ml-auto → AAR-status (ENDED only)
  //
  // ``backendState`` is the canonical source for the STATE pill so the
  // bar matches the brand mock's <AppTopBar> verbatim.
  const stateLabel = (props.backendState || props.phase).toUpperCase();
  const stateTone =
    props.backendState === "AWAITING_PLAYERS"
      ? "warn"
      : props.backendState === "ENDED"
        ? "default"
        : "signal";
  const stateBg =
    stateTone === "warn"
      ? "bg-warn-bg text-warn border border-warn"
      : stateTone === "signal"
        ? "bg-signal-tint text-signal border border-signal-deep"
        : "bg-ink-700 text-ink-200 border border-ink-500";
  return (
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
          // Mid-session navigating to ``/`` (the marketing home)
          // drops the operator's chat view + any in-flight reply.
          // Confirm before letting the click through; helper lives
          // in lib/leaveGuard so the same warning text applies to
          // Play.tsx + WizardRail too.
          onClick={confirmLeaveSession}
        >
          <img
            src="/logo/svg/lockup-crittable-dark-transparent.svg"
            alt="Crittable"
            height={28}
            // Tailwind preflight resets ``img { height: auto }`` —
            // overrides the height attr and lets the SVG render at
            // its intrinsic 100 px viewBox. Inline style wins. Same
            // trick on every lockup/mark img in the codebase.
            style={{ height: 28 }}
            className="block"
          />
        </a>
        <span className="h-6 w-px bg-ink-600" aria-hidden="true" />
        <span className="mono text-[10px] font-bold uppercase tracking-[0.22em] text-ink-300">
          FACILITATOR
        </span>
        <span className="mono text-[12px] text-ink-300">
          PHASE{" "}
          <span className="font-semibold text-ink-100">
            {props.phase.toUpperCase()}
          </span>
        </span>
        <span
          className={
            "mono inline-flex items-center gap-1 rounded-r-1 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.04em] " +
            stateBg
          }
          title="Backend session.state — see backend/app/sessions/manager.py"
        >
          <span className="opacity-70">STATE</span>
          <span className="tabular-nums">{stateLabel}</span>
        </span>
        {props.turnIndex != null ? (
          <span className="mono inline-flex items-center gap-1 rounded-r-1 border border-ink-500 bg-ink-700 px-2 py-0.5 text-[11px] font-semibold uppercase">
            <span className="text-ink-300 opacity-70">TURN</span>
            <span className="tabular-nums text-ink-100">{props.turnIndex}</span>
          </span>
        ) : null}
        <span className="mono inline-flex items-center gap-1 rounded-r-1 border border-ink-500 bg-ink-700 px-2 py-0.5 text-[11px] font-semibold uppercase">
          <span className="text-ink-300 opacity-70">PLAYERS</span>
          <span className="tabular-nums text-ink-100">{props.playerCount}</span>
        </span>

        {props.phase === "ended"
          ? (() => {
              if (props.aarStatus === "ready") {
                return (
                  <button
                    type="button"
                    onClick={props.onViewAar}
                    className="mono ml-auto rounded-r-1 bg-signal px-3 py-1 text-[11px] font-bold uppercase tracking-[0.16em] text-ink-900 hover:bg-signal-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal-bright"
                  >
                    VIEW AAR →
                  </button>
                );
              }
              if (props.aarStatus === "failed") {
                return (
                  <span
                    role="status"
                    className="mono ml-auto inline-flex items-center gap-1 rounded-r-1 border border-crit bg-crit-bg px-2 py-0.5 text-[11px] uppercase tracking-[0.10em] text-crit"
                  >
                    AAR FAILED — RETRY IN PANEL
                  </span>
                );
              }
              return (
                <span
                  role="status"
                  aria-live="polite"
                  className="mono ml-auto inline-flex items-center gap-1.5 rounded-r-1 bg-ink-800 px-2 py-0.5 text-[11px] uppercase tracking-[0.10em] text-ink-300"
                >
                  <span
                    aria-hidden="true"
                    className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-signal"
                  />
                  AAR GENERATING… (~30 S)
                </span>
              );
            })()
          : null}
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
      className="mono mb-1 inline-flex shrink-0 items-center gap-2 self-start rounded-r-1 border border-info bg-info-bg px-2 py-1 text-[11px] uppercase tracking-[0.10em] text-info"
    >
      <Spinner /> {message ?? "Working…"}
    </span>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-info border-t-transparent"
    />
  );
}

/* CostChip moved to <BottomActionBar/> as `CostChipMini`. The
 * post-redesign chrome puts dense operator telemetry (cost, turn,
 * msgs, rationale, last event, ws state, build SHA) in the bottom
 * action bar so the top SiteHeader stays uncluttered brand chrome.
 * If a future task needs an inline cost chip back in the top bar, the
 * minimal mono variant in `BottomActionBar` is the canonical version. */

// ActiveRolesHint and WaitingChip removed in PR #209 follow-up
// (decoupled-ready). Both were creator-side ready-quorum surfaces;
// the rail's per-role READY ✓ tags + Mark Ready buttons now carry
// the same signal in a place that's visible regardless of where the
// creator's cursor is. The compact "N of M ready" copy was inlined
// into the composer column above each composer.


/**
 * Issue #62: horizontal action bar pinned just below the StatusBar so the
 * primary phase-appropriate CTA (Start / Force-advance / End / View AAR /
 * New session) is always reachable on narrow viewports. Pre-fix the same
 * controls lived at the bottom of the left sidebar — on a 493×943
 * viewport the Start button was below the fold, requiring a scroll past
 * the entire role roster + activity panel to reach it.
 */
export function SetupView({
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
  draftingPlan,
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
  /** True from the moment the operator clicks LOOKS READY → PROPOSE
   *  THE PLAN until either the plan arrives or an error surfaces.
   *  Drives a prominent in-chat banner with the plan-specific label
   *  "Drafting scenario plan · typically 10–30 sec" so the operator
   *  has unambiguous feedback during the 10–30 s wait. The implicit
   *  branch — AI is thinking during a regular reply / option pick —
   *  is owned by SetupView's internal ``showImplicitThinkingBanner``
   *  state (debounced, neutral label) so quick turns don't mount the
   *  heavy banner. Required, not optional — every call site already
   *  passes it explicitly and a default would silently hide the
   *  indicator if a future site forgets. */
  draftingPlan: boolean;
}) {
  const hasPlan = Boolean(snapshot.plan);
  const notes = snapshot.setup_notes ?? [];

  // Implicit-thinking banner: shown during a regular reply / option
  // pick (not LOOKS READY) when the AI is processing pre-plan and the
  // wait crosses ~1.5 s. Two design choices, both from
  // user-persona + UI/UX review:
  //   1. **Debounce** — fast turns (chip pick → 5 s question) keep
  //      the small typing dots; only slow turns (≳1.5 s) escalate to
  //      the banner. Without this the banner would mount/unmount on
  //      every routine Q&A round, training the operator to ignore it
  //      and undermining its signal value when LOOKS-READY actually
  //      runs.
  //   2. **Neutral label** — "AI is thinking · typically 5–30 sec"
  //      rather than the LOOKS-READY-specific "Drafting scenario
  //      plan". The setup tier is non-streaming so we can't tell
  //      mid-call whether the AI is producing another question or
  //      the actual plan; a neutral label is honest in either case.
  //      The plan-specific label is reserved for ``draftingPlan``
  //      (the explicit operator-clicked-LOOKS-READY path) where a
  //      plan IS the documented next step.
  // The 1500 ms threshold matches the perceptual "barely noticed"
  // → "definitely waiting" boundary; tune if user feedback diverges.
  const [showImplicitThinkingBanner, setShowImplicitThinkingBanner] =
    useState(false);
  useEffect(() => {
    // The implicit banner only applies pre-plan and only when the
    // explicit LOOKS-READY banner isn't already up.
    if (busy && !hasPlan && !draftingPlan) {
      const timer = window.setTimeout(() => {
        setShowImplicitThinkingBanner(true);
        console.debug("[facilitator] implicit-thinking banner mounted");
      }, 1500);
      return () => {
        window.clearTimeout(timer);
        // The cleanup runs both on unmount and on dep change. If the
        // banner had mounted, ensure it clears so a transition from
        // "busy without plan" → "plan exists" / "LOOKS-READY took
        // over" / "request finished" doesn't leave a stale banner.
        setShowImplicitThinkingBanner(false);
      };
    }
    // Defensive reset for the ``busy=false`` / ``hasPlan=true`` /
    // ``draftingPlan=true`` branches — the cleanup above only fires
    // on dep change *from the previous truthy branch*, so a
    // first-render with the banner already false has no effect here.
    setShowImplicitThinkingBanner(false);
    return undefined;
  }, [busy, hasPlan, draftingPlan]);

  // The prominent banner is shown when EITHER explicit signal
  // (``draftingPlan``) or the debounced implicit signal is true and
  // no plan exists yet. The implicit branch is also gated on
  // ``busy`` directly (not just on the latched
  // ``showImplicitThinkingBanner`` state) so a render commit where
  // ``busy`` has just flipped false but the effect cleanup hasn't
  // run yet doesn't paint a stale banner for one frame (Copilot
  // PR #201 review). The state still drives the *delay* (banner only
  // appears after the 1500 ms timer); the ``busy`` gate just makes
  // the unmount synchronous with the request finishing.
  const showLooksReadyBanner = draftingPlan && !hasPlan;
  const showThinkingBanner =
    showImplicitThinkingBanner && busy && !hasPlan && !draftingPlan;
  const bannerVisible = showLooksReadyBanner || showThinkingBanner;

  // Layout intent (across both branches):
  //   - No plan: single column — chat → reply form, top to bottom.
  //   - With plan, xl+: 2-column grid. Left column = chat (row 1) +
  //     reply form (row 2); right column = sticky plan panel spanning
  //     both rows. APPROVE lives in the panel (on the artifact it
  //     commits), not in the reply-form button row.
  //   - With plan, sub-xl: single column with the panel inserted
  //     BETWEEN chat and reply form. This is the load-bearing detail
  //     vs the original layout — without the row reorder the panel
  //     would still render below the form on small screens (which is
  //     exactly the original "scroll past everything to see the plan"
  //     bug that this PR is meant to fix).
  //
  // ``chatGroup`` and ``replyForm`` are the per-branch building
  // blocks; the JSX below assembles them in the right order for each
  // layout.
  const chatGroup = (
    <div className="flex min-w-0 flex-col gap-3">
      {notes.length === 0 && !busy ? (
        <div className="flex flex-col items-center gap-3 rounded-r-3 border border-warn bg-warn-bg p-6">
          <DieLoader label="Waiting for the AI's first question" size={64} />
          <p className="mono text-[11px] uppercase tracking-[0.06em] text-warn">
            No setup messages yet. The AI usually responds in 5–20 seconds.
            If nothing appears soon, check the backend container logs — the
            most common causes are a missing{" "}
            <code className="mx-1 rounded-r-1 bg-ink-900 px-1 text-signal">ANTHROPIC_API_KEY</code>{" "}
            or a network issue reaching the Anthropic API.
          </p>
        </div>
      ) : null}

      {/* ``busy`` is the full in-flight flag — keeps the option
          chips on the latest AI question disabled so the operator
          can't dispatch a second ``api.setupReply()`` while a
          LOOKS-READY draft is mid-air (PR #186 review block).
          ``aiTyping`` is the indicator-only flag: suppress the
          small bouncing dots once a prominent banner takes over,
          otherwise mirror ``busy``. Sub-debounce regular replies
          (``busy=true``, banner not yet mounted) keep the dots so
          quick turns get a light indicator. The two flags are
          deliberately split — combining them would silently
          re-enable chip clicks during the draft. */}
      <SetupChat
        notes={notes}
        busy={busy}
        aiTyping={busy && !bannerVisible}
        onPickOption={onPickOption}
      />

      {/* Brand DieLoader as a named in-chat wait state. The DieLoader
          itself supplies ``role="status"`` + ``aria-live="polite"``;
          this wrapper deliberately does NOT add another live region
          (UI/UX review: nested aria-live blocks let screen readers
          drop the inner caption). The label carries the timing
          expectation inline so screen readers announce the full
          message in one pass.

          Two label branches share one banner element (single
          ``data-testid`` so existing tests / observers find it):
          ``draftingPlan`` (operator clicked LOOKS READY) → the
          plan-specific label with the 10–30 s window we know
          applies; the implicit/debounced branch → a neutral "AI is
          thinking" label that's honest whether the AI ends up
          drafting another question or the plan.

          ``!hasPlan`` race guard on both branches: the Facilitator
          clears ``draftingPlan`` as soon as the plan lands, but a
          render-cycle race could leave both true for a frame.
          Hiding the banner once a plan exists makes that race a
          no-op rather than a "drafting" caption flashing over the
          new plan card. */}
      {bannerVisible ? (
        <div
          data-testid="drafting-plan-banner"
          data-banner-variant={
            showLooksReadyBanner ? "looks-ready" : "implicit-thinking"
          }
          className="flex flex-col items-center gap-3 rounded-r-3 border border-signal-deep bg-signal-tint p-6"
        >
          <DieLoader
            label={
              showLooksReadyBanner
                ? "Drafting scenario plan · typically 10–30 sec"
                : "AI is thinking · typically 5–30 sec"
            }
            size={64}
          />
        </div>
      ) : null}

      {/* Suppress the small chip while a prominent banner is
          claiming the operator's attention (UI/UX review: parallel
          indicators read as duplicate UI). The chip continues to
          communicate the fast post-plan finalize step
          (``busyMessage = "Plan drafted — finalizing…"``) and every
          other ``busy`` state. */}
      <BusyChip busy={busy && !bannerVisible} message={busyMessage} />
    </div>
  );

  const replyForm = (
    <form
      onSubmit={onSubmit}
      className="flex min-w-0 flex-col gap-2 rounded-r-3 border border-ink-600 bg-ink-850 p-3"
    >
      <span className="mono text-[10px] font-bold uppercase tracking-[0.20em] text-signal">
        REPLY TO THE AI
      </span>
      <textarea
        value={setupReply}
        onChange={(e) => setSetupReply(e.target.value)}
        rows={3}
        placeholder={
          hasPlan
            ? "Want changes? Tell the AI what to revise…"
            : "Type your reply to the AI…"
        }
        disabled={busy}
        className="rounded-r-1 border border-ink-600 bg-ink-900 p-3 text-sm text-ink-100 sans focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal-deep focus:border-signal-deep disabled:opacity-50"
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={busy || !setupReply.trim()}
          className="mono rounded-r-1 bg-signal px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-ink-900 hover:bg-signal-bright disabled:cursor-not-allowed disabled:opacity-50"
        >
          SEND REPLY →
        </button>
        {!hasPlan ? (
          <button
            type="button"
            onClick={onLooksReady}
            disabled={busy}
            className="mono rounded-r-1 border border-signal-deep px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-signal hover:bg-signal-tint focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal disabled:opacity-50"
            title="Asks the AI to draft a plan you can review and approve."
          >
            LOOKS READY — PROPOSE THE PLAN
          </button>
        ) : null}
        <button
          type="button"
          onClick={onSkipSetup}
          disabled={busy}
          className="mono ml-auto rounded-r-1 border border-dashed border-ink-500 px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-ink-500 opacity-70 hover:opacity-100 hover:bg-ink-800 disabled:opacity-50"
          title="Dev/testing only: skip the AI setup dialogue and use a generic default plan."
        >
          SKIP SETUP (DEV)
        </button>
      </div>
    </form>
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Issue #113: SetupView is now nested inside the wizard's
          <PostCreationBody/> which already supplies the eyebrow +
          title (STEP 04 · INJECTS & SCHEDULE → "AI is drafting the
          plan"). The pre-PR inner header (STEP 02 · SETUP DIALOG)
          stamped a second, conflicting step number on the same
          screen — deleted. The helper paragraph stays since it
          explains the LOOKS READY / APPROVE buttons below.

          Copy is conditional on hasPlan because the position reference
          ("on the panel") and the button name ("Approve & start lobby")
          would mislead before the plan exists (no panel yet) and the
          old wording ("Approve plan") didn't match the actual button
          label after the plan arrived. */}
      <p className="mt-1 text-xs text-ink-300 leading-relaxed">
        {hasPlan ? (
          <>
            Plan&apos;s on the table. Read it through, then click{" "}
            <em>&quot;Approve &amp; start lobby&quot;</em> on the proposed-plan
            panel to commit. Want changes? Reply below to revise.
          </>
        ) : (
          <>
            Answer briefly. When you have shared enough background, click{" "}
            <em>&quot;Looks ready — propose the plan&quot;</em> to nudge it
            to draft.
          </>
        )}
      </p>

      {hasPlan ? (
        // 2-row × 2-col grid (collapses to a single column at sub-xl).
        // Row positioning matters:
        //   xl+: chat=(col1,row1), aside=(col2,rows1-2 sticky panel),
        //        form=(col1,row2). Panel pins on the right, conversation
        //        flows on the left.
        //   sub-xl: items render in DOM order (chat → aside → form),
        //        which puts the panel between the AI's last message
        //        and the reply form — the original "scroll past
        //        everything to see the plan" bug is fixed on small
        //        screens, not just at xl.
        // ``self-start`` on the aside is load-bearing for sticky:
        // without it the grid stretches the aside to the row height
        // (= conversation column) and sticky has no room to scroll
        // past — the panel would just sit there inert. ``max-h`` on
        // the inner section (in PlanPanel, NOT here) caps the panel's
        // own height so the APPROVE footer stays on screen even with
        // a tall plan.
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,460px)] xl:items-start">
          {chatGroup}
          <aside
            aria-label="Proposed plan"
            className="min-w-0 xl:col-start-2 xl:row-start-1 xl:row-span-2 xl:sticky xl:top-2 xl:self-start"
          >
            <PlanPanel
              plan={snapshot.plan!}
              sessionId={snapshot.id}
              onApprove={onApprovePlan}
              busy={busy}
            />
          </aside>
          <div className="min-w-0 xl:col-start-1 xl:row-start-2">
            {replyForm}
          </div>
        </div>
      ) : (
        <>
          {chatGroup}
          {replyForm}
        </>
      )}
    </div>
  );
}

/**
 * Side-panel rendering of the proposed plan with an APPROVE button at
 * the bottom of the panel — the action lives ON the artifact it
 * commits, not buried in the reply-form button row beneath the chat.
 *
 * Sizing strategy:
 *   - Below xl: this section renders at its intrinsic height; the
 *     wizard's ``overflow-auto`` ``<section>`` (see SetupWizard.tsx)
 *     handles outer page scroll. No internal scroll, no max-h.
 *   - At xl+: ``xl:max-h-[calc(100vh-11rem)]`` caps the panel below
 *     the wizard chrome (Eyebrow + h1 "AI is drafting the plan" +
 *     helper paragraph + ``lg:p-8`` outer padding ≈ 160px / 10rem).
 *     The extra ~16px buffer keeps the Approve footer comfortably
 *     above the fold on first render even before the operator
 *     scrolls the chrome out of view. After scrolling, the sticky
 *     aside (``xl:top-2``) keeps the panel pinned with whitespace
 *     below — visible-Approve > tightly-fitting-panel.
 *     ``xl:overflow-hidden`` contains the children; ``xl:flex-1
 *     xl:min-h-0 xl:overflow-auto`` on the body lets PlanView scroll
 *     internally while the header + Approve footer stay pinned.
 *     ``xl:min-h-0`` is load-bearing — without it the flex-child
 *     body refuses to shrink below its content size and the scroll
 *     never engages.
 *
 * Header includes the plan title so the operator keeps that context
 * even after scrolling the body — the original ``<details>`` summary
 * showed it for the same reason.
 */
function PlanPanel({
  plan,
  sessionId,
  onApprove,
  busy,
}: {
  plan: ScenarioPlan;
  sessionId?: string;
  onApprove: () => void;
  busy: boolean;
}) {
  return (
    <section className="flex flex-col rounded-r-3 border border-signal-deep bg-signal-tint xl:max-h-[calc(100vh-11rem)] xl:overflow-hidden">
      <header className="shrink-0 border-b border-signal-deep/50 px-3 py-2.5">
        <p
          className="mono truncate text-[10px] font-bold uppercase tracking-[0.20em] text-signal"
          title={plan.title}
        >
          ● PROPOSED PLAN — {plan.title}
        </p>
      </header>
      <div className="px-4 py-3 xl:flex-1 xl:min-h-0 xl:overflow-auto">
        <PlanView plan={plan} sessionId={sessionId} />
      </div>
      <div className="shrink-0 border-t border-signal-deep/50 px-3 py-2.5">
        <button
          type="button"
          onClick={onApprove}
          disabled={busy}
          className="mono w-full rounded-r-1 bg-signal px-3 py-2 text-[11px] font-bold uppercase tracking-[0.16em] text-ink-900 hover:bg-signal-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal-bright disabled:cursor-not-allowed disabled:opacity-50"
          title="Commits the existing draft plan immediately (no AI call)."
        >
          APPROVE &amp; START LOBBY →
        </button>
      </div>
    </section>
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
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const res = await fetch(
          `/api/sessions/${sessionId}/export.md?token=${encodeURIComponent(token)}`,
        );
        if (canceled) return;
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
        if (canceled) return;
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
      canceled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, token, aarState]);

  return (
    <div
      className="flex flex-col gap-3 rounded-r-3 border border-signal-deep bg-signal-tint p-5"
      role="status"
      aria-live="polite"
    >
      <p className="mono text-[10px] font-bold uppercase tracking-[0.22em] text-signal">
        STEP 06 · REVIEW
      </p>
      <h2 className="text-lg font-semibold tracking-[-0.01em] text-ink-050">
        Session ended — exercise complete
      </h2>
      {aarState === "generating" ? (
        <div className="flex items-center gap-4 rounded-r-2 border border-ink-600 bg-ink-850 p-3">
          <DieLoader size={48} label={null} />
          <div className="flex-1">
            <p className="mono text-[11px] font-bold uppercase tracking-[0.16em] text-signal">
              GENERATING AFTER-ACTION REPORT
            </p>
            <p className="mt-1 text-xs text-ink-300">
              This can take 30–60 seconds. The full transcript, per-role
              scores, frozen scenario plan, and audit log all flow through
              the AAR pipeline.
            </p>
          </div>
        </div>
      ) : aarState === "ready" ? (
        <p className="text-sm text-ink-100 leading-relaxed">
          After-action report is{" "}
          <span className="mono font-bold uppercase tracking-[0.10em] text-signal">
            READY
          </span>
          . Click{" "}
          <span className="mono font-bold uppercase tracking-[0.10em] text-signal">
            VIEW AAR
          </span>{" "}
          in the bottom action bar to read it (the popup contains a
          Download .md button). The report includes the full transcript,
          per-role scores, the frozen scenario plan, and the audit log.
        </p>
      ) : aarState === "expired" ? (
        <div className="flex flex-col gap-2 rounded-r-2 border border-warn bg-warn-bg p-3">
          <p className="mono text-[11px] font-bold uppercase tracking-[0.16em] text-warn">
            ⚠ AAR EXPIRED
          </p>
          <p className="text-xs text-ink-200 leading-relaxed">
            Sessions are purged from server memory after the configured
            retention window (<code className="mono text-signal">EXPORT_RETENTION_MIN</code>,
            default 60 minutes) to limit data retention. There is no
            recovery — to preserve a future AAR, download the{" "}
            <code className="mono text-signal">.md</code> file before the
            window elapses.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-r-2 border border-crit bg-crit-bg p-3">
          <p className="mono text-[11px] font-bold uppercase tracking-[0.16em] text-crit">
            ● AAR GENERATION FAILED{errMsg ? ` — ${errMsg}` : ""}
          </p>
          <p className="text-xs text-ink-200 leading-relaxed">
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
            className="mono self-start rounded-r-1 bg-warn px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-ink-900 hover:bg-warn/80"
          >
            RETRY AAR GENERATION
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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const downloadMdHref = `/api/sessions/${sessionId}/export.md?token=${encodeURIComponent(token)}`;
  const downloadJsonHref = `/api/sessions/${sessionId}/export.json?token=${encodeURIComponent(token)}`;

  // Use the native <dialog> for focus-trap + Esc-to-close. Matches the
  // GodMode pattern.
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
      className="m-auto flex h-[90vh] w-[min(1080px,96vw)] flex-col rounded-r-3 border border-ink-600 bg-ink-850 p-0 text-ink-100 backdrop:bg-black/60"
      aria-labelledby="aar-popup-heading"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-ink-600 bg-ink-900 p-3">
        <div className="flex items-center gap-3">
          <img
            src="/logo/svg/lockup-crittable-dark-transparent.svg"
            alt="Crittable"
            height={20}
            style={{ height: 20 }}
            className="block"
          />
          <span className="h-5 w-px bg-ink-600" aria-hidden="true" />
          <h3
            id="aar-popup-heading"
            className="mono text-[11px] font-bold uppercase tracking-[0.22em] text-signal"
          >
            ● AFTER-ACTION REPORT
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={downloadMdHref}
            rel="noopener"
            download
            className="mono rounded-r-1 bg-signal px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-ink-900 hover:bg-signal-bright"
          >
            DOWNLOAD .MD
          </a>
          <button
            type="button"
            onClick={onClose}
            className="mono rounded-r-1 border border-ink-500 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-200 hover:border-ink-400 hover:bg-ink-800"
          >
            CLOSE
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-5">
        <AarReportView
          sessionId={sessionId}
          token={token}
          downloadMdHref={downloadMdHref}
          downloadJsonHref={downloadJsonHref}
        />
      </div>
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-ink-600 bg-ink-900 p-3">
        <span className="mono text-[10px] uppercase tracking-[0.16em] text-ink-500">
          ROLL · RESPOND · REVIEW
        </span>
        <span className="mono text-[10px] uppercase tracking-[0.10em] text-ink-500 tabular-nums">
          SESSION {sessionId.slice(0, 8)}
        </span>
      </div>
    </dialog>
  );
}


// Issue #113: ReadyView removed — phase === "ready" now renders
// inside the wizard chrome (SetupLobbyView / SetupReviewView), so
// the in-session ReadyView is never reached. SetupReviewView owns
// the post-finalize "ready to launch" surface, START SESSION CTA
// included.
