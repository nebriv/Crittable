import {
  type Dispatch,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type SetStateAction,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  api,
  type Difficulty,
  type SessionFeatures,
  type SessionSnapshot,
} from "../../api/client";
import { Eyebrow } from "../brand/Eyebrow";
import { StatusChip } from "../brand/StatusChip";
import { WizardRail } from "./WizardRail";
import type { WizardStepId } from "./wizardSteps";

/**
 * Pre-creation form state. Owned by ``Facilitator``; the wizard is a
 * controlled form over these fields. Each is the operator's free-text
 * answer to one of the wizard's first three pages.
 */
export interface SetupParts {
  scenario: string;
  team: string;
  environment: string;
  constraints: string;
}

/**
 * One row in the step-3 roles list. ``builtin`` rows are the
 * canonical mockup-defined seats (IC / CSM / CSE / COM / EXE)
 * pre-seeded for the operator. Both builtin and custom rows are
 * toggleable AND removable — the user-agent review of the previous
 * iteration flagged "toggle-only" as paternal ("operators don't
 * want a permanent EXE row they never use"), so the only difference
 * between builtin and custom rows now is what's pre-populated on
 * mount. ``active`` drives whether the role gets submitted as part
 * of ``invitee_roles`` on session creation. ``key`` is a stable
 * React list key — builtin rows share their ``code`` for the key;
 * custom rows mint a timestamp+random fragment so duplicate-add
 * edge cases don't collide React's reconciliation.
 */
export interface SetupRoleSlot {
  key: string;
  code?: string;
  label: string;
  description?: string;
  active: boolean;
  builtin: boolean;
}

/**
 * Brand-mock setup wizard — wraps both the pre-creation form (steps
 * 1-3) and the post-creation flow (steps 4-6, where the backend has
 * already created the session and we're rendering existing in-app
 * components).
 *
 * State ownership is intentional:
 *   - All form state (scenario, team, env, constraints, roles,
 *     creator info) lives in <Facilitator/> and is passed through
 *     here as props. Once the user submits step 3 we call onSubmit
 *     and the existing handleCreate flow runs unchanged.
 *   - Post-creation steps render their content via the
 *     ``postCreationContent`` slot — the wizard provides only the
 *     chrome (left rail + main panel header). The slot's content
 *     decides its own primary CTA (e.g. step 06's
 *     ``SetupReviewView`` owns the START SESSION button, since the
 *     ``BottomActionBar`` isn't rendered inside wizard chrome).
 *     This keeps the engine-side state machine untouched.
 */

export type WizardPhase = "intro" | "setup" | "ready";

interface Props {
  phase: WizardPhase;
  // Form state (intro phase only).
  setupParts: SetupParts;
  setSetupParts: (p: SetupParts | ((prev: SetupParts) => SetupParts)) => void;
  creatorLabel: string;
  setCreatorLabel: (v: string) => void;
  creatorDisplayName: string;
  setCreatorDisplayName: (v: string) => void;
  setupRoleSlots: SetupRoleSlot[];
  setSetupRoleSlots: (
    v: SetupRoleSlot[] | ((prev: SetupRoleSlot[]) => SetupRoleSlot[]),
  ) => void;
  setupRoleDraft: string;
  setSetupRoleDraft: (v: string) => void;
  devMode: boolean;
  setDevMode: (v: boolean) => void;
  busy: boolean;
  busyMessage: string | null;
  error: string | null;
  onSubmit: (e: FormEvent) => void;
  // Issue #33-lite: creator-selected scenario tuning. Picked on the
  // wizard's Step 2 ("TUNING" panel), frozen on session creation,
  // surfaced into the AI's setup + play system blocks. ``setFeatures``
  // is the React ``useState`` setter type so callers can use the
  // functional updater form (``setFeatures(prev => ({...prev, x:
  // true}))``) without the wider ``SessionFeatures | (prev =>
  // SessionFeatures) | void`` shape that previously let "blew away
  // other toggles" bugs through.
  difficulty: Difficulty;
  setDifficulty: Dispatch<SetStateAction<Difficulty>>;
  durationMinutes: number;
  setDurationMinutes: Dispatch<SetStateAction<number>>;
  features: SessionFeatures;
  setFeatures: Dispatch<SetStateAction<SessionFeatures>>;
  // Post-creation slot — what to render in the main panel for steps
  // 4 (setup), 5 (ready / lobby), 6 (review). Provided by Facilitator.
  postCreationContent?: ReactNode;
  // Snapshot for the post-creation step computation (READY = lobby
  // step 5; if plan + ≥2 players it's step 6 review).
  snapshot?: SessionSnapshot | null;
  /** Player count from snapshot — used to decide step 5 vs 6. */
  playerCount?: number;
  /**
   * Discard the current session and return to the intro form.
   * Forwarded to ``WizardRail``'s ABANDON SESSION button at the
   * bottom of the rail (see WizardRail.tsx) — placed there
   * post-creation so it's never adjacent to step 06's
   * ``START SESSION`` button. Skip this prop on the intro phase
   * (no session to abandon).
   */
  onAbandonSession?: () => void;
  /**
   * Lobby-override flag (controlled by ``Facilitator``). When true,
   * the post-creation step pins to 5 (Invite players) even if the
   * launch gates are met (plan finalized + ≥ 2 player seats).
   * Lets the creator manage the lobby after seeing the launch
   * screen — clicking "← Back to lobby" inside ``SetupReviewView``
   * sets this; clicking step 6 in the rail clears it.
   */
  lobbyOverride?: boolean;
  /** Setter for ``lobbyOverride`` so the rail click in step 6
   *  can clear it without round-tripping through the parent. */
  setLobbyOverride?: (v: boolean) => void;
}

