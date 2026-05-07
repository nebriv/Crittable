import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

// Stub the WS module BEFORE importing Facilitator so the connect()
// effect doesn't try to open a real socket. Returns a no-op client
// that swallows every send/close call.
vi.mock("../lib/ws", () => {
  return {
    WsClient: class {
      connect() {
        /* no-op */
      }
      close() {
        /* no-op */
      }
      send() {
        /* no-op */
      }
    },
  };
});

import {
  api,
  type ScenarioPlan,
  type SessionSnapshot,
  DEFAULT_SESSION_FEATURES,
} from "../api/client";
import { Facilitator } from "../pages/Facilitator";

function fakePlan(): ScenarioPlan {
  return {
    title: "Operation Test Echo",
    executive_summary: "Ransomware drill in a regional hospital.",
    key_objectives: ["Identify patient zero by beat 3"],
    guardrails: ["No real exploit code"],
    success_criteria: ["Containment decision documented"],
    out_of_scope: ["Insurance specifics"],
    narrative_arc: [
      { beat: 1, label: "Detection", expected_actors: ["IR Lead"] },
    ],
    injects: [{ trigger: "T+10", type: "info", summary: "ping" }],
  };
}

function fakeSnapshotWithoutPlan(): SessionSnapshot {
  return {
    id: "session_test",
    state: "SETUP",
    created_at: "2026-05-07T00:00:00Z",
    scenario_prompt: "test scenario",
    settings: {
      difficulty: "standard",
      duration_minutes: 60,
      features: { ...DEFAULT_SESSION_FEATURES },
    },
    plan: null,
    roles: [],
    current_turn: null,
    messages: [],
    setup_notes: [
      {
        ts: "2026-05-07T00:00:01Z",
        speaker: "ai",
        content: "What's your industry?",
        topic: null,
        options: null,
      },
    ],
    cost: null,
    workstreams: [],
  };
}

function fakeSnapshotWithPlan(): SessionSnapshot {
  return { ...fakeSnapshotWithoutPlan(), plan: fakePlan() };
}

/**
 * Regression net for the bug fixed in this PR: clicking LOOKS READY —
 * PROPOSE THE PLAN previously called ``api.setupFinalize`` immediately
 * after the AI returned a plan, which transitioned the session
 * SETUP → READY and bumped the wizard from step 4 to step 5 without
 * the operator ever seeing the plan. The fix removes the auto-call;
 * finalize now only runs from the explicit APPROVE & START LOBBY click
 * in PlanPanel (which routes through ``handleApprovePlan``).
 *
 * The test drives the Facilitator from the intro form through
 * ROLL SESSION, fakes a SETUP-state session with a single AI question,
 * clicks LOOKS READY, and asserts:
 *   1. ``api.setupReply`` IS called (with the ``NUDGE_PROPOSE`` string).
 *   2. ``api.setupFinalize`` is NEVER called as part of that flow —
 *      the only legitimate call site is the operator's APPROVE click.
 *   3. The drafted plan title renders in the PlanPanel after the
 *      reply resolves, proving step 4 is the rendering surface.
 *
 * The WS module is mocked at the top of this file so the connect()
 * effect doesn't dial a real socket.
 */
describe("Facilitator — handleLooksReady doesn't auto-finalize (regression)", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does NOT call api.setupFinalize after LOOKS READY returns a plan", async () => {
    const createSpy = vi.spyOn(api, "createSession").mockResolvedValue({
      session_id: "session_test",
      creator_role_id: "role_creator",
      creator_token: "tok_creator",
      creator_join_url: "http://localhost/play/session_test/tok_creator",
      failed_invitees: [],
    });

    // First getSession (right after createSession) returns the no-plan
    // snapshot; the second one (right after setupReply) returns the
    // plan-bearing snapshot. Sequenced via mockImplementation so the
    // counter increments per call.
    let getSessionCalls = 0;
    const getSpy = vi
      .spyOn(api, "getSession")
      .mockImplementation(async () => {
        getSessionCalls += 1;
        if (getSessionCalls === 1) return fakeSnapshotWithoutPlan();
        return fakeSnapshotWithPlan();
      });

    const replySpy = vi.spyOn(api, "setupReply").mockResolvedValue({
      ok: true,
      plan_proposed: true,
      diagnostics: [],
    });
    const finalizeSpy = vi.spyOn(api, "setupFinalize");

    render(<Facilitator />);

    // Walk the intro wizard: scenario textarea (Step 1) → next →
    // next → ROLL SESSION. The creator label pre-fills to "CISO".
    const scenarioBox = screen.getByPlaceholderText(
      /What happened, when, at what severity/i,
    );
    fireEvent.change(scenarioBox, {
      target: { value: "ransomware in a hospital" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /NEXT · ENVIRONMENT/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /NEXT · ROLES/i }));
    // Submit via form.requestSubmit-equivalent: jsdom's button-click
    // → form-submit chain has known races, so trigger the form's
    // onSubmit directly by dispatching a submit event from the
    // ROLL SESSION button's enclosing form.
    const rollBtn = screen.getByRole("button", { name: /ROLL SESSION/i });
    const form = rollBtn.closest("form");
    if (!form) throw new Error("ROLL SESSION button not inside a form");
    fireEvent.submit(form);

    // Wait for the session to be created and the SetupView to mount
    // (the LOOKS READY button is the marker — it only renders inside
    // SetupView during the setup phase with no plan yet).
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
    await screen.findByRole("button", {
      name: /LOOKS READY — PROPOSE THE PLAN/i,
    });

    // Click LOOKS READY. The handler should call setupReply, then
    // getSession (which returns a plan-bearing snapshot), then STOP.
    fireEvent.click(
      screen.getByRole("button", {
        name: /LOOKS READY — PROPOSE THE PLAN/i,
      }),
    );

    // Wait for the plan to render in the PlanPanel header. The header
    // starts with "● PROPOSED PLAN — <title>" and is the load-bearing
    // signal that step 4 stayed mounted (vs. jumping to step 5).
    await screen.findByText(/PROPOSED PLAN — Operation Test Echo/i);

    // The actual regression assertions.
    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(replySpy).toHaveBeenCalledWith(
      "session_test",
      "tok_creator",
      expect.stringMatching(/draft the scenario plan now/i),
    );
    expect(finalizeSpy).not.toHaveBeenCalled();
    expect(getSpy).toHaveBeenCalledTimes(2);
  });
});
