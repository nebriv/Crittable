import type { FormEvent } from "react";
import { Eyebrow } from "./brand/Eyebrow";
import { SiteHeader } from "./brand/SiteHeader";
import { StatusChip } from "./brand/StatusChip";

/**
 * Landing page — the home / `/` surface. Lifts the brand mock's
 * <AppCreatorSetup> + <AppLobby> visual language, but stays a single
 * page (not a multi-step wizard): the existing 4-textarea form lives
 * here, dressed in brand chrome.
 *
 * All state is owned by Facilitator.tsx; this component is purely
 * presentational. Don't add behavior here.
 */

export interface SetupParts {
  scenario: string;
  team: string;
  environment: string;
  constraints: string;
}

interface Props {
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
}

// Defaults for the "Roles to invite" chip list. Mirrors the
// SETUP_ROLE_DEFAULTS constant in Facilitator.tsx so the Reset
// button restores the canonical seeded set.
const ROLE_DEFAULTS = ["IR Lead", "Legal", "Comms"] as const;

export function Landing(props: Props) {
  const {
    setupParts,
    setSetupParts,
    creatorLabel,
    setCreatorLabel,
    creatorDisplayName,
    setCreatorDisplayName,
    setupRoles,
    setSetupRoles,
    setupRoleDraft,
    setSetupRoleDraft,
    devMode,
    setDevMode,
    busy,
    busyMessage,
    error,
    onSubmit,
  } = props;

  function addRole(label: string) {
    const trimmed = label.trim();
    if (!trimmed) return;
    setSetupRoles((prev) =>
      prev.some((r) => r.toLowerCase() === trimmed.toLowerCase())
        ? prev
        : [...prev, trimmed],
    );
    setSetupRoleDraft("");
  }

  function removeRole(label: string) {
    setSetupRoles((prev) => prev.filter((r) => r !== label));
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--ink-900)",
      }}
    >
      <SiteHeader
        right={
          <span
            className="mono"
            style={{
              fontSize: 10,
              color: "var(--signal)",
              letterSpacing: "0.22em",
              fontWeight: 700,
            }}
          >
            NEW SESSION
          </span>
        }
      />

      <Hero />
      <ThreeModeStrip />

      <section style={{ padding: "32px 24px 64px" }}>
        <form
          onSubmit={onSubmit}
          style={{
            maxWidth: 720,
            margin: "0 auto",
            display: "flex",
            flexDirection: "column",
            gap: 18,
            background: "var(--ink-850)",
            border: "1px solid var(--ink-600)",
            borderRadius: 8,
            padding: 28,
          }}
        >
          <header style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <Eyebrow>step 01 · brief</Eyebrow>
            <h2
              className="sans"
              style={{
                fontSize: 22,
                fontWeight: 600,
                color: "var(--ink-050)",
                margin: 0,
                letterSpacing: "-0.01em",
              }}
            >
              Set the scene
            </h2>
            <p
              className="sans"
              style={{
                fontSize: 13,
                color: "var(--ink-300)",
                margin: 0,
                lineHeight: 1.55,
              }}
            >
              Drop in everything you know about the incident, the team, and
              the environment. The AI uses this to draft a plan you can
              approve, edit, or skip.
            </p>
          </header>

          <DevModeBand devMode={devMode} setDevMode={setDevMode} />

          <BriefField
            label="SCENARIO BRIEF"
            required
            value={setupParts.scenario}
            onChange={(v) => setSetupParts((p) => ({ ...p, scenario: v }))}
            placeholder="What happened, when, at what severity. Don't worry about prose."
          />
          <BriefField
            label="ABOUT YOUR TEAM"
            value={setupParts.team}
            onChange={(v) => setSetupParts((p) => ({ ...p, team: v }))}
            placeholder="Roles, seniority, on-call posture."
          />
          <BriefField
            label="ABOUT YOUR ENVIRONMENT"
            value={setupParts.environment}
            onChange={(v) => setSetupParts((p) => ({ ...p, environment: v }))}
            placeholder="Stack, identity provider, crown jewels."
          />
          <BriefField
            label="CONSTRAINTS / AVOID"
            value={setupParts.constraints}
            onChange={(v) => setSetupParts((p) => ({ ...p, constraints: v }))}
            placeholder="Hard NOs, learning objectives, things to skip."
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
              value={creatorLabel}
              onChange={setCreatorLabel}
              placeholder="Your role label (e.g. CISO)"
            />
            <MonoInput
              label="DISPLAY NAME"
              required
              value={creatorDisplayName}
              onChange={setCreatorDisplayName}
              placeholder="Your display name"
            />
          </div>

          <RolesField
            roles={setupRoles}
            draft={setupRoleDraft}
            onDraftChange={setSetupRoleDraft}
            onAdd={addRole}
            onRemove={removeRole}
            onClearAll={() => setSetupRoles([])}
            onResetDefaults={() => setSetupRoles([...ROLE_DEFAULTS])}
            creatorLabel={creatorLabel}
          />

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

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginTop: 4,
            }}
          >
            {busyMessage ? (
              <span
                className="mono"
                role="status"
                aria-live="polite"
                style={{
                  fontSize: 11,
                  color: "var(--signal)",
                  letterSpacing: "0.10em",
                }}
              >
                {busyMessage}
              </span>
            ) : null}
            <div style={{ flex: 1 }} />
            <button
              type="submit"
              disabled={busy}
              className="mono"
              style={{
                background: "var(--signal)",
                color: "var(--ink-900)",
                border: "none",
                padding: "14px 22px",
                borderRadius: 2,
                fontSize: 13,
                fontWeight: 700,
                letterSpacing: "0.20em",
                cursor: busy ? "not-allowed" : "pointer",
                opacity: busy ? 0.6 : 1,
              }}
            >
              {busy
                ? "ROLLING…"
                : devMode
                  ? "ROLL SESSION (DEV) →"
                  : "ROLL SESSION →"}
            </button>
          </div>
          <FieldHint />
        </form>
      </section>

      <footer
        style={{
          background: "var(--ink-950)",
          borderTop: "1px solid var(--ink-600)",
          padding: "16px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 10,
            color: "var(--ink-400)",
            letterSpacing: "0.22em",
            fontWeight: 600,
          }}
        >
          CRITTABLE
        </span>
        <span
          className="mono"
          style={{
            fontSize: 10,
            color: "var(--ink-500)",
            letterSpacing: "0.04em",
          }}
        >
          ROLL · RESPOND · REVIEW
        </span>
      </footer>
    </main>
  );
}

