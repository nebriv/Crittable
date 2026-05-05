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

  it("ignores non-notepad-scope error frames entirely (those belong to the parent page)", () => {
    const fake = makeFakeWs();
    const { provider, onError } = makeProvider(fake);
    provider.start();

    fake.emit({ type: "notepad_locked", locked_at: null });
    fake.emit({
      type: "error",
      scope: "submission",
      message: "boom",
    });

    // The provider's ``onError`` is for notepad-scope errors only.
    // Other scopes are not its concern — the page-level WS handler
    // surfaces those. (Copilot review on PR #171, LOW.)
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

  // ---- Idempotent lock transition (Copilot review on PR #171, HIGH) ----

  it("fires onLocked exactly ONCE across multiple lock signals (replay buffer + live event)", () => {
    const fake = makeFakeWs();
    const { provider, onLocked } = makeProvider(fake);
    provider.start();

    // Replay buffer (sync-response with locked=true) followed by the
    // live notepad_locked event — both common in reconnect scenarios.
    fake.emit({
      type: "notepad_sync_response",
      state: "",
      locked: true,
      template_id: null,
    });
    fake.emit({ type: "notepad_locked", locked_at: null });
    fake.emit({ type: "notepad_locked", locked_at: null });

    expect(onLocked).toHaveBeenCalledTimes(1);
    expect(provider.isLocked).toBe(true);
    provider.stop();
  });

  it("fires onLocked exactly ONCE for repeated notepad_locked events", () => {
    const fake = makeFakeWs();
    const { provider, onLocked } = makeProvider(fake);
    provider.start();

    fake.emit({ type: "notepad_locked", locked_at: null });
    fake.emit({ type: "notepad_locked", locked_at: null });
    fake.emit({ type: "notepad_locked", locked_at: null });

    expect(onLocked).toHaveBeenCalledTimes(1);
    provider.stop();
  });

  // ---- Initial sync-request retry (Copilot review on PR #171, BLOCK) ----

  it("retries the initial sync_request when the WS is not yet open, until it succeeds", async () => {
    vi.useFakeTimers();
    try {
      // Start with send() throwing (WS not open yet), then flip the
      // fake's send to succeed after the first scheduled retry. We
      // assert that the request is re-sent once the WS opens.
      let openYet = false;
      const sent: ClientEvent[] = [];
      const fake = {
        send(event: ClientEvent): void {
          if (!openYet) throw new Error("websocket not open");
          sent.push(event);
        },
        subscribe(): () => void {
          return () => {};
        },
      };
      const provider = new WsYjsProvider(
        new Y.Doc(),
        new Awareness(new Y.Doc()),
        fake as unknown as WsClient,
        () => {},
        () => {},
        () => {},
      );
      provider.start();

      // First attempt during start() failed silently; nothing sent yet.
      expect(sent).toHaveLength(0);

      // WS opens — advance past the first 100ms backoff.
      openYet = true;
      vi.advanceTimersByTime(100);

      expect(sent.some((e) => e.type === "notepad_sync_request")).toBe(true);
      provider.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up the initial sync_request after MAX_SYNC_RETRIES with a warn log", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fake = {
        send(): void {
          throw new Error("websocket not open");
        },
        subscribe(): () => void {
          return () => {};
        },
      };
      const provider = new WsYjsProvider(
        new Y.Doc(),
        new Awareness(new Y.Doc()),
        fake as unknown as WsClient,
        () => {},
        () => {},
        () => {},
      );
      provider.start();

      // 100 + 200 + 400 + 800 + 1600 = 3100 ms covers all 5 retries.
      vi.advanceTimersByTime(4000);

      expect(
        warnSpy.mock.calls.some(
          (c) =>
            typeof c[0] === "string" &&
            c[0].includes("initial sync_request gave up"),
        ),
      ).toBe(true);
      provider.stop();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("stop() cancels the pending sync-request retry timer", () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fake = {
        send(): void {
          throw new Error("websocket not open");
        },
        subscribe(): () => void {
          return () => {};
        },
      };
      const provider = new WsYjsProvider(
        new Y.Doc(),
        new Awareness(new Y.Doc()),
        fake as unknown as WsClient,
        () => {},
        () => {},
        () => {},
      );
      provider.start();
      provider.stop();

      // Advance past every backoff window — no further send calls or
      // give-up warns should fire because stop() cleared the timer.
      vi.advanceTimersByTime(4000);

      expect(
        warnSpy.mock.calls.some(
          (c) =>
            typeof c[0] === "string" &&
            c[0].includes("initial sync_request gave up"),
        ),
      ).toBe(false);
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