// Stable React keys for custom-role rows the operator adds. We can't
// just use the label as the key because two adds of the same label
// would collide (the de-dup check runs against active labels, but the
// row tracker still needs a unique identifier per slot).
function newCustomKey(): string {
  return `custom-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export function SetupWizard(props: Props) {
  // Pre-creation step navigation. The user moves through 1 → 2 → 3,
  // and submitting step 3 triggers session creation. Once created
  // (phase != "intro"), the step is derived from backend state.
  const [introStep, setIntroStep] = useState<1 | 2 | 3>(1);
  // Lobby-override flag is owned by ``Facilitator`` so the
  // ``SetupReviewView`` (rendered into the ``postCreationContent``
  // slot below) can request a hop back to step 5 without props
  // round-tripping through this component. Local fallback to
  // ``false`` keeps the component usable in isolation (Storybook,
  // tests).
  const lobbyOverride = props.lobbyOverride ?? false;
  const setLobbyOverride = props.setLobbyOverride;

  const current: WizardStepId = useMemo<WizardStepId>(() => {
    if (props.phase === "intro") return introStep;
    if (props.phase === "setup") return 4;
    if (props.phase === "ready") {
      // READY with a finalized plan + ≥2 players → review/launch
      // (step 6). Otherwise we're still gathering joiners → step 5.
      // ``lobbyOverride`` lets the creator pin step 5 to manage the
      // lobby even after the gates are met — set when they click
      // "← Back to lobby" from the review screen.
      const ready =
        props.snapshot?.plan != null && (props.playerCount ?? 0) >= 2;
      if (lobbyOverride) return 5;
      return ready ? 6 : 5;
    }
    return 1;
  }, [props.phase, introStep, props.snapshot, props.playerCount, lobbyOverride]);

  const done = useMemo(() => {
    const s = new Set<WizardStepId>();
    if (props.phase === "intro") {
      // Mark earlier intro steps as done as the user advances.
      for (let i = 1; i < introStep; i++) s.add(i as WizardStepId);
    } else {
      // Pre-creation steps are all done once the session is created.
      s.add(1);
      s.add(2);
      s.add(3);
      if (props.phase === "ready") s.add(4);
      // step 5 done when plan is finalized + roster gate met (we're
      // either in step 6, or pinned back on step 5 via lobbyOverride
      // but the room is launch-ready). The ``done`` set doubles as
      // the rail's "clickable" set — see WizardRail's ``isClickable``
      // calculation — so adding step 5 here is what makes the
      // "← BACK TO LOBBY" rail link work from step 6.
      const launchReady =
        props.snapshot?.plan != null && (props.playerCount ?? 0) >= 2;
      if (current === 6 || launchReady) s.add(5);
      // Step 6 normally only flips to "done" after START SESSION
      // runs, but in lobbyOverride mode (user clicked "← Back to
      // lobby" from step 6) we mark it ``done`` so the rail
      // exposes it as a forward-jump target — otherwise the user
      // would have to clear the override by some other means
      // before they could return to the launch screen. Only
      // applies when the launch gates are met; without that gate
      // step 6 would render as a half-broken review screen with
      // no working START SESSION CTA.
      if (lobbyOverride && launchReady) s.add(6);
    }
    return s;
  }, [
    props.phase,
    introStep,
    current,
    props.snapshot,
    props.playerCount,
    lobbyOverride,
  ]);

  // Step navigation. Intro phase: user moves backward through
  // completed form steps (state lives in ``introStep``). Post-
  // creation: the creator can hop between step 5 (lobby) and
  // step 6 (review) once both are reachable — useful when the
  // launch screen prompts them to verify presence and they want
  // to invite another role before pulling the trigger. Other
  // post-creation steps remain non-clickable (step 4 is AI work
  // they can't rewind, and steps 1-3 form state is frozen at
  // creation time).
  const onJumpToStep = (id: WizardStepId) => {
    if (props.phase === "intro") {
      if (id !== 1 && id !== 2 && id !== 3) return;
      setIntroStep(id);
      return;
    }
    if (props.phase === "ready" && setLobbyOverride) {
      // Ignore clicks on the step that's already current — re-firing
      // the same handler is at best a no-op and at worst a footgun
      // (clicking the *current* Step 5 when launch gates aren't yet
      // met would still flip ``lobbyOverride`` to true, pinning the
      // wizard to the lobby once gates DO get met and silently
      // suppressing the auto-advance to Step 6 — Copilot review on
      // PR #187).
      if (id === current) return;
      const launchReady =
        props.snapshot?.plan != null && (props.playerCount ?? 0) >= 2;
      if (id === 5) {
        // Only honour a jump to Step 5 from Step 6 — i.e. when the
        // user is actually using the back-nav. From any other step
        // (e.g. Step 4 while the AI is drafting), Step 5 isn't yet
        // reachable and the override flag would just be misleading.
        if (current === 6 && launchReady) setLobbyOverride(true);
        return;
      }
      if (id === 6) {
        // Only allow forward jump to 6 if the launch gates are met,
        // otherwise the user would land on a half-rendered review
        // screen that can't actually launch.
        if (launchReady) setLobbyOverride(false);
        return;
      }
      return;
    }
  };

  return (
    <main
      // Tailwind responsive grid: stack rail on top below ``lg``
      // (≤ 1023 px) so a 390 px viewport still gets a usable panel,
      // sit it on the left at ``lg`` and up. ``min-h-screen`` keeps
      // the rail+panel filling the viewport at any size.
      className="grid min-h-screen grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)]"
      style={{ background: "var(--ink-900)" }}
    >
      <WizardRail
        current={current}
        done={done}
        // Wired in two distinct phases: intro (back-nav through
        // the form-state steps 1-3) and ready (hop between
        // lobby step 5 and review step 6). Setup phase 4 keeps
        // the rail static — the AI is mid-draft and there's no
        // backward path from "AI is drafting" anyway. The ready-
        // phase wiring also requires the parent to have plumbed
        // ``setLobbyOverride`` through; without it the rail handler
        // returns early on every click, so leaving steps clickable
        // would just produce dead-affordance clicks (Copilot review
        // on PR #187).
        onJumpToStep={
          props.phase === "intro"
            ? onJumpToStep
            : props.phase === "ready" && setLobbyOverride
              ? onJumpToStep
              : undefined
        }
        onAbandonSession={
          props.phase !== "intro" ? props.onAbandonSession : undefined
        }
      />
      <section
        // Smaller padding at narrow viewports so the panel breathes;
        // restore brand-mock 32/48 spacing at ``lg`` and above.
        className="flex flex-col gap-5 overflow-auto p-5 lg:p-8 lg:px-12"
        style={{ minHeight: 0 }}
      >
        {props.phase === "intro" ? (
          <IntroStepBody
            step={introStep}
            onAdvance={(next) => setIntroStep(next)}
            {...props}
          />
        ) : (
          <PostCreationBody
            current={current}
            content={props.postCreationContent}
            error={props.error}
          />
        )}
      </section>
    </main>
  );
}

function PostCreationBody({
  current,
  content,
  error,
}: {
  current: WizardStepId;
  content: ReactNode;
  error: string | null;
}) {
  const titles: Record<WizardStepId, { eyebrow: string; title: string }> = {
    1: { eyebrow: "STEP 01 · SCENARIO", title: "Scenario" },
    2: { eyebrow: "STEP 02 · ENVIRONMENT", title: "Environment" },
    3: { eyebrow: "STEP 03 · ROLES", title: "Roles" },
    4: {
      eyebrow: "STEP 04 · INJECTS & SCHEDULE",
      title: "AI is drafting the plan",
    },
    5: { eyebrow: "STEP 05 · INVITE PLAYERS", title: "Invite players" },
    6: { eyebrow: "STEP 06 · REVIEW & LAUNCH", title: "Review & launch" },
  };
  const t = titles[current];
  return (
    <>
      <header style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <Eyebrow>{t.eyebrow.toLowerCase()}</Eyebrow>
        <h1
          className="sans"
          style={{
            fontSize: 32,
            fontWeight: 600,
            color: "var(--ink-050)",
            margin: 0,
            letterSpacing: "-0.02em",
          }}
        >
          {t.title}
        </h1>
      </header>
      {/* Surface page-level error from Facilitator state during post-
          creation steps too — the intro path renders this inside the
          form's NavRow, but the wizard's post-creation slot otherwise
          had nowhere to show api-call failures (kick / role-add /
          finalize errors got swallowed visually). */}
      {error ? (
        <p
          className="mono"
          role="alert"
          style={{
            margin: 0,
            color: "var(--crit)",
            fontSize: 12,
            letterSpacing: "0.04em",
          }}
        >
          {error}
        </p>
      ) : null}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {content}
      </div>
      {/* ABANDON SESSION lives in the rail (WizardRail) post-creation
          so it never sits adjacent to step-06's START SESSION button —
          the two right-hand actions had a misclick adjacency risk. */}
    </>
  );
}

// IntroStepBody is large enough to live in its own block at the
// bottom of this file — see below the export for the implementation.
type IntroBodyProps = Props & {
  step: 1 | 2 | 3;
  onAdvance: (next: 1 | 2 | 3) => void;
};

/** Compute whether step 3 is submittable (≥1 active invitee role).
 *  The lobby's ``start_session`` requires ≥2 player seats; the
 *  creator already counts as one, so we only need to gate on at
 *  least one active invitee here. Submitting with zero invitees
 *  used to silently land the operator in a lobby with only
 *  themselves — the LLM call to draft the plan would still fire,
 *  burning ~30 s and a setup turn before the lobby surfaces the
 *  block. UI/UX review flagged it BLOCK#2.
 */
function activeInviteeCount(slots: SetupRoleSlot[]): number {
  return slots.reduce((n, s) => (s.active ? n + 1 : n), 0);
}

function IntroStepBody(props: IntroBodyProps) {
  const titles: Record<1 | 2 | 3, { eyebrow: string; title: string; sub: string }> = {
    1: {
      eyebrow: "step 01 · scenario",
      title: "Set the scene",
      sub: "What happened, when, at what severity. Pre-fill the brief and the AI will pick up the rest in conversation.",
    },
    2: {
      eyebrow: "step 02 · scope",
      title: "Shape the exercise",
      sub: "Lock the AI's facilitation knobs, then describe the environment the injects ride on top of.",
    },
    3: {
      eyebrow: "step 03 · roles",
      title: "Who's in the room?",
      sub: "Each role is a seat at the table. The AI routes turns to active roles only — you can add more mid-session.",
    },
  };
  const t = titles[props.step];
  return (
    <>
      <header style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <Eyebrow>{t.eyebrow}</Eyebrow>
        <h1
          className="sans"
          style={{
            fontSize: 32,
            fontWeight: 600,
            color: "var(--ink-050)",
            margin: 0,
            letterSpacing: "-0.02em",
          }}
        >
          {t.title}
        </h1>
        <p
          className="sans"
          style={{
            fontSize: 14,
            color: "var(--ink-300)",
            margin: 0,
            maxWidth: 720,
            lineHeight: 1.55,
          }}
        >
          {t.sub}
        </p>
      </header>

      <form
        onSubmit={props.onSubmit}
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        {props.step === 1 ? <Step1Body {...props} /> : null}
        {props.step === 2 ? <Step2Body {...props} /> : null}
        {props.step === 3 ? <Step3Body {...props} /> : null}

        {props.error ? (
          <p
            className="mono"
            role="alert"
            style={{
              margin: 0,
              color: "var(--crit)",
              fontSize: 12,
              letterSpacing: "0.04em",
            }}
          >
            {props.error}
          </p>
        ) : null}

        <NavRow
          step={props.step}
          onBack={() =>
            props.onAdvance(((props.step as number) - 1) as 1 | 2 | 3)
          }
          onNext={() =>
            props.onAdvance(((props.step as number) + 1) as 1 | 2 | 3)
          }
          busy={props.busy}
          busyMessage={props.busyMessage}
          devMode={props.devMode}
          // Step 3's primary CTA is gated on ≥1 active invitee. The
          // creator counts as one of the two seats ``start_session``
          // requires; we just need at least one invitee active so
          // the lobby's gate clears without a second-trip retry.
          submitDisabled={
            props.step === 3 &&
            activeInviteeCount(props.setupRoleSlots) === 0
          }
          submitDisabledReason={
            props.step === 3 &&
            activeInviteeCount(props.setupRoleSlots) === 0
              ? "Activate at least one invitee role before rolling."
              : undefined
          }
        />
      </form>
    </>
  );
}

function NavRow({
  step,
  onBack,
  onNext,
  busy,
  busyMessage,
  devMode,
  submitDisabled = false,
  submitDisabledReason,
}: {
  step: 1 | 2 | 3;
  onBack: () => void;
  onNext: () => void;
  busy: boolean;
  busyMessage: string | null;
  devMode: boolean;
  /** Step-3 only: disable the ROLL SESSION button and show the
   *  reason inline. Used to gate "no active invitees" before the
   *  setup turn fires. */
  submitDisabled?: boolean;
  submitDisabledReason?: string;
}) {
  // The primary CTA is type="button" on steps 1-2 (it just advances
  // the wizard) and type="submit" on step 3 (where it actually
  // creates the session). Splitting submit from advance keeps the
  // form's onSubmit single-purpose and stops jsdom-flaky behaviour
  // around button-click → form-submit chains in tests.
  const primaryLabel =
    step === 1
      ? "NEXT · ENVIRONMENT →"
      : step === 2
        ? "NEXT · ROLES →"
        : busy
          ? "ROLLING…"
          : devMode
            ? "ROLL SESSION (DEV) →"
            : "ROLL SESSION →";
  return (
    <div
      // Sticky to the bottom of the scrolling section so the primary
      // CTA stays in view no matter how tall the form grows. The
      // tuning panel pushed Step 2 past 1080p reachability at common
      // viewport sizes (UI/UX H1) — sticky positioning keeps NEXT
      // visible without forcing the operator to scroll past the
      // textareas. The 1px top divider + ink-900 background keep the
      // bar visually distinct from the form content scrolling under
      // it. ``z-index: 1`` so the bar wins against any nested fieldset
      // shadows.
      style={{
        position: "sticky",
        bottom: 0,
        marginTop: 12,
        marginInline: "-8px",
        padding: "10px 8px",
        background: "var(--ink-900)",
        borderTop: "1px solid var(--ink-700)",
        zIndex: 1,
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      <button
        type="button"
        onClick={onBack}
        disabled={step === 1 || busy}
        className="mono"
        style={{
          background: "transparent",
          color: step === 1 ? "var(--ink-500)" : "var(--ink-300)",
          border: "1px solid var(--ink-500)",
          padding: "10px 18px",
          borderRadius: 2,
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.18em",
          cursor: step === 1 || busy ? "not-allowed" : "pointer",
          opacity: step === 1 ? 0.5 : 1,
        }}
      >
        ← BACK
      </button>
      {busyMessage ? (
        <StatusChip label="WORKING" value={busyMessage} tone="signal" />
      ) : null}
      {submitDisabledReason ? (
        <span
          role="status"
          className="mono"
          style={{
            fontSize: 11,
            color: "var(--warn)",
            letterSpacing: "0.04em",
          }}
        >
          {submitDisabledReason}
        </span>
      ) : null}
      <div style={{ flex: 1 }} />
      {step === 3 ? (
        <button
          type="submit"
          disabled={busy || submitDisabled}
          aria-disabled={busy || submitDisabled}
          title={submitDisabledReason}
          className="mono"
          style={{
            background: "var(--signal)",
            color: "var(--ink-900)",
            border: "none",
            padding: "10px 22px",
            borderRadius: 2,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.18em",
            cursor: busy ? "not-allowed" : "pointer",
            opacity: busy ? 0.6 : 1,
          }}
        >
          {primaryLabel}
        </button>
      ) : (
        <button
          type="button"
          onClick={onNext}
          disabled={busy}
          className="mono"
          style={{
            background: "var(--signal)",
            color: "var(--ink-900)",
            border: "none",
            padding: "10px 22px",
            borderRadius: 2,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.18em",
            cursor: busy ? "not-allowed" : "pointer",
            opacity: busy ? 0.6 : 1,
          }}
        >
          {primaryLabel}
        </button>
      )}
    </div>
  );
}

/**
 * Step 1 — Scenario brief + dev-mode toggle. Creator-role / display-name
 * inputs moved to Step 3 (Roles) per issue #159 — "Set the scene"
 * shouldn't ask about who you are, only about what happened.
 */
function Step1Body(props: IntroBodyProps) {
  return (
    <>
      <DevModeBand
        devMode={props.devMode}
        setDevMode={props.setDevMode}
      />
      {/* Dev-mode scenarios: when the operator has DEV_TOOLS_ENABLED
          on AND has flipped the dev-mode toggle, show a one-click
          replay picker right here so they don't have to walk through
          the whole wizard before realising they wanted a preset. */}
      {props.devMode ? <WizardScenarioPicker /> : null}
      <BriefField
        label="SCENARIO BRIEF"
        required
        value={props.setupParts.scenario}
        onChange={(v) =>
          props.setSetupParts((p) => ({ ...p, scenario: v }))
        }
        placeholder="What happened, when, at what severity. Don't worry about prose."
      />
      <BriefField
        label="ABOUT YOUR TEAM"
        value={props.setupParts.team}
        onChange={(v) => props.setSetupParts((p) => ({ ...p, team: v }))}
        placeholder="Roles, seniority, on-call posture."
      />
    </>
  );
}

function Step2Body(props: IntroBodyProps) {
  return (
    <>
      {/* TuningPanel renders FIRST on Step 2 so an operator who lands
          here sees the facilitation knobs immediately — rather than
          scrolling past two textareas to discover them. The panel's
          defaults work click-through, but burying it below the env
          textareas hid the affordance from first-time creators
          (per app-owner / user-agent review). */}
      <TuningPanel
        difficulty={props.difficulty}
        setDifficulty={props.setDifficulty}
        durationMinutes={props.durationMinutes}
        setDurationMinutes={props.setDurationMinutes}
        features={props.features}
        setFeatures={props.setFeatures}
      />
      <BriefField
        label="ABOUT YOUR ENVIRONMENT"
        value={props.setupParts.environment}
        onChange={(v) =>
          props.setSetupParts((p) => ({ ...p, environment: v }))
        }
        placeholder="Stack, identity provider, EDR/XDR, crown jewels, regulatory regime."
      />
      <BriefField
        label="CONSTRAINTS / AVOID"
        value={props.setupParts.constraints}
        onChange={(v) =>
          props.setSetupParts((p) => ({ ...p, constraints: v }))
        }
        placeholder="Hard NOs, learning objectives, things to skip."
      />
    </>
  );
}

const DIFFICULTY_OPTIONS: { value: Difficulty; label: string; sub: string }[] = [
  {
    value: "easy",
    label: "EASY",
    sub: "Coaching mode. AI fills gaps and hints. Adversary stays passive.",
  },
  {
    value: "standard",
    label: "STANDARD",
    sub: "Balanced. Reasonable assumptions allowed; injects fire on plan triggers.",
  },
  {
    value: "hard",
    label: "HARD",
    sub: "Literal execution. AI does only what was ordered; adversary exploits gaps.",
  },
];

const FEATURE_OPTIONS: {
  key: keyof SessionFeatures;
  label: string;
  on: string;
  off: string;
}[] = [
  {
    key: "active_adversary",
    label: "Active adversary",
    on: "Red side counters moves and probes for re-entry paths.",
    off: "Adversary is static — injects fire on schedule but red doesn't react.",
  },
  {
    key: "time_pressure",
    label: "Time pressure",
    on: "Critical injects fire on deadlines; urgency escalates over the session.",
    off: "No deadline framing on injects; players deliberate without an artificial timer.",
  },
  {
    key: "executive_escalation",
    label: "Executive escalation",
    on: "C-suite / board demands updates and forces reprioritization.",
    off: "Exec layer stays off-stage; no unsolicited C-suite asks.",
  },
  {
    key: "media_pressure",
    label: "Media / PR pressure",
    on: "Press inquiries, social-media leaks, reputational injects.",
    off: "Internal-facing only; customer disclosure framed as policy, not a media crisis.",
  },
];

/**
 * Step 2 tuning panel — difficulty chips, duration slider, feature
 * checkboxes. Submitted as ``settings`` on ``createSession`` and frozen
 * server-side; the setup + play system prompts read off these values
 * so the AI tunes facilitation without re-asking the creator.
 *
 * Defaults (matching ``DEFAULT_SESSION_FEATURES``) are a balanced
 * standard tabletop — an operator who clicks straight through still
 * gets a sensible exercise.
 */
function TuningPanel({
  difficulty,
  setDifficulty,
  durationMinutes,
  setDurationMinutes,
  features,
  setFeatures,
}: {
  difficulty: Difficulty;
  setDifficulty: Dispatch<SetStateAction<Difficulty>>;
  durationMinutes: number;
  setDurationMinutes: Dispatch<SetStateAction<number>>;
  features: SessionFeatures;
  setFeatures: Dispatch<SetStateAction<SessionFeatures>>;
}) {
  const activeDiff = DIFFICULTY_OPTIONS.find((o) => o.value === difficulty);

  // ARIA radiogroup contract: declare ←/→/↑/↓ to move selection across
  // the chips (with roving tabIndex). Without this, screen readers
  // and power-keyboard users cannot navigate per the role's
  // documented behaviour — UI/UX review B1.
  function onChipKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    const dir =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (dir === 0) return;
    e.preventDefault();
    const idx = DIFFICULTY_OPTIONS.findIndex((o) => o.value === difficulty);
    const next =
      DIFFICULTY_OPTIONS[
        (idx + dir + DIFFICULTY_OPTIONS.length) % DIFFICULTY_OPTIONS.length
      ];
    setDifficulty(next.value);
    // Move focus to the newly selected chip so the user sees + the
    // screen-reader announces the change.
    const root = e.currentTarget.parentElement;
    const btn = root?.querySelector<HTMLButtonElement>(
      `button[data-diff="${next.value}"]`,
    );
    btn?.focus();
  }

  return (
    <fieldset
      aria-label="Session tuning"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 14,
        padding: 14,
        border: "1px solid var(--ink-600)",
        borderRadius: 4,
        background: "var(--ink-850)",
      }}
    >
      <legend
        className="mono"
        style={{
          padding: "0 6px",
          fontSize: 10,
          color: "var(--signal)",
          letterSpacing: "0.20em",
          fontWeight: 700,
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span>Tuning</span>
        {/* "Frozen on roll" indicator — once you click ROLL SESSION,
            settings can't be changed. Without this banner first-time
            creators read "I'll fix this later" (user-agent H1). */}
        <span
          className="mono"
          aria-label="Tuning settings are frozen at session creation"
          style={{
            padding: "2px 6px",
            border: "1px solid var(--warn)",
            color: "var(--warn)",
            background: "transparent",
            borderRadius: 2,
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: "0.14em",
          }}
        >
          FROZEN ON ROLL
        </span>
      </legend>
      <p
        className="sans"
        style={{
          margin: 0,
          fontSize: 12,
          color: "var(--ink-300)",
          lineHeight: 1.45,
        }}
      >
        Locked at session creation. The AI reads these from its system
        block on every turn. Defaults are a balanced standard tabletop —
        click through and they'll work.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <Eyebrow>difficulty</Eyebrow>
        <div
          role="radiogroup"
          aria-label="Difficulty"
          style={{ display: "flex", flexWrap: "wrap", gap: 8 }}
        >
          {DIFFICULTY_OPTIONS.map((opt) => {
            const selected = opt.value === difficulty;
            return (
              <button
                key={opt.value}
                data-diff={opt.value}
                type="button"
                role="radio"
                aria-checked={selected}
                // Roving tabindex: only the selected chip is in the
                // tab order; arrow keys cycle within the group.
                tabIndex={selected ? 0 : -1}
                onClick={() => setDifficulty(opt.value)}
                onKeyDown={onChipKeyDown}
                className="mono tuning-chip"
                style={{
                  padding: "8px 14px",
                  borderRadius: 2,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.18em",
                  cursor: "pointer",
                  border: selected
                    ? "1px solid var(--signal)"
                    : "1px solid var(--ink-500)",
                  background: selected ? "var(--signal-tint)" : "transparent",
                  color: selected ? "var(--signal)" : "var(--ink-300)",
                  // Inline base; :hover/:focus-visible polish lives
                  // in index.css under the .tuning-chip selector so
                  // we don't need a fragile ::after pseudo here.
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        {activeDiff ? (
          <p
            className="sans"
            style={{
              margin: 0,
              fontSize: 12,
              color: "var(--ink-400)",
              lineHeight: 1.45,
            }}
          >
            {activeDiff.sub}
          </p>
        ) : null}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 8,
          }}
        >
          <Eyebrow>target duration</Eyebrow>
          <span
            className="mono"
            style={{
              fontSize: 12,
              color: "var(--signal)",
              fontWeight: 700,
              letterSpacing: "0.04em",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {durationMinutes} MIN
          </span>
        </div>
        <input
          type="range"
          aria-label="Target duration in minutes"
          min={15}
          max={180}
          step={5}
          value={durationMinutes}
          list="tuning-duration-ticks"
          onChange={(e) => setDurationMinutes(Number(e.target.value))}
          className="tuning-slider"
          style={{ width: "100%", accentColor: "var(--signal)" }}
        />
        {/* Native datalist renders ticks at common tabletop lengths
            in modern browsers (UI/UX M2). */}
        <datalist id="tuning-duration-ticks">
          <option value="15" />
          <option value="30" />
          <option value="60" />
          <option value="90" />
          <option value="120" />
          <option value="180" />
        </datalist>
        <div
          className="mono"
          aria-hidden
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 10,
            color: "var(--ink-500)",
            letterSpacing: "0.10em",
          }}
        >
          <span>15</span>
          <span>60</span>
          <span>120</span>
          <span>180</span>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <Eyebrow>features</Eyebrow>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 8,
          }}
        >
          {FEATURE_OPTIONS.map((opt) => {
            const checked = features[opt.key];
            return (
              <label
                key={opt.key}
                className="tuning-feature"
                data-checked={checked ? "on" : "off"}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  padding: 10,
                  border: checked
                    ? "1px solid var(--signal-deep)"
                    : "1px solid var(--ink-600)",
                  borderRadius: 2,
                  background: checked ? "var(--signal-tint)" : "transparent",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) =>
                    setFeatures((prev) => ({
                      ...prev,
                      [opt.key]: e.target.checked,
                    }))
                  }
                  style={{
                    marginTop: 3,
                    accentColor: "var(--signal)",
                  }}
                />
                <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <span
                      className="mono"
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: "0.12em",
                        color: checked ? "var(--signal)" : "var(--ink-200)",
                        textTransform: "uppercase",
                      }}
                    >
                      {opt.label}
                    </span>
                    <span
                      className="mono"
                      aria-hidden
                      style={{
                        fontSize: 9,
                        fontWeight: 700,
                        letterSpacing: "0.14em",
                        color: checked ? "var(--signal)" : "var(--ink-500)",
                        border: `1px solid ${
                          checked ? "var(--signal-deep)" : "var(--ink-500)"
                        }`,
                        padding: "1px 4px",
                        borderRadius: 2,
                      }}
                    >
                      {checked ? "ON" : "OFF"}
                    </span>
                  </span>
                  <span
                    className="sans"
                    style={{
                      fontSize: 11,
                      color: "var(--ink-400)",
                      lineHeight: 1.4,
                    }}
                  >
                    {checked ? opt.on : opt.off}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </fieldset>
  );
}

function Step3Body(props: IntroBodyProps) {
  function toggleSlot(key: string) {
    props.setSetupRoleSlots((prev) =>
      prev.map((s) => (s.key === key ? { ...s, active: !s.active } : s)),
    );
  }
  function removeCustom(key: string) {
    props.setSetupRoleSlots((prev) => prev.filter((s) => s.key !== key));
  }
  function addCustom(label: string) {
    const trimmed = label.trim();
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    props.setSetupRoleSlots((prev) => {
      // Case-insensitive dup check across BOTH builtin and custom
      // rows. If the label collides with an existing slot, just turn
      // that slot back on instead of creating a duplicate row — the
      // operator's intent is clearly "I want this role at the table".
      const existing = prev.find((s) => s.label.toLowerCase() === lower);
      if (existing) {
        return prev.map((s) =>
          s.key === existing.key ? { ...s, active: true } : s,
        );
      }
      return [
        ...prev,
        {
          key: newCustomKey(),
          label: trimmed,
          active: true,
          builtin: false,
        },
      ];
    });
    props.setSetupRoleDraft("");
  }
  const creatorLabelLower = props.creatorLabel.trim().toLowerCase();
  const collidingActive = creatorLabelLower
    ? props.setupRoleSlots.find(
        (s) => s.active && s.label.toLowerCase() === creatorLabelLower,
      )
    : undefined;
  return (
    <>
      {/* Creator's own seat — moved from Step 1 (issue #159). The
          collision-with-invitee warning lives in the fieldset below
          and reacts immediately as the user edits either field.
          Border tinted ``--signal-deep`` (vs the invitee fieldset's
          ``--ink-600``) so the operator instantly sees this block is
          about THEM, not the team. */}
      <fieldset
        aria-label="Your seat"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          padding: 14,
          border: "1px solid var(--signal-deep)",
          borderRadius: 4,
          background: "var(--ink-850)",
        }}
      >
        <legend
          className="mono"
          style={{
            padding: "0 6px",
            fontSize: 10,
            color: "var(--signal)",
            letterSpacing: "0.20em",
            fontWeight: 700,
          }}
        >
          Your seat
        </legend>
        <p
          className="sans"
          style={{
            margin: 0,
            fontSize: 12,
            color: "var(--ink-300)",
            lineHeight: 1.45,
          }}
        >
          You play one of the roles too. Pick a label and how you want
          to appear in the transcript.
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 12,
          }}
        >
          <MonoInput
            label="CREATOR ROLE"
            required
            value={props.creatorLabel}
            onChange={props.setCreatorLabel}
            placeholder="Your role label (e.g. CISO)"
          />
          <MonoInput
            label="DISPLAY NAME"
            required
            value={props.creatorDisplayName}
            onChange={props.setCreatorDisplayName}
            placeholder="Your display name"
          />
        </div>
      </fieldset>
      <fieldset
        aria-label="Roles to invite"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          padding: 14,
          border: "1px solid var(--ink-600)",
          borderRadius: 4,
          background: "var(--ink-850)",
        }}
      >
        <legend
          className="mono"
          style={{
            padding: "0 6px",
            fontSize: 10,
            color: "var(--signal)",
            letterSpacing: "0.20em",
            fontWeight: 700,
          }}
        >
          Who's in the room?
        </legend>
        <p
          className="sans"
          style={{
            margin: 0,
            fontSize: 12,
            color: "var(--ink-300)",
            lineHeight: 1.45,
          }}
        >
          Each role is a seat at the table. Toggle Active to put them in
          play; the AI routes turns to active roles only. You can add or
          remove roles mid-session too.
        </p>
        <RoleSlotList
          slots={props.setupRoleSlots}
          collidingKey={collidingActive?.key}
          onToggle={toggleSlot}
          onRemove={removeCustom}
        />
        {collidingActive ? (
          <p
            role="status"
            className="mono"
            style={{
              margin: 0,
              fontSize: 11,
              color: "var(--warn)",
              letterSpacing: "0.04em",
            }}
          >
            You're playing "{collidingActive.label}", so it won't be
            auto-added as a separate invitee.
          </p>
        ) : null}
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "stretch",
            paddingTop: 4,
            borderTop: "1px solid var(--ink-700)",
            marginTop: 4,
          }}
        >
          <input
            type="text"
            aria-label="New role label"
            value={props.setupRoleDraft}
            onChange={(e) => props.setSetupRoleDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addCustom(props.setupRoleDraft);
              }
            }}
            placeholder="Add custom role (e.g. Threat Intel)"
            style={{
              flex: 1,
              background: "var(--ink-900)",
              border: "1px solid var(--ink-600)",
              borderRadius: 2,
              padding: "8px 10px",
              color: "var(--ink-100)",
              fontFamily: "var(--font-sans)",
              fontSize: 13,
              outline: "none",
            }}
          />
          <button
            type="button"
            onClick={() => addCustom(props.setupRoleDraft)}
            disabled={!props.setupRoleDraft.trim()}
            className="mono"
            style={{
              background: "transparent",
              color: "var(--ink-200)",
              border: "1px solid var(--ink-500)",
              padding: "0 14px",
              borderRadius: 2,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.16em",
              cursor: props.setupRoleDraft.trim() ? "pointer" : "not-allowed",
              opacity: props.setupRoleDraft.trim() ? 1 : 0.5,
            }}
          >
            Add role
          </button>
        </div>
      </fieldset>
    </>
  );
}

/**
 * Mockup-faithful row list — see ``design/handoff/source/app-screens.jsx``
 * §02 ``AppCreatorSetup`` (lines 643-656). Each row: code badge, label
 * + description, Active/Off pills (we drop STANDBY per UX direction),
 * and a remove ``×`` for custom rows only. The collision warning row
 * (creator label === slot label) gets a tinted border so the operator
 * sees the conflict on the row itself, not just the inline message.
 */
function RoleSlotList({
  slots,
  collidingKey,
  onToggle,
  onRemove,
}: {
  slots: SetupRoleSlot[];
  collidingKey?: string;
  onToggle: (key: string) => void;
  onRemove: (key: string) => void;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--ink-600)",
        borderRadius: 4,
        background: "var(--ink-900)",
      }}
    >
      {slots.map((slot, i) => (
        <RoleSlotRow
          key={slot.key}
          slot={slot}
          last={i === slots.length - 1}
          colliding={slot.key === collidingKey}
          onToggle={() => onToggle(slot.key)}
          onRemove={() => onRemove(slot.key)}
        />
      ))}
    </div>
  );
}

function RoleSlotRow({
  slot,
  last,
  colliding,
  onToggle,
  onRemove,
}: {
  slot: SetupRoleSlot;
  last: boolean;
  colliding: boolean;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const code = slot.code ?? slot.label.slice(0, 3).toUpperCase();
  return (
    <div
      style={{
        padding: "12px 14px",
        borderBottom: last ? "none" : "1px solid var(--ink-700)",
        // Wrap the right-side controls below the label/description on
        // narrow viewports so the description doesn't hard-clip on
        // mobile. ``flex-wrap: wrap`` + ``min-width: 200px`` on the
        // label column is the simplest pattern that keeps the desktop
        // layout intact.
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 12,
        background: colliding
          ? "color-mix(in oklch, var(--warn) 8%, transparent)"
          : "transparent",
      }}
    >
      <div
        className="mono"
        style={{
          width: 48,
          fontSize: 11,
          fontWeight: 700,
          color: slot.active ? "var(--ink-100)" : "var(--ink-400)",
          letterSpacing: "0.10em",
        }}
      >
        {code}
      </div>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div
          className="sans"
          style={{
            fontSize: 13,
            color: slot.active ? "var(--ink-100)" : "var(--ink-300)",
            fontWeight: 600,
          }}
        >
          {slot.label}
        </div>
        {slot.description ? (
          <div
            className="sans"
            style={{
              fontSize: 12,
              // Description uses the documented secondary-text token
              // (``--ink-300``); ``--ink-400`` is the placeholder /
              // disabled token and trips WCAG AA contrast at this size.
              color: "var(--ink-300)",
              marginTop: 2,
            }}
          >
            {slot.description}
          </div>
        ) : null}
      </div>
      <div
        // The pills are a pair of independently-toggleable buttons
        // with ``aria-pressed``, not a true radio group (which would
        // require ``role="radio"`` children + roving tabindex +
        // arrow-key navigation). Drop the wrapper role rather than
        // half-implement radio semantics; the aria-label on each pill
        // identifies the row context for screen readers.
        style={{ display: "flex", gap: 4, alignItems: "center" }}
      >
        <RoleStatePill
          active={slot.active}
          onClick={() => {
            if (!slot.active) onToggle();
          }}
          tone="active"
          ariaLabel={`${slot.label} active`}
        >
          ACTIVE
        </RoleStatePill>
        <RoleStatePill
          active={!slot.active}
          onClick={() => {
            if (slot.active) onToggle();
          }}
          tone="off"
          ariaLabel={`${slot.label} off`}
        >
          OFF
        </RoleStatePill>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${slot.label}`}
          className="mono"
          style={{
            marginLeft: 4,
            background: "transparent",
            color: "var(--ink-400)",
            border: "1px solid var(--ink-600)",
            padding: "5px 8px",
            borderRadius: 2,
            fontSize: 11,
            fontWeight: 700,
            cursor: "pointer",
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}

function RoleStatePill({
  children,
  active,
  onClick,
  tone,
  ariaLabel,
}: {
  children: ReactNode;
  active: boolean;
  onClick: () => void;
  tone: "active" | "off";
  ariaLabel: string;
}) {
  // ACTIVE pill uses ``--signal`` (mockup accent). OFF pill, when
  // it's the toggle-current state, uses ``--warn`` so it reads as
  // "selected but cautionary" instead of as disabled. Earlier
  // iteration used ``--ink-200`` for the active OFF state, which the
  // UI/UX review flagged as indistinguishable from disabled controls.
  const accent = tone === "active" ? "var(--signal)" : "var(--warn)";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={ariaLabel}
      className="mono"
      style={{
        background: active
          ? `color-mix(in oklch, ${accent} 16%, transparent)`
          : "transparent",
        color: active ? accent : "var(--ink-400)",
        border: active
          ? `1px solid ${accent}`
          : "1px solid var(--ink-600)",
        padding: "5px 12px",
        borderRadius: 2,
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: "0.16em",
        // Always ``pointer`` — ``default`` on the active pill made
        // operators think the toggle was locked.
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function DevModeBand({
  devMode,
  setDevMode,
}: {
  devMode: boolean;
  setDevMode: (v: boolean) => void;
}) {
  return (
    <label
      htmlFor="wizard-dev-mode"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 12px",
        background: "var(--warn-bg)",
        border: "1px solid var(--warn)",
        borderRadius: 4,
        cursor: "pointer",
      }}
    >
      <input
        id="wizard-dev-mode"
        type="checkbox"
        checked={devMode}
        onChange={(e) => setDevMode(e.target.checked)}
        style={{ accentColor: "var(--warn)" }}
      />
      <span
        className="mono"
        style={{
          fontSize: 11,
          color: "var(--warn)",
          letterSpacing: "0.16em",
          fontWeight: 700,
        }}
      >
        DEV MODE
      </span>
      <span
        className="sans"
        style={{
          fontSize: 12,
          color: "var(--ink-200)",
          lineHeight: 1.4,
        }}
      >
        Skip the AI setup dialogue and use a known ransomware brief.
      </span>
    </label>
  );
}

interface ScenarioOption {
  id: string;
  name: string;
  description: string;
  roster_size: number;
  play_turns: number;
}

/**
 * Dev-only scenario picker shown on Step 01 of the setup wizard
 * when the operator has dev mode toggled on. Lets a solo dev
 * one-click replay a preset scenario instead of walking through the
 * whole wizard manually.
 *
 * Click → calls ``/api/dev/scenarios/{id}/play`` (no token needed
 * when ``DEV_TOOLS_ENABLED=true``); the backend returns IMMEDIATELY
 * with a session id + creator token, then runs the play / end /
 * AAR phases in a background task. We navigate the same tab to
 * ``/play/:sessionId/:token`` (the App router's two-segment route;
 * the one-segment shape silently falls through to the home page)
 * so the dev watches the replay unfold live via the existing WS
 * broadcasts — same code path, no new routes to maintain.
 *
 * Hidden when the backend gate is closed (``disabled=true``).
 */
function WizardScenarioPicker() {
  const [scenarios, setScenarios] = useState<ScenarioOption[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const body = await api.listScenarios();
        if (cancelled) return;
        setScenarios(body.scenarios);
        setDisabled(body.disabled);
      } catch (err) {
        if (!cancelled) {
          const text = err instanceof Error ? err.message : String(err);
          setError(text);
          console.warn("[wizard-scenarios] list failed", text);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handlePlay() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const body = await api.playScenario(selected);
      if (!body.ok || !body.session_id) {
        setError(body.error ?? "replay failed");
        setBusy(false);
        return;
      }
      const creatorRoleId = body.role_label_to_id["creator"];
      const creatorToken = creatorRoleId
        ? body.role_tokens[creatorRoleId]
        : undefined;
      if (!creatorToken) {
        setError("replay returned no creator token");
        setBusy(false);
        return;
      }
      console.info("[wizard-scenarios] navigating to replayed session");
      // Route is ``/play/:sessionId/:token`` — both segments are
      // required by the App router (the one-segment shape silently
      // falls through to the home page).
      window.location.href = `/play/${body.session_id}/${creatorToken}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      console.warn("[wizard-scenarios] play failed", err);
    }
  }

  if (disabled) {
    // Dev tools off → picker hidden; dev mode still works.
    return null;
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "10px 12px",
        // ``--info`` is the design-system info-tint token; using
        // ``color-mix`` keeps the alpha at the same level the
        // hard-coded ``rgba(38, 132, 255, 0.10/0.40)`` originally
        // produced but stays in sync with theme/contrast changes.
        background: "color-mix(in srgb, var(--info) 10%, transparent)",
        border:
          "1px solid color-mix(in srgb, var(--info) 40%, transparent)",
        borderRadius: 4,
      }}
    >
      <span
        className="mono"
        style={{
          fontSize: 11,
          color: "var(--info)",
          letterSpacing: "0.16em",
          fontWeight: 700,
        }}
      >
        OR REPLAY A PRESET SCENARIO
      </span>
      {scenarios.length === 0 ? (
        <span
          className="sans"
          style={{ fontSize: 12, color: "var(--ink-300)" }}
        >
          No scenarios available — drop a JSON file into
          <code style={{ marginLeft: 4 }}>backend/scenarios/</code>.
        </span>
      ) : (
        <>
          <label
            className="sans"
            style={{ display: "flex", flexDirection: "column", gap: 4 }}
          >
            <span style={{ fontSize: 11, color: "var(--ink-300)" }}>
              Skip the wizard and watch a preset play out live.
            </span>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={busy}
              style={{
                fontSize: 13,
                padding: "6px 8px",
                background: "var(--ink-850)",
                border: "1px solid var(--ink-600)",
                color: "var(--ink-100)",
                borderRadius: 3,
              }}
            >
              <option value="">— pick one —</option>
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.roster_size} roles, {s.play_turns} turns)
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!selected || busy}
            onClick={handlePlay}
            style={{
              alignSelf: "flex-start",
              fontSize: 12,
              padding: "6px 14px",
              // Token-derived info-tint, same pattern as the panel
              // background above — matches the design system rather
              // than hard-coding the ``rgba(38, 132, 255, 0.20)``
              // numerals.
              background: "color-mix(in srgb, var(--info) 20%, transparent)",
              border: "1px solid var(--info)",
              color: "var(--info)",
              borderRadius: 3,
              cursor: busy ? "wait" : "pointer",
              fontWeight: 600,
            }}
          >
            {busy ? "Spinning up replay…" : "Play scenario"}
          </button>
          {error ? (
            <span
              role="alert"
              className="sans"
              style={{ fontSize: 11, color: "var(--crit)" }}
            >
              {error}
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}

function BriefField({
  label,
  value,
  onChange,
  placeholder,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span
        className="mono"
        style={{
          fontSize: 10,
          color: "var(--signal)",
          letterSpacing: "0.20em",
          fontWeight: 700,
        }}
      >
        {label}
        {required ? (
          <span style={{ color: "var(--crit)", marginLeft: 4 }}>*</span>
        ) : null}
      </span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        rows={4}
        style={{
          background: "var(--ink-900)",
          border: "1px solid var(--ink-600)",
          borderRadius: 2,
          padding: "12px 14px",
          color: "var(--ink-100)",
          fontFamily: "var(--font-sans)",
          fontSize: 13,
          lineHeight: 1.55,
          outline: "none",
          resize: "vertical",
          minHeight: 88,
        }}
      />
    </label>
  );
}

function MonoInput({
  label,
  value,
  onChange,
  placeholder,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span
        className="mono"
        style={{
          fontSize: 10,
          color: "var(--signal)",
          letterSpacing: "0.20em",
          fontWeight: 700,
        }}
      >
        {label}
        {required ? (
          <span style={{ color: "var(--crit)", marginLeft: 4 }}>*</span>
        ) : null}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        style={{
          background: "var(--ink-900)",
          border: "1px solid var(--ink-600)",
          borderRadius: 2,
          padding: "10px 12px",
          color: "var(--ink-100)",
          fontFamily: "var(--font-sans)",
          fontSize: 13,
          outline: "none",
        }}
      />
    </label>
  );
}
