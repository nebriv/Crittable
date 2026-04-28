import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  CostSnapshot,
  RoleView,
  SessionSnapshot,
} from "../api/client";
import { Composer } from "../components/Composer";
import { CriticalEventBanner } from "../components/CriticalEventBanner";
import { RoleRoster } from "../components/RoleRoster";
import { Transcript } from "../components/Transcript";
import { ServerEvent, WsClient } from "../lib/ws";

type Phase = "intro" | "setup" | "ready" | "play" | "ended";

interface CreatorState {
  sessionId: string;
  token: string;
  creatorRoleId: string;
  joinUrl: string;
}

export function Facilitator() {
  const [state, setState] = useState<CreatorState | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [scenarioPrompt, setScenarioPrompt] = useState("");
  const [creatorLabel, setCreatorLabel] = useState("CISO");
  const [creatorDisplayName, setCreatorDisplayName] = useState("");
  const [setupReply, setSetupReply] = useState("");
  const [error, setError] = useState<string | null>(null);

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

  // ----------------------------------------------------- create session
  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const created = await api.createSession({
        scenario_prompt: scenarioPrompt,
        creator_label: creatorLabel,
        creator_display_name: creatorDisplayName,
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
    }
  }

  // ------------------------------------------------------- WS connection
  useEffect(() => {
    if (!state) return;
    const ws = new WsClient({
      sessionId: state.sessionId,
      token: state.token,
      onEvent: handleEvent,
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

  async function handleSetupReply(e: FormEvent) {
    e.preventDefault();
    if (!state || !setupReply.trim()) return;
    try {
      await api.setupReply(state.sessionId, state.token, setupReply.trim());
      setSetupReply("");
      await refreshSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleAddRole(label: string) {
    if (!state) return;
    try {
      const r = await api.addRole(state.sessionId, state.token, { label });
      const link = `${window.location.origin}/play/${state.sessionId}/${encodeURIComponent(r.token)}`;
      await navigator.clipboard?.writeText(link).catch(() => undefined);
      await refreshSnapshot();
      return link;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleStart() {
    if (!state) return;
    try {
      await api.start(state.sessionId, state.token);
      await refreshSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
    try {
      await api.forceAdvance(state.sessionId, state.token);
      await refreshSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleEnd() {
    if (!state) return;
    try {
      await api.endSession(state.sessionId, state.token, "ended by creator");
      await refreshSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
            className="self-start rounded bg-sky-600 px-4 py-2 text-sm font-semibold text-white"
          >
            Create session
          </button>
        </form>
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
      </main>
    );
  }

  if (!state || !snapshot) return null;

  const activeRoleIds = snapshot.current_turn?.active_role_ids ?? [];
  const isMyTurn = activeRoleIds.includes(state.creatorRoleId);

  return (
    <main className="flex min-h-screen flex-col">
      {criticalBanner ? (
        <CriticalEventBanner
          {...criticalBanner}
          canAcknowledge={isMyTurn}
          onAcknowledge={() => setCriticalBanner(null)}
        />
      ) : null}
      <div className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-1 gap-4 p-4 md:grid-cols-[260px_1fr]">
        <section className="flex flex-col gap-4">
          <RoleRoster roles={snapshot.roles} activeRoleIds={activeRoleIds} selfRoleId={state.creatorRoleId} />
          <CostMeter cost={cost ?? snapshot.cost} />
          <Controls
            phase={phase}
            onAddRole={handleAddRole}
            onStart={handleStart}
            onForceAdvance={handleForceAdvance}
            onEnd={handleEnd}
            onExport={() =>
              window.open(api.exportUrl(state.sessionId, state.token), "_blank", "noopener")
            }
            roles={snapshot.roles}
          />
        </section>

        <section className="flex flex-col gap-4">
          {phase === "setup" ? (
            <SetupView snapshot={snapshot} setupReply={setupReply} setSetupReply={setSetupReply} onSubmit={handleSetupReply} />
          ) : null}
          {phase === "ready" ? (
            <ReadyView plan={snapshot.plan} />
          ) : null}
          {phase === "play" || phase === "ended" ? (
            <>
              <Transcript messages={snapshot.messages} roles={snapshot.roles} streamingText={streamingText} />
              <Composer
                enabled={phase === "play" && isMyTurn}
                placeholder={
                  isMyTurn
                    ? "You are an active role. Make your decision."
                    : "Waiting for the AI / other roles."
                }
                onSubmit={handleSubmit}
              />
            </>
          ) : null}
          {error ? <p className="text-sm text-red-400">{error}</p> : null}
        </section>
      </div>
    </main>
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

function Controls(props: {
  phase: Phase;
  roles: RoleView[];
  onAddRole: (label: string) => Promise<string | undefined>;
  onStart: () => void;
  onForceAdvance: () => void;
  onEnd: () => void;
  onExport: () => void;
}) {
  const [newRole, setNewRole] = useState("");
  const [lastJoinLink, setLastJoinLink] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!newRole.trim()) return;
    const link = await props.onAddRole(newRole.trim());
    setNewRole("");
    if (link) setLastJoinLink(link);
  }

  return (
    <div className="flex flex-col gap-3 rounded border border-slate-700 bg-slate-900 p-3 text-sm">
      {props.phase === "ready" || props.phase === "setup" ? (
        <form onSubmit={add} className="flex flex-col gap-2">
          <label className="text-xs uppercase tracking-widest text-slate-400">Add role</label>
          <div className="flex gap-2">
            <input
              value={newRole}
              onChange={(e) => setNewRole(e.target.value)}
              placeholder="IR Lead"
              className="flex-1 rounded border border-slate-700 bg-slate-950 p-1 text-sm"
            />
            <button type="submit" className="rounded bg-sky-600 px-2 text-xs font-semibold text-white">
              Add
            </button>
          </div>
          {lastJoinLink ? (
            <p className="break-all rounded bg-slate-950 p-1 text-xs text-emerald-300">
              Copied join URL: {lastJoinLink}
            </p>
          ) : null}
        </form>
      ) : null}

      {props.phase === "ready" ? (
        <button onClick={props.onStart} className="rounded bg-emerald-600 px-2 py-1 text-sm font-semibold text-white">
          Start session
        </button>
      ) : null}

      {props.phase === "play" ? (
        <>
          <button
            onClick={props.onForceAdvance}
            className="rounded border border-amber-500 px-2 py-1 text-sm font-semibold text-amber-200"
          >
            Force-advance turn
          </button>
          <button
            onClick={props.onEnd}
            className="rounded border border-red-500 px-2 py-1 text-sm font-semibold text-red-300"
          >
            End session
          </button>
        </>
      ) : null}

      {props.phase === "ended" ? (
        <button onClick={props.onExport} className="rounded bg-emerald-600 px-2 py-1 text-sm font-semibold text-white">
          Download AAR
        </button>
      ) : null}
    </div>
  );
}

function SetupView({
  snapshot,
  setupReply,
  setSetupReply,
  onSubmit,
}: {
  snapshot: SessionSnapshot;
  setupReply: string;
  setSetupReply: (s: string) => void;
  onSubmit: (e: FormEvent) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Setup dialogue</h2>
      <p className="text-xs text-slate-400">
        The AI is gathering context. Answer briefly; click "Looks ready" once you're set.
      </p>
      <Transcript messages={snapshot.messages.length ? snapshot.messages : []} roles={snapshot.roles} />
      <form onSubmit={onSubmit} className="flex flex-col gap-2">
        <textarea
          value={setupReply}
          onChange={(e) => setSetupReply(e.target.value)}
          rows={3}
          placeholder="e.g. mid-size regional bank, PCI + SOX in scope"
          className="rounded border border-slate-700 bg-slate-900 p-2 text-sm"
        />
        <button
          type="submit"
          className="self-end rounded bg-sky-600 px-3 py-1 text-sm font-semibold text-white"
        >
          Send to AI
        </button>
      </form>
      {snapshot.plan ? (
        <details className="rounded border border-slate-700 bg-slate-900 p-2 text-xs">
          <summary className="cursor-pointer">Proposed plan</summary>
          <pre className="mt-2 whitespace-pre-wrap">{JSON.stringify(snapshot.plan, null, 2)}</pre>
        </details>
      ) : null}
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
