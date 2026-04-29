import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  api,
  CostSnapshot,
  RoleView,
  ScenarioPlan,
  SessionSnapshot,
} from "../api/client";
import { Composer } from "../components/Composer";
import { CriticalEventBanner } from "../components/CriticalEventBanner";
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

/**
 * Sample scenario prefilled when the operator toggles "Dev mode" on the
 * intro page. Mirrors the backend's ``_default_dev_plan`` ransomware brief
 * so the resulting plan is consistent end-to-end.
 */
const DEV_SCENARIO_PROMPT =
  "Ransomware via compromised vendor portal at a mid-size regional bank. " +
  "Finance laptops are encrypting; attribution is unclear; a vendor that was " +
  "publicly breached two weeks ago shares a service account that was never " +
  "rotated. The team has ~90 minutes of simulated time to contain, decide on " +
  "regulator/comms posture, and respond to an attacker demand.";

export function Facilitator() {
  const [state, setState] = useState<CreatorState | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [scenarioPrompt, setScenarioPrompt] = useState("");
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
  // role_id -> last typing-true timestamp (ms). Filtered to "currently typing"
  // by the consuming components which check freshness < 4s.
  const [typing, setTyping] = useState<Record<string, number>>({});
  const wsRef = useRef<WsClient | null>(null);

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
    setBusyMessage("Creating session and starting AI setup dialogue…");
    try {
      const created = await api.createSession({
        scenario_prompt: scenarioPrompt,
        creator_label: creatorLabel,
        creator_display_name: creatorDisplayName,
      });
      // Don't log the response object — it carries the creator token in
      // ``creator_token`` and ``creator_join_url``. Log only non-secret IDs.
      console.info("[facilitator] session created", {
        sessionId: created.session_id,
        creatorRoleId: created.creator_role_id,
      });
      setState({
        sessionId: created.session_id,
        token: created.creator_token,
        creatorRoleId: created.creator_role_id,
        joinUrl: created.creator_join_url,
      });
      if (devMode) {
        setBusyMessage("Dev mode: skipping setup with a default plan…");
        await api.setupSkip(created.session_id, created.creator_token);
        console.info("[facilitator] dev mode auto-skipped setup");
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
      case "typing":
        setTyping((prev) => {
          const next = { ...prev };
          if (evt.typing) {
            next[evt.role_id] = Date.now();
          } else {
            delete next[evt.role_id];
          }
          return next;
        });
        break;
      case "aar_status_changed":
        // The EndedView polls /export.md too; this just nudges the snapshot
        // refresh so the AAR-status pill updates immediately.
        refreshSnapshot();
        break;
      case "error":
        setError(evt.message);
        break;
      default:
        break;
    }
  }

  // Expire stale typing entries every second so the indicator disappears
  // even if the typing_stop event got dropped.
  useEffect(() => {
    const id = setInterval(() => {
      setTyping((prev) => {
        const cutoff = Date.now() - 4000;
        const next: Record<string, number> = {};
        let changed = false;
        for (const [k, v] of Object.entries(prev)) {
          if (v >= cutoff) next[k] = v;
          else changed = true;
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  async function refreshSnapshot() {
    if (!state) return;
    try {
      const snap = await api.getSession(state.sessionId, state.token);
      setSnapshot(snap);
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
      await api.setupReply(state.sessionId, state.token, NUDGE_PROPOSE);
      const snap = await api.getSession(state.sessionId, state.token);
      setSnapshot(snap);
      if (snap.plan) {
        setBusyMessage("Plan drafted — finalizing…");
        await api.setupFinalize(state.sessionId, state.token);
        const after = await api.getSession(state.sessionId, state.token);
        setSnapshot(after);
      } else {
        setError(
          "The AI didn't propose a plan yet. Try once more, or share a bit more context first.",
        );
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
        // Prefill only if the user hasn't typed anything custom.
        if (!scenarioPrompt.trim()) {
          setScenarioPrompt(DEV_SCENARIO_PROMPT);
        }
        if (!creatorDisplayName.trim()) {
          setCreatorDisplayName("Dev Tester");
        }
      }
    };
    return (
      <main className="mx-auto flex max-w-2xl flex-col gap-4 p-8">
        <h1 className="text-2xl font-semibold">New tabletop exercise</h1>
        <p className="text-sm text-slate-400">
          Provide a scenario prompt and your facilitator details. The AI will then walk you through
          structured setup before you invite players.
        </p>
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
              Prefills a known ransomware scenario + display name and skips the
              AI setup dialogue. Use this for local QA only.
            </span>
          </div>
          <label className="text-xs uppercase tracking-widest text-slate-400">Scenario prompt</label>
          <textarea
            value={scenarioPrompt}
            onChange={(e) => setScenarioPrompt(e.target.value)}
            rows={4}
            required
            placeholder="Ransomware via vendor portal compromise, mid-size regional bank…"
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
    <main className="flex h-screen min-h-0 flex-col overflow-hidden">
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
      <div className="mx-auto grid min-h-0 w-full max-w-7xl flex-1 grid-cols-1 gap-4 overflow-hidden p-4 lg:grid-cols-[280px_1fr_280px]">
        <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
          <RolesPanel
            sessionId={state.sessionId}
            creatorToken={state.token}
            roles={snapshot.roles}
            busy={busy}
            onRoleAdded={refreshSnapshot}
            onRoleChanged={refreshSnapshot}
            onError={setError}
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
          <CostMeter cost={cost ?? snapshot.cost} />
          <Controls
            phase={phase}
            onStart={handleStart}
            onForceAdvance={handleForceAdvance}
            onEnd={handleEnd}
            onNewSession={handleNewSession}
            onExport={() =>
              window.open(api.exportUrl(state.sessionId, state.token), "_blank", "noopener")
            }
            playerCount={playerCount}
            hasFinalizedPlan={Boolean(snapshot.plan)}
            aarStatus={snapshot.aar_status ?? null}
            busy={busy}
          />
        </aside>

        <section className="flex min-h-0 flex-col gap-3 overflow-hidden">
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
          {phase === "ready" ? <ReadyView plan={snapshot.plan} /> : null}
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
                    The AI failed to yield via a tool. Force-advance to skip
                    this turn, or end the session.
                  </span>
                  <button
                    type="button"
                    onClick={handleForceAdvance}
                    disabled={busy}
                    className="rounded border border-amber-500 bg-amber-900/30 px-3 py-1 text-xs font-semibold text-amber-100 hover:bg-amber-800/40 disabled:opacity-50"
                  >
                    Force-advance turn
                  </button>
                </div>
              ) : null}
              <div className="min-h-0 flex-1 overflow-y-auto pr-1">
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
              </div>
              {phase === "play" ? (
                <div className="shrink-0">
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
                    // Creator-only "respond as" dropdown: list every active
                    // role except the creator's own seat. Lets a solo
                    // tester answer for SOC Analyst etc. without juggling
                    // browser tabs. Empty for non-active roles or when
                    // there's nothing to impersonate.
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
                    // speak as themselves OR they have other seats to
                    // proxy for — solo testers need both paths.
                    const canSelfSpeak = isMyTurn && !busy;
                    const canProxy = impersonateOptions.length > 0 && !busy;
                    return (
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
                    );
                  })()}
                </div>
              ) : null}
            </>
          ) : null}
          {error ? <p className="text-sm text-red-400">{error}</p> : null}
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
}: {
  activeRoleIds: string[];
  submittedRoleIds: string[];
  roles: RoleView[];
}) {
  const submitted = new Set(submittedRoleIds);
  const pending = activeRoleIds.filter((id) => !submitted.has(id));
  if (pending.length === 0) return null;
  const labels = pending
    .map((id) => roles.find((r) => r.id === id)?.label ?? id)
    .join(", ");
  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-2 flex items-center gap-2 rounded border border-amber-700/40 bg-amber-950/30 px-2 py-1 text-xs text-amber-100"
    >
      <span
        aria-hidden="true"
        className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300"
      />
      <span>
        Waiting on <span className="font-semibold">{pending.length} of {activeRoleIds.length}</span>
        {": "}
        <span className="text-amber-200">{labels}</span>
      </span>
    </div>
  );
}


