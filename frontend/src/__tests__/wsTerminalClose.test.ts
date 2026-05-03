/**
 * Frontend regression net for issue #127 — terminal close-code mapping
 * in ``WsClient``. Pre-fix, every server-initiated close re-armed the
 * exponential-backoff reconnect loop, so a kicked tab kept hammering
 * the server with 4401 connect attempts indefinitely. Post-fix, codes
 * 4401 / 4403 / 4404 each translate to a distinct ``onStatus`` value
 * and the reconnect timer is NOT armed.
 *
 * The QA review on the PR flagged the missing frontend coverage — this
 * file fills that gap by stubbing the ``WebSocket`` global with a fake
 * that lets the test fire ``close`` events with arbitrary codes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WsClient } from "../lib/ws";

interface FakeListener {
  type: string;
  fn: EventListener;
}

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  url: string;
  readyState = 0;
  listeners: FakeListener[] = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, fn: EventListener) {
    this.listeners.push({ type, fn });
  }
  removeEventListener(type: string, fn: EventListener) {
    this.listeners = this.listeners.filter(
      (l) => !(l.type === type && l.fn === fn),
    );
  }
  send() {
    /* noop */
  }
  close() {
    this.closed = true;
  }
  fire(type: string, init: Record<string, unknown> = {}) {
    const evt = Object.assign(new Event(type), init);
    for (const l of this.listeners) if (l.type === type) l.fn(evt);
  }
}

describe("WsClient — terminal close-code mapping (issue #127)", () => {
  const realWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    // @ts-expect-error — replace with our fake for this suite.
    globalThis.WebSocket = FakeWebSocket;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.WebSocket = realWebSocket;
    vi.useRealTimers();
  });

  function newClient(onStatus: (s: string) => void) {
    return new WsClient({
      sessionId: "s1",
      token: "tok",
      onEvent: () => {},
      onStatus: (s) => onStatus(s as string),
    });
  }

  it("maps close 4401 (revoked token) to 'kicked' and stops the reconnect loop", () => {
    const statuses: string[] = [];
    const ws = newClient((s) => statuses.push(s));
    ws.connect();

    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.instances[0].fire("close", { code: 4401, reason: "kicked" });

    expect(statuses).toContain("kicked");
    expect(statuses).not.toContain("closed");

    // Roll the clock past every backoff window — no second connect.
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("maps close 4403 (forbidden origin) to 'rejected' (NOT kicked)", () => {
    const statuses: string[] = [];
    const ws = newClient((s) => statuses.push(s));
    ws.connect();

    FakeWebSocket.instances[0].fire("close", { code: 4403, reason: "" });

    expect(statuses).toContain("rejected");
    expect(statuses).not.toContain("kicked");
    expect(statuses).not.toContain("closed");
  });

  it("maps close 4404 (session not found) to 'session-gone' (NOT kicked)", () => {
    const statuses: string[] = [];
    const ws = newClient((s) => statuses.push(s));
    ws.connect();

    FakeWebSocket.instances[0].fire("close", { code: 4404, reason: "" });

    expect(statuses).toContain("session-gone");
    expect(statuses).not.toContain("kicked");
  });

  it("non-terminal close codes still trigger reconnect with backoff", () => {
    const statuses: string[] = [];
    const ws = newClient((s) => statuses.push(s));
    ws.connect();

    // Close with a generic abnormal-close code (1006 — connection lost).
    FakeWebSocket.instances[0].fire("close", { code: 1006, reason: "" });

    expect(statuses).toContain("closed");
    expect(statuses).not.toContain("kicked");

    // First backoff is ~1s + jitter; advance 2s to clear it.
    vi.advanceTimersByTime(2_000);
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
  });

  it("manual close() does NOT surface a terminal status", () => {
    const statuses: string[] = [];
    const ws = newClient((s) => statuses.push(s));
    ws.connect();
    ws.close();
    FakeWebSocket.instances[0].fire("close", { code: 1000, reason: "" });
    expect(statuses).not.toContain("kicked");
    expect(statuses).not.toContain("rejected");
    expect(statuses).not.toContain("session-gone");
  });
});
