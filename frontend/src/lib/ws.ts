/**
 * Streaming-aware WebSocket client with exponential-backoff reconnect.
 */

export type ServerEvent =
  | { type: "state_changed"; state: string; active_role_ids: string[]; turn_index: number | null }
  | { type: "message_chunk"; turn_id: string; text: string }
  | {
      type: "message_complete";
      kind: string;
      body: string;
      tool_name: string | null;
      turn_id: string | null;
      /**
       * Phase B chat-declutter (docs/plans/chat-decluttering.md §4.8):
       * server-validated workstream tag. ``null`` = synthetic ``#main``
       * (unscoped) bucket. The colored track-bar stripe in
       * ``Transcript.tsx`` reads this field directly.
       */
      workstream_id?: string | null;
      /**
       * Phase B chat-declutter (plan §5.1) + Wave 2 composer mentions:
       * structural source for the @-highlight (amber outline +
       * ``(@you)`` badge). Each entry is a real ``role_id`` from the
       * roster or the literal ``"facilitator"`` token. **Never**
       * regex'd from ``body``.
       */
      mentions?: string[];
      /** Wave 3 (issue #69): True iff this player message was a
       *  ``@facilitator`` mention submitted while ``Session.ai_paused``
       *  was set. Drives the transcript-side "AI silenced — won't
       *  reply" indicator without the client having to track timing. */
      ai_paused_at_submit?: boolean;
    }
  | { type: "turn_changed"; turn_index: number; active_role_ids: string[] }
  | { type: "tool_invocation"; tool: string; args: Record<string, unknown> }
  | { type: "participant_joined"; role_id: string; label: string; display_name: string | null; kind: string }
  | { type: "participant_left"; role_id: string }
  // Player-initiated rename via the join-intro flow (or any future
  // self-rename surface). Snapshot reflects the new ``display_name``
  // server-side; clients can refresh on receipt to update headers /
  // banners that include the name. ``record=True`` so a late joiner
  // sees the latest name without an explicit refetch.
  | { type: "participant_renamed"; role_id: string; display_name: string }
  | { type: "critical_event"; severity: string; headline: string; body: string }
  | { type: "cost_updated"; cost: Record<string, number>; max_turns: number }
  | { type: "guardrail_blocked"; verdict: string; message: string }
  | { type: "submission_truncated"; scope: string; cap: number; original_len: number; message: string }
  | { type: "plan_proposed"; plan: Record<string, unknown> }
  | { type: "plan_finalized"; plan: Record<string, unknown> }
  | { type: "plan_proposed_announcement" }
  | { type: "plan_finalized_announcement" }
  | { type: "plan_edited"; field: string }
  | { type: "aar_status_changed"; status: "pending" | "generating" | "ready" | "failed" }
  // Wave 3 (issue #69): creator toggled the AI-pause flag. Fan-out
  // to all participants so the session-wide banner appears /
  // disappears in real time. Server-side only event — clients never
  // emit this; the corresponding action is the creator-only
  // ``POST /pause`` / ``/resume`` REST endpoint. ``record=True`` so
  // a late joiner's replay buffer reflects the current pause state.
  | { type: "ai_pause_state_changed"; paused: boolean }
  // Real-time AI-thinking indicator. Emitted by the LLM client at every
  // call boundary (begin / end), regardless of tier — so interject /
  // guardrail / setup-tier / AAR-generation work all show the indicator
  // without each driver path having to remember to emit. ``call_id`` is a
  // stable opaque token so a UI that sees concurrent calls (e.g. guardrail
  // overlapping a play turn) can reference-count rather than naively
  // toggle on/off. ``record=False`` server-side, so the events do NOT
  // replay on reconnect (they would be stale by then).
  | {
      type: "ai_thinking";
      active: boolean;
      tier: string;
      call_id: string;
      started_at_ms?: number;
    }
  // Labelled "what is the AI doing right now?" status, emitted by the
  // turn-driver at known points (play attempt N/M, recovery directive
  // active, interject for role X, briefing, AAR). ``ai_thinking`` answers
  // "is anything running"; ``ai_status`` answers "what should the human
  // see?". A null phase clears the label.
  | {
      type: "ai_status";
      phase: "play" | "interject" | "setup" | "briefing" | "aar" | null;
      attempt?: number;
      budget?: number;
      recovery?: string | null;
      turn_index?: number | null;
      for_role_id?: string | null;
    }
  | { type: "typing"; role_id: string; typing: boolean }
  | {
      type: "presence";
      role_id: string;
      active: boolean;
      /** Whether the role currently has at least one *focused / visible*
       *  tab. Drives the tri-state dot in the creator's RolesPanel:
       *  active=true & focused=true → blue (engaged), active=true &
       *  focused=false → yellow (joined but tabbed away),
       *  active=false → grey (not joined). */
      focused: boolean;
      /** Total open WS tabs on this session, used for the top-bar
       *  "Tabs: N" chip. */
      connection_count?: number;
    }
  | {
      type: "presence_snapshot";
      role_ids: string[];
      /** Subset of ``role_ids`` whose tabs are currently focused /
       *  visible. */
      focused_role_ids: string[];
      connection_count?: number;
    }
  | {
      type: "decision_logged";
      entry: {
        id: string;
        ts: string;
        turn_index: number | null;
        turn_id: string | null;
        rationale: string;
      };
    }
  // Shared markdown notepad (issue #98). Yjs binary updates are
  // base64-encoded inside JSON envelopes so they ride the existing
  // /ws/sessions/{id} channel without a separate y-websocket server.
  // Server-side recording policy:
  //   - notepad_update / notepad_awareness / notepad_lock_pending:
  //     record=False — high-volume, not idempotent against the 256-
  //     event replay buffer; reconnecting clients explicitly send
  //     notepad_sync_request for current state.
  //   - notepad_locked: record=True — terminal state; a late joiner
  //     who reconnects after End must learn the notepad is locked
  //     (otherwise their editor would be writable but every edit
  //     would 409 from the service).
  | {
      type: "notepad_sync_response";
      state: string;
      locked: boolean;
      template_id: string | null;
    }
  | {
      type: "notepad_update";
      update: string;
      origin_role_id: string;
    }
  | {
      // Live cursor presence (y-protocols Awareness update). record=False
      // server-side; relayed to all peers except the sender. ``origin_role_id``
      // lets the receiver tag the rendered cursor.
      type: "notepad_awareness";
      awareness: string;
      origin_role_id: string;
    }
  | { type: "notepad_lock_pending"; locks_in_seconds: number }
  | { type: "notepad_locked"; locked_at: string | null }
  /**
   * Phase A chat-declutter (docs/plans/chat-decluttering.md §4.8):
   * AI declared one or more workstreams during setup (the new tool
   * ``declare_workstreams``). Recorded server-side so a late joiner
   * still sees the registry replay through their snapshot fetch.
   * ``record=True`` so reconnecting tabs stay in sync with the
   * filter UI's available pills.
   */
  | {
      type: "workstream_declared";
      workstreams: {
        id: string;
        label: string;
        lead_role_id: string | null;
        state: "open" | "closed";
        created_at: string;
        closed_at: string | null;
      }[];
    }
  /**
   * Chat-declutter polish: a creator or message-author re-tagged a
   * single message via the contextmenu / REST endpoint. Recorded
   * server-side (replay-buffered) so reconnecting tabs converge on
   * the latest categorization. ``workstream_id=null`` means the
   * message was moved back to the synthetic ``#main`` bucket.
   * ``actor_role_id`` is who performed the override; surface in the
   * audit log only — clients update their local message map without
   * a snapshot round-trip.
   */
  | {
      type: "message_workstream_changed";
      message_id: string;
      workstream_id: string | null;
      actor_role_id: string;
    }
  | { type: "error"; scope: string; message: string };

