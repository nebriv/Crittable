/**
 * Thin REST client. Token is appended as a query param matching the backend
 * routes. Errors throw with the server's `detail` field if available.
 */

export interface SessionSnapshot {
  id: string;
  state: string;
  /** Session-start timestamp (ISO 8601, UTC) — used for ``T+MM:SS`` relative timestamps in the shared notepad. */
  created_at: string;
  scenario_prompt: string;
  plan: ScenarioPlan | null;
  roles: RoleView[];
  current_turn: TurnView | null;
  messages: MessageView[];
  setup_notes: SetupNoteView[] | null;
  cost: CostSnapshot | null;
  /** "pending" | "generating" | "ready" | "failed" — surfaced for download-button gating. */
  aar_status?: string | null;
  /**
   * Creator-only AI rationale log (issue #55). Each entry is a short
   * sentence the AI emitted via ``record_decision_rationale`` explaining
   * why it picked a turn's actions. ``null`` for non-creator roles.
   */
  decision_log?: DecisionLogEntry[] | null;
}

export interface DecisionLogEntry {
  id: string;
  ts: string;
  turn_index: number | null;
  turn_id: string | null;
  rationale: string;
}

export interface SetupNoteView {
  ts: string;
  speaker: "ai" | "creator";
  content: string;
  topic: string | null;
  options: string[] | null;
}

export interface RoleView {
  id: string;
  label: string;
  display_name: string | null;
  kind: "player" | "spectator";
  is_creator: boolean;
  /** Bumped on kick; included in localStorage keys to isolate notes per join. */
  token_version: number;
}

export interface TurnView {
  index: number;
  active_role_ids: string[];
  /** Role-ids that have already submitted on this turn. */
  submitted_role_ids?: string[];
  status: string;
}

export interface MessageView {
  id: string;
  ts: string;
  role_id: string | null;
  kind: string;
  body: string;
  tool_name: string | null;
  /** Raw tool input args, used by Timeline to surface titles/headlines. */
  tool_args: Record<string, unknown> | null;
  /** Issue #78: true when the player posted this message while NOT on
   * the active set (or after already submitting on this turn). The
   * transcript renders a "sidebar" badge so it isn't confused with a
   * turn submission. */
  is_interjection?: boolean;
}

export interface CostSnapshot {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  estimated_usd: number;
}

export interface ScenarioPlan {
  title: string;
  executive_summary: string;
  key_objectives: string[];
  narrative_arc: { beat: number; label: string; expected_actors: string[] }[];
  injects: { trigger: string; type: string; summary: string }[];
  guardrails: string[];
  success_criteria: string[];
  out_of_scope: string[];
}

export interface BackendDiagnostic {
  /** ``tool_use_rejected`` or ``llm_truncated``. */
  kind: string;
  /** Tool name that was rejected, when applicable. */
  name?: string | null;
  /** LLM tier (``setup`` / ``play`` / ``aar`` / ``guardrail``). */
  tier?: string | null;
  /** Human-readable validator / dispatcher message. */
  reason?: string | null;
  /** Operator hint (e.g. "raise LLM_MAX_TOKENS_SETUP"). */
  hint?: string | null;
}

export interface SetupReplyResult {
  ok: boolean;
  /** True iff the AI's tool call set a draft scenario plan. */
  plan_proposed?: boolean;
  /** Backend-side rejections / truncations that occurred during this reply. */
  diagnostics?: BackendDiagnostic[];
}

/**
 * Strip query-string secrets ({@code token=...}) from a path before logging.
 * Tokens are bearer credentials — leaking them via console is a real bug.
 */
function _scrub(path: string): string {
  return path.replace(/([?&]token=)[^&]+/gi, "$1***");
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const safePath = _scrub(path);
  console.debug(`[api] ${method} ${safePath}`, body ?? "");
  const start = performance.now();
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const ms = Math.round(performance.now() - start);
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const json = await res.json();
      detail = (json.detail as string) ?? detail;
    } catch {
      /* ignore */
    }
    console.warn(`[api] ${method} ${safePath} → ${res.status} (${ms}ms)`, detail);
    throw new Error(detail);
  }
  const out = (await res.json()) as T;
  console.debug(`[api] ${method} ${safePath} → ${res.status} (${ms}ms)`);
  return out;
}

