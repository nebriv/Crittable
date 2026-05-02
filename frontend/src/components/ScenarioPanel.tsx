import { useEffect, useState } from "react";
import { api } from "../api/client";

interface ScenarioMeta {
  id: string;
  name: string;
  description: string;
  tags: string[];
  roster_size: number;
  play_turns: number;
  skip_setup: boolean;
}

interface PlayResult {
  ok: boolean;
  session_id: string | null;
  error: string | null;
  log: string[];
  role_tokens: Record<string, string>;
  role_label_to_id: Record<string, string>;
}

interface Props {
  /** Current session id — required for the "record" button. */
  sessionId: string;
  /** Creator token — required for the "record" button. */
  creatorToken: string;
  /** Current ``SessionState`` value. Record is disabled in CREATED /
   * SETUP / READY because there's no transcript to capture; clicking
   * Record on an empty session would 4xx with a validation message
   * the dev couldn't act on. */
  sessionState: string;
}

/**
 * Dev-tools panel: pick a preset scenario and replay it through the
 * live engine, or dump the current session as a replayable scenario
 * JSON file. Only renders content when ``DEV_TOOLS_ENABLED=true`` on
 * the backend (the list endpoint 404s otherwise; we render an empty
 * state with a hint).
 *
 * Lives inside God Mode (creator-only). The "Play scenario" button
 * spawns a NEW session, leaving the current session untouched. The
 * resulting role-token URLs are surfaced as clickable links so the
 * dev can pop each role's tab open in parallel.
 */