export type ClientEvent =
  | {
      type: "submit_response";
      content: string;
      /**
       * Wave 1 (issue #134): per-submission intent. ``"ready"``
       * signals the player is done; ``"discuss"`` keeps the seat
       * open for further team discussion. Required — the backend
       * rejects payloads without it.
       */
      intent: "ready" | "discuss";
      /**
       * Wave 2 (composer mentions + facilitator routing).
       *
       * Structural mention targets parsed from the composer's
       * marks. Order-preserving + de-duplicated. Each entry is
       * either a real ``role_id`` from the session roster or the
       * literal ``"facilitator"`` token (synthetic AI target;
       * client-side aliases ``@ai`` / ``@gm`` resolve to this same
       * string before the payload is built).
       *
       * The backend's WS handler calls
       * ``run_interject`` iff ``"facilitator"`` is present AND
       * ``Session.ai_paused`` is False. Plain ``role_id`` entries
       * are player-to-player only — they surface the @-highlight to
       * the addressed role but trigger no AI side effect. Empty
       * list when the player didn't tag anyone.
       *
       * The server validates this list at the submission pipeline:
       * unknown / non-string entries are dropped with a
       * ``mention_dropped`` WARNING audit; the cleaned list is the
       * one persisted on ``Message.mentions``.
       */
      mentions: string[];
    }
  | { type: "request_force_advance" }
  | { type: "request_end_session"; reason?: string }
  | { type: "typing_start" }
  | { type: "typing_stop" }
  | { type: "heartbeat" }
  // Per-tab visibility signal — fired on ``visibilitychange`` /
  // ``focus`` / ``blur`` so the creator's RolesPanel can show a
  // tri-state status dot (joined+focused / joined+backgrounded /
  // not joined). The server aggregates per-role: a role is
  // "focused" if at least one of its open tabs is focused.
  | { type: "tab_focus"; focused: boolean }
  // Shared markdown notepad (issue #98).
  | { type: "notepad_sync_request" }
  | { type: "notepad_update"; update: string }
  | { type: "notepad_awareness"; awareness: string };

