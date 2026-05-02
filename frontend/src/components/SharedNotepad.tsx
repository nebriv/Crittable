/**
 * SharedNotepad — collaborative markdown notepad (issue #98).
 *
 * - TipTap editor + Yjs collaboration plugin.
 * - A custom Yjs provider (no y-websocket dep): binary updates ride the
 *   existing /ws/sessions/{id} channel as base64 in JSON envelopes.
 * - Markdown extraction happens client-side (see ../lib/notepad.ts) and
 *   the latest snapshot is POSTed to the server, debounced ~1s and on
 *   editor blur. The server's pycrdt Doc is an opaque relay; the AAR
 *   reads ``session.notepad.markdown_snapshot`` (path C of the plan).
 * - Header chip explicitly de-jargons the AI-visibility rule per the
 *   first-time-user persona-review must-fix.
 */
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import StarterKit from "@tiptap/starter-kit";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor, Extension } from "@tiptap/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";

import { RailHeader } from "./brand/RailHeader";
import { StatusChip } from "./brand/StatusChip";
import {
  applyTemplate,
  exportMarkdownUrl,
  editorToMarkdown,
  listTemplates,
  pushSnapshot,
  templateMarkdownToHtml,
} from "../lib/notepad";
import type { NotepadTemplate } from "../lib/notepad";
import type { ServerEvent, WsClient } from "../lib/ws";

interface Props {
  sessionId: string;
  token: string;
  /**
   * The shared ``WsClient`` instance. We subscribe to it internally
   * (via ``ws.subscribe`` in the provider effect) — accepting a
   * separate ``subscribe`` prop tempted callers to pass a fresh
   * arrow function on every render, which would tear down + restart
   * the Yjs/awareness provider on every parent re-render. Per
   * Copilot review on PR #115.
   */
  ws: WsClient;
  isCreator: boolean;
  initiallyExpanded?: boolean;
  /** Session start time (ISO) — used to render T+MM:SS timestamps. */
  sessionStartedAt: string;
  /** Caller's role id — used for ``CollaborationCaret`` user identity. */
  selfRoleId: string;
  /** Display name shown above the remote caret. Falls back to the role label. */
  selfDisplayName: string;
}

/** Stable hashed colour for a role id, drawn from the brand palette so
 * role names + carets render in consistent colours across tabs. */
function roleColor(roleId: string): string {
  // 5 deliberate ink-tinted accents — brand-safe; no neon. Hash the
  // role id so the same role always renders the same colour.
  const palette = [
    "#7CC4FF", // signal
    "#E59B00", // warn
    "#9DD49B", // info
    "#D38BFF", // accent
    "#F08A8A", // crit (muted)
  ];
  let h = 0;
  for (let i = 0; i < roleId.length; i++) {
    h = (h * 31 + roleId.charCodeAt(i)) >>> 0;
  }
  return palette[h % palette.length];
}

/**
 * Minimal Yjs <-> WsClient bridge. Replaces the standard y-websocket
 * provider so we don't need a separate Yjs server.
 *
 * On open: send notepad_sync_request. The server replies with the
 * current encoded state.
 *
 * On local Yjs update: send notepad_update with the binary payload
 * base64-encoded.
 *
 * On incoming notepad_update: apply to local doc. Yjs is idempotent,
 * so the sender's own update is a no-op when echoed back.
 */
