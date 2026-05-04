import { useState } from "react";

import { api } from "../api/client";

interface Props {
  sessionId: string;
  creatorToken: string;
}

/**
 * Creator-only "operator-facing markdown exports" panel.
 *
 * Two surfaces, both AAR-independent (the AAR pipeline stays
 * workstream-blind per chat-decluttering plan §6.9):
 *
 *   - **Timeline** — curated chronological summary: track lifecycle
 *     + critical injects + pinned artifacts. The "what just happened"
 *     debrief.
 *   - **Full record** — every visible message with track + role + ts
 *     + flags. The raw transcript dump.
 *
 * Both endpoints stream markdown; the client just hands the response
 * to the browser via Blob + a.click() so the file lands in the
 * downloads folder with a stable filename. Using a fetch pipeline
 * (rather than just opening the URL) lets us handle the 401/403
 * branches as a toast instead of a full-tab navigation.
 */
export function ExportsPanel({ sessionId, creatorToken }: Props) {
  const [busy, setBusy] = useState<"timeline" | "full" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function download(
    kind: "timeline" | "full",
    fallbackFilename: string,
  ): Promise<void> {
    setBusy(kind);
    setError(null);
    try {
      const url =
        kind === "timeline"
          ? api.exportTimelineUrl(sessionId, creatorToken)
          : api.exportFullRecordUrl(sessionId, creatorToken);
      console.debug(`[exports] GET ${kind}`);
      const res = await fetch(url);
      if (!res.ok) {
        const text = await safeReadText(res);
        throw new Error(text || `${kind} export failed (${res.status})`);
      }
      // Read filename from Content-Disposition where the server
      // already chose a slugged name; fall back to a sensible default.
      const filename =
        extractFilename(res.headers.get("content-disposition")) ??
        fallbackFilename;
      const blob = await res.blob();
      const obj = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = obj;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      // Defer revocation so Safari's download trigger has time to
      // capture the URL.
      setTimeout(() => {
        URL.revokeObjectURL(obj);
        a.remove();
      }, 0);
      console.info(`[exports] downloaded ${kind} as ${filename}`);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      console.warn(`[exports] ${kind} failed`, text);
      setError(text);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      aria-labelledby="exports-heading"
      className="flex flex-col gap-2 rounded border border-ink-600 bg-ink-850 p-3 text-sm"
    >
      <header className="flex items-baseline justify-between gap-2">
        <h3
          id="exports-heading"
          className="text-xs uppercase tracking-widest text-ink-300"
        >
          Operator exports
        </h3>
        <span className="rounded bg-info/40 px-1.5 py-0.5 text-[10px] text-info">
          creator only
        </span>
      </header>
      <p className="text-[11px] leading-snug text-ink-400">
        Markdown drops for the live exercise. Independent of the AAR.
      </p>
      <button
        type="button"
        onClick={() => download("timeline", "tabletop-timeline.md")}
        disabled={busy !== null}
        aria-disabled={busy !== null}
        className="rounded border border-ink-500 bg-ink-800 px-2 py-1 text-left text-xs text-ink-100 hover:border-signal-deep hover:text-ink-050 disabled:cursor-not-allowed disabled:opacity-50"
        title="Track lifecycle + critical injects + pinned artifacts."
      >
        {busy === "timeline" ? "Downloading…" : "Export timeline (md)"}
      </button>
      <button
        type="button"
        onClick={() => download("full", "tabletop-full-record.md")}
        disabled={busy !== null}
        aria-disabled={busy !== null}
        className="rounded border border-ink-500 bg-ink-800 px-2 py-1 text-left text-xs text-ink-100 hover:border-signal-deep hover:text-ink-050 disabled:cursor-not-allowed disabled:opacity-50"
        title="Every visible message with track / role / ts / flags per row."
      >
        {busy === "full" ? "Downloading…" : "Export full record (md)"}
      </button>
      {error ? (
        <p role="alert" className="text-[11px] text-crit">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function extractFilename(disposition: string | null): string | null {
  if (!disposition) return null;
  // ``attachment; filename="foo.md"`` — keep this parser narrow; the
  // server only ever emits the simple ASCII variant.
  const m = /filename="([^"]+)"/.exec(disposition);
  return m?.[1] ?? null;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}
