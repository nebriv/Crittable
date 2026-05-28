/**
 * Tests for ``src/api/errorDetail.ts`` — the single boundary that turns a
 * FastAPI ``detail`` (string OR Pydantic-422 array) into a readable
 * message — PLUS a source-grep guard that fences off the whole bug class.
 *
 * The bug: ``json.detail as string`` on a 422 array stringifies to
 * ``"[object Object]"`` in the UI. It shipped twice (create-session
 * wizard + notepad fetch). The unit cases lock the formatter's contract;
 * the grep guard (same idiom as backend ``test_live_fixtures.py``) fails
 * CI if any future fetch boundary re-introduces the cast instead of
 * routing through ``formatErrorDetail``.
 */

import { describe, expect, it } from "vitest";

import { formatErrorDetail, humanizeLoc } from "../api/errorDetail";

describe("humanizeLoc", () => {
  it("drops the body/query/path prefix and sentence-cases the field", () => {
    expect(humanizeLoc(["body", "creator_label"])).toBe("Creator label");
    expect(humanizeLoc(["query", "scenario_prompt"])).toBe("Scenario prompt");
  });

  it("uses the last string segment, ignoring trailing array indices", () => {
    expect(humanizeLoc(["body", "invitee_roles", 0, "label"])).toBe("Label");
  });

  it("returns '' for a non-array and a dotted path when no string segment", () => {
    expect(humanizeLoc("nope")).toBe("");
    expect(humanizeLoc(["body", 0])).toBe("0");
  });
});

describe("formatErrorDetail", () => {
  it("passes a plain string detail through", () => {
    expect(formatErrorDetail("session not yet ended", 425)).toBe(
      "session not yet ended",
    );
  });

  it("formats a Pydantic-422 array as '<Field>: <msg>'", () => {
    expect(
      formatErrorDetail(
        [
          {
            type: "string_too_long",
            loc: ["body", "scenario_prompt"],
            msg: "String should have at most 16000 characters",
          },
        ],
        422,
      ),
    ).toBe("Scenario prompt: String should have at most 16000 characters");
  });

  it("joins multiple validation errors with '; '", () => {
    expect(
      formatErrorDetail(
        [
          { loc: ["body", "creator_label"], msg: "field required" },
          { loc: ["body", "invitee_roles", 0, "label"], msg: "too long" },
        ],
        422,
      ),
    ).toBe("Creator label: field required; Label: too long");
  });

  it("NEVER yields [object Object] — for arrays of objects or junk", () => {
    expect(
      formatErrorDetail([{ loc: ["body", "x"], msg: "y" }], 422),
    ).not.toContain("[object Object]");
    // Unusable entries (no msg/loc) fall back to the status, not a blob.
    expect(formatErrorDetail([{}, {}], 422)).toBe("422");
    expect(formatErrorDetail({ unexpected: "shape" }, 500)).toBe("500");
    expect(formatErrorDetail(null, 503)).toBe("503");
    expect(formatErrorDetail("", 400)).toBe("400");
  });

  it("clamps to the first 10 entries (no multi-KB alert string)", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      loc: ["body", `f${i}`],
      msg: "bad",
    }));
    const out = formatErrorDetail(many, 422);
    expect(out.split("; ")).toHaveLength(10);
  });

  it("truncates an over-long per-error message", () => {
    const out = formatErrorDetail(
      [{ loc: ["body", "x"], msg: "z".repeat(500) }],
      422,
    );
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThan(260);
  });
});

describe("source guard — no hand-rolled `detail` cast outside the helper", () => {
  // Vite-native raw glob (eager → { path: rawText } synchronously). Used
  // instead of node:fs so this stays type-clean in a browser tsconfig
  // with no @types/node. Globbed relative to this file: ``../`` is src/.
  const modules = import.meta.glob("../**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  // Strip comments first: a doc-comment that *names* the antipattern to
  // warn against it (this file, the helper docstring, the notepad
  // explainer) must not be a false positive — we only flag the cast in
  // real code.
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  }

  // The two shapes the bug took: ``.detail as string`` and
  // ``as { detail?: string }`` / ``as { detail: string }``.
  const BANNED: RegExp[] = [
    /\bdetail\s+as\s+string\b/,
    /as\s*\{[^}]*\bdetail\??\s*:\s*string/,
  ];

  it("scans a non-trivial slice of the source tree (guard isn't a no-op)", () => {
    // A grep guard that silently matched zero files would "pass" forever.
    expect(Object.keys(modules).length).toBeGreaterThan(20);
  });

  it("every fetch boundary routes `detail` through formatErrorDetail", () => {
    const offenders: string[] = [];
    for (const [path, raw] of Object.entries(modules)) {
      if (path.includes("/__tests__/")) continue;
      if (path.endsWith("/api/errorDetail.ts")) continue;
      const code = stripComments(raw);
      for (const re of BANNED) {
        if (re.test(code)) offenders.push(`${path} matched ${re}`);
      }
    }
    expect(
      offenders,
      `Found hand-rolled error-detail casts (use formatErrorDetail from ` +
        `api/errorDetail.ts instead — a 422 detail is an array, not a ` +
        `string, and casting it yields "[object Object]"):\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
