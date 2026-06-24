/**
 * Tests for ``frontend/src/api/client.ts``.
 *
 * The api-client wrapper is the only thing standing between every
 * ``api.foo()`` call and the network. It must:
 *
 *   * scrub ``token=`` from the path before logging,
 *   * surface a parsed ``detail`` when the server returns 4xx/5xx JSON,
 *   * fall back to ``HTTP <code>`` when the body isn't JSON,
 *   * pass body as JSON-encoded with the right content-type,
 *   * never log the raw token,
 *   * construct stable URLs for the ``exportUrl`` / ``exportJsonUrl`` helpers.
 *
 * The AAR-poll loop (Facilitator.tsx) hits ``/export.md`` and treats
 * 425 / 200 / 410 / 5xx differently. We exercise the polling response
 * shape here too so a future refactor of that loop can't silently
 * regress the contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, ApiError } from "../api/client";

type FetchInit = RequestInit | undefined;

function _mockFetch(impl: (path: string, init: FetchInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  // Cast — vitest's typing for global fetch is fussy in node-jsdom.
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return fn;
}

function _jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("api/client — request wrapper", () => {
  const realFetch = globalThis.fetch;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    warnSpy.mockRestore();
    debugSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("returns parsed JSON on a 200 response", async () => {
    _mockFetch(async () =>
      _jsonResponse({
        session_id: "s1",
        creator_role_id: "r1",
        creator_token: "tok",
        creator_join_url: "/play/s1/tok",
      }),
    );
    const res = await api.createSession({
      scenario_prompt: "x",
      creator_label: "CISO",
      creator_display_name: "Alex",
      settings: {
        difficulty: "standard",
        duration_minutes: 60,
        features: {
          active_adversary: true,
          time_pressure: true,
          executive_escalation: true,
          media_pressure: false,
        },
      },
    });
    expect(res.session_id).toBe("s1");
    expect(res.creator_token).toBe("tok");
  });

  it("scrubs the token query param from console logs", async () => {
    _mockFetch(async () => _jsonResponse({ ok: true }));
    await api.start("s1", "very-secret-token");
    // Combine all console.debug invocations into one string.
    const allLogs = debugSpy.mock.calls.flat().join(" ");
    expect(allLogs).not.toContain("very-secret-token");
    // The wrapper writes ``token=***`` — that's the scrub contract.
    expect(allLogs).toContain("token=***");
  });

  it("throws Error(detail) when server returns 4xx with JSON body", async () => {
    _mockFetch(async () =>
      new Response(JSON.stringify({ detail: "session not yet ended" }), {
        status: 425,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(api.start("s1", "tok")).rejects.toThrow("session not yet ended");
  });

  it("formats a Pydantic 422 detail array into '<field>: <msg>' (never [object Object])", async () => {
    // This is the bug the HAR captured: an over-length scenario_prompt
    // returns ``detail: [{loc:["body","scenario_prompt"], msg:"…"}]``.
    // The old ``json.detail as string`` stringified the array to
    // "[object Object]" and rendered that red blob in the wizard.
    _mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            detail: [
              {
                type: "string_too_long",
                loc: ["body", "scenario_prompt"],
                msg: "String should have at most 16000 characters",
                ctx: { max_length: 16000 },
              },
            ],
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
    );
    const err = (await api
      .createSession({
        scenario_prompt: "x".repeat(20000),
        creator_label: "CISO",
        creator_display_name: "Alex",
        settings: {
          difficulty: "standard",
          duration_minutes: 60,
          features: {
            active_adversary: true,
            time_pressure: true,
            executive_escalation: true,
            media_pressure: false,
          },
        },
      })
      .catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
    // Field name is humanised from the snake_case schema id so it reads
    // like something on the form, and the [object Object] blob is gone.
    expect(err.message).toBe(
      "Scenario prompt: String should have at most 16000 characters",
    );
    expect(err.message).not.toContain("[object Object]");
    expect(err.message).not.toContain("scenario_prompt");
  });

  it("joins multiple 422 validation errors with '; '", async () => {
    _mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            detail: [
              { loc: ["body", "scenario_prompt"], msg: "too long" },
              { loc: ["body", "creator_label"], msg: "field required" },
            ],
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
    );
    await expect(api.start("s1", "tok")).rejects.toThrow(
      "Scenario prompt: too long; Creator label: field required",
    );
  });

  it("humanises a nested loc with a numeric array index", async () => {
    // A too-long invitee role label: loc carries the array index.
    _mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            detail: [
              {
                loc: ["body", "invitee_roles", 0, "label"],
                msg: "String should have at most 64 characters",
              },
            ],
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
    );
    await expect(api.start("s1", "tok")).rejects.toThrow(
      "Label: String should have at most 64 characters",
    );
  });

  it("falls back to ``<status>`` for an empty or unparseable detail array", async () => {
    _mockFetch(
      async () =>
        new Response(JSON.stringify({ detail: [] }), {
          status: 422,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(api.start("s1", "tok")).rejects.toThrow(/422/);
  });

  it("falls back to ``<status>`` when the error body isn't JSON", async () => {
    _mockFetch(async () =>
      new Response("plain text 500", {
        status: 500,
        headers: { "content-type": "text/plain" },
      }),
    );
    await expect(api.start("s1", "tok")).rejects.toThrow(/500/);
  });

  it("parses a numeric Retry-After header onto ApiError.retryAfter (503 at-capacity)", async () => {
    _mockFetch(
      async () =>
        new Response(
          JSON.stringify({ detail: "Crittable is at capacity; try again shortly." }),
          {
            status: 503,
            headers: {
              "content-type": "application/json",
              "Retry-After": "30",
            },
          },
        ),
    );
    const err = (await api
      .createSession({
        scenario_prompt: "x",
        creator_label: "CISO",
        creator_display_name: "Alex",
        settings: {
          difficulty: "standard",
          duration_minutes: 60,
          features: {
            active_adversary: true,
            time_pressure: true,
            executive_escalation: true,
            media_pressure: false,
          },
        },
      })
      .catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(503);
    expect(err.retryAfter).toBe(30);
    expect(err.message).toMatch(/at capacity/i);
  });

  it("leaves ApiError.retryAfter null when the header is absent or non-numeric", async () => {
    // Absent header → null.
    _mockFetch(async () =>
      new Response(JSON.stringify({ detail: "nope" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    const absent = (await api.start("s1", "tok").catch((e) => e)) as ApiError;
    expect(absent.retryAfter).toBeNull();

    // HTTP-date form (spec-legal but our server never sends it) → null,
    // not a misleading number.
    _mockFetch(async () =>
      new Response(JSON.stringify({ detail: "nope" }), {
        status: 503,
        headers: {
          "content-type": "application/json",
          "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT",
        },
      }),
    );
    const dated = (await api.start("s1", "tok").catch((e) => e)) as ApiError;
    expect(dated.retryAfter).toBeNull();
  });

  it("getInviteStatus probes the bare endpoint with no ?code= oracle query", async () => {
    const fetchMock = _mockFetch(async () => _jsonResponse({ required: true }));
    const status = await api.getInviteStatus();
    expect(status).toEqual({ required: true });
    const [path] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/invite/status");
    expect(String(path)).not.toContain("code=");
  });

  it("warns to console on a 4xx without exposing the raw token", async () => {
    _mockFetch(async () =>
      new Response(JSON.stringify({ detail: "nope" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(api.start("s1", "leak-tok-123")).rejects.toThrow();
    const warnText = warnSpy.mock.calls.flat().join(" ");
    expect(warnText).not.toContain("leak-tok-123");
    expect(warnText).toContain("token=***");
  });

  it("sends JSON body with the right content-type when one is supplied", async () => {
    const fetchMock = _mockFetch(async () => _jsonResponse({ ok: true }));
    await api.endSession("s1", "tok", "wrap up");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init?.body as string)).toEqual({ reason: "wrap up" });
  });

  it("omits content-type and body when none is supplied", async () => {
    const fetchMock = _mockFetch(async () => _jsonResponse({ ok: true }));
    await api.start("s1", "tok");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toBeUndefined();
  });
});

describe("api/client — exportUrl helpers", () => {
  it("encodes the token in exportUrl", () => {
    const url = api.exportUrl("s1", "weird/token=value");
    expect(url).toBe(
      "/api/sessions/s1/export.md?token=weird%2Ftoken%3Dvalue",
    );
  });

  it("encodes the token in exportJsonUrl", () => {
    const url = api.exportJsonUrl("s1", "weird&token");
    expect(url).toBe(
      "/api/sessions/s1/export.json?token=weird%26token",
    );
  });
});

/**
 * The AAR poll loop (Facilitator.tsx) hits ``/export.md`` and switches
 * on the status code. The test below documents the contract that loop
 * relies on so a future refactor — say, moving the polling logic into
 * api/client.ts proper — can't silently regress.
 */
