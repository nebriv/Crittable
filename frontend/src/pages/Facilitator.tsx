import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
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
import { ServerEvent, WsClient } from "../lib/ws";

type Phase = "intro" | "setup" | "ready" | "play" | "ended";

interface CreatorState {
  sessionId: string;
  token: string;
  creatorRoleId: string;
  joinUrl: string;
}

const NUDGE_PROPOSE = "I think we have enough context. Please draft the scenario plan now.";

// Receiver-side typing indicator timings — kept in sync with Play.tsx.
// See issue #53: the indicator should appear cleanly on a real typing
// burst and persist for about three seconds, never flickering.
const TYPING_VISIBLE_MS = 5000;
const TYPING_FADE_HEAD_START_MS = TYPING_VISIBLE_MS - 1500;

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
  // Dev-mode toggle on the intro page: prefills a known scenario + creator
  // identity, and on submit auto-skips the AI setup dialogue so testers
  // bypass the 5–30 s setup loop. Use only for local QA.
  const [devMode, setDevMode] = useState(false);
  const [setupReply, setSetupReply] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<"connecting" | "open" | "closed" | "error">("connecting");

  const [streamingText, setStreamingText] = useState("");
  const [criticalBanner, setCriticalBanner] = useState<{
    severity: string;
    headline: string;
    body: string;
  } | null>(null);
  const [cost, setCost] = useState<CostSnapshot | null>(null);
  const [godMode, setGodMode] = useState(false);
  // Page-level state for the AAR popup so a single "View AAR" button in
  // the sidebar Controls is the only surface that opens it. Pre-fix the
  // sidebar had a "Download AAR" that bypassed the popup AND the chat
  // area had a duplicate "Show AAR report" button — two competing CTAs
  // for the same task.
  const [showAarPopup, setShowAarPopup] = useState(false);
  // role_id -> last typing-true timestamp (ms). Filtered to "currently typing"
  // by the consuming components which check freshness < 4s.
  const [typing, setTyping] = useState<Record<string, number>>({});
  // role_ids whose tabs are currently connected. Server-pushed via the
  // ``presence`` / ``presence_snapshot`` WS events. See issue #52 — the
  // creator needs to know which invites have actually been opened
  // before kicking off the exercise.
  const [presence, setPresence] = useState<Set<string>>(() => new Set());
  // Live AI decision rationale stream (issue #55). Entries arrive via
  // ``decision_logged`` events as the AI calls
  // ``record_decision_rationale``; on snapshot refresh we replace the
  // local state with the canonical server list to avoid drift if a
  // WebSocket frame was missed during reconnect.
  const [decisionLog, setDecisionLog] = useState<DecisionLogEntry[]>([]);
  const wsRef = useRef<WsClient | null>(null);
  // Wraps the chat scroll region so we can auto-pin the latest message to
  // the bottom on each new arrival. Without this the user's view stays
  // fixed where they were last reading and they don't realise a new AI
  // beat just landed.
  const scrollRegionRef = useRef<HTMLDivElement | null>(null);
  // Force-scroll latch: bumped whenever the local user takes an action
  // (submit, proxy submit, force-advance) so the next render pins the
  // chat to the bottom regardless of where they were scrolled. The
  // slack-based "only if near bottom" rule below still applies for
  // *incoming* messages from other roles.
  const [forceScrollNonce, setForceScrollNonce] = useState(0);

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
    switch (evt.type) {
      case "message_chunk":
        setStreamingText((t) => t + evt.text);
        break;
      case "message_complete":
        setStreamingText("");
        refreshSnapshot();
        break;
      case "state_changed":
      case "turn_changed":
      case "plan_proposed":
      case "plan_finalized":
      case "plan_edited":
        refreshSnapshot();
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
        break;
      case "presence_snapshot":
        setPresence(new Set(evt.role_ids));
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

  // Auto-scroll the chat region to the bottom when the message count or
  // streaming buffer grows. For incoming messages we keep the operator's
  // scroll position if they've scrolled up to re-read an earlier beat
  // (120px slack). For local-user actions (submit / proxy / force-
  // advance) ``forceScrollNonce`` is bumped so we ALWAYS pin to the
  // bottom — they just took an action and want to see the result.
  const messageCount = snapshot?.messages.length ?? 0;
  useEffect(() => {
    const el = scrollRegionRef.current;
    if (!el) return;
    if (forceScrollNonce > 0) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 120) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messageCount, streamingText, forceScrollNonce]);

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
    setStreamingText("");
    setCriticalBanner(null);
    setDecisionLog([]);
    setPresence(new Set());
    setCost(null);
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
    setForceScrollNonce((n) => n + 1);
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

  function handleTypingChange(typing: boolean) {
    try {
      wsRef.current?.send({ type: typing ? "typing_start" : "typing_stop" });
    } catch {
      /* WS can be closed mid-typing; never throw out of this handler. */
    }
  }

  async function handleForceAdvance() {
    if (!state) return;
    setBusy(true);
    setBusyMessage("Force-advancing turn — AI is drafting the next beat…");
    setForceScrollNonce((n) => n + 1);
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
      <StatusBar
        phase={phase}
        backendState={snapshot.state}
        wsStatus={wsStatus}
        busy={busy}
        busyMessage={busyMessage}
        onToggleGodMode={() => setGodMode((g) => !g)}
        godMode={godMode}
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
            busy={busy}
          />
          <DecisionLogPanel entries={decisionLog} />
          <CostMeter cost={cost ?? snapshot.cost} />
          <Controls
            phase={phase}
            onStart={handleStart}
            onForceAdvance={handleForceAdvance}
            onEnd={handleEnd}
            onNewSession={handleNewSession}
            onViewAar={() => setShowAarPopup(true)}
            playerCount={playerCount}
            hasFinalizedPlan={Boolean(snapshot.plan)}
            aarStatus={snapshot.aar_status ?? null}
            busy={busy}
          />
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
                    disabled={busy}
                    className="rounded border border-emerald-500 bg-emerald-900/30 px-3 py-1 text-xs font-semibold text-emerald-100 hover:bg-emerald-700/40 disabled:opacity-50"
                  >
                    AI: take next beat
                  </button>
                </div>
              ) : null}
              <Transcript
                messages={snapshot.messages}
                roles={snapshot.roles}
                streamingText={streamingText}
                aiThinking={
                  phase === "play" &&
                  !streamingText &&
                  // Don't spin the indicator if the turn errored — the
                  // AI is no longer working; the activity panel surfaces
                  // the error and the operator can force-advance.
                  snapshot.current_turn?.status !== "errored" &&
                  (snapshot.state === "AI_PROCESSING" ||
                    snapshot.state === "BRIEFING" ||
                    snapshot.current_turn?.status === "processing")
                }
                typingRoleIds={Object.keys(typing).filter(
                  (rid) => rid !== state.creatorRoleId,
                )}
              />
            </>
          ) : null}
          {error ? <p className="text-sm text-red-400">{error}</p> : null}
          </div>
          {phase === "play" ? (
            // Composer + WaitingChip live OUTSIDE the scroll region so they
            // stay pinned at the bottom of the section regardless of
            // transcript length. ``shrink-0`` here is what keeps Submit
            // reachable on a 30-message exercise.
            <div className="shrink-0">
              {!isMyTurn && snapshot.current_turn?.active_role_ids?.length ? (
                <WaitingChip
                  activeRoleIds={activeRoleIds}
                  submittedRoleIds={
                    snapshot.current_turn?.submitted_role_ids ?? []
                  }
                  roles={snapshot.roles}
                  sessionId={state.sessionId}
                  creatorToken={state.token}
                />
              ) : null}
              {(() => {
                // Creator-only "respond as" dropdown: list every active
                // role except the creator's own seat. Lets a solo
                // tester answer for SOC Analyst etc. without juggling
                // browser tabs. Empty when no other seats need a voice.
                const impersonateOptions = activeRoleIds
                  .filter((rid) => rid !== state.creatorRoleId)
                  .filter(
                    (rid) =>
                      !(snapshot.current_turn?.submitted_role_ids ?? []).includes(rid),
                  )
                  .map((rid) => {
                    const r = snapshot.roles.find((x) => x.id === rid);
                    return {
                      id: rid,
                      label: r ? r.label : rid,
                    };
                  });
                const selfRole = snapshot.roles.find(
                  (r) => r.id === state.creatorRoleId,
                );
                // The composer is enabled when EITHER the creator can
                // speak as themselves OR they have other seats to proxy
                // for — solo testers need both paths.
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
                      enabled={canSelfSpeak || canProxy}
                      placeholder={
                        canSelfSpeak
                          ? "You are an active role. Make your decision."
                          : canProxy
                            ? "Solo test: respond on behalf of a pending role using the dropdown."
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

function StatusBar({
  phase,
  backendState,
  wsStatus,
  busy,
  busyMessage,
  onToggleGodMode,
  godMode,
}: {
  phase: Phase;
  backendState: string;
  wsStatus: "connecting" | "open" | "closed" | "error";
  busy: boolean;
  onToggleGodMode: () => void;
  godMode: boolean;
  busyMessage: string | null;
}) {
  const wsColour =
    wsStatus === "open"
      ? "text-emerald-300"
      : wsStatus === "connecting"
        ? "text-amber-300"
        : "text-red-300";
  return (
    <header className="border-b border-slate-800 bg-slate-900/70 px-4 py-2 text-xs">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4">
        <span className="font-semibold uppercase tracking-widest text-slate-400">
          Facilitator
        </span>
        <span className="rounded bg-slate-800 px-2 py-0.5 text-slate-200">
          state: {backendState} · phase: {phase}
        </span>
        <span className={wsColour}>● ws: {wsStatus}</span>
        {/* Build identification — surfaced so a creator filing a bug
            report can tell us which version they're on without opening
            DevTools. Vite injects ``__ATF_GIT_SHA__`` at build time. */}
        <span
          className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[10px] text-slate-400"
          title={`Build: ${__ATF_GIT_SHA__} · ${__ATF_BUILD_TS__}`}
        >
          v {__ATF_GIT_SHA__}
        </span>
        {busy ? (
          <span
            role="status"
            aria-live="polite"
            className="inline-flex items-center gap-2 rounded bg-sky-900/40 px-2 py-0.5 text-sky-200"
          >
            <Spinner /> {busyMessage ?? "Working…"}
          </span>
        ) : null}
        <button
          type="button"
          onClick={onToggleGodMode}
          aria-pressed={godMode}
          className={
            "ml-auto rounded border px-2 py-0.5 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-300 " +
            (godMode
              ? "border-purple-500 bg-purple-700/40 text-purple-100"
              : "border-purple-700/40 text-purple-300 hover:bg-purple-900/30")
          }
          title="Toggle full debug overlay (audit log, system prompt, etc). Creator-only."
        >
          {godMode ? "● God Mode" : "○ God Mode"}
        </button>
      </div>
    </header>
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

function CostMeter({ cost }: { cost: CostSnapshot | null }) {
  if (!cost) return null;
  return (
    <div className="rounded border border-slate-700 bg-slate-900 p-2 text-xs text-slate-300">
      <p className="uppercase tracking-widest text-slate-500">Cost (creator only)</p>
      <p>
        in {cost.input_tokens.toLocaleString()} · out {cost.output_tokens.toLocaleString()} · cache_r{" "}
        {cost.cache_read_tokens.toLocaleString()}
      </p>
      <p className="font-semibold text-emerald-300">≈ ${cost.estimated_usd.toFixed(4)}</p>
      <p
        className="mt-0.5 text-[10px] leading-tight text-slate-500"
        title="Anthropic API spend, attributed to the operator's ANTHROPIC_API_KEY. Not billed to participants."
      >
        Charged to the operator's Anthropic key. Cumulative for this session.
      </p>
    </div>
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
 * Pinned above the Composer when *other* roles still owe a response. Tells
 * the local player exactly who we're blocked on so the screen doesn't look
 * frozen, and surfaces the count ("waiting on 1 of 3") for at-a-glance scan.
 */
function WaitingChip({
  activeRoleIds,
  submittedRoleIds,
  roles,
  sessionId,
  creatorToken,
}: {
  activeRoleIds: string[];
  submittedRoleIds: string[];
  roles: RoleView[];
  /** When provided, the chip exposes a "Copy invite link" button per
   *  pending role so the operator can re-share a join link without
   *  scrolling up to the Roles panel. Tokens are fetched on-demand via
   *  ``api.reissueRole`` so they're never embedded in the snapshot. */
  sessionId?: string;
  creatorToken?: string;
}) {
  const [copiedRoleId, setCopiedRoleId] = useState<string | null>(null);
  const [copyErr, setCopyErr] = useState<string | null>(null);
  const submitted = new Set(submittedRoleIds);
  const pending = activeRoleIds.filter((id) => !submitted.has(id));
  if (pending.length === 0) return null;
  const pendingRoles = pending.map(
    (id) => roles.find((r) => r.id === id) ?? { id, label: id, display_name: null },
  );
  const canResend = Boolean(sessionId && creatorToken);

  async function copyInvite(roleId: string) {
    if (!sessionId || !creatorToken) return;
    setCopyErr(null);
    try {
      const r = await api.reissueRole(sessionId, creatorToken, roleId);
      await navigator.clipboard.writeText(r.join_url);
      setCopiedRoleId(roleId);
      setTimeout(() => {
        setCopiedRoleId((cur) => (cur === roleId ? null : cur));
      }, 2000);
    } catch (err) {
      setCopyErr(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-2 flex flex-col gap-1 rounded border border-amber-700/40 bg-amber-950/30 px-2 py-1 text-xs text-amber-100"
    >
      <span className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300"
        />
        <span>
          Waiting on{" "}
          <span className="font-semibold">{pending.length} of {activeRoleIds.length}</span>
        </span>
      </span>
      <ul className="flex flex-wrap items-center gap-1">
        {pendingRoles.map((r) => (
          <li
            key={r.id}
            className="inline-flex items-center gap-1 rounded bg-amber-950/60 px-1.5 py-0.5"
          >
            <span className="text-amber-200">{r.label}</span>
            {canResend ? (
              <button
                type="button"
                onClick={() => copyInvite(r.id)}
                className="rounded border border-amber-500/50 px-1 py-0 text-[10px] text-amber-100 hover:bg-amber-900/40"
                title={`Reissue and copy ${r.label}'s join link.`}
              >
                {copiedRoleId === r.id ? "Copied!" : "Copy invite"}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {copyErr ? (
        <p className="text-[10px] text-red-300">copy failed: {copyErr}</p>
      ) : null}
    </div>
  );
}


function Controls(props: {
  phase: Phase;
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
}) {
  const canStart =
    (props.phase === "ready" || props.phase === "setup") &&
    props.hasFinalizedPlan &&
    props.playerCount >= 2;

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded border border-slate-700 bg-slate-900 p-3 text-sm">
      {props.phase === "ready" || props.phase === "setup" ? (
        <>
          <p className="text-xs text-slate-400">
            Players: {props.playerCount} (need ≥ 2 to start)
          </p>
          <button
            onClick={props.onStart}
            disabled={!canStart || props.busy}
            className="rounded bg-emerald-600 px-2 py-1 text-sm font-semibold text-white hover:bg-emerald-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
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
        </>
      ) : null}

      {props.phase === "play" ? (
        <>
          {/*
            Single force-advance button. The User-Agent review flagged
            two stacked buttons that landed on the same handler as
            "reads like an unfinished refactor" — fair. We now ship one
            primary action with a clarifying tooltip + a one-line
            inline hint that covers both intents (nudge AI / skip
            missing voices).
          */}
          <button
            onClick={props.onForceAdvance}
            disabled={props.busy}
            className="rounded border border-emerald-500 bg-emerald-900/30 px-2 py-1 text-sm font-semibold text-emerald-100 hover:bg-emerald-700/40 disabled:opacity-50"
            title="Hand the turn to the AI now. Use when conversation has stalled OR when one player is unresponsive."
          >
            AI: take next beat
          </button>
          <p className="text-[10px] leading-tight text-slate-500">
            Marks the current player turn complete (skipping any missing
            voices) and lets the AI run the next beat.
          </p>
          <button
            onClick={props.onEnd}
            disabled={props.busy}
            className="rounded border border-red-500 px-2 py-1 text-sm font-semibold text-red-300 hover:bg-red-900/30 disabled:opacity-50"
          >
            End session
          </button>
        </>
      ) : null}

      {props.phase === "ended" ? (() => {
        // Single AAR entry point. The popup contains the actual Download
        // button; this CTA only opens the viewer. Pre-fix there were two
        // competing buttons (sidebar "Download AAR" that bypassed the
        // popup, plus an in-chat "Show AAR report").
        if (props.aarStatus === "ready") {
          return (
            <button
              onClick={props.onViewAar}
              className="rounded bg-emerald-600 px-2 py-1 text-sm font-semibold text-white hover:bg-emerald-500"
            >
              View AAR
            </button>
          );
        }
        if (props.aarStatus === "failed") {
          return (
            <div
              role="status"
              className="flex flex-col gap-1 rounded border border-red-500/60 bg-red-950/30 px-2 py-1 text-xs text-red-200"
            >
              <span>AAR generation failed.</span>
              <span className="text-[11px] text-red-200/80">
                Use Retry in the main panel, or end + restart the session.
              </span>
            </div>
          );
        }
        return (
          <span
            role="status"
            aria-live="polite"
            className="inline-flex items-center gap-1.5 rounded bg-slate-800/80 px-2 py-1 text-xs text-slate-300"
          >
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400"
            />
            AAR generating… (~30 s)
          </span>
        );
      })() : null}

      <button
        onClick={props.onNewSession}
        disabled={props.busy}
        className="mt-1 rounded border border-slate-600 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
        title="End the current session (if any) and return to the new-session form."
      >
        Start a new session
      </button>
    </div>
  );
}

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