/** Close codes the server uses to reject the WS upgrade (or terminate
 *  it post-kick). Reconnecting with the same token will fail the same
 *  way, so the client stops the auto-reconnect loop and surfaces a
 *  status the page can render specifically.
 *
 *  - 4401: bad / revoked token. The creator kicked this seat (issue
 *    #127) OR the join URL was forged. From the player's view both
 *    look the same — the link no longer works.
 *  - 4403: forbidden origin. CORS_ORIGINS doesn't include this
 *    origin. Unlike "kicked", this is usually an operator
 *    misconfiguration; the player can't fix it by getting a fresh
 *    link. Render distinct copy so the operator's screenshot of the
 *    UI doesn't get mistakenly triaged as "the player was kicked".
 *  - 4404: session not found. The GC reaper evicted the session
 *    (long-idle), or the operator restarted the in-memory store. A
 *    fresh creator session would be needed; a fresh link won't help.
 */
const CLOSE_CODE_BAD_TOKEN = 4401;
const CLOSE_CODE_FORBIDDEN_ORIGIN = 4403;
const CLOSE_CODE_SESSION_GONE = 4404;
const TERMINAL_CLOSE_CODES = new Set([
  CLOSE_CODE_BAD_TOKEN,
  CLOSE_CODE_FORBIDDEN_ORIGIN,
  CLOSE_CODE_SESSION_GONE,
]);

export type TerminalCloseStatus = "kicked" | "rejected" | "session-gone";

export interface WsClientOptions {
  sessionId: string;
  token: string;
  onEvent: (event: ServerEvent) => void;
  onStatus?: (
    status:
      | "connecting"
      | "open"
      | "closed"
      | "error"
      | TerminalCloseStatus,
  ) => void;
  heartbeatMs?: number;
}

export class WsClient {
  private socket: WebSocket | null = null;
  private closedByCaller = false;
  private reconnectAttempt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  // Additional fan-out listeners (issue #98 — SharedNotepad needs to
  // observe notepad_* events without taking over the page-level
  // ``onEvent`` callback). The page's ``onEvent`` is still called
  // first; subscribe handlers run after, so a panic in a notepad
  // handler can't suppress page-level state updates.
  private subscribers = new Set<(evt: ServerEvent) => void>();

  constructor(private readonly opts: WsClientOptions) {}

