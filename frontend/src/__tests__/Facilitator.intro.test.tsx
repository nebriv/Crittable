import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Facilitator, TopBar } from "../pages/Facilitator";
import { BottomActionBar } from "../components/brand/BottomActionBar";
import { api } from "../api/client";
import {
  SESSION_DRAFT_STORAGE_KEY,
  writeStoredSessionDraft,
} from "../lib/sessionDraftStorage";
import { DEFAULT_SESSION_FEATURES } from "../api/client";

// Setup wizard splits the form across 3 steps (Scenario → Environment
// → Roles). Roles live on step 3, so every Roles assertion needs the
// wizard advanced two NEXT clicks. ``advanceToRoles`` runs the
// navigation; the creator-label-collision test sets the label on
// step 1 first, then advances.
async function advanceToRoles() {
  // The intro wizard renders only after the mount-time invite-code
  // probe resolves (one round-trip in real life, one microtask in
  // tests with the spy in ``beforeEach``). ``findByRole`` polls
  // until the first NEXT button appears, then the synchronous
  // chain runs.
  fireEvent.click(
    await screen.findByRole("button", { name: /NEXT · ENVIRONMENT/i }),
  );
  fireEvent.click(screen.getByRole("button", { name: /NEXT · ROLES/i }));
}

function getRolesFieldset(): HTMLElement {
  return screen.getByRole("group", { name: /Roles to invite/i });
}

