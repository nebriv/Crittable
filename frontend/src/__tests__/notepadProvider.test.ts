/**
 * Unit tests for ``WsYjsProvider``'s lock-suppression logic
 * (issue #160 — "Notepad locked shows twice").
 *
 * The provider mirrors the server's lock state so that, once the
 * server has told us the notepad is locked:
 *   1. Outbound Yjs / awareness updates are dropped at the source.
 *   2. Any subsequent ``scope:"notepad"`` error frame is silenced
 *      (the parent UI's chip already conveys the lock; the user
 *      cannot act on the error).
 *
 * These tests drive a fake ``WsClient`` through both lock-arrival
 * orderings and assert the expected callbacks fire / don't fire.
 */
import { describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { WsYjsProvider } from "../lib/notepadProvider";
import type { ClientEvent, ServerEvent, WsClient } from "../lib/ws";

interface FakeWsClient {
  client: WsClient;
  emit: (evt: ServerEvent) => void;
  sent: ClientEvent[];
}

function makeFakeWs(opts: { sendThrows?: boolean } = {}): FakeWsClient {
  const sent: ClientEvent[] = [];
  let listener: ((evt: ServerEvent) => void) | null = null;
  const fake = {
    send(event: ClientEvent): void {
      if (opts.sendThrows) throw new Error("websocket not open");
      sent.push(event);
    },
    subscribe(handler: (evt: ServerEvent) => void): () => void {
      listener = handler;
      return () => {
        listener = null;
      };
    },
  };
  return {
    client: fake as unknown as WsClient,
    emit: (evt: ServerEvent) => listener?.(evt),
    sent,
  };
}

function makeProvider(fake: FakeWsClient): {
  provider: WsYjsProvider;
  doc: Y.Doc;
  awareness: Awareness;
  onLocked: ReturnType<typeof vi.fn>;
  onLockPending: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
} {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const onLocked = vi.fn();
  const onLockPending = vi.fn();
  const onError = vi.fn();
  const provider = new WsYjsProvider(
    doc,
    awareness,
    fake.client,
    onLocked,
    onLockPending,
    onError,
  );
  return { provider, doc, awareness, onLocked, onLockPending, onError };
}

describe("WsYjsProvider — lock-state handling (issue #160)", () => {
  it("starts unlocked", () => {
    const fake = makeFakeWs();
    const { provider } = makeProvider(fake);
    provider.start();
    expect(provider.isLocked).toBe(false);
    provider.stop();
  });

  it("flips locked=true on a notepad_locked event", () => {
    const fake = makeFakeWs();
    const { provider, onLocked } = makeProvider(fake);
    provider.start();

    fake.emit({ type: "notepad_locked", locked_at: null });

    expect(provider.isLocked).toBe(true);
    expect(onLocked).toHaveBeenCalledTimes(1);
    provider.stop();
  });

  it("flips locked=true on notepad_sync_response with locked=true", () => {
    const fake = makeFakeWs();
    const { provider, onLocked } = makeProvider(fake);
    provider.start();

    fake.emit({
      type: "notepad_sync_response",
      state: "",
      locked: true,
      template_id: null,
    });

    expect(provider.isLocked).toBe(true);
    expect(onLocked).toHaveBeenCalledTimes(1);
    provider.stop();
  });

  it("does NOT lock on notepad_sync_response with locked=false", () => {
    const fake = makeFakeWs();
    const { provider, onLocked } = makeProvider(fake);
    provider.start();

    fake.emit({
      type: "notepad_sync_response",
      state: "",
      locked: false,
      template_id: null,
    });

    expect(provider.isLocked).toBe(false);
    expect(onLocked).not.toHaveBeenCalled();
    provider.stop();
  });

  it("LOCK-THEN-ERROR race: suppresses subsequent notepad-scope error frames", () => {
    const fake = makeFakeWs();
    const { provider, onError } = makeProvider(fake);
    provider.start();

    fake.emit({ type: "notepad_locked", locked_at: null });
    fake.emit({
      type: "error",
      scope: "notepad",
      message: "notepad is locked",
    });

    expect(onError).not.toHaveBeenCalled();
    provider.stop();
  });

  it("LOCK-THEN-ERROR race: suppresses ANY notepad-scope error post-lock (not just locked-string)", () => {
    // Per QA review M1: keying on the exact server message string
    // ("notepad is locked") was brittle. The widened policy is to
    // suppress any notepad-scope error once we know we're locked,
    // since none of them are user-actionable at that point.
    const fake = makeFakeWs();
    const { provider, onError } = makeProvider(fake);
    provider.start();

    fake.emit({ type: "notepad_locked", locked_at: null });
    fake.emit({ type: "error", scope: "notepad", message: "rate limited" });
    fake.emit({ type: "error", scope: "notepad", message: "update too large" });

    expect(onError).not.toHaveBeenCalled();
    provider.stop();
  });

  it("ERROR-BEFORE-LOCK: surfaces the error normally (parent clears it on its own onLocked)", () => {
    const fake = makeFakeWs();
    const { provider, onError } = makeProvider(fake);
    provider.start();

    fake.emit({
      type: "error",
      scope: "notepad",
      message: "notepad is locked",
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("notepad is locked");
    provider.stop();
  });

  it("preserves non-notepad-scope error pass-through (locked or not)", () => {
    const fake = makeFakeWs();
    const { provider, onError } = makeProvider(fake);
    provider.start();

    fake.emit({ type: "notepad_locked", locked_at: null });
    fake.emit({
      type: "error",
      scope: "submission",
      message: "boom",
    });

    // The provider only inspects scope:"notepad" errors. Other scopes
    // are intentionally ignored (the parent page handles them).
    expect(onError).not.toHaveBeenCalled();
    provider.stop();
  });

  it("stops sending notepad_update once locked", () => {
    const fake = makeFakeWs();
    const { provider, doc } = makeProvider(fake);
    provider.start();

    // Drain the initial sync_request the provider sends on start.
    fake.sent.length = 0;

    // Pre-lock: a local Yjs change produces a notepad_update.
    doc.getMap("pre").set("k", "v");
    expect(fake.sent.some((e) => e.type === "notepad_update")).toBe(true);

    fake.sent.length = 0;
    fake.emit({ type: "notepad_locked", locked_at: null });

    // Post-lock: a local Yjs change produces NOTHING.
    doc.getMap("post").set("k", "v");
    expect(fake.sent).toHaveLength(0);
    provider.stop();
  });

  it("stops sending notepad_awareness once locked", () => {
    const fake = makeFakeWs();
    const { provider, awareness } = makeProvider(fake);
    provider.start();

    fake.sent.length = 0;

    // Pre-lock: an awareness change produces a notepad_awareness.
    awareness.setLocalState({ cursor: 1 });
    expect(fake.sent.some((e) => e.type === "notepad_awareness")).toBe(true);

    fake.sent.length = 0;
    fake.emit({ type: "notepad_locked", locked_at: null });

    // Post-lock: an awareness change produces NOTHING.
    awareness.setLocalState({ cursor: 2 });
    expect(fake.sent).toHaveLength(0);
    provider.stop();
  });

  it("forwards notepad_lock_pending to the parent unchanged", () => {
    const fake = makeFakeWs();
    const { provider, onLockPending } = makeProvider(fake);
    provider.start();

    fake.emit({ type: "notepad_lock_pending", locks_in_seconds: 5 });

    expect(onLockPending).toHaveBeenCalledWith(5);
    expect(provider.isLocked).toBe(false);
    provider.stop();
  });
});
