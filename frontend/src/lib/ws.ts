/**
 * Streaming-aware WebSocket client with exponential-backoff reconnect.
 */

export type ServerEvent =
  | { type: "state_changed"; state: string; active_role_ids: string[]; turn_index: number | null }
  | { type: "message_chunk"; turn_id: string; text: string }
  | { type: "message_complete"; kind: string; body: string; tool_name: string | null; turn_id: string | null }
  | { type: "turn_changed"; turn_index: number; active_role_ids: string[] }
  | { type: "tool_invocation"; tool: string; args: Record<string, unknown> }
  | { type: "participant_joined"; role_id: string; label: string; display_name: string | null; kind: string }
  | { type: "participant_left"; role_id: string }
  | { type: "critical_event"; severity: string; headline: string; body: string }
  | { type: "cost_updated"; cost: Record<string, number>; max_turns: number }
  | { type: "guardrail_blocked"; verdict: string; message: string }
  | { type: "plan_proposed"; plan: Record<string, unknown> }
  | { type: "plan_finalized"; plan: Record<string, unknown> }
  | { type: "plan_edited"; field: string }
  | { type: "error"; scope: string; message: string };

export type ClientEvent =
  | { type: "submit_response"; content: string }
  | { type: "request_force_advance" }
  | { type: "request_end_session"; reason?: string }
  | { type: "heartbeat" };

export interface WsClientOptions {
  sessionId: string;
  token: string;
  onEvent: (event: ServerEvent) => void;
  onStatus?: (status: "connecting" | "open" | "closed" | "error") => void;
  heartbeatMs?: number;
}

export class WsClient {
  private socket: WebSocket | null = null;
  private closedByCaller = false;
  private reconnectAttempt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: WsClientOptions) {}

  connect(): void {
    this.closedByCaller = false;
    this._open();
  }

  close(): void {
    this.closedByCaller = true;
    this._teardownHeartbeat();
    this.socket?.close();
    this.socket = null;
  }

  send(event: ClientEvent): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("websocket not open");
    }
    this.socket.send(JSON.stringify(event));
  }

  private _open(): void {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${window.location.host}/ws/sessions/${this.opts.sessionId}?token=${encodeURIComponent(this.opts.token)}`;
    this.opts.onStatus?.("connecting");
    const ws = new WebSocket(url);
    this.socket = ws;

    ws.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.opts.onStatus?.("open");
      console.debug("[ws] open", { sessionId: this.opts.sessionId });
      this._setupHeartbeat();
    });

    ws.addEventListener("message", (evt) => {
      try {
        const parsed = JSON.parse(evt.data) as ServerEvent;
        // Don't log payloads that carry plan content / message bodies — those
        // can be sensitive (frozen scenario plan is creator-only). Log type
        // only; the network tab in devtools shows full WS frames if needed.
        console.debug("[ws] event", { type: parsed.type });
        this.opts.onEvent(parsed);
      } catch {
        // Drop malformed frames silently.
      }
    });

    ws.addEventListener("close", (evt) => {
      this._teardownHeartbeat();
      this.opts.onStatus?.("closed");
      console.debug("[ws] close", { code: evt.code, reason: evt.reason });
      if (!this.closedByCaller) {
        this._scheduleReconnect();
      }
    });

    ws.addEventListener("error", (evt) => {
      console.warn("[ws] error", evt);
      this.opts.onStatus?.("error");
    });
  }

  private _scheduleReconnect(): void {
    const attempt = (this.reconnectAttempt += 1);
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
    const jitter = Math.floor(Math.random() * 500);
    setTimeout(() => {
      if (!this.closedByCaller) this._open();
    }, delay + jitter);
  }

  private _setupHeartbeat(): void {
    const interval = this.opts.heartbeatMs ?? 20_000;
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: "heartbeat" } satisfies ClientEvent));
      }
    }, interval);
  }

  private _teardownHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
