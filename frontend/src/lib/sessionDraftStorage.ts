/**
 * Persistence for the new-session wizard's pre-creation form state.
 *
 * Without this, refreshing ``/new`` while filling out the wizard
 * wipes every field — the operator loses the scenario brief, the
 * team description, the role toggles, and the tuning panel selection
 * because all of it lives in <Facilitator/> React state and a
 * re-mount starts from the defaults.
 *
 * Uses ``sessionStorage`` rather than ``localStorage`` so the draft
 * is scoped to the tab and gets cleaned up automatically when the
 * tab closes — the goal is "don't lose what I just typed", not
 * "save a draft forever". Cleared explicitly on a successful
 * session create so a refresh after the wizard has handed off
 * doesn't restore a now-stale form.
 */
import {
  DEFAULT_SESSION_FEATURES,
  type Difficulty,
  type SessionFeatures,
} from "../api/client";
import type {
  SetupParts,
  SetupRoleSlot,
} from "../components/setup/SetupWizard";

export const SESSION_DRAFT_STORAGE_KEY = "crittable.session_draft.v1";

/** JSON-safe snapshot of every field <Facilitator/> owns while the
 *  user is filling out the wizard. ``introStep`` is included so a
 *  refresh on Step 2 or Step 3 lands the user back on the same page
 *  instead of dumping them at Step 1. */
export interface SessionDraft {
  setupParts: SetupParts;
  creatorLabel: string;
  creatorDisplayName: string;
  setupRoleSlots: SetupRoleSlot[];
  setupRoleDraft: string;
  difficulty: Difficulty;
  durationMinutes: number;
  features: SessionFeatures;
  introStep: 1 | 2 | 3;
}

function isSetupParts(v: unknown): v is SetupParts {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.scenario === "string" &&
    typeof o.team === "string" &&
    typeof o.environment === "string" &&
    typeof o.constraints === "string"
  );
}

function isSetupRoleSlot(v: unknown): v is SetupRoleSlot {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.key === "string" &&
    typeof o.label === "string" &&
    typeof o.active === "boolean" &&
    typeof o.builtin === "boolean" &&
    (o.code === undefined || typeof o.code === "string") &&
    (o.description === undefined || typeof o.description === "string")
  );
}

function isDifficulty(v: unknown): v is Difficulty {
  return v === "easy" || v === "standard" || v === "hard";
}

function isFeatures(v: unknown): v is SessionFeatures {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.active_adversary === "boolean" &&
    typeof o.time_pressure === "boolean" &&
    typeof o.executive_escalation === "boolean" &&
    typeof o.media_pressure === "boolean"
  );
}

function isIntroStep(v: unknown): v is 1 | 2 | 3 {
  return v === 1 || v === 2 || v === 3;
}

/** Bounds for ``durationMinutes`` mirrored from the backend's
 *  pydantic validator (``SessionSettings.duration_minutes``,
 *  ``ge=15, le=180``). Defense-in-depth clamp at the storage
 *  boundary follows the model-output-trust pattern in CLAUDE.md:
 *  clamp out-of-band numerics to the documented range instead of
 *  trusting whatever sat in storage. */
const DURATION_MIN_MINUTES = 15;
const DURATION_MAX_MINUTES = 180;

/**
 * Read + validate the stored draft. Any unrecognized field is
 * silently replaced with its default so a schema bump never
 * soft-bricks the form. Returns ``null`` when nothing is stored or
 * sessionStorage is unavailable (private mode / strict CSP). Logs a
 * single warning per failure mode so an operator chasing a "draft
 * didn't restore" mystery finds a breadcrumb instead of a silent
 * swallow.
 */
export function readStoredSessionDraft(): SessionDraft | null {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(SESSION_DRAFT_STORAGE_KEY);
  } catch (err) {
    console.warn("[sessionDraft] read failed (storage unavailable?)", err);
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(
      "[sessionDraft] stored entry is not valid JSON; discarding",
      err,
    );
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const setupParts: SetupParts = isSetupParts(o.setupParts)
    ? o.setupParts
    : { scenario: "", team: "", environment: "", constraints: "" };
  const setupRoleSlots: SetupRoleSlot[] = Array.isArray(o.setupRoleSlots)
    ? o.setupRoleSlots.filter(isSetupRoleSlot)
    : [];
  const rawDuration =
    typeof o.durationMinutes === "number" && Number.isFinite(o.durationMinutes)
      ? o.durationMinutes
      : 60;
  const durationMinutes = Math.min(
    DURATION_MAX_MINUTES,
    Math.max(DURATION_MIN_MINUTES, rawDuration),
  );
  return {
    setupParts,
    creatorLabel:
      typeof o.creatorLabel === "string" ? o.creatorLabel : "CISO",
    creatorDisplayName:
      typeof o.creatorDisplayName === "string" ? o.creatorDisplayName : "",
    setupRoleSlots,
    setupRoleDraft:
      typeof o.setupRoleDraft === "string" ? o.setupRoleDraft : "",
    difficulty: isDifficulty(o.difficulty) ? o.difficulty : "standard",
    durationMinutes,
    features: isFeatures(o.features)
      ? o.features
      : { ...DEFAULT_SESSION_FEATURES },
    introStep: isIntroStep(o.introStep) ? o.introStep : 1,
  };
}

export function writeStoredSessionDraft(draft: SessionDraft): void {
  try {
    window.sessionStorage.setItem(
      SESSION_DRAFT_STORAGE_KEY,
      JSON.stringify(draft),
    );
  } catch (err) {
    // sessionStorage may be disabled (private mode, strict CSP) or
    // the quota may be exhausted. Form keeps working in memory; the
    // user just loses the refresh-recovery affordance. Log so an
    // operator chasing "why didn't my draft come back" has a
    // breadcrumb instead of a silent no-op.
    console.warn("[sessionDraft] write failed (storage unavailable?)", err);
  }
}

export function clearStoredSessionDraft(): void {
  try {
    window.sessionStorage.removeItem(SESSION_DRAFT_STORAGE_KEY);
  } catch (err) {
    console.warn("[sessionDraft] clear failed (storage unavailable?)", err);
  }
}
