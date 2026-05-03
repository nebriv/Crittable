/**
 * Page-level smoke tests for the Play view.
 *
 * Mounts the page through SETUP → BRIEFING → PLAY → ENDED + an error
 * recovery state, and asserts the CTA per state EXISTS in the
 * rendered DOM. This is **not** a layout-reachability test — jsdom
 * has no layout engine, so an unscrollable-overflow regression of
 * the 2026-04 Approve-button class would still slip past this file.
 * A true reachability harness needs Playwright (tracked as follow-
 * up); this file is the cheap regression net for "the page mounts
 * at all and the primary CTA is in the tree."
 *
 * Strategy:
 *   * Mock ``api.getSession`` to return curated snapshots per state.
 *   * Mock ``WsClient`` so the Play page treats it as connected
 *     without opening a real socket.
 *   * Pre-seed the localStorage display name so JoinIntro auto-
 *     resolves and the chat layout mounts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { Play } from "../pages/Play";
import { api, type SessionSnapshot } from "../api/client";

// ---------------------------------------------------------------- ws mock

const STATUS_CALLBACKS: Array<(s: string) => void> = [];

vi.mock("../lib/ws", () => {
  class FakeWsClient {
    private _onStatus: (s: string) => void;
    constructor(opts: { onStatus: (s: string) => void }) {
      this._onStatus = opts.onStatus;
      STATUS_CALLBACKS.push(opts.onStatus);
    }
    connect() {
      this._onStatus("open");
    }
    send() {
      /* noop */
    }
    sendNotepadUpdate() {
      /* noop */
    }
    close() {
      /* noop */
    }
  }
  return { WsClient: FakeWsClient };
});

// SharedNotepad imports tiptap which is heavy + DOM-fussy in jsdom.
// Stub the whole component out — the e2e cares about chrome reachability,
// not collaborative-editing internals.
vi.mock("../components/SharedNotepad", () => ({
  SharedNotepad: () => <div data-testid="shared-notepad-stub" />,
}));

// ---------------------------------------------------------------- snapshots

function _baseSnapshot(): SessionSnapshot {
  return {
    id: "s-test",
    state: "AWAITING_PLAYERS",
    created_at: "2026-05-03T00:00:00Z",
    scenario_prompt: "Ransomware via vendor portal",
    plan: {
      title: "Ransomware",
      executive_summary: "Detection at 03:14 on three finance laptops.",
      key_objectives: ["containment"],
      narrative_arc: [{ beat: 1, label: "Detection", expected_actors: ["SOC"] }],
      injects: [
        { trigger: "after beat 1", type: "critical", summary: "leak" },
      ],
      guardrails: [],
      success_criteria: [],
      out_of_scope: [],
    },
    roles: [
      {
        id: "role-creator",
        label: "CISO",
        display_name: "Alex",
        kind: "player",
        is_creator: true,
        token_version: 1,
      },
      {
        id: "role-soc",
        label: "SOC",
        display_name: "Bo",
        kind: "player",
        is_creator: false,
        token_version: 1,
      },
    ],
    current_turn: {
      index: 0,
      active_role_ids: ["role-soc"],
      submitted_role_ids: [],
      status: "open",
    },
    messages: [],
    setup_notes: null,
    cost: null,
    aar_status: null,
  };
}

function _setupSnapshot(): SessionSnapshot {
  const s = _baseSnapshot();
  s.state = "SETUP";
  s.current_turn = null;
  return s;
}

function _playSnapshot(): SessionSnapshot {
  const s = _baseSnapshot();
  s.state = "AWAITING_PLAYERS";
  s.messages = [
    {
      id: "m1",
      ts: "2026-05-03T00:00:01Z",
      role_id: null,
      kind: "ai_text",
      body: "**SOC** — what does the alert queue actually show?",
      tool_name: "broadcast",
      tool_args: null,
    },
  ];
  return s;
}

function _endedSnapshot(): SessionSnapshot {
  const s = _baseSnapshot();
  s.state = "ENDED";
  s.current_turn = null;
  s.aar_status = "generating";
  return s;
}

// ---------------------------------------------------------------- helpers

