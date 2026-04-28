import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api, SessionSnapshot } from "../api/client";
import { Composer } from "../components/Composer";
import { CriticalEventBanner } from "../components/CriticalEventBanner";
import { RoleRoster } from "../components/RoleRoster";
import { Transcript } from "../components/Transcript";
import { ServerEvent, WsClient } from "../lib/ws";

interface Props {
  sessionId: string;
  token: string;
}

const DISPLAY_NAME_KEY = "atf-display-name";

export function Play({ sessionId, token }: Props) {
  const [displayName, setDisplayName] = useState<string | null>(
    () => window.localStorage.getItem(`${DISPLAY_NAME_KEY}:${sessionId}`),
  );
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [streamingText, setStreamingText] = useState("");
  const [criticalBanner, setCriticalBanner] = useState<{
    severity: string;
    headline: string;
    body: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WsClient | null>(null);

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
        setStreamingText((t) => t + evt.text);
        break;
      case "message_complete":
        setStreamingText("");
        refreshSnapshot();
        break;
      case "state_changed":
        console.info("[play] state changed", evt);
        refreshSnapshot();
        break;
      case "turn_changed":
        console.info("[play] turn changed", evt);
        refreshSnapshot();
        break;
      case "critical_event":
        setCriticalBanner({ severity: evt.severity, headline: evt.headline, body: evt.body });
        break;
      case "guardrail_blocked":
        setError(evt.message);
        break;
      case "error":
        setError(evt.message);
        break;
      default:
        break;
    }
  }

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

  function handleForceAdvance() {
    wsRef.current?.send({ type: "request_force_advance" });
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

  const activeRoleIds = snapshot.current_turn?.active_role_ids ?? [];
  const isMyTurn = selfRoleId !== null && activeRoleIds.includes(selfRoleId);
  const myRole = snapshot.roles.find((r) => r.id === selfRoleId);
  const placeholder = isMyTurn
    ? "It's your turn — make your decision."
    : `Waiting for ${activeRoleIds
        .map((id) => snapshot.roles.find((r) => r.id === id)?.label ?? id)
        .join(", ") || "the AI"}.`;

  return (
    <main className="flex min-h-screen flex-col">
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
      ) : isMyTurn ? (
        <div
          role="status"
          aria-live="assertive"
          className="sticky top-0 z-10 bg-emerald-700 px-4 py-2 text-center text-sm font-semibold text-white shadow-lg"
        >
          Your turn — {myRole?.label} ({displayName})
        </div>
      ) : null}
      <div className="mx-auto grid w-full max-w-5xl flex-1 grid-cols-1 gap-4 p-4 md:grid-cols-[220px_1fr]">
        <section>
          <RoleRoster roles={snapshot.roles} activeRoleIds={activeRoleIds} selfRoleId={selfRoleId} />
          <div className="mt-3 flex flex-col gap-2 rounded border border-slate-700 bg-slate-900 p-2 text-xs">
            <button
              onClick={handleForceAdvance}
              className="rounded border border-amber-500 px-2 py-1 font-semibold text-amber-200"
            >
              Force-advance turn
            </button>
            <button
              onClick={handleEnd}
              className="rounded border border-red-500 px-2 py-1 font-semibold text-red-300"
            >
              End session
            </button>
          </div>
        </section>
        <section className="flex flex-col gap-3">
          <Transcript
            messages={snapshot.messages}
            roles={snapshot.roles}
            streamingText={streamingText}
            aiThinking={
              snapshot.state !== "ENDED" &&
              !streamingText &&
              (snapshot.state === "AI_PROCESSING" ||
                snapshot.state === "BRIEFING" ||
                snapshot.current_turn?.status === "processing")
            }
          />
          <Composer enabled={isMyTurn && snapshot.state !== "ENDED"} placeholder={placeholder} onSubmit={handleSubmit} />
          {error ? <p className="text-sm text-red-400" role="alert">{error}</p> : null}
        </section>
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