function Hero() {
  return (
    <section
      className="dotgrid"
      style={{
        padding: "48px 24px",
        display: "flex",
        gap: 32,
        alignItems: "center",
        justifyContent: "center",
        flexWrap: "wrap",
      }}
    >
      {/* Animated mark hero. Earlier rounds tried the SMIL-driven SVG
          variant — it loops in Chromium but Firefox / Safari either
          freeze on the first frame or refuse SMIL outright. The brand
          designer ships a GIF render specifically so we don't have to
          care; the sized variants live under /logo/gif/. The static
          encounter-01 SVG is the prefers-reduced-motion fallback. */}
      <picture>
        <source
          media="(prefers-reduced-motion: reduce)"
          srcSet="/logo/svg/mark-encounter-01-dark.svg"
        />
        <img
          src="/logo/gif/mark-animated-256-dark.gif"
          alt=""
          width={220}
          height={220}
          style={{ display: "block", flexShrink: 0 }}
        />
      </picture>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          maxWidth: 480,
        }}
      >
        <Eyebrow>roll · respond · review</Eyebrow>
        <h1
          className="sans"
          style={{
            fontSize: 36,
            fontWeight: 600,
            color: "var(--ink-050)",
            margin: 0,
            letterSpacing: "-0.02em",
            lineHeight: 1.1,
          }}
        >
          Roll a tabletop in 5 minutes.
        </h1>
        <p
          className="sans"
          style={{
            fontSize: 15,
            color: "var(--ink-300)",
            margin: 0,
            lineHeight: 1.55,
          }}
        >
          The AI runs the room. Your team runs the response. The AAR drafts
          itself while the room is still warm.
        </p>
      </div>
    </section>
  );
}

function ThreeModeStrip() {
  const modes: { name: string; sub: string }[] = [
    { name: "ROLL", sub: "Set the brief. Claude proposes a plan." },
    { name: "RESPOND", sub: "All operators, same wall-clock." },
    { name: "REVIEW", sub: "AAR drafted while the room is still warm." },
  ];
  return (
    <section
      style={{
        borderTop: "1px solid var(--ink-600)",
        borderBottom: "1px solid var(--ink-600)",
        background: "var(--ink-850)",
      }}
    >
      <div
        style={{
          maxWidth: 1080,
          margin: "0 auto",
          padding: "24px 24px",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 24,
        }}
      >
        {modes.map((m) => (
          <div
            key={m.name}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <span
              className="mono"
              style={{
                fontSize: 11,
                color: "var(--signal)",
                letterSpacing: "0.22em",
                fontWeight: 700,
              }}
            >
              {m.name}
            </span>
            <span
              className="sans"
              style={{
                fontSize: 13,
                color: "var(--ink-200)",
                lineHeight: 1.55,
              }}
            >
              {m.sub}
            </span>
          </div>
        ))}
      </div>
    </section>
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
      htmlFor="landing-dev-mode"
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
        id="landing-dev-mode"
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
        Skip the AI setup dialogue and use a known ransomware brief. For
        local QA only.
      </span>
    </label>
  );
}

