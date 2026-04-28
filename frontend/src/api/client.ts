/**
 * Thin REST client. Token is appended as a query param matching the backend
 * routes. Errors throw with the server's `detail` field if available.
 */

export interface SessionSnapshot {
  id: string;
  state: string;
  scenario_prompt: string;
  plan: ScenarioPlan | null;
  roles: RoleView[];
  current_turn: TurnView | null;
  messages: MessageView[];
  setup_notes: SetupNoteView[] | null;
  cost: CostSnapshot | null;
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
  status: string;
}

export interface MessageView {
  id: string;
  ts: string;
  role_id: string | null;
  kind: string;
  body: string;
  tool_name: string | null;
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

  async setupReply(sessionId: string, token: string, content: string): Promise<{ ok: boolean }> {
    return request("POST", `/api/sessions/${sessionId}/setup/reply?token=${encodeURIComponent(token)}`, { content });
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

  async endSession(sessionId: string, token: string, reason?: string): Promise<{ ok: boolean }> {
    return request("POST", `/api/sessions/${sessionId}/end?token=${encodeURIComponent(token)}`, { reason: reason ?? null });
  },

  async editPlan(sessionId: string, token: string, field: string, value: unknown): Promise<{ ok: boolean }> {
    return request("POST", `/api/sessions/${sessionId}/plan?token=${encodeURIComponent(token)}`, { field, value });
  },

  exportUrl(sessionId: string, token: string): string {
    return `/api/sessions/${sessionId}/export.md?token=${encodeURIComponent(token)}`;
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