export const api = {
  async createSession(body: {
    scenario_prompt: string;
    creator_label: string;
    creator_display_name: string;
    /** Skip the AI auto-greet + drop the default plan in one shot.
     *  Mirrors ``POST /api/sessions/{id}/setup/skip`` but avoids the
     *  wasted auto-greet LLM call. Used by the frontend's Dev mode. */
    skip_setup?: boolean;
  }): Promise<{
    session_id: string;
    creator_role_id: string;
    creator_token: string;
    creator_join_url: string;
  }> {
    return request("POST", "/api/sessions", body);
  },

  async addRole(
    sessionId: string,
    creatorToken: string,
    body: { label: string; display_name?: string | null; kind?: "player" | "spectator" },
  ): Promise<{ role_id: string; token: string; join_url: string; label: string; display_name: string | null }> {
    return request("POST", `/api/sessions/${sessionId}/roles?token=${encodeURIComponent(creatorToken)}`, body);
  },

  async getSession(sessionId: string, token: string): Promise<SessionSnapshot> {
    return request("GET", `/api/sessions/${sessionId}?token=${encodeURIComponent(token)}`);
  },

  /** Token-bound; the role being renamed is encoded in the token's
   *  ``role_id`` claim — the caller cannot rename someone else.
   *  Used by the player join-intro flow so the entered display name
   *  propagates from the local browser to every participant's
   *  snapshot. */
  async setSelfDisplayName(
    sessionId: string,
    token: string,
    displayName: string,
  ): Promise<{ role_id: string; label: string; display_name: string }> {
    return request(
      "POST",
      `/api/sessions/${sessionId}/roles/me/display_name?token=${encodeURIComponent(token)}`,
      { display_name: displayName },
    );
  },

  async setupReply(
    sessionId: string,
    token: string,
    content: string,
  ): Promise<SetupReplyResult> {
    return request(
      "POST",
      `/api/sessions/${sessionId}/setup/reply?token=${encodeURIComponent(token)}`,
      { content },
    );
  },

  async setupFinalize(
    sessionId: string,
    token: string,
    plan?: ScenarioPlan,
  ): Promise<{ ok: boolean }> {
    return request(
      "POST",
      `/api/sessions/${sessionId}/setup/finalize?token=${encodeURIComponent(token)}`,
      plan ?? {},
    );
  },

  async setupSkip(sessionId: string, token: string): Promise<{ ok: boolean }> {
    return request(
      "POST",
      `/api/sessions/${sessionId}/setup/skip?token=${encodeURIComponent(token)}`,
    );
  },

  async start(sessionId: string, token: string): Promise<{ ok: boolean }> {
    return request("POST", `/api/sessions/${sessionId}/start?token=${encodeURIComponent(token)}`);
  },

  async forceAdvance(sessionId: string, token: string): Promise<{ ok: boolean }> {
    return request("POST", `/api/sessions/${sessionId}/force-advance?token=${encodeURIComponent(token)}`);
  },

  /** God-mode-only: mark the current AI turn errored to recover a stuck session. */
  async adminAbortTurn(sessionId: string, creatorToken: string): Promise<{ ok: boolean }> {
    return request(
      "POST",
      `/api/sessions/${sessionId}/admin/abort-turn?token=${encodeURIComponent(creatorToken)}`,
    );
  },

  /** Creator-only: re-kick the AAR pipeline after a ``failed`` status. */
  async adminRetryAar(
    sessionId: string,
    creatorToken: string,
  ): Promise<{ ok: boolean; status?: string; noop?: boolean }> {
    return request(
      "POST",
      `/api/sessions/${sessionId}/admin/retry-aar?token=${encodeURIComponent(creatorToken)}`,
    );
  },

  /** Creator-only solo-test helper: submit on behalf of a specific role. */
  async adminProxyRespond(
    sessionId: string,
    creatorToken: string,
    asRoleId: string,
    content: string,
  ): Promise<{ ok: boolean }> {
    return request(
      "POST",
      `/api/sessions/${sessionId}/admin/proxy-respond?token=${encodeURIComponent(creatorToken)}`,
      { as_role_id: asRoleId, content },
    );
  },

  async endSession(sessionId: string, token: string, reason?: string): Promise<{ ok: boolean }> {
    return request("POST", `/api/sessions/${sessionId}/end?token=${encodeURIComponent(token)}`, { reason: reason ?? null });
  },

  async editPlan(sessionId: string, token: string, field: string, value: unknown): Promise<{ ok: boolean }> {
    return request("POST", `/api/sessions/${sessionId}/plan?token=${encodeURIComponent(token)}`, { field, value });
  },

  exportUrl(sessionId: string, token: string): string {
    return `/api/sessions/${sessionId}/export.md?token=${encodeURIComponent(token)}`;
  },

  exportJsonUrl(sessionId: string, token: string): string {
    return `/api/sessions/${sessionId}/export.json?token=${encodeURIComponent(token)}`;
  },

  async reissueRole(
    sessionId: string,
    creatorToken: string,
    roleId: string,
  ): Promise<{ token: string; join_url: string }> {
    return request(
      "POST",
      `/api/sessions/${sessionId}/roles/${roleId}/reissue?token=${encodeURIComponent(creatorToken)}`,
    );
  },

  async revokeRole(
    sessionId: string,
    creatorToken: string,
    roleId: string,
  ): Promise<{ token: string; join_url: string }> {
    return request(
      "POST",
      `/api/sessions/${sessionId}/roles/${roleId}/revoke?token=${encodeURIComponent(creatorToken)}`,
    );
  },

  async removeRole(
    sessionId: string,
    creatorToken: string,
    roleId: string,
  ): Promise<{ ok: boolean }> {
    return request(
      "DELETE",
      `/api/sessions/${sessionId}/roles/${roleId}?token=${encodeURIComponent(creatorToken)}`,
    );
  },

  async getActivity(sessionId: string, token: string): Promise<unknown> {
    return request(
      "GET",
      `/api/sessions/${sessionId}/activity?token=${encodeURIComponent(token)}`,
    );
  },

  async getDebug(sessionId: string, token: string): Promise<unknown> {
    return request(
      "GET",
      `/api/sessions/${sessionId}/debug?token=${encodeURIComponent(token)}`,
    );
  },
};

/**
 * Strip the ``?token=…`` query param from a URL before logging it. Centralised
 * here so any module that bypasses the wrapped ``request<T>()`` (e.g. raw
 * polling like ``EndedView``) can still avoid leaking creator/player tokens
 * to the browser console.
 */
export function scrubUrl(url: string): string {
  return url.replace(/([?&]token=)[^&]+/gi, "$1***");
}