  /** Add a fan-out listener. Returns an unsubscribe fn. */
  subscribe(handler: (evt: ServerEvent) => void): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

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
        // can be sensitive (frozen scenario plan is creator-only). For each
        // event type we log a small set of safe scalar fields so a console
        // dump tells the operator which event arrived and roughly what it
        // means without leaking content. Full frames are visible in the
        // browser's network tab if deeper inspection is needed.
        const safe: Record<string, unknown> = { type: parsed.type };
        switch (parsed.type) {
          case "state_changed":
            safe.state = parsed.state;
            safe.turn_index = parsed.turn_index;
            safe.active_role_count = parsed.active_role_ids?.length ?? 0;
            break;
          case "turn_changed":
            safe.turn_index = parsed.turn_index;
            safe.active_role_count = parsed.active_role_ids?.length ?? 0;
            break;
          case "message_chunk":
            safe.turn_id = parsed.turn_id;
            safe.chars = parsed.text?.length ?? 0;
            break;
          case "message_complete":
            safe.kind = parsed.kind;
            safe.tool_name = parsed.tool_name;
            safe.body_chars = parsed.body?.length ?? 0;
            break;
          case "participant_joined":
          case "participant_left":
          case "participant_renamed":
            safe.role_id = parsed.role_id;
            break;
          case "critical_event":
            safe.severity = parsed.severity;
            // headline is operator-visible by design — safe to surface.
            safe.headline = parsed.headline;
            break;
          case "aar_status_changed":
            safe.status = parsed.status;
            break;
          case "ai_thinking":
            safe.active = parsed.active;
            safe.tier = parsed.tier;
            safe.call_id = parsed.call_id;
            break;
          case "ai_status":
            safe.phase = parsed.phase;
            safe.attempt = parsed.attempt;
            safe.budget = parsed.budget;
            safe.recovery = parsed.recovery;
            break;
          case "typing":
            safe.role_id = parsed.role_id;
            safe.typing = parsed.typing;
            break;
          case "presence":
            safe.role_id = parsed.role_id;
            safe.active = parsed.active;
            safe.focused = parsed.focused;
            safe.connection_count = parsed.connection_count;
            break;
          case "presence_snapshot":
            safe.role_count = parsed.role_ids?.length ?? 0;
            safe.focused_count = parsed.focused_role_ids?.length ?? 0;
            safe.connection_count = parsed.connection_count;
            break;
          case "decision_logged":
            // Don't log the rationale text itself — it's debug content
            // intended for the creator panel and could leak narrative
            // information into a console paste. Length only.
            safe.rationale_chars = parsed.entry?.rationale?.length ?? 0;
            safe.turn_index = parsed.entry?.turn_index ?? null;
            break;
          case "error":
            safe.scope = parsed.scope;
            safe.message = parsed.message;
            break;
          case "guardrail_blocked":
            safe.verdict = parsed.verdict;
            break;
          case "submission_truncated":
            safe.cap = parsed.cap;
            safe.original_len = parsed.original_len;
            break;
          case "notepad_sync_response":
            // Log size only — the content is opaque Yjs binary; no
            // user-visible text leaks via console regardless.
            safe.state_chars = parsed.state?.length ?? 0;
            safe.locked = parsed.locked;
            safe.template_id = parsed.template_id;
            break;
          case "notepad_update":
            safe.update_chars = parsed.update?.length ?? 0;
            safe.origin_role_id = parsed.origin_role_id;
            break;
          case "notepad_lock_pending":
            safe.locks_in_seconds = parsed.locks_in_seconds;
            break;
          case "notepad_locked":
            safe.locked_at = parsed.locked_at;
            break;
          case "message_workstream_changed":
            safe.message_id = parsed.message_id;
            safe.workstream_id = parsed.workstream_id;
            safe.actor_role_id = parsed.actor_role_id;
            break;
          default:
            break;
        }
        console.debug("[ws] event", safe);
        this.opts.onEvent(parsed);
        // Fan-out to additional subscribers. Each is wrapped so a
        // throw in one handler doesn't suppress the others.
        for (const sub of this.subscribers) {
          try {
            sub(parsed);
          } catch (err) {
            console.warn("[ws] subscriber threw", err);
          }
        }
      } catch (err) {
        // Surface parse failures rather than dropping silently — they're
        // almost always a contract drift between client and server.
        console.warn("[ws] parse failed", err);
      }
    });

    ws.addEventListener("close", (evt) => {
      this._teardownHeartbeat();
      console.debug("[ws] close", { code: evt.code, reason: evt.reason });
      // Server-initiated terminal closes will fail the same way on
      // reconnect — looping with backoff just spams the server and
      // logs. Map each terminal code to a distinct status so the
      // page can render the right copy (a kicked player and a
      // CORS-misconfigured origin should NOT see the same banner).
      // Flip the closed-by-caller flag so any subsequent close
      // events on this socket also stay out of the reconnect path.
      if (TERMINAL_CLOSE_CODES.has(evt.code) && !this.closedByCaller) {
        this.closedByCaller = true;
        let status: TerminalCloseStatus;
        switch (evt.code) {
          case CLOSE_CODE_BAD_TOKEN:
            status = "kicked";
            break;
          case CLOSE_CODE_FORBIDDEN_ORIGIN:
            status = "rejected";
            break;
          case CLOSE_CODE_SESSION_GONE:
            status = "session-gone";
            break;
          default:
            status = "kicked";
        }
        console.info("[ws] terminal close — disabling reconnect", {
          code: evt.code,
          status,
        });
        this.opts.onStatus?.(status);
        return;
      }
      this.opts.onStatus?.("closed");
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
