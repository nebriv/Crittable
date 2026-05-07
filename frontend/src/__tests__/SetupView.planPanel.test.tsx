import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupView } from "../pages/Facilitator";
import {
  DEFAULT_SESSION_FEATURES,
  type ScenarioPlan,
  type SessionSnapshot,
} from "../api/client";

/**
 * Coverage for the plan-panel side-rail refactor (this PR). The user's
 * complaint was that the AI-proposed plan rendered *below* the chat
 * reply form, so the Approve button sat in the form's button row
 * instead of next to the artifact it commits. The fix: 2-column
 * layout at xl+, plan in an aside on the right with its own Approve
 * button at the bottom.
 *
 * These tests guard the two structural branches (no-plan, with-plan)
 * and the load-bearing copy / aria-label / placeholder details. They
 * don't exercise sticky-positioning behavior (jsdom has no layout)
 * — that piece is covered by manual smoke at xl viewports per the
 * CLAUDE.md "for UI changes, drive the dev server in a browser" rule.
 */

function fakeSnapshot(plan: ScenarioPlan | null): SessionSnapshot {
  return {
    id: "session_test",
    state: plan ? "SETUP" : "SETUP",
    created_at: "2026-05-05T00:00:00Z",
    scenario_prompt: "test scenario",
    settings: {
      difficulty: "standard",
      duration_minutes: 60,
      features: { ...DEFAULT_SESSION_FEATURES },
    },
    plan,
    roles: [],
    current_turn: null,
    messages: [],
    setup_notes: [
      {
        ts: "2026-05-05T00:00:01Z",
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

function fakePlan(): ScenarioPlan {
  return {
    title: "Operation Chalk Dust",
    executive_summary: "A ransomware exercise in a K-12 environment.",
    key_objectives: ["Identify patient zero by beat 3"],
    guardrails: ["No real exploit code"],
    success_criteria: ["Containment decision documented"],
    out_of_scope: ["Insurance specifics"],
    narrative_arc: [{ beat: 1, label: "Detection", expected_actors: ["IR Lead"] }],
    injects: [{ trigger: "T+10", type: "info", summary: "ping" }],
  };
}

function baseProps() {
  return {
    setupReply: "",
    setSetupReply: vi.fn(),
    onSubmit: vi.fn((e: React.FormEvent) => e.preventDefault()),
    onLooksReady: vi.fn(),
    onApprovePlan: vi.fn(),
    onSkipSetup: vi.fn(),
    onPickOption: vi.fn(),
    busy: false,
    busyMessage: null,
    draftingPlan: false,
  };
}

describe("SetupView — no plan branch", () => {
  it("renders single-column conversation with LOOKS READY and no plan aside", () => {
    render(<SetupView snapshot={fakeSnapshot(null)} {...baseProps()} />);

    // No aside is rendered when hasPlan is false.
    expect(
      screen.queryByRole("complementary", { name: /Proposed plan/i }),
    ).not.toBeInTheDocument();

    // LOOKS READY button is visible (the nudge to draft the plan).
    expect(
      screen.getByRole("button", { name: /LOOKS READY — PROPOSE THE PLAN/i }),
    ).toBeInTheDocument();

    // APPROVE & START LOBBY is NOT in the form (it lives only in the
    // panel which doesn't exist yet).
    expect(
      screen.queryByRole("button", { name: /APPROVE & START LOBBY/i }),
    ).not.toBeInTheDocument();
  });

  it("uses neutral helper copy that doesn't reference the absent panel", () => {
    render(<SetupView snapshot={fakeSnapshot(null)} {...baseProps()} />);
    // Pre-plan copy: the helper paragraph emphasizes the LOOKS READY
    // action via an <em> tag (matching the conditional branch in
    // SetupView). This selector pins it to the paragraph copy, not
    // the button label, which would also match the regex.
    expect(
      screen.getByText(/Looks ready — propose the plan/i, { selector: "em" }),
    ).toBeInTheDocument();
    // Must NOT mention the panel that doesn't exist yet.
    expect(screen.queryByText(/proposed-plan panel/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/on the right/i)).not.toBeInTheDocument();
  });

  it("uses the default placeholder on the reply textarea", () => {
    render(<SetupView snapshot={fakeSnapshot(null)} {...baseProps()} />);
    expect(
      screen.getByPlaceholderText(/Type your reply to the AI/i),
    ).toBeInTheDocument();
  });
});

describe("SetupView — with-plan branch", () => {
  it("renders the plan inside an aside labeled 'Proposed plan'", () => {
    render(<SetupView snapshot={fakeSnapshot(fakePlan())} {...baseProps()} />);
    const aside = screen.getByRole("complementary", { name: /Proposed plan/i });
    expect(aside).toBeInTheDocument();
    // Plan title appears in the panel header (not just buried inside
    // PlanView's body) so the operator keeps context after scrolling.
    expect(
      within(aside).getByText(/PROPOSED PLAN — Operation Chalk Dust/i),
    ).toBeInTheDocument();
  });

  it("places APPROVE & START LOBBY inside the panel, not in the form", () => {
    render(<SetupView snapshot={fakeSnapshot(fakePlan())} {...baseProps()} />);
    const aside = screen.getByRole("complementary", { name: /Proposed plan/i });
    const approve = within(aside).getByRole("button", {
      name: /APPROVE & START LOBBY/i,
    });
    expect(approve).toBeInTheDocument();

    // It must NOT also appear in the conversation form (no duplicate).
    const allApproves = screen.getAllByRole("button", {
      name: /APPROVE & START LOBBY/i,
    });
    expect(allApproves).toHaveLength(1);
  });

  it("hides LOOKS READY once a plan exists (Approve is the next step)", () => {
    render(<SetupView snapshot={fakeSnapshot(fakePlan())} {...baseProps()} />);
    expect(
      screen.queryByRole("button", { name: /LOOKS READY — PROPOSE THE PLAN/i }),
    ).not.toBeInTheDocument();
  });

  it("invokes onApprovePlan when the panel's Approve button is clicked", () => {
    const props = baseProps();
    render(<SetupView snapshot={fakeSnapshot(fakePlan())} {...props} />);
    const aside = screen.getByRole("complementary", { name: /Proposed plan/i });
    fireEvent.click(
      within(aside).getByRole("button", { name: /APPROVE & START LOBBY/i }),
    );
    expect(props.onApprovePlan).toHaveBeenCalledOnce();
  });

  it("uses revision-oriented placeholder + helper copy that aligns with the panel button", () => {
    render(<SetupView snapshot={fakeSnapshot(fakePlan())} {...baseProps()} />);
    expect(
      screen.getByPlaceholderText(/Want changes\? Tell the AI what to revise/i),
    ).toBeInTheDocument();
    // Helper copy must use the actual button label ("Approve & start
    // lobby") so a first-time creator scanning for the action finds
    // the matching button immediately. The pre-fix copy said
    // "Approve plan" which mismatched the rendered label.
    expect(
      screen.getByText(/Approve & start lobby/i, { selector: "em" }),
    ).toBeInTheDocument();
  });

  it("disables Approve while busy", () => {
    render(
      <SetupView snapshot={fakeSnapshot(fakePlan())} {...baseProps()} busy />,
    );
    const aside = screen.getByRole("complementary", { name: /Proposed plan/i });
    const approve = within(aside).getByRole("button", {
      name: /APPROVE & START LOBBY/i,
    });
    expect(approve).toBeDisabled();
  });
});

/**
 * The plan-drafting wait is 5–30 s of non-streaming LLM work; pre-fix,
 * the operator only saw the small typing dots inside the chat
 * transcript and the LOOKS READY button reading as "stuck." A
 * prominent in-chat banner with the brand DieLoader names the wait
 * as an explicit step.
 *
 * Two banner variants share one ``data-testid="drafting-plan-banner"``
 * element; ``data-banner-variant`` distinguishes them:
 *
 *  - ``looks-ready`` — driven by the ``draftingPlan`` prop
 *    (Facilitator's ``handleLooksReady`` click). Mounts immediately,
 *    label "Drafting scenario plan · typically 10–30 sec". A plan IS
 *    the documented next step here.
 *  - ``implicit-thinking`` — internal SetupView state. Mounts after
 *    a 1.5 s debounce when ``busy && !hasPlan && !draftingPlan``.
 *    Label "AI is thinking · typically 5–30 sec" — neutral because
 *    the AI may end up drafting another question or the plan, and we
 *    can't tell mid-call (the setup tier is non-streaming). Quick
 *    chip-pick turns under the threshold keep the small typing dots
 *    only — no heavy banner mount/unmount thrash.
 *
 * The banner intentionally relies on ``<DieLoader>``'s own
 * ``role="status" aria-live="polite"`` rather than wrapping in a
 * second status region (nested live regions are flaky across screen
 * readers). The label inside DieLoader carries the timing
 * expectation so a single announcement covers both pieces.
 */
describe("SetupView — draftingPlan banner", () => {
  it("does NOT render the banner when not busy and no draftingPlan", () => {
    render(<SetupView snapshot={fakeSnapshot(null)} {...baseProps()} />);
    expect(screen.queryByTestId("drafting-plan-banner")).not.toBeInTheDocument();
  });

  it("renders the LOOKS-READY banner immediately (no debounce) with the plan-specific label", () => {
    render(
      <SetupView
        snapshot={fakeSnapshot(null)}
        {...baseProps()}
        busy
        busyMessage="Drafting the scenario plan…"
        draftingPlan
      />,
    );
    const banner = screen.getByTestId("drafting-plan-banner");
    expect(banner).toBeInTheDocument();
    // The plan-specific variant is honest only when LOOKS READY was
    // explicitly clicked — that's what ``draftingPlan`` represents.
    expect(banner).toHaveAttribute("data-banner-variant", "looks-ready");
    // The DieLoader label is the load-bearing copy — names the step
    // ("Drafting scenario plan") and sets a timing expectation
    // ("typically 10–30 sec"). The operator's complaint was "feels
    // stuck"; the timing window is what turns "stuck" into "patient."
    expect(
      within(banner).getByText(/Drafting scenario plan/i),
    ).toBeInTheDocument();
    expect(within(banner).getByText(/10–30 sec/i)).toBeInTheDocument();
  });

  it("hides the banner once a plan exists, even if draftingPlan is still true", () => {
    // Race-guard regression test: the Facilitator clears
    // ``draftingPlan`` as soon as the plan lands, but a render-cycle
    // race could leave both true for a frame. The ``!hasPlan`` guard
    // in the JSX must hide the banner when a plan is present so the
    // operator never sees a "drafting" caption flashing over a new
    // plan card. Passing ``draftingPlan={true}`` AND a plan
    // exercises the guard directly (vs. the prior tautological
    // ``draftingPlan={false}`` test the QA agent flagged).
    render(
      <SetupView
        snapshot={fakeSnapshot(fakePlan())}
        {...baseProps()}
        draftingPlan
      />,
    );
    expect(screen.queryByTestId("drafting-plan-banner")).not.toBeInTheDocument();
  });

  it("suppresses the small BusyChip while the prominent banner is showing", () => {
    // UI/UX + user-persona reviews flagged BusyChip + banner +
    // chat-typing-dots as redundant indicators. While
    // ``draftingPlan=true``, only the banner should be visible. The
    // BusyChip resumes for the post-plan finalize step.
    render(
      <SetupView
        snapshot={fakeSnapshot(null)}
        {...baseProps()}
        busy
        busyMessage="Drafting the scenario plan…"
        draftingPlan
      />,
    );
    // Banner is present, chip text is NOT.
    expect(screen.getByTestId("drafting-plan-banner")).toBeInTheDocument();
    expect(
      screen.queryByText(/Drafting the scenario plan…/),
    ).not.toBeInTheDocument();
  });

  it("keeps option chips disabled while drafting (concurrency regression guard)", () => {
    // PR #186 review BLOCK from Copilot: the original
    // ``busy={busy && !draftingPlan}`` pass-through to <SetupChat>
    // collapsed the chip-disable flag and the typing-indicator
    // visibility into one prop, which re-enabled the latest AI
    // question's option chips during the in-flight LOOKS READY
    // request. A click on a chip would dispatch a second
    // overlapping ``api.setupReply()`` (``callSetup`` has no
    // already-busy gate). Fix: split into ``busy`` (chip disable)
    // and ``aiTyping`` (indicator visibility); pass full ``busy``
    // for the disable. This test pins that invariant: with
    // ``draftingPlan=true`` AND a chip-bearing AI question as the
    // last note, every chip must be ``disabled``.
    const snapshotWithOptions: SessionSnapshot = {
      ...fakeSnapshot(null),
      setup_notes: [
        {
          ts: "2026-05-05T00:00:01Z",
          speaker: "ai",
          content: "Pick one:",
          topic: "preference",
          options: ["Option A", "Option B"],
        },
      ],
    };
    render(
      <SetupView
        snapshot={snapshotWithOptions}
        {...baseProps()}
        busy
        draftingPlan
      />,
    );
    expect(screen.getByRole("button", { name: "Option A" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Option B" })).toBeDisabled();
  });
});

/**
 * The implicit-thinking variant covers the case the user reported in
 * the bug fix that introduced this code: when the AI is processing a
 * regular setup reply (not LOOKS READY) and may decide to draft the
 * plan on its own, the operator was previously left with only the
 * small typing dots — feels stuck.
 *
 * Two design rules these tests pin (both came directly from review):
 *  - **Debounce.** Quick turns (chip pick → 5 s question response)
 *    keep the small typing dots; only slow turns (≳1.5 s) escalate
 *    to the banner. Without the debounce, fast Q&A round-trips cause
 *    the heavy banner to mount/unmount on every reply, training the
 *    operator to ignore it (banner-fatigue) and undermining its
 *    signal value when LOOKS-READY actually runs.
 *  - **Neutral label.** "AI is thinking · typically 5–30 sec"
 *    rather than "Drafting scenario plan". The setup tier is
 *    non-streaming so we can't tell mid-call whether the AI is
 *    producing another question or the actual plan; a neutral label
 *    is honest in either case. The plan-specific label is reserved
 *    for ``draftingPlan`` (LOOKS-READY click) where a plan IS the
 *    documented next step.
 */
describe("SetupView — implicit-thinking banner (debounced)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT render under the 1500 ms debounce threshold", () => {
    render(
      <SetupView
        snapshot={fakeSnapshot(null)}
        {...baseProps()}
        busy
        busyMessage="AI is thinking — drafting the next setup question…"
      />,
    );
    // Banner is absent at t=0.
    expect(screen.queryByTestId("drafting-plan-banner")).not.toBeInTheDocument();
    // Still absent just before the threshold — fast turns shouldn't
    // mount the heavy banner.
    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(screen.queryByTestId("drafting-plan-banner")).not.toBeInTheDocument();
  });

  it("renders with the neutral label after the 1500 ms debounce", () => {
    render(
      <SetupView
        snapshot={fakeSnapshot(null)}
        {...baseProps()}
        busy
        busyMessage="AI is thinking — drafting the next setup question…"
      />,
    );
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    const banner = screen.getByTestId("drafting-plan-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveAttribute("data-banner-variant", "implicit-thinking");
    // Neutral label is honest whether the AI ends up drafting another
    // question or the plan.
    expect(within(banner).getByText(/AI is thinking/i)).toBeInTheDocument();
    expect(within(banner).getByText(/5–30 sec/i)).toBeInTheDocument();
    // The plan-specific label MUST NOT appear in the implicit branch
    // — it would lie when the AI is just drafting another question.
    expect(
      within(banner).queryByText(/Drafting scenario plan/i),
    ).not.toBeInTheDocument();
  });

  it("clears in the same render commit when busy goes false (no flicker)", () => {
    // Copilot PR #201 review flagged a one-frame flicker risk: the
    // latched ``showImplicitThinkingBanner`` state would still be
    // true on the render where ``busy`` flipped false, until the
    // ``useEffect`` cleanup committed the reset. The fix is to gate
    // ``showThinkingBanner`` on ``busy`` directly. This test pins
    // that — the banner must be absent on the very first render
    // after ``busy=false`` is passed in, BEFORE any subsequent
    // effect tick.
    const { rerender } = render(
      <SetupView
        snapshot={fakeSnapshot(null)}
        {...baseProps()}
        busy
        busyMessage="AI is thinking…"
      />,
    );
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByTestId("drafting-plan-banner")).toBeInTheDocument();
    // Re-render with busy=false but DON'T wrap in act — we want to
    // observe the synchronous render commit. (act wraps state +
    // effect flushes; the gate must work without that.)
    rerender(
      <SetupView
        snapshot={fakeSnapshot(null)}
        {...baseProps()}
        busy={false}
      />,
    );
    expect(screen.queryByTestId("drafting-plan-banner")).not.toBeInTheDocument();
  });

  it("does not arm the implicit banner when LOOKS-READY is already showing", () => {
    // Concurrency invariant: when ``draftingPlan`` is true, the
    // LOOKS-READY variant takes priority — the implicit timer must
    // not also arm and swap labels mid-wait.
    render(
      <SetupView
        snapshot={fakeSnapshot(null)}
        {...baseProps()}
        busy
        draftingPlan
        busyMessage="Drafting the scenario plan…"
      />,
    );
    // LOOKS-READY variant shows immediately.
    const banner = screen.getByTestId("drafting-plan-banner");
    expect(banner).toHaveAttribute("data-banner-variant", "looks-ready");
    // Even after the implicit-debounce window passes, the variant
    // must stay LOOKS-READY (priority guard).
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(banner).toHaveAttribute("data-banner-variant", "looks-ready");
  });

  it("does not arm when a plan already exists (revision case)", () => {
    // The revision case (``hasPlan=true`` + ``busy=true``) is owned
    // by the BusyChip's "revising the plan" message. The prominent
    // banner would compete with the plan card itself.
    render(
      <SetupView
        snapshot={fakeSnapshot(fakePlan())}
        {...baseProps()}
        busy
        busyMessage="AI is thinking — revising the plan…"
      />,
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByTestId("drafting-plan-banner")).not.toBeInTheDocument();
  });

  it("suppresses the small BusyChip once the implicit banner is up", () => {
    // Same indicator-hierarchy invariant as the LOOKS-READY case:
    // banner + chip + dots together read as duplicate UI.
    render(
      <SetupView
        snapshot={fakeSnapshot(null)}
        {...baseProps()}
        busy
        busyMessage="AI is thinking — drafting the next setup question…"
      />,
    );
    // Pre-debounce: chip is visible (small indicator) and banner is
    // absent.
    expect(
      screen.getByText(/AI is thinking — drafting the next setup question…/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("drafting-plan-banner")).not.toBeInTheDocument();
    // Post-debounce: banner is up, chip text is suppressed.
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByTestId("drafting-plan-banner")).toBeInTheDocument();
    expect(
      screen.queryByText(/AI is thinking — drafting the next setup question…/),
    ).not.toBeInTheDocument();
  });
});