export function ScenarioPanel({
  sessionId,
  creatorToken,
  sessionState,
}: Props) {
  // Recording requires meaningful state — pre-PLAY there's nothing
  // captured worth shipping into ``backend/scenarios/``. Per UI/UX
  // review BLOCK B2.
  const recordable =
    sessionState === "AWAITING_PLAYERS" ||
    sessionState === "AI_PROCESSING" ||
    sessionState === "BRIEFING" ||
    sessionState === "ENDED";
  const [scenarios, setScenarios] = useState<ScenarioMeta[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<PlayResult | null>(null);
  const [recordName, setRecordName] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Distinguish "endpoint is 404 because the dev-tools gate is closed"
  // (disabled=true) from "the gate is open but the directory is
  // empty" (disabled=false). Same UI state otherwise renders the same
  // text, leaving the dev unable to tell which knob to flip.
  const [disabled, setDisabled] = useState(false);
  const [scenariosPath, setScenariosPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const body = await api.listScenarios();
        if (!cancelled) {
          setScenarios(body.scenarios);
          setDisabled(body.disabled);
          setScenariosPath(body.path ?? null);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
          console.warn("[scenarios] list failed", err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handlePlay() {
    if (!selected) return;
    setBusy("play");
    setError(null);
    setResult(null);
    try {
      const body = await api.playScenario(selected, creatorToken);
      setResult(body);
      console.info("[scenarios] play complete", body.session_id, body.error);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setError(text);
      console.warn("[scenarios] play failed", text);
    } finally {
      setBusy(null);
    }
  }

  async function handleRecord() {
    if (!recordName.trim()) {
      setError("Recording requires a non-empty name.");
      return;
    }
    setBusy("record");
    setError(null);
    try {
      const body = await api.recordScenario(sessionId, creatorToken, {
        name: recordName.trim(),
        description: `Recorded from session ${sessionId.slice(0, 8)}`,
        tags: ["recorded"],
      });
      const blob = new Blob([JSON.stringify(body.scenario_json, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const slug = recordName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      a.download = `${slug || "scenario"}.json`;
      a.click();
      URL.revokeObjectURL(url);
      console.info("[scenarios] record dumped", body.stats);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setError(text);
      console.warn("[scenarios] record failed", text);
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <section
        aria-label="Scenarios"
        className="flex flex-col gap-2 rounded border border-info/40 bg-info/10 p-3 text-ink-100"
      >
        <h3 className="text-sm font-semibold uppercase tracking-widest text-info">
          Scenarios
        </h3>
        <p className="text-xs text-ink-300">Loading scenarios…</p>
      </section>
    );
  }
  if (disabled) {
    // Backend gate is closed (404). Distinct from "no scenarios" so
    // the dev knows which knob to flip.
    return (
      <section
        aria-label="Scenarios"
        className="flex flex-col gap-2 rounded border border-warn/40 bg-warn/10 p-3 text-ink-100"
      >
        <h3 className="text-sm font-semibold uppercase tracking-widest text-warn">
          Scenarios — disabled
        </h3>
        <p className="text-xs text-ink-300">
          Dev-tools gate is closed. Set{" "}
          <code className="font-mono text-warn">DEV_TOOLS_ENABLED=true</code> in
          your backend env (or <code className="font-mono text-warn">TEST_MODE=true</code>{" "}
          for tests), restart the backend, and reload this tab.
        </p>
        <p className="text-[11px] text-ink-400">
          The <code className="font-mono">/api/dev/scenarios</code> endpoint
          returned 404 — see the browser console for the exact response.
        </p>
      </section>
    );
  }
  if (!scenarios || scenarios.length === 0) {
    // Gate open, directory empty. The dev needs to drop a JSON file.
    return (
      <section
        aria-label="Scenarios"
        className="flex flex-col gap-2 rounded border border-info/40 bg-info/10 p-3 text-ink-100"
      >
        <h3 className="text-sm font-semibold uppercase tracking-widest text-info">
          Scenarios — empty
        </h3>
        <p className="text-xs text-ink-300">
          Dev-tools is enabled, but no scenarios were found in{" "}
          <code className="font-mono text-info">
            {scenariosPath ?? "backend/scenarios"}
          </code>
          .
        </p>
        <p className="text-[11px] text-ink-400">
          Drop a <code className="font-mono">*.json</code> file in that
          directory and reload this tab, or run a session through to PLAY and
          use the Record button below to download one.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label="Scenarios"
      className="flex flex-col gap-3 rounded border border-info/40 bg-info/10 p-3 text-ink-100"
    >
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-widest text-info">
          Scenarios
        </h3>
        <span className="text-[11px] text-ink-300">
          {scenarios.length} available
        </span>
      </header>

      <div className="flex flex-col gap-2">
        <label className="text-xs text-ink-200">
          Replay scenario
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={busy !== null}
            className="mt-1 w-full rounded border border-ink-600 bg-ink-850 px-2 py-1 text-xs text-ink-100"
          >
            <option value="">— pick one —</option>
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.roster_size} roles, {s.play_turns} turns)
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!selected || busy !== null}
            onClick={handlePlay}
            className="rounded border border-info bg-info/20 px-3 py-1 text-xs font-semibold text-info hover:bg-info/30 disabled:opacity-50"
          >
            {busy === "play" ? "Replaying…" : "Play scenario (new session)"}
          </button>
          {selected
            ? (() => {
                const s = scenarios.find((x) => x.id === selected);
                return s ? (
                  <span className="text-[11px] text-ink-300">
                    {s.description}
                  </span>
                ) : null;
              })()
            : null}
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t border-ink-700 pt-3">
        <label className="text-xs text-ink-200">
          Record current session
          <input
            type="text"
            value={recordName}
            onChange={(e) => setRecordName(e.target.value)}
            placeholder="ransomware_smoke"
            disabled={!recordable || busy !== null}
            className="mt-1 w-full rounded border border-ink-600 bg-ink-850 px-2 py-1 text-xs text-ink-100"
          />
        </label>
        {!recordable ? (
          <p className="text-[11px] text-ink-300">
            Recording is available once the session has reached the play
            phase or ended.
          </p>
        ) : null}
        <button
          type="button"
          disabled={!recordable || !recordName.trim() || busy !== null}
          onClick={handleRecord}
          className="self-start rounded border border-info bg-info/20 px-3 py-1 text-xs font-semibold text-info hover:bg-info/30 disabled:opacity-50"
        >
          {busy === "record" ? "Recording…" : "Download scenario JSON"}
        </button>
      </div>

      {error ? (
        <p role="alert" className="text-xs text-crit">
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="rounded border border-ink-700 bg-ink-850 p-2 text-[11px]">
          <p className="font-semibold text-ink-100">
            {result.ok ? "Replay finished." : "Replay failed."}
          </p>
          {result.session_id ? (
            <p className="mt-1 text-ink-200">
              New session: <code>{result.session_id}</code>
            </p>
          ) : null}
          {result.error ? (
            <p className="mt-1 text-crit">{result.error}</p>
          ) : null}
          {Object.keys(result.role_tokens).length > 0 ? (
            <details className="mt-1">
              <summary className="cursor-pointer text-ink-300">
                Per-role join URLs
              </summary>
              <ul className="mt-1 space-y-0.5">
                {Object.entries(result.role_tokens).map(([roleId, token]) => {
                  const label =
                    Object.entries(result.role_label_to_id).find(
                      ([, id]) => id === roleId,
                    )?.[0] ?? roleId.slice(0, 8);
                  return (
                    <li key={roleId}>
                      <a
                        href={`/play/${token}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-info underline"
                      >
                        {label}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