// SOC's role_id is encoded in the token's first segment as `role_id` JSON;
// the production code base64-decodes it. We mint a token that matches.
//
// IMPORTANT: production tokens are HMAC-signed via itsdangerous and verified
// on every request. This fake token skips signing because the WsClient and
// api.getSession are mocked — neither actually enforces the signature in
// these tests. Don't take this shape as the production contract; it isn't.
function _socToken(): string {
  const payload = btoa(JSON.stringify({ role_id: "role-soc" }))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  // Form: <header>.<sig>; the production decode only inspects the header.
  return `${payload}.sig`;
}

beforeEach(() => {
  STATUS_CALLBACKS.length = 0;
  // Pre-seed localStorage display name so JoinIntro auto-resolves.
  window.localStorage.setItem("atf-display-name:s-test", "Bo");
  vi.spyOn(api, "getSession").mockImplementation(async () => _baseSnapshot());
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- tests


describe("Play page e2e — state transitions", () => {
  it("SETUP: renders the JoinIntro waiting variant (player can't act yet)", async () => {
    vi.spyOn(api, "getSession").mockImplementation(async () => _setupSnapshot());
    render(<Play sessionId="s-test" token={_socToken()} />);
    await waitFor(() => {
      expect(screen.getByTestId("join-intro-waiting")).toBeInTheDocument();
    });
    // No composer in SETUP — the player can't submit anything.
    expect(screen.queryByPlaceholderText(/type your response/i)).toBeNull();
  });

  it("BRIEFING: surfaces the AI-preparing waiting variant", async () => {
    const briefing = _setupSnapshot();
    briefing.state = "BRIEFING";
    vi.spyOn(api, "getSession").mockImplementation(async () => briefing);
    render(<Play sessionId="s-test" token={_socToken()} />);
    await waitFor(() => {
      expect(screen.getByTestId("join-intro-waiting")).toBeInTheDocument();
    });
    // The BRIEFING copy should differ from the SETUP copy.
    expect(
      screen.getByText(/AI is preparing the scenario brief/i),
    ).toBeInTheDocument();
  });

  it("PLAY (AWAITING_PLAYERS): shows the chat layout and a reachable Composer", async () => {
    vi.spyOn(api, "getSession").mockImplementation(async () => _playSnapshot());
    render(<Play sessionId="s-test" token={_socToken()} />);
    // The waiting panel is gone in PLAY.
    await waitFor(() => {
      expect(screen.queryByTestId("join-intro-waiting")).toBeNull();
    });
    // Composer textarea is reachable (the primary CTA for an active player).
    const textarea = await screen.findByRole("textbox");
    expect(textarea).toBeInTheDocument();
    expect(textarea).not.toBeDisabled();
    // The AI's prior broadcast renders.
    expect(
      screen.getByText(/what does the alert queue actually show/i),
    ).toBeInTheDocument();
  });

  it("ENDED: renders the after-action review surface", async () => {
    vi.spyOn(api, "getSession").mockImplementation(async () => _endedSnapshot());
    render(<Play sessionId="s-test" token={_socToken()} />);
    await waitFor(() => {
      // The ENDED state replaces the chat surface with an AAR-pending
      // banner. Either of these two strings appears in the production
      // copy. We accept any of them.
      const text = document.body.textContent || "";
      expect(/after-action|debrief|generating|exercise complete|review/i.test(text)).toBe(true);
    });
  });

});

describe("Play page e2e — error / loading states", () => {
  it("snapshot fetch failure surfaces a recoverable error with a Retry CTA", async () => {
    // Clear the localStorage display name so the page goes through the
    // JoinIntro path (the only place that renders the snapshot error
    // surface). With a name set, Play.tsx falls through to the chat
    // shell which shows a loader.
    window.localStorage.removeItem("atf-display-name:s-test");
    vi.spyOn(api, "getSession").mockRejectedValue(new Error("boom: HTTP 500"));
    render(<Play sessionId="s-test" token={_socToken()} />);
    await waitFor(() =>
      expect(
        screen.getByText(/COULDN'T LOAD THE SESSION/i),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/boom: HTTP 500/i)).toBeInTheDocument();
    // The Retry button is the recovery CTA — must be reachable.
    expect(
      screen.getByRole("button", { name: /retry/i }),
    ).toBeInTheDocument();
  });
});
