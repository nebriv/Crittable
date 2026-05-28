/**
 * Tests for ``frontend/src/lib/sessionDraftStorage.ts``.
 *
 * The draft storage is the only thing standing between an operator's
 * half-filled wizard and a tab-refresh wiping the form. The contract
 * we care about:
 *
 *   * round-trips a complete draft byte-for-byte,
 *   * tolerates an entirely missing entry without throwing,
 *   * recovers field-by-field when a stored entry was written by a
 *     prior schema (unknown field → default; valid field → kept),
 *   * silently no-ops when ``sessionStorage`` is unavailable
 *     (private mode, strict CSP, quota exhausted).
 *
 * A regression in any of these would either lose form data the user
 * already typed, or — worse — let corrupt storage break the page on
 * mount before the operator can even reach the form.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SESSION_FEATURES } from "../api/client";
import {
  SESSION_DRAFT_STORAGE_KEY,
  type SessionDraft,
  clearStoredSessionDraft,
  readStoredSessionDraft,
  writeStoredSessionDraft,
} from "../lib/sessionDraftStorage";

function _completeDraft(): SessionDraft {
  return {
    setupParts: {
      scenario: "Ransomware mid-quarter close",
      team: "CISO + IR Lead + Legal",
      environment: "Azure AD + Defender",
      constraints: "No real CVEs",
    },
    creatorLabel: "CISO",
    creatorDisplayName: "Alice",
    setupRoleSlots: [
      {
        key: "IC",
        code: "IC",
        label: "Incident Commander",
        description: "Owns the response.",
        active: true,
        builtin: true,
      },
      {
        key: "custom-abc-123",
        label: "Threat Intel",
        active: false,
        builtin: false,
      },
    ],
    setupRoleDraft: "Forensics",
    difficulty: "hard",
    durationMinutes: 90,
    features: {
      active_adversary: true,
      time_pressure: false,
      executive_escalation: true,
      media_pressure: true,
    },
    introStep: 2,
  };
}

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  window.sessionStorage.clear();
});

describe("sessionDraftStorage — round-trip", () => {
  it("read returns null when nothing is stored", () => {
    expect(readStoredSessionDraft()).toBeNull();
  });

  it("write + read returns the exact draft", () => {
    const draft = _completeDraft();
    writeStoredSessionDraft(draft);
    expect(readStoredSessionDraft()).toEqual(draft);
  });

  it("clear removes the entry", () => {
    writeStoredSessionDraft(_completeDraft());
    clearStoredSessionDraft();
    expect(readStoredSessionDraft()).toBeNull();
  });

  it("write overwrites an existing draft (no merge)", () => {
    writeStoredSessionDraft(_completeDraft());
    const next: SessionDraft = {
      ..._completeDraft(),
      setupParts: {
        scenario: "Different scenario",
        team: "",
        environment: "",
        constraints: "",
      },
      introStep: 3,
    };
    writeStoredSessionDraft(next);
    expect(readStoredSessionDraft()).toEqual(next);
  });
});

describe("sessionDraftStorage — schema tolerance", () => {
  it("non-JSON storage returns null instead of throwing", () => {
    window.sessionStorage.setItem(SESSION_DRAFT_STORAGE_KEY, "{not json");
    expect(readStoredSessionDraft()).toBeNull();
  });

  it("non-object JSON returns null instead of throwing", () => {
    window.sessionStorage.setItem(SESSION_DRAFT_STORAGE_KEY, "42");
    expect(readStoredSessionDraft()).toBeNull();
  });

  it("missing setupParts falls back to empty strings", () => {
    window.sessionStorage.setItem(
      SESSION_DRAFT_STORAGE_KEY,
      JSON.stringify({}),
    );
    const out = readStoredSessionDraft();
    expect(out?.setupParts).toEqual({
      scenario: "",
      team: "",
      environment: "",
      constraints: "",
    });
  });

  it("partial setupParts (missing a field) falls back to all-empty", () => {
    // A field-type mismatch invalidates the whole subobject — we
    // don't try to merge half-typed shape because partial-trust on
    // free-text fields is just as user-confusing as fully losing
    // them, and the validator stays simple.
    window.sessionStorage.setItem(
      SESSION_DRAFT_STORAGE_KEY,
      JSON.stringify({ setupParts: { scenario: "kept" } }),
    );
    const out = readStoredSessionDraft();
    expect(out?.setupParts).toEqual({
      scenario: "",
      team: "",
      environment: "",
      constraints: "",
    });
  });

  it("unknown difficulty falls back to standard", () => {
    window.sessionStorage.setItem(
      SESSION_DRAFT_STORAGE_KEY,
      JSON.stringify({ difficulty: "extreme" }),
    );
    expect(readStoredSessionDraft()?.difficulty).toBe("standard");
  });

  it("non-numeric durationMinutes falls back to 60", () => {
    window.sessionStorage.setItem(
      SESSION_DRAFT_STORAGE_KEY,
      JSON.stringify({ durationMinutes: "ninety" }),
    );
    expect(readStoredSessionDraft()?.durationMinutes).toBe(60);
  });

  it("malformed features falls back to defaults", () => {
    window.sessionStorage.setItem(
      SESSION_DRAFT_STORAGE_KEY,
      JSON.stringify({ features: { active_adversary: "yes" } }),
    );
    expect(readStoredSessionDraft()?.features).toEqual(
      DEFAULT_SESSION_FEATURES,
    );
  });

  it("invalid introStep falls back to 1", () => {
    window.sessionStorage.setItem(
      SESSION_DRAFT_STORAGE_KEY,
      JSON.stringify({ introStep: 4 }),
    );
    expect(readStoredSessionDraft()?.introStep).toBe(1);
  });

  it("setupRoleSlots: invalid entries are dropped; valid entries kept", () => {
    window.sessionStorage.setItem(
      SESSION_DRAFT_STORAGE_KEY,
      JSON.stringify({
        setupRoleSlots: [
          {
            key: "IC",
            label: "Incident Commander",
            active: true,
            builtin: true,
          },
          { key: 42, label: "bad" }, // wrong type → dropped
          { label: "no key" }, // missing key → dropped
          {
            key: "custom-1",
            label: "Threat Intel",
            active: false,
            builtin: false,
          },
        ],
      }),
    );
    const slots = readStoredSessionDraft()?.setupRoleSlots ?? [];
    expect(slots.map((s) => s.key)).toEqual(["IC", "custom-1"]);
  });

  it("non-array setupRoleSlots returns empty array (caller falls back to builtins)", () => {
    window.sessionStorage.setItem(
      SESSION_DRAFT_STORAGE_KEY,
      JSON.stringify({ setupRoleSlots: "oops" }),
    );
    expect(readStoredSessionDraft()?.setupRoleSlots).toEqual([]);
  });

  it("partial setupParts with wrong field TYPE (not just missing) falls back to empty", () => {
    // The validator rejects {scenario: 42, team: "ok", ...} because
    // ``scenario`` isn't a string. Per the rest of the contract, the
    // whole sub-object falls back to all-empty rather than half-typed.
    window.sessionStorage.setItem(
      SESSION_DRAFT_STORAGE_KEY,
      JSON.stringify({
        setupParts: {
          scenario: 42,
          team: "ok",
          environment: "",
          constraints: "",
        },
      }),
    );
    expect(readStoredSessionDraft()?.setupParts).toEqual({
      scenario: "",
      team: "",
      environment: "",
      constraints: "",
    });
  });

  it("durationMinutes NaN falls back to default 60", () => {
    window.sessionStorage.setItem(
      SESSION_DRAFT_STORAGE_KEY,
      // JSON can't carry NaN literally — JSON.stringify drops it to
      // null. Test the typeof-narrowing branch with a string instead,
      // then assert the bound semantics with a separate test below.
      JSON.stringify({ durationMinutes: null }),
    );
    expect(readStoredSessionDraft()?.durationMinutes).toBe(60);
  });

  it("durationMinutes is clamped to the backend's [15, 180] range", () => {
    // Defense-in-depth: even though the wizard's range input visually
    // clamps and the backend rejects out-of-band values with 400, the
    // storage boundary clamps so a hand-edited sessionStorage entry
    // can't dump an absurd value into a UI label like "10000000 MIN".
    window.sessionStorage.setItem(
      SESSION_DRAFT_STORAGE_KEY,
      JSON.stringify({ durationMinutes: 99999 }),
    );
    expect(readStoredSessionDraft()?.durationMinutes).toBe(180);
    window.sessionStorage.setItem(
      SESSION_DRAFT_STORAGE_KEY,
      JSON.stringify({ durationMinutes: 1 }),
    );
    expect(readStoredSessionDraft()?.durationMinutes).toBe(15);
    window.sessionStorage.setItem(
      SESSION_DRAFT_STORAGE_KEY,
      JSON.stringify({ durationMinutes: -100 }),
    );
    expect(readStoredSessionDraft()?.durationMinutes).toBe(15);
  });
});

describe("sessionDraftStorage — silent-failure logging", () => {
  // CLAUDE.md "Logging rules" require every broad catch to log so a
  // user reporting "my draft didn't restore" gives the operator a
  // breadcrumb in the console. These tests pin the wiring — a future
  // refactor that drops the console.warn would regress diagnosability.
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("read: corrupt JSON in storage logs a warning + returns null", () => {
    window.sessionStorage.setItem(SESSION_DRAFT_STORAGE_KEY, "{not json");
    expect(readStoredSessionDraft()).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[sessionDraft]"),
      expect.anything(),
    );
  });

  it("write: a throwing setItem logs a warning + does not throw", () => {
    // jsdom's sessionStorage uses prototype methods, so spy on the
    // Storage prototype rather than the instance property.
    const setSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota exceeded");
      });
    try {
      expect(() => writeStoredSessionDraft(_completeDraft())).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[sessionDraft]"),
        expect.anything(),
      );
    } finally {
      setSpy.mockRestore();
    }
  });

  it("clear: a throwing removeItem logs a warning + does not throw", () => {
    const removeSpy = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(() => {
        throw new Error("nope");
      });
    try {
      expect(() => clearStoredSessionDraft()).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[sessionDraft]"),
        expect.anything(),
      );
    } finally {
      removeSpy.mockRestore();
    }
  });
});

describe("sessionDraftStorage — multiple custom rows", () => {
  it("preserves React stable keys across a write→read round trip", () => {
    // The wizard mints custom keys as ``custom-<ts>-<rand>`` to keep
    // React reconciliation stable when two rows share a label. The
    // round-trip must keep each key distinct so a remount doesn't
    // collapse the rows. Regression net for the "two custom adds"
    // edge case.
    const draft: SessionDraft = {
      ..._completeDraft(),
      setupRoleSlots: [
        {
          key: "custom-abc-111",
          label: "Threat Intel",
          active: true,
          builtin: false,
        },
        {
          key: "custom-def-222",
          label: "Forensics",
          active: false,
          builtin: false,
        },
        {
          key: "custom-ghi-333",
          label: "Threat Intel",
          active: true,
          builtin: false,
        },
      ],
    };
    writeStoredSessionDraft(draft);
    const out = readStoredSessionDraft();
    expect(out?.setupRoleSlots.map((s) => s.key)).toEqual([
      "custom-abc-111",
      "custom-def-222",
      "custom-ghi-333",
    ]);
  });
});
