/**
 * Shared, component-free logic for the setup wizard's scenario brief.
 *
 * Lives in its own module (not in ``SetupWizard.tsx``) so the value
 * exports below don't trip ``react-refresh/only-export-components`` —
 * a component file may only export components for Fast Refresh to work.
 * Both ``SetupWizard`` (live counter + submit gate) and ``Facilitator``
 * (the actual ``createSession`` call) import from here so there's a
 * single source of truth for how the four sections become the wire
 * ``scenario_prompt`` and what the cap is.
 */

/**
 * The four short text sections the creator fills on wizard steps 1-2.
 * Each maps to one ``BriefField`` textarea.
 */
export interface SetupParts {
  scenario: string;
  team: string;
  environment: string;
  constraints: string;
}

/**
 * Hard cap (characters) on the composed ``scenario_prompt`` — the four
 * setup sections joined with headers. Must stay in sync with the
 * backend's ``CreateSessionBody.scenario_prompt`` ``max_length`` in
 * ``backend/app/api/routes.py`` and the cap stated in the README's
 * "Drafting a brief with your work's LLM" prompt template. The wizard
 * shows a live counter against this and disables the forward / ROLL
 * SESSION button when a brief exceeds it, so an operator sees the
 * limit while composing instead of round-tripping a 422 from the
 * server (which previously surfaced as an unrecoverable
 * ``[object Object]`` blob).
 */
export const SCENARIO_PROMPT_MAX_CHARS = 16000;

/**
 * Combine the four setup sections into the single ``scenario_prompt``
 * string the backend accepts. Empty sections are dropped entirely so
 * the AI never sees a bare header it has to interpret. This is the
 * exact string the wizard counts against ``SCENARIO_PROMPT_MAX_CHARS``
 * and that ``Facilitator`` ships as ``scenario_prompt`` — counting
 * anything else (e.g. the raw sum of section lengths) would drift from
 * what the server actually validates, since the headers + blank-line
 * separators add real characters.
 */
export function composeScenarioPrompt(parts: SetupParts): string {
  const sections: [string, string][] = [
    ["SCENARIO BRIEF", parts.scenario],
    ["TEAM", parts.team],
    ["ENVIRONMENT", parts.environment],
    ["CONSTRAINTS / AVOID", parts.constraints],
  ];
  return sections
    .filter(([, body]) => body.trim().length > 0)
    .map(([title, body]) => `${title}\n${body.trim()}`)
    .join("\n\n");
}
