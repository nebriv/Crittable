import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import { api, type SessionSnapshot } from "../../api/client";
import { Eyebrow } from "../brand/Eyebrow";
import { StatusChip } from "../brand/StatusChip";
import { WizardRail, type WizardStepId } from "./WizardRail";

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
 *   - Post-creation steps render the existing SetupView /
 *     ReadyView-style content via the ``children`` slot. The wizard
 *     just provides the chrome (left rail + main panel header +
 *     footer nav). This keeps the engine-side state machine
 *     untouched.
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
  setupRoles: string[];
  setSetupRoles: (v: string[] | ((prev: string[]) => string[])) => void;
  setupRoleDraft: string;
  setSetupRoleDraft: (v: string) => void;
  devMode: boolean;
  setDevMode: (v: boolean) => void;
  busy: boolean;
  busyMessage: string | null;
  error: string | null;
  onSubmit: (e: FormEvent) => void;
  // Post-creation slot — what to render in the main panel for steps
  // 4 (setup), 5 (ready / lobby), 6 (review). Provided by Facilitator.
  postCreationContent?: ReactNode;
  // Snapshot for the post-creation step computation (READY = lobby
  // step 5; if plan + ≥2 players it's step 6 review).
  snapshot?: SessionSnapshot | null;
  /** Player count from snapshot — used to decide step 5 vs 6. */
  playerCount?: number;
}

const ROLE_DEFAULTS = ["IR Lead", "Legal", "Comms"] as const;

export function SetupWizard(props: Props) {
  // Pre-creation step navigation. The user moves through 1 → 2 → 3,
  // and submitting step 3 triggers session creation. Once created
  // (phase != "intro"), the step is derived from backend state.
  const [introStep, setIntroStep] = useState<1 | 2 | 3>(1);

  const current: WizardStepId = useMemo<WizardStepId>(() => {
    if (props.phase === "intro") return introStep;
    if (props.phase === "setup") return 4;
    if (props.phase === "ready") {
      // READY with a finalized plan + ≥2 players → review/launch
      // (step 6). Otherwise we're still gathering joiners → step 5.
      const ready =
        props.snapshot?.plan != null && (props.playerCount ?? 0) >= 2;
      return ready ? 6 : 5;
    }
    return 1;
  }, [props.phase, introStep, props.snapshot, props.playerCount]);

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
      // step 5 done when plan is finalized (we're now reviewing in
      // step 6); step 6 is never "done" until START SESSION runs and
      // we leave this view entirely.
      if (current === 6) s.add(5);
    }
    return s;
  }, [props.phase, introStep, current]);

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        gridTemplateColumns: "260px 1fr",
        background: "var(--ink-900)",
      }}
    >
      <WizardRail current={current} done={done} />
      <section
        style={{
          padding: "32px 48px",
          display: "flex",
          flexDirection: "column",
          gap: 20,
          minHeight: 0,
          overflow: "auto",
        }}
      >
        {props.phase === "intro" ? (
          <IntroStepBody
            step={introStep}
            onAdvance={(next) => setIntroStep(next)}
            {...props}
          />
        ) : (
          <PostCreationBody current={current} content={props.postCreationContent} />
        )}
      </section>
    </main>
  );
}

function PostCreationBody({
  current,
  content,
}: {
  current: WizardStepId;
  content: ReactNode;
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
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {content}
      </div>
    </>
  );
}

// IntroStepBody is large enough to live in its own block at the
// bottom of this file — see below the export for the implementation.
type IntroBodyProps = Props & {
  step: 1 | 2 | 3;
  onAdvance: (next: 1 | 2 | 3) => void;
};