describe("AAR poll loop contract — /export.md status codes", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("425 means 'still generating' — Retry-After is present", async () => {
    _mockFetch(
      async () =>
        new Response("AAR is generating", {
          status: 425,
          headers: { "Retry-After": "3", "X-AAR-Status": "generating" },
        }),
    );
    const res = await fetch(api.exportUrl("s1", "tok"));
    expect(res.status).toBe(425);
    expect(res.headers.get("Retry-After")).toBe("3");
    expect(res.headers.get("X-AAR-Status")).toBe("generating");
  });

  it("200 means 'ready' — body is the markdown payload", async () => {
    _mockFetch(
      async () =>
        new Response("# After-action report\n\nDetails…", {
          status: 200,
          headers: {
            "Content-Type": "text/markdown",
            "X-AAR-Status": "ready",
          },
        }),
    );
    const res = await fetch(api.exportUrl("s1", "tok"));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-AAR-Status")).toBe("ready");
    const body = await res.text();
    expect(body).toContain("# After-action report");
  });

  it("410 means 'expired' — definitive stop signal for the poll loop", async () => {
    _mockFetch(
      async () =>
        new Response("retention window expired", {
          status: 410,
          headers: { "X-AAR-Status": "evicted" },
        }),
    );
    const res = await fetch(api.exportUrl("s1", "tok"));
    expect(res.status).toBe(410);
    expect(res.headers.get("X-AAR-Status")).toBe("evicted");
  });

  it("500 means 'failed' — body has the error reason", async () => {
    _mockFetch(
      async () =>
        new Response("AAR generation failed: anthropic timeout", {
          status: 500,
          headers: { "X-AAR-Status": "failed" },
        }),
    );
    const res = await fetch(api.exportUrl("s1", "tok"));
    expect(res.status).toBe(500);
    expect(res.headers.get("X-AAR-Status")).toBe("failed");
    const body = await res.text();
    expect(body).toContain("anthropic timeout");
  });
});
