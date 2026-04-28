import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  CostSnapshot,
  RoleView,
  ScenarioPlan,
  SessionSnapshot,
} from "../api/client";
import { Composer } from "../components/Composer";
import { CriticalEventBanner } from "../components/CriticalEventBanner";
import { RolesPanel } from "../components/RolesPanel";
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

export function Facilitator() {
  const [state, setState] = useState<CreatorState | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [scenarioPrompt, setScenarioPrompt] = useState("");
  const [creatorLabel, setCreatorLabel] = useState("CISO");
  const [creatorDisplayName, setCreatorDisplayName] = useState("");
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
      case "error":
        setError(evt.message);
        break;
      default:
        break;
    }
  }

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

  async function handleSubmit(text: string) {
    if (!wsRef.current) return;
    try {
      wsRef.current.send({ type: "submit_response", content: text });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
    return (
      <main className="mx-auto flex max-w-2xl flex-col gap-4 p-8">
        <h1 className="text-2xl font-semibold">New tabletop exercise</h1>
        <p className="text-sm text-slate-400">
          Provide a scenario prompt and your facilitator details. The AI will then walk you through
          structured setup before you invite players.
        </p>
        <form onSubmit={handleCreate} className="flex flex-col gap-3">
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
            {busy ? "Creating…" : "Create session"}
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
    <main className="flex min-h-screen flex-col">
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
      />
      <div className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-1 gap-4 p-4 md:grid-cols-[280px_1fr]">
        <section className="flex flex-col gap-4">
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
            busy={busy}
          />
        </section>

        <section className="flex flex-col gap-4">
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
              onExport={() =>
                window.open(api.exportUrl(state.sessionId, state.token), "_blank", "noopener")
              }
            />
          ) : null}
          {phase === "play" || phase === "ended" ? (
            <>
              <Transcript
                messages={snapshot.messages}
                roles={snapshot.roles}
                streamingText={streamingText}
                aiThinking={
                  phase === "play" &&
                  !streamingText &&
                  (snapshot.state === "AI_PROCESSING" ||
                    snapshot.state === "BRIEFING" ||
                    snapshot.current_turn?.status === "processing")
                }
              />
              {phase === "play" ? (
                <Composer
                  enabled={isMyTurn && !busy}
                  placeholder={
                    isMyTurn
                      ? "You are an active role. Make your decision."
                      : "Waiting for the AI / other roles."
                  }
                  onSubmit={handleSubmit}
                />
              ) : null}
            </>
          ) : null}
          {error ? <p className="text-sm text-red-400">{error}</p> : null}
        </section>
      </div>
    </main>
  );
}

function StatusBar({
  phase,
  backendState,
  wsStatus,
  busy,
  busyMessage,
}: {
  phase: Phase;
  backendState: string;
  wsStatus: "connecting" | "open" | "closed" | "error";
  busy: boolean;
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
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4">
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
            className="ml-auto inline-flex items-center gap-2 rounded bg-sky-900/40 px-2 py-0.5 text-sky-200"
          >
            <Spinner /> {busyMessage ?? "Working…"}
          </span>
        ) : null}
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


function Controls(props: {
  phase: Phase;
  onStart: () => void;
  onForceAdvance: () => void;
  onEnd: () => void;
  onNewSession: () => void;
  onExport: () => void;
  playerCount: number;
  hasFinalizedPlan: boolean;
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

      {props.phase === "ended" ? (
        <button
          onClick={props.onExport}
          className="rounded bg-emerald-600 px-2 py-1 text-sm font-semibold text-white hover:bg-emerald-500"
        >
          Download AAR
        </button>
      ) : null}

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

function EndedView({ onExport }: { onExport: () => void }) {
  return (
    <div
      className="flex flex-col gap-3 rounded border border-emerald-700/60 bg-emerald-950/30 p-4"
      role="status"
      aria-live="polite"
    >
      <h2 className="text-lg font-semibold text-emerald-200">
        Session ended — exercise complete
      </h2>
      <p className="text-sm text-emerald-100">
        Download the markdown after-action report. It includes the full transcript,
        per-role scores, the frozen scenario plan, and the audit log.
      </p>
      <button
        type="button"
        onClick={onExport}
        className="self-start rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
      >
        Download AAR (.md)
      </button>
    </div>
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
