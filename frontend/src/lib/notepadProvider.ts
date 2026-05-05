/**
 * WsYjsProvider — minimal Yjs <-> WsClient bridge for the shared
 * notepad. Replaces the standard y-websocket provider so the app
 * doesn't need a separate Yjs server.
 *
 * Lifecycle:
 *   - On ``start()``: subscribes to local Yjs / awareness updates
 *     and to the WS event stream. Sends an initial
 *     ``notepad_sync_request``.
 *   - On local Yjs / awareness update: forwards the binary payload
 *     base64-encoded (``notepad_update`` / ``notepad_awareness``).
 *   - On incoming ``notepad_update`` / ``notepad_awareness``: applies
 *     to the local doc / awareness state. Yjs is idempotent, so the
 *     sender's own update is a no-op when echoed back.
 *   - On ``notepad_locked`` (or ``notepad_sync_response.locked``):
 *     marks the provider terminally locked; future outbound updates
 *     are dropped at the source AND any future ``scope:"notepad"``
 *     error frame is suppressed (the parent UI's chip already shows
 *     the lock state, and the user can't act on the error).
 *
 * Extracted from SharedNotepad.tsx so the lock-suppression logic is
 * unit-testable without booting React/TipTap (issue #160; QA review H2).
 */
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";

import type { ServerEvent, WsClient } from "./ws";

export class WsYjsProvider {
  private unsub: (() => void) | null = null;
  private yObserver: ((u: Uint8Array, origin: unknown) => void) | null = null;
  private awarenessObserver:
    | ((args: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void)
    | null = null;
  private isOriginRemote = Symbol("notepad-remote");
  // Mirrors the React ``locked`` state on the provider so the WS-side
  // hot path doesn't have to re-query the parent. Two reasons:
  //   1. Suppress the round-trip noise — once the server has told us the
  //      notepad is locked, any in-flight Yjs / awareness updates we
  //      still try to send come back as ``error: notepad is locked``,
  //      which used to surface as a redundant orange banner under the
  //      already-visible "LOCKED · session ended" chip (issue #160).
  //   2. Silence those server errors at the source: when we know we're
  //      locked, we drop ANY ``scope:"notepad"`` error toast because
  //      the chip already conveys the lock state and the user cannot
  //      act on the error. (Started as an exact-string match on
  //      ``"notepad is locked"`` — see backend/app/ws/routes.py:345 —
  //      but per QA review M1 we widened it: keying on the
  //      server-message string is brittle, and once locked there's
  //      nothing actionable for any notepad-scope error.)
  // Lock is terminal — we never reset to false. A reconnect rebuilds
  // the provider from scratch via the parent useEffect, so a fresh
  // session starts unlocked.
  private locked = false;

  constructor(
    public readonly doc: Y.Doc,
    public readonly awareness: Awareness,
    private readonly ws: WsClient,
    public readonly onLocked: () => void,
    public readonly onLockPending: (secs: number) => void,
    public readonly onError: (msg: string) => void,
  ) {}

  /** Read-only view of the lock flag (test hook + future debuggability). */
  get isLocked(): boolean {
    return this.locked;
  }

  start(): void {
    this.yObserver = (update: Uint8Array, origin: unknown) => {
      if (origin === this.isOriginRemote) return;
      // Server REJECTS local notepad_update once locked (raises
      // NotepadLockedError → ``error: notepad is locked``) so this
      // short-circuit eliminates the round-trip + the would-be toast.
      if (this.locked) return;
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
      // Server-side awareness handler does NOT raise on lock (it just
      // broadcasts) — so this short-circuit is purely defensive: once
      // the session has ended, awareness cursor positions stop being
      // useful, and dropping them keeps the WS quiet. Don't "fix" this
      // by adding server-side rejection; that would re-introduce a
      // race where late awareness frames produce a toast.
      // (QA review H1 for issue #160.)
      if (this.locked) return;
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
        if (evt.locked) {
          this.locked = true;
          console.info("[notepad] locked", { source: "sync_response" });
          this.onLocked();
        }
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
        this.locked = true;
        console.info("[notepad] locked", { source: "lock_event" });
        this.onLocked();
        break;
      case "error":
        if (evt.scope === "notepad") {
          // Drop ANY notepad-scope error once we know we're locked —
          // the parent already renders the lock chip and the user
          // cannot act on the error. Keying on the literal message
          // string (e.g. ``"notepad is locked"``) is brittle: the
          // backend literal at app/ws/routes.py could be rephrased,
          // and other late-arriving notepad errors (rate limit,
          // oversized) post-lock would surface as confusing toasts
          // under a clearly-locked chip. (Issue #160; QA review M1.)
          if (this.locked) {
            console.debug(
              "[notepad] suppressed post-lock error toast",
              { message: evt.message },
            );
            break;
          }
          this.onError(evt.message);
        }
        break;
      default:
        break;
    }
  }
}

export function bytesToBase64(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i += 0x8000) {
    out += String.fromCharCode(...b.subarray(i, i + 0x8000));
  }
  return btoa(out);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
