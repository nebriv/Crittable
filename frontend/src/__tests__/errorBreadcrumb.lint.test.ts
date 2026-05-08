/**
 * Source-level regression net for the logging rule:
 *
 *   "Every ``setError(...)`` call in a page-level component must be
 *   accompanied by a prefixed ``console.warn`` breadcrumb so the
 *   browser console tells the operator which page-level action
 *   failed. The [api] wrapper logs the URL+status; the page-level
 *   warn names the action."
 *
 * This catches the class of regression where someone copies a
 * try/catch from elsewhere in the file but forgets the breadcrumb,
 * which is exactly how the bug-scrub HIGH H1 fix had to retrofit
 * nine sites in Facilitator.tsx + Play.tsx.
 *
 * Strategy: walk the page-level files (loaded via Vite ``?raw``) and
 * assert that every bubbling ``setError(err...)`` line has a
 * ``console.warn("[<prefix>]"...)`` within ~5 lines above it.
 *
 * Lints, not unit tests; cheap. The Vite ?raw query loads the file
 * as a string at test time so we don't need node:fs at typecheck.
 */

import { describe, expect, it } from "vitest";

// Vite's ``?raw`` query loads the source file as a string at test
// time. The type definitions for ``*?raw`` come from the ``vite/client``
// reference in ``src/vite-env.d.ts``.
import facilitatorSource from "../pages/Facilitator.tsx?raw";
import playSource from "../pages/Play.tsx?raw";

const BREADCRUMB_LOOKBACK_LINES = 5;

function findOrphanedSetErrors(
  source: string,
): { line: number; text: string }[] {
  const lines = source.split(/\r?\n/);
  const orphans: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/setError\s*\(/.test(line)) continue;

    // Restrict the rule to the "bubble the error up" shape:
    // setError(err...), setError(msg...), setError(message...).
    // Plain setError(null) / setError("literal") are clears or
    // hand-written user copy and don't need a breadcrumb here —
    // they're emitted from non-error code paths.
    const bubbles =
      /setError\s*\(\s*(err|msg|message)\b/.test(line) ||
      /setError\s*\(\s*err\s+instanceof/.test(line);
    if (!bubbles) continue;

    let hasBreadcrumb = false;
    const start = Math.max(0, i - BREADCRUMB_LOOKBACK_LINES);
    for (let j = start; j <= i; j++) {
      // Match console.warn("[<prefix>] ..." (the brand of breadcrumb
      // the logging rule mandates) — generic console.warn(err) by
      // itself doesn't carry the action label and shouldn't pass.
      if (/console\.warn\s*\(\s*"\[/.test(lines[j])) {
        hasBreadcrumb = true;
        break;
      }
    }
    if (!hasBreadcrumb) {
      orphans.push({ line: i + 1, text: line.trim() });
    }
  }
  return orphans;
}

describe("error-breadcrumb lint", () => {
  const cases: { name: string; source: string }[] = [
    { name: "pages/Facilitator.tsx", source: facilitatorSource },
    { name: "pages/Play.tsx", source: playSource },
  ];
  for (const { name, source } of cases) {
    it(`${name}: every setError(err...) call has a paired [prefix] console.warn`, () => {
      const orphans = findOrphanedSetErrors(source);
      const detail = orphans
        .map((o) => `  ${name}:${o.line}  ${o.text}`)
        .join("\n");
      expect(
        orphans,
        `\nMissing console.warn breadcrumbs on these setError sites in ${name}:\n${detail}\n\n` +
          "Fix: above each bubbling setError(...) in a catch, add:\n" +
          '  const msg = err instanceof Error ? err.message : String(err);\n' +
          '  console.warn("[<page>] <action>_failed", msg, err);\n' +
          '  setError(msg);\n',
      ).toEqual([]);
    });
  }
});