describe("Facilitator intro — Roles step (issue #61, redesign)", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    vi.spyOn(api, "getInviteStatus").mockResolvedValue({
      required: false,
      valid: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("seeds the 5 mockup-defined builtin role slots", async () => {
    render(<Facilitator />);
    await advanceToRoles();
    const fs = getRolesFieldset();
    // All 5 builtin labels must render as rows regardless of toggle state.
    expect(within(fs).getByText("Incident Commander")).toBeInTheDocument();
    expect(within(fs).getByText("Cybersecurity Manager")).toBeInTheDocument();
    expect(within(fs).getByText("Cybersecurity Engineer")).toBeInTheDocument();
    expect(within(fs).getByText("Comms / Legal")).toBeInTheDocument();
    expect(within(fs).getByText("Executive Sponsor")).toBeInTheDocument();
  });

  it("all 5 builtin roles default to ACTIVE", async () => {
    render(<Facilitator />);
    await advanceToRoles();
    // ACTIVE pill on every default-active row is pressed. After the
    // user-agent review flagged "OFF default for Comms/Legal /
    // Executive Sponsor reads as broken without STANDBY context",
    // the defaults shifted to all-ACTIVE — operators opt out via
    // the toggle.
    for (const label of [
      "Incident Commander",
      "Cybersecurity Manager",
      "Cybersecurity Engineer",
      "Comms / Legal",
      "Executive Sponsor",
    ]) {
      const activeBtn = screen.getByRole("button", {
        name: new RegExp(`${label.replace(/\//g, ".")} active`, "i"),
      });
      expect(activeBtn).toHaveAttribute("aria-pressed", "true");
    }
  });

  it("toggling ACTIVE on a default-OFF row flips to active (direct off→active)", async () => {
    render(<Facilitator />);
    await advanceToRoles();
    // Toggle Executive Sponsor OFF first (since defaults are now all
    // active), then toggle ACTIVE to verify the off→active direction
    // works on the same handler.
    fireEvent.click(
      screen.getByRole("button", { name: /Executive Sponsor off/i }),
    );
    expect(
      screen.getByRole("button", { name: /Executive Sponsor off/i }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(
      screen.getByRole("button", { name: /Executive Sponsor active/i }),
    );
    expect(
      screen.getByRole("button", { name: /Executive Sponsor active/i }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: /Executive Sponsor off/i }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("disables ROLL SESSION + shows warning when zero invitees are active", async () => {
    render(<Facilitator />);
    await advanceToRoles();
    // Toggle every builtin OFF.
    for (const label of [
      "Incident Commander",
      "Cybersecurity Manager",
      "Cybersecurity Engineer",
      "Comms / Legal",
      "Executive Sponsor",
    ]) {
      fireEvent.click(
        screen.getByRole("button", {
          name: new RegExp(`${label.replace(/\//g, ".")} off`, "i"),
        }),
      );
    }
    // Submit button is disabled and the inline reason is shown.
    const submit = screen.getByRole("button", { name: /ROLL SESSION/i });
    expect(submit).toBeDisabled();
    expect(
      screen.getByText(/Activate at least one invitee role/i),
    ).toBeInTheDocument();
  });

  it("removes a builtin row via the × button (every row is removable)", async () => {
    render(<Facilitator />);
    await advanceToRoles();
    // Builtin rows now have a remove control too — the previous
    // "toggle-only" treatment frustrated operators who didn't want
    // a given builtin in their list at all.
    fireEvent.click(screen.getByLabelText("Remove Executive Sponsor"));
    expect(
      screen.queryByText("Executive Sponsor"),
    ).not.toBeInTheDocument();
  });

  it("toggling OFF on an active builtin row flips the pill state", async () => {
    render(<Facilitator />);
    await advanceToRoles();
    const offBtn = screen.getByRole("button", {
      name: /Incident Commander off/i,
    });
    fireEvent.click(offBtn);
    expect(offBtn).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: /Incident Commander active/i }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("adds a custom role row via the Add role button", async () => {
    render(<Facilitator />);
    await advanceToRoles();
    const draft = screen.getByLabelText("New role label") as HTMLInputElement;
    fireEvent.change(draft, { target: { value: "Threat Intel" } });
    fireEvent.click(screen.getByRole("button", { name: "Add role" }));
    expect(
      within(getRolesFieldset()).getByText("Threat Intel"),
    ).toBeInTheDocument();
    expect(draft.value).toBe("");
  });

  it("adds via Enter without submitting the form", async () => {
    const createSpy = vi.spyOn(api, "createSession");
    render(<Facilitator />);
    await advanceToRoles();
    const draft = screen.getByLabelText("New role label") as HTMLInputElement;
    fireEvent.change(draft, { target: { value: "Threat Intel" } });
    fireEvent.keyDown(draft, { key: "Enter" });
    expect(
      within(getRolesFieldset()).getByText("Threat Intel"),
    ).toBeInTheDocument();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("typing an existing label re-activates the existing slot instead of duplicating", async () => {
    render(<Facilitator />);
    await advanceToRoles();
    // Toggle OFF, then add the same label via the form — should flip
    // back to ACTIVE on the same row, no duplicate row.
    fireEvent.click(
      screen.getByRole("button", { name: /Incident Commander off/i }),
    );
    const draft = screen.getByLabelText("New role label") as HTMLInputElement;
    fireEvent.change(draft, { target: { value: "incident commander" } });
    fireEvent.click(screen.getByRole("button", { name: "Add role" }));
    expect(
      within(getRolesFieldset()).getAllByText(/Incident Commander/i),
    ).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: /Incident Commander active/i }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("ignores blank / whitespace-only role labels", async () => {
    render(<Facilitator />);
    await advanceToRoles();
    const draft = screen.getByLabelText("New role label") as HTMLInputElement;
    const addButton = screen.getByRole("button", { name: "Add role" });
    expect(addButton).toBeDisabled();
    fireEvent.change(draft, { target: { value: "   " } });
    fireEvent.keyDown(draft, { key: "Enter" });
    // Still only the 5 builtin rows.
    expect(
      within(getRolesFieldset()).queryByText(/^\s+$/),
    ).not.toBeInTheDocument();
  });

  it("removes a custom row via the × button", async () => {
    render(<Facilitator />);
    await advanceToRoles();
    const draft = screen.getByLabelText("New role label") as HTMLInputElement;
    fireEvent.change(draft, { target: { value: "Threat Intel" } });
    fireEvent.click(screen.getByRole("button", { name: "Add role" }));
    fireEvent.click(screen.getByLabelText("Remove Threat Intel"));
    expect(
      within(getRolesFieldset()).queryByText("Threat Intel"),
    ).not.toBeInTheDocument();
  });

  it("warns when the creator label collides with an active invitee row", async () => {
    render(<Facilitator />);
    await advanceToRoles();
    const labelInput = screen.getByPlaceholderText(
      /Your role label/i,
    ) as HTMLInputElement;
    // Incident Commander is ACTIVE by default — collide with it.
    fireEvent.change(labelInput, { target: { value: "Incident Commander" } });
    expect(
      screen.getByText(/won't be auto-added as a separate invitee/i),
    ).toBeInTheDocument();
  });

  it("collision warning clears when the colliding row is toggled OFF", async () => {
    render(<Facilitator />);
    await advanceToRoles();
    const labelInput = screen.getByPlaceholderText(
      /Your role label/i,
    ) as HTMLInputElement;
    fireEvent.change(labelInput, { target: { value: "Incident Commander" } });
    expect(
      screen.getByText(/won't be auto-added as a separate invitee/i),
    ).toBeInTheDocument();
    // Toggle the row OFF — the collision check only flags ACTIVE rows.
    fireEvent.click(
      screen.getByRole("button", { name: /Incident Commander off/i }),
    );
    expect(
      screen.queryByText(/won't be auto-added as a separate invitee/i),
    ).not.toBeInTheDocument();
  });
});

// Refresh-recovery: filling out the wizard then "refreshing" (i.e.
// unmounting + re-mounting <Facilitator/>) must restore the form
// fields the operator already typed. Without this, an accidental
// refresh wipes the entire setup — scenario brief, team, env,
// constraints, tuning panel, role roster. Storage round-trip is
// covered separately in sessionDraftStorage.test.ts; this block
// covers the wiring inside <Facilitator/>.
describe("Facilitator intro — refresh recovery", () => {
  beforeEach(() => {
    vi.spyOn(api, "getInviteStatus").mockResolvedValue({
      required: false,
      valid: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("restores scenario brief + current step after re-mount", async () => {
    const { unmount } = render(<Facilitator />);
    // Find + fill scenario, then advance one step so we exercise
    // both per-field persistence AND introStep persistence.
    const scenario = await screen.findByLabelText(/SCENARIO BRIEF/i);
    fireEvent.change(scenario, {
      target: { value: "Ransomware end-quarter close" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /NEXT · ENVIRONMENT/i }),
    );
    // Simulate a refresh by tearing down the React tree and rendering
    // a fresh <Facilitator/>. sessionStorage survives the unmount.
    unmount();
    render(<Facilitator />);
    // Step 2's environment header is the marker for "we landed on
    // step 2, not step 1". On step 1 the page header reads "Set the
    // scene"; on step 2 it reads "Shape the exercise".
    expect(
      await screen.findByText(/Shape the exercise/i),
    ).toBeInTheDocument();
    // The scenario brief value is preserved across the refresh
    // even though step 2 doesn't render the SCENARIO textarea —
    // navigate back to step 1 to confirm.
    fireEvent.click(screen.getByRole("button", { name: /← BACK/i }));
    const restored = (await screen.findByLabelText(
      /SCENARIO BRIEF/i,
    )) as HTMLTextAreaElement;
    expect(restored.value).toBe("Ransomware end-quarter close");
  });

  it("restores role-roster edits after re-mount", async () => {
    const { unmount } = render(<Facilitator />);
    await advanceToRoles();
    // Toggle a builtin OFF + add a custom row. The OFF pill is the
    // one that flips an ACTIVE row off (the ACTIVE pill is a no-op
    // when the row is already active).
    fireEvent.click(
      screen.getByRole("button", { name: /Executive Sponsor off/i }),
    );
    const draft = screen.getByLabelText("New role label") as HTMLInputElement;
    fireEvent.change(draft, { target: { value: "Threat Intel" } });
    fireEvent.click(screen.getByRole("button", { name: "Add role" }));
    // Refresh.
    unmount();
    render(<Facilitator />);
    // We're back on step 3 because introStep persisted.
    expect(
      await screen.findByRole("group", { name: /Roles to invite/i }),
    ).toBeInTheDocument();
    // Custom row survives the round-trip.
    expect(
      within(getRolesFieldset()).getByText("Threat Intel"),
    ).toBeInTheDocument();
    // Executive Sponsor stays OFF after the round-trip.
    expect(
      screen.getByRole("button", { name: /Executive Sponsor off/i }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("clears stored draft after a successful session create", async () => {
    // QA review MEDIUM: regression net for the
    // ``clearStoredSessionDraft()`` call inside ``handleCreate``.
    // Without this test a future refactor that drops the clear
    // would leave a stale draft in storage and a refresh after
    // create would dump the operator back into the wizard with
    // pre-populated form fields.
    vi.spyOn(api, "createSession").mockResolvedValue({
      session_id: "session_test",
      creator_role_id: "role_creator",
      creator_token: "tok_creator",
      creator_join_url: "http://localhost/play/session_test/tok_creator",
      failed_invitees: [],
    });
    vi.spyOn(api, "getSession").mockResolvedValue({
      id: "session_test",
      state: "SETUP",
      created_at: "2026-05-05T00:00:00Z",
      scenario_prompt: "scenario",
      plan_title: null,
      plan_summary: null,
      settings: {
        difficulty: "standard",
        duration_minutes: 60,
        features: { ...DEFAULT_SESSION_FEATURES },
      },
      plan: null,
      roles: [],
      current_turn: null,
      messages: [],
      setup_notes: [],
      cost: null,
      workstreams: [],
    });
    // Pre-seed a draft so we can assert it's gone after create.
    writeStoredSessionDraft({
      setupParts: {
        scenario: "to-be-cleared",
        team: "",
        environment: "",
        constraints: "",
      },
      creatorLabel: "CISO",
      creatorDisplayName: "Alice",
      setupRoleSlots: [
        {
          key: "IC",
          code: "IC",
          label: "Incident Commander",
          active: true,
          builtin: true,
        },
      ],
      setupRoleDraft: "",
      difficulty: "standard",
      durationMinutes: 60,
      features: { ...DEFAULT_SESSION_FEATURES },
      introStep: 3,
    });
    expect(
      window.sessionStorage.getItem(SESSION_DRAFT_STORAGE_KEY),
    ).not.toBeNull();
    render(<Facilitator />);
    // Land on step 3 thanks to the restored introStep.
    await screen.findByRole("group", { name: /Roles to invite/i });
    const rollBtn = screen.getByRole("button", { name: /ROLL SESSION/i });
    const form = rollBtn.closest("form");
    if (!form) throw new Error("ROLL SESSION button not inside a form");
    fireEvent.submit(form);
    // Wait for the storage entry to drop. The clear happens
    // synchronously inside ``handleCreate`` right after the
    // ``setState`` for the creator info.
    await waitFor(() => {
      expect(
        window.sessionStorage.getItem(SESSION_DRAFT_STORAGE_KEY),
      ).toBeNull();
    });
  });

  it("preserves an explicitly emptied roster instead of re-seeding builtins", async () => {
    // QA review HIGH: if the operator deliberately removed every
    // builtin row, refreshing must NOT silently restore the canonical
    // 5. Step 3's Add-role input remains available so the operator
    // can recover from an empty list — that's the affordance, not a
    // paternalistic re-seed.
    const { unmount } = render(<Facilitator />);
    await advanceToRoles();
    // Remove all 5 builtins via the × button on each row.
    for (const label of [
      "Incident Commander",
      "Cybersecurity Manager",
      "Cybersecurity Engineer",
      "Comms / Legal",
      "Executive Sponsor",
    ]) {
      fireEvent.click(screen.getByLabelText(`Remove ${label}`));
    }
    // ROLL SESSION button is disabled (no active invitees).
    expect(screen.getByRole("button", { name: /ROLL SESSION/i })).toBeDisabled();
    // Refresh.
    unmount();
    render(<Facilitator />);
    // After refresh we're still on Step 3 with an empty roster — no
    // builtin re-seed. The submit button stays disabled.
    expect(
      await screen.findByRole("group", { name: /Roles to invite/i }),
    ).toBeInTheDocument();
    expect(
      within(getRolesFieldset()).queryByText("Incident Commander"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ROLL SESSION/i })).toBeDisabled();
  });
});

// Post-redesign: most operator telemetry + phase CTAs moved out of
// the top bar (which is now brand chrome) into a sticky bottom action
// bar. The TopBar still renders STATE/PHASE/PLAYERS/AAR-status pills;
// every "Start session", "End session", "View AAR" button + every
// dense telemetry chip (T#, msgs, rationale, tabs, last event, LLM,
// cost, build SHA, God Mode, "+ NEW SESSION") lives in BottomActionBar.
const baseProps = {
  onStart: vi.fn(),
  onForceAdvance: vi.fn(),
  onEnd: vi.fn(),
  onNewSession: vi.fn(),
  onViewAar: vi.fn(),
  onToggleGodMode: vi.fn(),
  busy: false,
  backendState: "READY",
  wsStatus: "open" as const,
  godMode: false,
  turnIndex: null,
  rationaleCount: 0,
  connectionCount: null,
  lastEventAt: null,
  cost: null,
  messageCount: 0,
  activeTiers: [] as string[],
  // Issue #70: multi-state LLM chip needs ai_paused + recoveryStatus + turnErrored.
  aiPaused: false,
  recoveryStatus: null as { kind: string; attempt?: number; budget?: number } | null,
  turnErrored: false,
  // Issue #33-lite: tuning chip surfaces creator-frozen difficulty
  // + duration. ``null`` while the snapshot hasn't loaded; here we
  // pass concrete values so the chip renders in tests that exercise
  // the rest of the bar.
  difficulty: "standard" as const,
  durationMinutes: 60,
  buildSha: "abcdef0",
  buildTs: "2026-05-01T00:00:00Z",
};

describe("BottomActionBar — phase CTAs (issue #62)", () => {
  it("renders START SESSION disabled when plan not finalized", async () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="setup"
        playerCount={3}
        hasFinalizedPlan={false}
        aarStatus={null}
      />,
    );
    const btn = screen.getByRole("button", { name: /START SESSION/i });
    expect(btn).toBeDisabled();
  });

  it("renders START SESSION disabled when fewer than 2 players", async () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="ready"
        playerCount={1}
        hasFinalizedPlan={true}
        aarStatus={null}
      />,
    );
    expect(
      screen.getByRole("button", { name: /START SESSION/i }),
    ).toBeDisabled();
  });

  it("enables START SESSION when plan finalized and ≥2 players", async () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="ready"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
      />,
    );
    const btn = screen.getByRole("button", { name: /START SESSION/i });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(baseProps.onStart).toHaveBeenCalled();
  });

  it("renders FORCE-ADVANCE + END SESSION buttons during play", async () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="play"
        playerCount={3}
        hasFinalizedPlan={true}
        aarStatus={null}
      />,
    );
    expect(
      screen.getByRole("button", { name: /FORCE-ADVANCE/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /END SESSION/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /START SESSION/i }),
    ).not.toBeInTheDocument();
  });

  it("renders VIEW AAR when ended phase + AAR ready", async () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="ended"
        playerCount={3}
        hasFinalizedPlan={true}
        aarStatus="ready"
      />,
    );
    expect(
      screen.getByRole("button", { name: /VIEW AAR/i }),
    ).toBeInTheDocument();
  });

  it("surfaces turn / message / rationale / tabs / cost telemetry chips", async () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="play"
        playerCount={3}
        hasFinalizedPlan={true}
        aarStatus={null}
        turnIndex={4}
        messageCount={42}
        rationaleCount={7}
        connectionCount={5}
        cost={{
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_tokens: 200,
          cache_creation_tokens: 100,
          estimated_usd: 0.0234,
        }}
      />,
    );
    expect(screen.getByText("T#4")).toBeInTheDocument();
    expect(screen.getByText("42 msgs")).toBeInTheDocument();
    expect(screen.getByText("Rationale: 7")).toBeInTheDocument();
    expect(screen.getByText("Tabs: 5")).toBeInTheDocument();
    expect(screen.getByText("Cost: $0.0234")).toBeInTheDocument();
  });

  it("renders dash placeholders when telemetry is null", async () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="setup"
        playerCount={1}
        hasFinalizedPlan={false}
        aarStatus={null}
      />,
    );
    expect(screen.getByText("T#—")).toBeInTheDocument();
    expect(screen.getByText("Tabs: —")).toBeInTheDocument();
    expect(screen.getByText("Cost: $—")).toBeInTheDocument();
    expect(screen.getByText(/Last: —/)).toBeInTheDocument();
  });

  it("renders 'Last: <Ns' once a lastEventAt timestamp is set", async () => {
    const fiveSecondsAgo = Date.now() - 5_500;
    render(
      <BottomActionBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
        lastEventAt={fiveSecondsAgo}
      />,
    );
    expect(screen.getByText(/Last: 5s/)).toBeInTheDocument();
  });

  it("renders 'LLM: idle' when no LLM calls are in flight", async () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
      />,
    );
    expect(screen.getByText("LLM: idle")).toBeInTheDocument();
  });

  it("renders 'LLM: <tier>' when a single tier is active", async () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
        activeTiers={["play"]}
      />,
    );
    expect(screen.getByText("LLM: play")).toBeInTheDocument();
    expect(screen.queryByText("LLM: idle")).not.toBeInTheDocument();
  });

  it("joins multiple concurrent tiers with '+' (e.g. guardrail + play)", async () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
        activeTiers={["guardrail", "play"]}
      />,
    );
    expect(screen.getByText("LLM: guardrail+play")).toBeInTheDocument();
  });

  // Issue #70: multi-state LLM chip — distinguish recovering / paused
  // / waiting-for-players / recovery-failed from the legacy binary
  // "thinking-or-idle" chip. Each branch is the cure for an
  // operationally-distinct state that used to read as "LLM: idle"
  // and was the diagnostic gap behind the silent-yield 5-hour log
  // dive.
  it("renders 'LLM: idle (paused)' when the AI is paused with no calls in flight", async () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
        aiPaused={true}
      />,
    );
    expect(screen.getByText("LLM: idle (paused)")).toBeInTheDocument();
  });

  it("renders 'LLM: waiting for players' on AWAITING_PLAYERS with no calls in flight", async () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
        backendState="AWAITING_PLAYERS"
      />,
    );
    expect(
      screen.getByText("LLM: waiting for players"),
    ).toBeInTheDocument();
  });

  it("renders 'LLM: recovering N/M (kind)' during a recovery cascade", async () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
        recoveryStatus={{
          kind: "missing_drive",
          attempt: 2,
          budget: 3,
        }}
      />,
    );
    // Check substring rather than full string so "last attempt" cue
    // is verified separately in its own case.
    expect(
      screen.getByText(/LLM: recovering 2\/3.*missing drive/),
    ).toBeInTheDocument();
  });

  it("appends 'last attempt' when recovery hits the budget (UI/UX HIGH #2)", async () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
        recoveryStatus={{
          kind: "missing_yield",
          attempt: 3,
          budget: 3,
        }}
      />,
    );
    expect(
      screen.getByText(/LLM: recovering 3\/3 — last attempt/),
    ).toBeInTheDocument();
  });

  it("appends '· paused' to the in-flight chip when paused mid-recovery (User Agent MEDIUM #6)", async () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
        aiPaused={true}
        recoveryStatus={{
          kind: "missing_drive",
          attempt: 2,
          budget: 3,
        }}
      />,
    );
    expect(
      screen.getByText(/LLM: recovering 2\/3.*missing drive.*· paused/),
    ).toBeInTheDocument();
  });

  it("renders crit 'LLM: recovery FAILED' when the current turn errored (User Agent HIGH #3)", async () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
        turnErrored={true}
      />,
    );
    expect(screen.getByText("LLM: recovery FAILED")).toBeInTheDocument();
    // Even with concurrent recovery + active tiers, the errored
    // signal wins the chip because it's the operator's call to act
    // on. Without this, the silent-yield class of bug stays hidden
    // the moment the strict-retry loop exits.
  });

  it("turnErrored wins over recoveryStatus + activeTiers (priority order)", async () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
        turnErrored={true}
        recoveryStatus={{ kind: "missing_yield", attempt: 3, budget: 3 }}
        activeTiers={["play"]}
      />,
    );
    expect(screen.getByText("LLM: recovery FAILED")).toBeInTheDocument();
    expect(screen.queryByText(/recovering/)).not.toBeInTheDocument();
    expect(screen.queryByText("LLM: play")).not.toBeInTheDocument();
  });

  it("expands the cost chip to show the token breakdown", async () => {
    render(
      <BottomActionBar
        {...baseProps}
        phase="play"
        playerCount={2}
        hasFinalizedPlan={true}
        aarStatus={null}
        cost={{
          input_tokens: 12345,
          output_tokens: 6789,
          cache_read_tokens: 100,
          cache_creation_tokens: 50,
          estimated_usd: 1.2345,
        }}
      />,
    );
    const summary = screen.getByText("Cost: $1.2345");
    fireEvent.click(summary);
    expect(screen.getByText("Cost — token breakdown")).toBeInTheDocument();
    expect(screen.getByText("12,345")).toBeInTheDocument();
    expect(screen.getByText("6,789")).toBeInTheDocument();
  });

  it("always renders '+ NEW SESSION' regardless of phase", async () => {
    for (const phase of ["setup", "ready", "play", "ended"] as const) {
      const { unmount } = render(
        <BottomActionBar
          {...baseProps}
          phase={phase}
          playerCount={2}
          hasFinalizedPlan={true}
          aarStatus="ready"
        />,
      );
      expect(
        screen.getByRole("button", { name: /NEW SESSION/i }),
      ).toBeInTheDocument();
      unmount();
    }
  });
});

describe("TopBar — brand chrome (post-redesign)", () => {
  const minimalProps = { ...baseProps };

  it("renders the AAR-generating status when ended phase + AAR pending", async () => {
    render(
      <TopBar
        {...minimalProps}
        phase="ended"
        playerCount={3}
        hasFinalizedPlan={true}
        aarStatus="pending"
      />,
    );
    expect(screen.getByText(/AAR GENERATING/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /VIEW AAR/i }),
    ).not.toBeInTheDocument();
  });

  it("renders the VIEW AAR button when ended phase + AAR ready", async () => {
    render(
      <TopBar
        {...minimalProps}
        phase="ended"
        playerCount={3}
        hasFinalizedPlan={true}
        aarStatus="ready"
      />,
    );
    expect(
      screen.getByRole("button", { name: /VIEW AAR/i }),
    ).toBeInTheDocument();
  });
});
