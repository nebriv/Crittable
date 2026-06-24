import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "../lib/ws";

/**
 * Signal 2 (integration) — the broadcast ``turn_limit_reached`` WS event
 * drives the informational banner on the player surface.
 *
 * Captures the page's ``onEvent`` callback through a WsClient mock, then
 * fires the event and asserts the banner appears. The player (non-creator)
 * variant must NOT show an End button.
 */

const EVENT_CALLBACKS: Array<(e: ServerEvent) => void> = [];

vi.mock("../lib/ws", () => {
  class FakeWsClient {
    private _onStatus: (s: string) => void;
    constructor(opts: {
      onStatus: (s: string) => void;
      onEvent: (e: ServerEvent) => void;
    }) {
      this._onStatus = opts.onStatus;
      EVENT_CALLBACKS.push(opts.onEvent);
    }
    connect() {
      this._onStatus("open");
    }
    send() {
      /* noop */
    }
    subscribe() {
      return () => {};
    }
    close() {
      /* noop */
    }
  }
  return { WsClient: FakeWsClient };
});

// SharedNotepad pulls in tiptap (DOM-fussy in jsdom). Stub it out.
vi.mock("../components/SharedNotepad", () => ({
  SharedNotepad: () => <div data-testid="shared-notepad-stub" />,
}));

import { api, type SessionSnapshot, DEFAULT_SESSION_FEATURES } from "../api/client";
import { Play } from "../pages/Play";

function playSnapshot(): SessionSnapshot {
  return {
    id: "s-test",
    state: "AWAITING_PLAYERS",
    created_at: "2026-06-24T00:00:00Z",
    scenario_prompt: "Ransomware via vendor portal",
    plan_title: "Ransomware",
    plan_summary: "Detection at 03:14.",
    settings: {
      difficulty: "standard",
      duration_minutes: 60,
      features: { ...DEFAULT_SESSION_FEATURES },
    },
    plan: {
      title: "Ransomware",
      executive_summary: "Detection at 03:14.",
      key_objectives: ["containment"],
      narrative_arc: [{ beat: 1, label: "Detection", expected_actors: ["SOC"] }],
      injects: [],
      guardrails: [],
      success_criteria: [],
      out_of_scope: [],
    },
    roles: [
      {
        id: "role-soc",
        label: "SOC",
        display_name: "Bo",
        kind: "player",
        is_creator: false,
        token_version: 1,
      },
      {
        id: "role-creator",
        label: "CISO",
        display_name: "Alex",
        kind: "player",
        is_creator: true,
        token_version: 1,
      },
    ],
    current_turn: {
      index: 0,
      active_role_groups: [["role-soc"]],
      active_role_ids: ["role-soc"],
      submitted_role_ids: [],
      status: "open",
    },
    messages: [],
    setup_notes: null,
    cost: null,
    aar_status: null,
    workstreams: [],
  };
}

function socToken(): string {
  const payload = btoa(JSON.stringify({ role_id: "role-soc" }))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${payload}.sig`;
}

beforeEach(() => {
  EVENT_CALLBACKS.length = 0;
  window.localStorage.setItem("atf-display-name:s-test", "Bo");
  vi.spyOn(api, "getSession").mockImplementation(async () => playSnapshot());
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

function fire(evt: ServerEvent) {
  act(() => {
    for (const cb of EVENT_CALLBACKS) cb(evt);
  });
}

describe("Play — turn_limit_reached banner (player)", () => {
  it("shows the informational banner without an End button for a player", async () => {
    render(<Play sessionId="s-test" token={socToken()} />);
    // Wait for the snapshot to load (the transcript header renders).
    await waitFor(() => {
      expect(api.getSession).toHaveBeenCalled();
    });

    // No banner before the event.
    expect(screen.queryByTestId("turn-limit-banner")).not.toBeInTheDocument();

    fire({ type: "turn_limit_reached", max_turns: 10 });

    const banner = await screen.findByTestId("turn-limit-banner");
    expect(banner).toHaveTextContent(/Turn limit reached/i);
    expect(banner).toHaveTextContent(/10 TURNS/);
    // Player is not the creator → no End affordance, informational copy.
    expect(
      screen.queryByRole("button", { name: /END SESSION/i }),
    ).not.toBeInTheDocument();
    expect(banner).toHaveTextContent(/Your facilitator can end the session/i);
  });
});