function Controls(props: {
  phase: Phase;
  onStart: () => void;
  onForceAdvance: () => void;
  onEnd: () => void;
  onNewSession: () => void;
  onExport: () => void;
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
          <button
            onClick={props.onForceAdvance}
            disabled={props.busy}
            className="rounded border border-amber-500 px-2 py-1 text-sm font-semibold text-amber-200 hover:bg-amber-900/30 disabled:opacity-50"
          >
            Force-advance turn
          </button>
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
        // Don't surface a Download button until the AAR pipeline reports
        // ``ready``. Showing it during ``pending`` / ``generating`` led to
        // operators clicking it and getting a 425 Too Early error.
        if (props.aarStatus === "ready") {
          return (
            <button
              onClick={props.onExport}
              className="rounded bg-emerald-600 px-2 py-1 text-sm font-semibold text-white hover:bg-emerald-500"
            >
              Download AAR
            </button>
          );
        }
        if (props.aarStatus === "failed") {
          return (
            <p className="rounded border border-red-500/60 bg-red-950/30 px-2 py-1 text-xs text-red-200">
              AAR generation failed — check backend logs.
            </p>
          );
        }
        return (
          <button
            type="button"
            disabled
            className="cursor-not-allowed rounded bg-slate-700 px-2 py-1 text-sm font-semibold text-slate-300 opacity-70"
            title="AAR is still generating — the EndedView panel will pop the report when it's ready."
          >
            AAR generating…
          </button>
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

      {hasPlan ? <PlanPreview plan={snapshot.plan!} /> : null}
    </div>
  );
}

function PlanPreview({ plan }: { plan: ScenarioPlan }) {
  return (
    <details className="rounded border border-emerald-700/60 bg-emerald-950/20 p-2 text-xs" open>
      <summary className="cursor-pointer text-emerald-300">
        Proposed plan: {plan.title}
      </summary>
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-slate-200">
        {JSON.stringify(plan, null, 2)}
      </pre>
    </details>
  );
}

function EndedView({ sessionId, token }: { sessionId: string; token: string }) {
  type AARState = "generating" | "ready" | "failed";
  const [aarState, setAarState] = useState<AARState>("generating");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [showPopup, setShowPopup] = useState(false);

  // Poll the export endpoint with HEAD-style behavior: if 425, keep
  // polling. If 200, mark ready (the popup will fetch the body on open).
  // If 5xx, mark failed.
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
          timer = setTimeout(tick, 2500);
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
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, token]);

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
        <>
          <p className="text-sm text-emerald-100">
            After-action report is ready. It includes the full transcript,
            per-role scores, the frozen scenario plan, and the audit log.
          </p>
          <button
            type="button"
            onClick={() => setShowPopup(true)}
            className="self-start rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
          >
            Show AAR report
          </button>
          {showPopup ? (
            <AARPopup
              sessionId={sessionId}
              token={token}
              onClose={() => setShowPopup(false)}
            />
          ) : null}
        </>
      ) : (
        <p className="text-sm text-red-300">
          AAR generation failed: {errMsg ?? "unknown error"}. Check the backend logs.
        </p>
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
          setErr(`HTTP ${res.status}`);
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
                  <div className="mb-3 overflow-x-auto">
                    <table className="min-w-full border-collapse text-xs">{children}</table>
                  </div>
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


function ReadyView({ plan }: { plan: SessionSnapshot["plan"] }) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Plan finalized — ready to start</h2>
      {plan ? (
        <pre className="overflow-auto rounded border border-slate-700 bg-slate-900 p-3 text-xs">
          {JSON.stringify(plan, null, 2)}
        </pre>
      ) : null}
      <p className="text-sm text-slate-400">Add at least 2 roles, then click "Start session".</p>
    </div>
  );
}