class WsYjsProvider {
  private unsub: (() => void) | null = null;
  private yObserver: ((u: Uint8Array, origin: unknown) => void) | null = null;
  private awarenessObserver:
    | ((args: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void)
    | null = null;
  private isOriginRemote = Symbol("notepad-remote");

  constructor(
    public readonly doc: Y.Doc,
    public readonly awareness: Awareness,
    private readonly ws: WsClient,
    public readonly onLocked: () => void,
    public readonly onLockPending: (secs: number) => void,
    public readonly onError: (msg: string) => void,
  ) {}

  start(): void {
    this.yObserver = (update: Uint8Array, origin: unknown) => {
      if (origin === this.isOriginRemote) return;
      try {
        this.ws.send({ type: "notepad_update", update: bytesToBase64(update) });
      } catch (err) {
        console.warn("[notepad] update send failed", err);
      }
    };
    this.doc.on("update", this.yObserver);

    this.awarenessObserver = (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      if (origin === this.isOriginRemote) return;
      const changed = added.concat(updated, removed);
      if (changed.length === 0) return;
      try {
        const update = encodeAwarenessUpdate(this.awareness, changed);
        this.ws.send({
          type: "notepad_awareness",
          awareness: bytesToBase64(update),
        });
      } catch (err) {
        console.warn("[notepad] awareness send failed", err);
      }
    };
    this.awareness.on("update", this.awarenessObserver);

    this.unsub = this.ws.subscribe((evt) => this.handle(evt));

    // Send initial sync request. The WS may not be open yet — guard.
    try {
      this.ws.send({ type: "notepad_sync_request" });
    } catch {
      // Will retry on the next open via the page-level reconnect logic.
    }
  }

  stop(): void {
    if (this.yObserver) {
      this.doc.off("update", this.yObserver);
      this.yObserver = null;
    }
    if (this.awarenessObserver) {
      this.awareness.off("update", this.awarenessObserver);
      this.awarenessObserver = null;
    }
    // Drop our awareness state cleanly so other clients see us go offline.
    this.awareness.setLocalState(null);
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
  }

  private handle(evt: ServerEvent): void {
    switch (evt.type) {
      case "notepad_sync_response": {
        try {
          const bytes = base64ToBytes(evt.state);
          if (bytes.length > 0) {
            Y.applyUpdate(this.doc, bytes, this.isOriginRemote);
          }
        } catch (err) {
          console.warn("[notepad] sync apply failed", err);
        }
        if (evt.locked) this.onLocked();
        break;
      }
      case "notepad_update": {
        try {
          Y.applyUpdate(
            this.doc,
            base64ToBytes(evt.update),
            this.isOriginRemote,
          );
        } catch (err) {
          console.warn("[notepad] remote update apply failed", err);
        }
        break;
      }
      case "notepad_awareness": {
        try {
          applyAwarenessUpdate(
            this.awareness,
            base64ToBytes(evt.awareness),
            this.isOriginRemote,
          );
        } catch (err) {
          console.warn("[notepad] awareness apply failed", err);
        }
        break;
      }
      case "notepad_lock_pending":
        this.onLockPending(evt.locks_in_seconds);
        break;
      case "notepad_locked":
        this.onLocked();
        break;
      case "error":
        if (evt.scope === "notepad") this.onError(evt.message);
        break;
      default:
        break;
    }
  }
}

function bytesToBase64(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i += 0x8000) {
    out += String.fromCharCode(...b.subarray(i, i + 0x8000));
  }
  return btoa(out);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function timestampHotkeyExtension(sessionStartedAt: string): Extension {
  // Drops `T+MM:SS — ` at the cursor. Computes against
  // session.created_at, which is plenty close to "session start" for
  // tabletop purposes (we don't need to align with the AI's first turn).
  //
  // We use ``Mod-Shift-T`` rather than ``Mod-T`` because Cmd/Ctrl+T is
  // owned by the browser ("open new tab") and the page cannot
  // intercept it — picked up in the UI/UX review.
  return {
    name: "notepad-timestamp-hotkey",
    addKeyboardShortcuts() {
      return {
        "Mod-Shift-t": () => {
          const start = new Date(sessionStartedAt).getTime();
          const elapsedMs = Date.now() - start;
          const minutes = Math.max(0, Math.floor(elapsedMs / 60000));
          const seconds = Math.max(0, Math.floor((elapsedMs % 60000) / 1000));
          const stamp = `T+${String(minutes).padStart(2, "0")}:${String(
            seconds,
          ).padStart(2, "0")} — `;
          // @ts-expect-error: editor is bound by TipTap at runtime
          this.editor?.chain().focus().insertContent(stamp).run();
          return true;
        },
      };
    },
  } as unknown as Extension;
}

const COACHMARK_KEY = "crittable.notepad.coachmark_seen";

export function SharedNotepad({
  sessionId,
  token,
  ws,
  isCreator,
  initiallyExpanded,
  sessionStartedAt,
  selfRoleId,
  selfDisplayName,
}: Props) {
  const ydoc = useMemo(() => new Y.Doc(), []);
  const xmlFragment = useMemo(() => ydoc.getXmlFragment("body"), [ydoc]);
  const awareness = useMemo(() => new Awareness(ydoc), [ydoc]);
  const myColor = useMemo(() => roleColor(selfRoleId), [selfRoleId]);

  const [expanded, setExpanded] = useState(() => {
    if (initiallyExpanded !== undefined) return initiallyExpanded;
    try {
      return !window.localStorage.getItem(COACHMARK_KEY);
    } catch {
      return false;
    }
  });
  const [locked, setLocked] = useState(false);
  const [lockPendingSecs, setLockPendingSecs] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [templates, setTemplates] = useState<NotepadTemplate[] | null>(null);
  const [isEmpty, setIsEmpty] = useState(true);
  const lastSnapshotRef = useRef<string>("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          undoRedo: false, // collaboration owns undo/redo (Yjs UndoManager)
        }),
        // Task list / item — needed so ``- [ ]`` markdown round-trips
        // through the editor without losing the checkbox semantics
        // (the AAR's verbatim-action-items extractor depends on the
        // ``- [ ] ...`` lines surviving the editor's internal model).
        TaskList,
        TaskItem.configure({ nested: true }),
        Collaboration.configure({ fragment: xmlFragment }),
        // Live cursor presence (issue #98 follow-up): renders other
        // editors' carets with their role colour + display name. The
        // y-protocols Awareness object is bridged to the existing WS
        // channel via WsYjsProvider — no separate y-websocket server.
        CollaborationCaret.configure({
          provider: { awareness },
          user: { name: selfDisplayName, color: myColor },
        }),
        timestampHotkeyExtension(sessionStartedAt),
      ],
      editable: !locked,
      editorProps: {
        attributes: {
          class:
            "prose prose-invert max-w-none focus:outline-none text-sm leading-6 min-h-[16rem]",
          "data-notepad-editor": "true",
        },
      },
    },
    [xmlFragment],
  );

  // Wire the WS provider once the editor is mounted. Subscription
  // happens inside the provider via ``ws.subscribe`` so callers
  // don't have to pass a stable subscribe function.
  useEffect(() => {
    if (!editor) return;
    const provider = new WsYjsProvider(
      ydoc,
      awareness,
      ws,
      () => setLocked(true),
      (secs) => setLockPendingSecs(secs),
      (msg) => setErrorMsg(msg),
    );
    provider.start();
    return () => provider.stop();
  }, [editor, ydoc, awareness, ws]);

  // Reflect the lock flag onto the editor's editable state.
  useEffect(() => {
    if (editor) editor.setEditable(!locked);
  }, [editor, locked]);

  // Track empty-state. We watch ydoc updates rather than editor state
  // so the picker disappears as soon as ANY content arrives — even
  // content authored remotely.
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const md = editorToMarkdown(editor);
      setIsEmpty(md.trim().length === 0);
    };
    update();
    editor.on("update", update);
    editor.on("transaction", update);
    return () => {
      editor.off("update", update);
      editor.off("transaction", update);
    };
  }, [editor]);

  // Debounced snapshot push: 1s after the last local edit.
  useEffect(() => {
    if (!editor) return;
    const onUpdate = ({ transaction }: { transaction: { getMeta: (key: string) => unknown } }) => {
      // Don't push for transactions that originated from a remote update.
      // Yjs's collab plugin marks remote transactions with a meta key.
      if (transaction.getMeta("y-sync$")) return;
      if (locked) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const md = editorToMarkdown(editor);
        if (md === lastSnapshotRef.current) return;
        lastSnapshotRef.current = md;
        pushSnapshot(sessionId, token, md).catch((err) =>
          console.warn("[notepad] snapshot push failed", err),
        );
      }, 1000);
    };
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [editor, sessionId, token, locked]);

  // Force a snapshot push on blur (catches the trailing edit).
  useEffect(() => {
    if (!editor) return;
    const onBlur = () => {
      if (locked) return;
      const md = editorToMarkdown(editor);
      if (md === lastSnapshotRef.current) return;
      lastSnapshotRef.current = md;
      pushSnapshot(sessionId, token, md).catch((err) =>
        console.warn("[notepad] snapshot blur push failed", err),
      );
    };
    editor.on("blur", onBlur);
    return () => {
      editor.off("blur", onBlur);
    };
  }, [editor, sessionId, token, locked]);

  // Lazy-load template catalog when the empty-state picker is visible.
  useEffect(() => {
    if (!isEmpty || !isCreator || templates !== null) return;
    listTemplates(sessionId, token)
      .then(setTemplates)
      .catch((err) => console.warn("[notepad] template list failed", err));
  }, [isEmpty, isCreator, templates, sessionId, token]);

  function applyTemplateLocally(
    editor: Editor,
    template: NotepadTemplate,
  ): void {
    // ``insertContent(string)`` parses the input as HTML, NOT markdown
    // (Copilot review on PR #115). Convert the template's markdown
    // to a small HTML subset first so headings / lists / task items
    // render as structured nodes instead of literal "# Heading" text.
    const html = templateMarkdownToHtml(template.content);
    editor
      .chain()
      .focus()
      .clearContent()
      .insertContent(html, { parseOptions: { preserveWhitespace: false } })
      .run();
  }

  function handleApplyTemplate(t: NotepadTemplate): void {
    if (!editor) return;
    // Confirm before clobbering. The empty-state picker only shows
    // when ``isEmpty`` is true, but a remote teammate may have started
    // typing in the gap between render and click. The confirm step
    // (per User Agent review) prevents silent loss of their work.
    const currentMd = editorToMarkdown(editor).trim();
    if (currentMd.length > 0) {
      const ok = window.confirm(
        `The notepad already has content. Replace it with the "${t.label}" template?`,
      );
      if (!ok) return;
    }
    applyTemplateLocally(editor, t);
    applyTemplate(sessionId, token, t.id).catch((err) =>
      console.warn("[notepad] template POST failed", err),
    );
    try {
      window.localStorage.setItem(COACHMARK_KEY, "1");
    } catch {
      /* localStorage unavailable; fine */
    }
  }

  function handleStartBlank(): void {
    try {
      window.localStorage.setItem(COACHMARK_KEY, "1");
    } catch {
      /* fine */
    }
    editor?.chain().focus().run();
  }

  if (!expanded) {
    return (
      <section
        aria-label="Team notepad (collapsed)"
        className="rounded-r-3 border border-ink-600 bg-ink-850"
      >
        <button
          type="button"
          className="flex w-full items-center justify-between px-3 py-2 text-left"
          onClick={() => setExpanded(true)}
          title="Shared notes — team timeline, action items, decisions."
        >
          <RailHeader title="TEAM NOTEPAD" inline />
          <span className="mono text-[10px] uppercase tracking-[0.18em] text-ink-400">
            EXPAND
          </span>
        </button>
      </section>
    );
  }

  return (
    <section
      aria-label="Team notepad"
      className="flex min-h-0 flex-col gap-2 rounded-r-3 border border-ink-600 bg-ink-850 p-3 text-sm"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <RailHeader title="TEAM NOTEPAD" inline />
        <div className="flex items-center gap-2">
          <StatusChip
            tone="warn"
            label="SHARED"
            value={locked ? "LOCKED · export available" : "HIDDEN FROM AI"}
            title={
              locked
                ? "Notepad is read-only; the export link still works."
                : "Hidden from the AI during play; the AI reads it only at the end of the session, when generating the final report. Plan and debrief freely."
            }
          />
          {/* Right-rail is 280px; the bare EXPORT + COLLAPSE labels
              clipped off the edge alongside the chip. Collapsed into
              a small ⋯ menu so the header always fits the rail. */}
          <details className="relative">
            <summary
              aria-label="Notepad actions"
              className="mono cursor-pointer list-none rounded-r-1 border border-ink-600 bg-ink-850 px-2 py-0.5 text-[12px] leading-none text-ink-200 hover:border-signal-deep marker:hidden [&::-webkit-details-marker]:hidden"
            >
              ⋯
            </summary>
            <div className="absolute right-0 z-10 mt-1 flex flex-col gap-0 rounded-r-1 border border-ink-500 bg-ink-900 p-1 shadow-md">
              <a
                href={exportMarkdownUrl(sessionId, token)}
                target="_blank"
                rel="noreferrer"
                className="mono whitespace-nowrap rounded-r-1 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-ink-200 hover:bg-ink-800 hover:text-ink-100"
              >
                Export .md
              </a>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="mono whitespace-nowrap rounded-r-1 px-2 py-1 text-left text-[10px] uppercase tracking-[0.18em] text-ink-200 hover:bg-ink-800 hover:text-ink-100"
              >
                Collapse
              </button>
            </div>
          </details>
        </div>
      </header>

      {lockPendingSecs !== null && !locked ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-r-1 border border-warn bg-warn-bg px-2 py-1 text-[12px] text-warn"
        >
          Session ending — notepad locks in {lockPendingSecs}s. Notes will
          export regardless.
        </div>
      ) : null}

      {locked ? (
        <div className="rounded-r-1 border border-ink-500 bg-ink-900 px-2 py-1 text-[12px] text-ink-200">
          NOTEPAD LOCKED — session ended. Export still available via the
          link above.
        </div>
      ) : null}

      {errorMsg ? (
        <div
          className="rounded-r-1 border border-warn bg-warn-bg px-2 py-1 text-[12px] text-warn"
          role="alert"
        >
          {errorMsg.toLowerCase().includes("too large")
            ? "That edit was too large to sync — break it into smaller paste chunks."
            : errorMsg}
        </div>
      ) : null}

      {/* Coachmark: visible to ALL roles, even non-creators. Empty
          notepad on first visit needs the highlight-to-pin tip; non-
          creators don't get the picker, but they do get this hint. */}
      {isEmpty ? (
        <div className="text-[11px] text-ink-400">
          Tip: highlight any chat message to pin it here.
          <span className="mono ml-2 text-ink-500">
            (Ctrl/⌘+Shift+T inserts a T+MM:SS timestamp.)
          </span>
        </div>
      ) : null}

      {isEmpty && isCreator ? (
        <div className="space-y-2 rounded-r-1 border border-ink-600 bg-ink-900 p-2">
          <div className="mono text-[10px] uppercase tracking-[0.18em] text-ink-300">
            START WITH A TEMPLATE
          </div>
          {templates?.length ? (
            <div className="grid gap-2">
              {templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => handleApplyTemplate(t)}
                  className="rounded-r-1 border border-ink-600 bg-ink-850 p-2 text-left hover:border-signal-deep"
                >
                  <div className="mono text-[11px] font-bold uppercase tracking-[0.12em] text-ink-100">
                    {t.label}
                  </div>
                  <div className="mt-1 text-[12px] text-ink-300">
                    {t.description}
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-ink-400">Loading templates…</div>
          )}
          <button
            type="button"
            onClick={handleStartBlank}
            className="mono w-full text-left text-[10px] uppercase tracking-[0.18em] text-ink-400 hover:text-ink-200"
          >
            OR START TYPING
          </button>
        </div>
      ) : null}

      <div
        className="min-h-[12rem] max-h-[60vh] overflow-y-auto rounded-r-1 border border-ink-600 bg-ink-900 p-2"
        onClick={() => editor?.chain().focus().run()}
      >
        <EditorContent editor={editor} />
      </div>
    </section>
  );
}

export default SharedNotepad;
