import { type FormEvent, useId, useState } from "react";
import { api } from "../api/client";
import { writeStoredInviteCode } from "../lib/inviteCodeStorage";
import { Eyebrow } from "./brand/Eyebrow";
import { SiteHeader } from "./brand/SiteHeader";

/**
 * Soft anti-strangers gate rendered ahead of the facilitator wizard
 * when the server has ``INVITE_CODE`` set. Public-URL deploys (e.g.
 * the crittable.app Cloudflare tunnel) use it to keep random web
 * traffic from spending LLM tokens on session creation; player join
 * links don't need it because they already carry per-role HMAC tokens.
 *
 * Lifecycle:
 *   1. <Facilitator> probes ``api.getInviteStatus(storedCode)`` on
 *      mount. The single probe answers both "is the gate on?" and
 *      "is the stored code still valid?" — so a returning visitor
 *      with a rotated-since-last-visit code lands here directly,
 *      not after filling out the whole wizard.
 *   2. If the probe says required + invalid (or no stored code),
 *      <Facilitator> renders this component. The user pastes the
 *      code; we re-check via ``getInviteStatus(code)``.
 *   3. On ``valid: true`` we persist via the ``inviteCodeStorage``
 *      module and call ``onValidated(code)``. <Facilitator> threads
 *      that code into ``createSession`` and clears it from storage
 *      if the create call later 403s (the rotated-code recovery
 *      path; <Facilitator> remounts us with a ``staleNotice``).
 *
 * The gate is intentionally NOT a security boundary against a
 * motivated attacker — it's a stopgap so a public URL doesn't burn
 * LLM tokens on every drive-by. Pair with ``RATE_LIMIT_ENABLED=true``
 * on the backend so a brute-forcer can't grind through the code.
 */

interface Props {
  /** Called once the entered code is server-validated and stored. */
  onValidated: (code: string) => void;
  /** Optional banner shown above the input — used by <Facilitator>
   *  on the stale-code-after-rotation recovery path so the user
   *  knows why the gate is back instead of seeing a bare prompt. */
  staleNotice?: string | null;
}

export function InviteGate({ onValidated, staleNotice }: Props) {
  const inputId = useId();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = code.trim();
    if (trimmed.length === 0) {
      setError("Enter the invite code provided to you.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const status = await api.getInviteStatus(trimmed);
      if (!status.required) {
        // Gate was removed server-side between mount and submit; let
        // the user through and don't bother persisting a now-unused
        // code.
        onValidated(trimmed);
        return;
      }
      if (status.valid !== true) {
        setError(
          "That code didn't match. Watch for stray spaces or look-alike characters (0/O, 1/l).",
        );
        return;
      }
      writeStoredInviteCode(trimmed);
      onValidated(trimmed);
    } catch (err) {
      const detail =
        err instanceof Error && err.message ? err.message : "Network error";
      console.warn("[invite] validation failed", detail);
      setError(`Couldn't reach the server (${detail}). Try again.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main
      className="grid min-h-screen grid-cols-1"
      style={{ background: "var(--ink-900)" }}
    >
      <SiteHeader />
      <section
        className="flex flex-1 items-start justify-center overflow-auto p-5 lg:p-8"
        style={{ minHeight: 0 }}
      >
        <div
          className="flex flex-col gap-5"
          style={{
            width: "100%",
            maxWidth: 480,
            marginTop: "8vh",
            padding: 24,
            background: "var(--ink-800)",
            border: "1px solid var(--ink-600)",
            borderRadius: 4,
          }}
        >
          <header className="flex flex-col gap-2">
            <Eyebrow>Access · Invite required</Eyebrow>
            <h1
              className="sans"
              style={{
                fontSize: 26,
                fontWeight: 600,
                color: "var(--ink-050)",
                margin: 0,
                letterSpacing: "-0.01em",
              }}
            >
              Enter your invite code to start a session
            </h1>
            <p
              className="sans"
              style={{
                fontSize: 13,
                color: "var(--ink-300)",
                margin: 0,
                lineHeight: 1.5,
              }}
            >
              Session creation is gated. Paste your invite code below.
              Already invited as a player? Use the link you were sent —
              no code needed. Self-hosting? Check{" "}
              <code
                className="mono"
                style={{
                  background: "var(--ink-700)",
                  padding: "1px 6px",
                  borderRadius: 2,
                  fontSize: 12,
                  color: "var(--ink-100)",
                }}
              >
                INVITE_CODE
              </code>{" "}
              in your backend env (unset to disable this gate). The
              backend rate-limits invalid attempts.
            </p>
          </header>
          {staleNotice ? (
            <div
              role="status"
              className="sans"
              style={{
                fontSize: 12,
                color: "var(--warn)",
                background: "var(--warn-bg)",
                border: "1px solid var(--warn)",
                borderRadius: 2,
                padding: "8px 10px",
                lineHeight: 1.5,
              }}
            >
              {staleNotice}
            </div>
          ) : null}
          <form
            onSubmit={handleSubmit}
            className="flex flex-col gap-3"
            noValidate
          >
            <label
              htmlFor={inputId}
              className="mono"
              style={{
                fontSize: 11,
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                color: "var(--ink-300)",
                fontWeight: 700,
              }}
            >
              Invite code
            </label>
            <input
              id={inputId}
              name="invite_code"
              type="text"
              autoComplete="one-time-code"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={busy}
              spellCheck={false}
              maxLength={128}
              className="mono invite-input"
              style={{
                background: "var(--ink-700)",
                color: "var(--ink-100)",
                border: `1px solid ${error ? "var(--crit)" : "var(--ink-500)"}`,
                borderRadius: 2,
                padding: "10px 12px",
                fontSize: 14,
                letterSpacing: "0.04em",
                outline: "none",
              }}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${inputId}-error` : undefined}
            />
            {error ? (
              <div
                id={`${inputId}-error`}
                role="alert"
                className="sans"
                style={{
                  fontSize: 12,
                  color: "var(--crit)",
                }}
              >
                {error}
              </div>
            ) : null}
            <button
              type="submit"
              disabled={busy}
              className="mono invite-submit"
              style={{
                marginTop: 4,
                padding: "10px 16px",
                background: busy ? "var(--ink-700)" : "var(--signal)",
                color: busy ? "var(--ink-300)" : "var(--ink-950)",
                border: "1px solid var(--signal-deep)",
                borderRadius: 2,
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                cursor: busy ? "wait" : "pointer",
              }}
            >
              {busy ? "Checking…" : "Continue"}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