function IntroStepBody(props: IntroBodyProps) {
  const titles: Record<1 | 2 | 3, { eyebrow: string; title: string; sub: string }> = {
    1: {
      eyebrow: "step 01 · scenario",
      title: "Set the scene",
      sub: "What happened, when, at what severity. Pre-fill the brief and the AI will pick up the rest in conversation.",
    },
    2: {
      eyebrow: "step 02 · environment",
      title: "What does the environment look like?",
      sub: "The AI uses this to ground injects. Concrete vendor names + crown jewels make the simulation feel less generic.",
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
}: {
  step: 1 | 2 | 3;
  onBack: () => void;
  onNext: () => void;
  busy: boolean;
  busyMessage: string | null;
  devMode: boolean;
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
      style={{
        marginTop: 12,
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
      <div style={{ flex: 1 }} />
      {step === 3 ? (
        <button
          type="submit"
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
 * Step 1 — Scenario brief + creator-role inputs + dev-mode toggle.
 * The team / constraints fields are kept on this step too so a
 * minimal session can be created in 30 seconds (the user just fills
 * step 1 and clicks NEXT through the rest with empty fields).
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
    </>
  );
}

function Step2Body(props: IntroBodyProps) {
  return (
    <>
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

function Step3Body(props: IntroBodyProps) {
  function addRole(label: string) {
    const trimmed = label.trim();
    if (!trimmed) return;
    props.setSetupRoles((prev) =>
      prev.some((r) => r.toLowerCase() === trimmed.toLowerCase())
        ? prev
        : [...prev, trimmed],
    );
    props.setSetupRoleDraft("");
  }
  function removeRole(label: string) {
    props.setSetupRoles((prev) => prev.filter((r) => r !== label));
  }
  const creatorLabelLower = props.creatorLabel.trim().toLowerCase();
  const dedupeWithCreator = creatorLabelLower
    ? props.setupRoles.find((r) => r.toLowerCase() === creatorLabelLower)
    : undefined;
  const defaultsMatch =
    props.setupRoles.length === ROLE_DEFAULTS.length &&
    ROLE_DEFAULTS.every((d, i) => props.setupRoles[i] === d);
  return (
    <fieldset
      aria-label="Roles to invite"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
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
        Roles to invite
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
        Pre-create seats so you can copy join links right after submit.
        You can add or remove roles mid-session too.
      </p>
      {props.setupRoles.length > 0 ? (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
          }}
        >
          {props.setupRoles.map((label) => (
            <li key={label} style={{ display: "inline-flex" }}>
              <span
                className="mono"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 4px 4px 10px",
                  background: "var(--ink-800)",
                  border: "1px solid var(--ink-500)",
                  borderRadius: 2,
                  fontSize: 11,
                  color: "var(--ink-100)",
                  letterSpacing: "0.06em",
                }}
              >
                {label}
                <button
                  type="button"
                  onClick={() => removeRole(label)}
                  aria-label={`Remove ${label}`}
                  style={{
                    background: "transparent",
                    color: "var(--ink-300)",
                    border: "none",
                    padding: "0 6px",
                    cursor: "pointer",
                    fontSize: 12,
                    lineHeight: 1,
                  }}
                >
                  ×
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p
          className="mono"
          style={{
            margin: 0,
            fontSize: 11,
            color: "var(--ink-400)",
            letterSpacing: "0.04em",
          }}
        >
          No invitee roles yet — you can still invite people after the
          session is created.
        </p>
      )}
      {dedupeWithCreator ? (
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
          You're playing "{dedupeWithCreator}", so it won't be auto-added
          as a separate invitee.
        </p>
      ) : null}
      <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
        <input
          type="text"
          aria-label="New role label"
          value={props.setupRoleDraft}
          onChange={(e) => props.setSetupRoleDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addRole(props.setupRoleDraft);
            }
          }}
          placeholder="e.g. Threat Intel"
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
          onClick={() => addRole(props.setupRoleDraft)}
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
      {(props.setupRoles.length > 0 || !defaultsMatch) ? (
        <div
          className="mono"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            fontSize: 11,
            color: "var(--ink-400)",
            letterSpacing: "0.04em",
          }}
        >
          {props.setupRoles.length > 0 ? (
            <button
              type="button"
              onClick={() => props.setSetupRoles([])}
              style={{
                background: "transparent",
                color: "var(--ink-400)",
                border: "none",
                padding: 0,
                fontSize: 11,
                textDecoration: "underline",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Clear all
            </button>
          ) : null}
          {!defaultsMatch ? (
            <button
              type="button"
              onClick={() => props.setSetupRoles([...ROLE_DEFAULTS])}
              style={{
                background: "transparent",
                color: "var(--ink-400)",
                border: "none",
                padding: 0,
                fontSize: 11,
                textDecoration: "underline",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Reset to defaults
            </button>
          ) : null}
        </div>
      ) : null}
    </fieldset>
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
 * ``/play/{creator_token}`` so the dev watches the replay unfold
 * live via the existing WS broadcasts — same code path, no new
 * routes to maintain.
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
          setError(err instanceof Error ? err.message : String(err));
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
      // Navigate the same tab — the dev sees the replay unfold via
      // the live WS broadcasts as the background task progresses.
      // Route is ``/play/:sessionId/:token`` — both segments are
      // required by the App router. Pre-fix this used
      // ``/play/{token}`` (one segment), which the router didn't
      // match, so the dev landed on the marketing home page instead
      // of the replayed session.
      window.location.href = `/play/${body.session_id}/${creatorToken}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      console.warn("[wizard-scenarios] play failed", err);
    }
  }

  if (disabled) {
    // Dev tools off — picker hidden, dev mode still works.
    return null;
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "10px 12px",
        background: "rgba(38, 132, 255, 0.10)",
        border: "1px solid rgba(38, 132, 255, 0.40)",
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
              background: "rgba(38, 132, 255, 0.20)",
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
