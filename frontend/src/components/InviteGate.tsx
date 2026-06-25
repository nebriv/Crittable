import { type FormEvent, useId, useState } from "react";
import { writeStoredInviteCode } from "../lib/inviteCodeStorage";
import { CenteredCard } from "./brand/CenteredCard";
import { Eyebrow } from "./brand/Eyebrow";

/**
 * Soft anti-strangers gate rendered ahead of the facilitator wizard
 * when the server has ``INVITE_CODES`` set. Public-URL deploys (e.g.
 * the crittable.app Cloudflare tunnel) use it to keep random web
 * traffic from spending LLM tokens on session creation; player join
 * links don't need it because they already carry per-role HMAC tokens.
 *
 * Lifecycle:
 *   1. <Facilitator> probes ``api.getInviteStatus()`` on mount. The
 *      probe answers one thing — "is the gate on?". (It used to also
 *      report whether a stored code matched, but that match oracle was
 *      removed server-side; the endpoint no longer echoes validity.)
 *   2. If the probe says required AND no code has been entered yet,
 *      <Facilitator> renders this component. The user pastes the code.
 *   3. We persist it via the ``inviteCodeStorage`` module and call
 *      ``onValidated(code)`` — there is no separate validation probe
 *      anymore. <Facilitator> threads that code into ``createSession``;
 *      a wrong code surfaces as a 403 on that create call (session
 *      creation is the unauthenticated front door — invite-gated and
 *      rate-limited, not token-authenticated), at which point
 *      <Facilitator> clears storage and remounts us with a
 *      ``staleNotice`` so the user can re-enter the current code.
 *
 * The gate is intentionally NOT a security boundary against a
 * motivated attacker — it's a stopgap so a public URL doesn't burn
 * LLM tokens on every drive-by. Pair with ``RATE_LIMIT_ENABLED=true``
 * on the backend so a brute-forcer can't grind through the code.
 */

interface Props {
  /** Called once a non-empty code is entered and stored. The code is
   *  NOT pre-validated here (the match oracle was removed); validation
   *  happens on the create-session call <Facilitator> makes next. */
  onValidated: (code: string) => void;
  /** Optional banner shown above the input — used by <Facilitator>
   *  on the stale-code-after-rotation recovery path so the user
   *  knows why the gate is back instead of seeing a bare prompt. */
  staleNotice?: string | null;
}

export function InviteGate({ onValidated, staleNotice }: Props) {
  const inputId = useId();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = code.trim();
    if (trimmed.length === 0) {
      setError("Enter the invite code provided to you.");
      console.warn("[invite] submit blocked: empty code");
      return;
    }
    // No pre-validation probe: the match oracle was removed server-side.
    // We persist the code and hand it up; <Facilitator> threads it into
    // ``POST /api/sessions``, where a wrong code comes back as a 403 and
    // <Facilitator> re-prompts us with a stale-code notice. This keeps
    // brute-force attempts on the rate-limited create path (invite-gated
    // and per-IP throttled — not token-authenticated).
    setError(null);
    writeStoredInviteCode(trimmed);
    console.info("[invite] code entered; validation deferred to create");
    onValidated(trimmed);
  }

  return (
    <CenteredCard>
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
            INVITE_CODES
          </code>{" "}
          array in your backend env (unset to disable this gate). The
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
          className="mono invite-submit"
          style={{
            marginTop: 4,
            padding: "10px 16px",
            background: "var(--signal)",
            color: "var(--ink-950)",
            border: "1px solid var(--signal-deep)",
            borderRadius: 2,
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            cursor: "pointer",
          }}
        >
          Continue
        </button>
      </form>
    </CenteredCard>
  );
}