interface BriefFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
}

function BriefField({
  label,
  value,
  onChange,
  placeholder,
  required,
}: BriefFieldProps) {
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
        onFocus={(e) =>
          (e.currentTarget.style.borderColor = "var(--signal-deep)")
        }
        onBlur={(e) =>
          (e.currentTarget.style.borderColor = "var(--ink-600)")
        }
      />
    </label>
  );
}

interface MonoInputProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
}

function MonoInput({
  label,
  value,
  onChange,
  placeholder,
  required,
}: MonoInputProps) {
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
        onFocus={(e) =>
          (e.currentTarget.style.borderColor = "var(--signal-deep)")
        }
        onBlur={(e) =>
          (e.currentTarget.style.borderColor = "var(--ink-600)")
        }
      />
    </label>
  );
}

interface RolesFieldProps {
  roles: string[];
  draft: string;
  onDraftChange: (v: string) => void;
  onAdd: (label: string) => void;
  onRemove: (label: string) => void;
  onClearAll: () => void;
  onResetDefaults: () => void;
  /** Used to surface the "creator label collides with an invitee chip" warning. */
  creatorLabel: string;
}

function RolesField({
  roles,
  draft,
  onDraftChange,
  onAdd,
  onRemove,
  onClearAll,
  onResetDefaults,
  creatorLabel,
}: RolesFieldProps) {
  // Surface the silent dedupe-against-creator-label case: if the
  // operator picks "IR Lead" as their own role label and leaves it
  // in the suggestions, it'll be filtered out at create time. Tell
  // them up front rather than letting the seat go missing without
  // explanation. (Mirrors the original Facilitator.tsx behavior.)
  const creatorLabelLower = creatorLabel.trim().toLowerCase();
  const dedupeWithCreator = creatorLabelLower
    ? roles.find((r) => r.toLowerCase() === creatorLabelLower)
    : undefined;
  const defaultsMatch =
    roles.length === ROLE_DEFAULTS.length &&
    ROLE_DEFAULTS.every((d, i) => roles[i] === d);
  return (
    <fieldset
      aria-label="Roles to invite"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 14,
        border: "1px solid var(--ink-600)",
        borderRadius: 4,
        background: "var(--ink-900)",
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
        Pre-create seats so you can copy join links right after submit. You
        can add or remove roles mid-session too.
      </p>

      {roles.length > 0 ? (
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
          {roles.map((label) => (
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
                  onClick={() => onRemove(label)}
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
          You're playing "{dedupeWithCreator}", so it won't be auto-added as
          a separate invitee.
        </p>
      ) : null}

      <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
        <input
          type="text"
          aria-label="New role label"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onAdd(draft);
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
          onFocus={(e) =>
            (e.currentTarget.style.borderColor = "var(--signal-deep)")
          }
          onBlur={(e) =>
            (e.currentTarget.style.borderColor = "var(--ink-600)")
          }
        />
        <button
          type="button"
          onClick={() => onAdd(draft)}
          disabled={!draft.trim()}
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
            cursor: draft.trim() ? "pointer" : "not-allowed",
            opacity: draft.trim() ? 1 : 0.5,
          }}
        >
          Add role
        </button>
      </div>

      {(roles.length > 0 || !defaultsMatch) ? (
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
          {roles.length > 0 ? (
            <button
              type="button"
              onClick={onClearAll}
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
              onClick={onResetDefaults}
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

function FieldHint() {
  return (
    <div
      style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}
    >
      <StatusChip label="ROUTE" value="WS · /api/sessions" tone="default" />
      <StatusChip label="HOST" value="self" tone="signal" />
      <span
        className="mono"
        style={{
          fontSize: 10,
          color: "var(--ink-400)",
          letterSpacing: "0.04em",
        }}
      >
        After submit, you'll move to setup → ready → play.
      </span>
    </div>
  );
}
