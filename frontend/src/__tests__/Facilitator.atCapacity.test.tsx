/**
 * Tests for the "at capacity" (HTTP 503) handling on session creation.
 *
 * When ``POST /api/sessions`` comes back 503 (the server has hit its
 * live-session cap), <Facilitator/> must render a distinct, on-brand
 * "at capacity" card instead of the generic red error line, mention the
 * ``Retry-After`` wait when the header is present, and let the operator
 * RETRY back into the wizard (draft intact). A non-503 failure must keep
 * the existing generic-error path.
 *
 * The WS module is stubbed because the test stays on the intro phase and
 * never opens a session, but the connect effect constructs ``WsClient``
 * regardless.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ws", () => {
  return {
    WsClient: class {
      connect() {
        /* no-op */
      }
      close() {
        /* no-op */
      }
      send() {
        /* no-op */
      }
    },
  };
});

import { api, ApiError } from "../api/client";
import { Facilitator } from "../pages/Facilitator";
import { INVITE_CODE_STORAGE_KEY } from "../lib/inviteCodeStorage";

// The wizard splits creation across 3 steps; ROLL SESSION lives on
// step 3. Walk there, then submit the form the button belongs to (the
// same pattern Facilitator.intro.test.tsx uses to fire create).
async function rollSession() {
  fireEvent.click(
    await screen.findByRole("button", { name: /NEXT · ENVIRONMENT/i }),
  );
  fireEvent.click(screen.getByRole("button", { name: /NEXT · ROLES/i }));
  const rollBtn = await screen.findByRole("button", { name: /ROLL SESSION/i });
  const form = rollBtn.closest("form");
  if (!form) throw new Error("ROLL SESSION button not inside a form");
  fireEvent.submit(form);
}

describe("Facilitator — at-capacity (503) handling", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    // No invite gate — go straight to the wizard.
    vi.spyOn(api, "getInviteStatus").mockResolvedValue({ required: false });
  });
  afterEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("renders the at-capacity card (not a generic error) and names the Retry-After wait", async () => {
    vi.spyOn(api, "createSession").mockRejectedValue(
      new ApiError("Crittable is at capacity; try again shortly.", 503, 120),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<Facilitator />);
    await rollSession();

    expect(
      await screen.findByText(/Crittable is at capacity/i),
    ).toBeInTheDocument();
    // 120 s rounds up to "about 2 minutes".
    expect(screen.getByText(/about 2 minutes/i)).toBeInTheDocument();
    // The wizard's scenario textarea is gone — the card replaced it.
    expect(
      screen.queryByPlaceholderText(/What happened, when, at what severity/i),
    ).not.toBeInTheDocument();
    // Per the logging rules, the surfaced state also warns with context.
    const warnText = warnSpy.mock.calls.flat().join(" ");
    expect(warnText).toContain("create_session_at_capacity");
  });

  it("falls back to a generic wait when no Retry-After header was present", async () => {
    vi.spyOn(api, "createSession").mockRejectedValue(
      new ApiError("Crittable is at capacity; try again shortly.", 503, null),
    );
    render(<Facilitator />);
    await rollSession();

    expect(
      await screen.findByText(/Crittable is at capacity/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/in a few minutes/i)).toBeInTheDocument();
  });

  it("RETRY dismisses the card and returns to the wizard with the draft intact", async () => {
    vi.spyOn(api, "createSession").mockRejectedValue(
      new ApiError("at capacity", 503, 30),
    );
    render(<Facilitator />);
    // Type into the scenario brief so we can prove the draft survives.
    const scenario = await screen.findByLabelText(/SCENARIO BRIEF/i);
    fireEvent.change(scenario, { target: { value: "Ransomware drill" } });
    await rollSession();

    const retry = await screen.findByRole("button", {
      name: /back to setup · retry/i,
    });
    fireEvent.click(retry);

    // Back on the wizard. ROLL SESSION is on step 3, where the submit
    // left us, and the scenario value is preserved (navigate back to
    // step 1 to read it).
    expect(
      await screen.findByRole("button", { name: /ROLL SESSION/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Crittable is at capacity/i),
    ).not.toBeInTheDocument();
  });

  it("keeps the generic-error path for a non-503 failure (no capacity card)", async () => {
    vi.spyOn(api, "createSession").mockRejectedValue(
      new ApiError("Boom: internal server error", 500, null),
    );
    render(<Facilitator />);
    await rollSession();

    // Generic error surfaces inline on the wizard; no capacity card.
    expect(await screen.findByText(/Boom: internal server error/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/Crittable is at capacity/i),
    ).not.toBeInTheDocument();
    // Still on the wizard (ROLL SESSION reachable).
    expect(
      screen.getByRole("button", { name: /ROLL SESSION/i }),
    ).toBeInTheDocument();
  });

  it("re-prompts the invite gate on a 403 (stale-code path still works)", async () => {
    // Gate on this time; carry a stored code, then 403 on create.
    window.localStorage.setItem(INVITE_CODE_STORAGE_KEY, "old-code");
    vi.spyOn(api, "getInviteStatus").mockResolvedValue({ required: true });
    vi.spyOn(api, "createSession").mockRejectedValue(
      new ApiError("invite code rejected", 403, null),
    );
    render(<Facilitator />);
    // Stored code skips the gate → wizard. Roll → 403 → gate returns.
    await rollSession();
    expect(await screen.findByLabelText(/invite code/i)).toBeInTheDocument();
    expect(
      screen.getByText(/no longer valid/i),
    ).toBeInTheDocument();
    // Not the capacity card.
    expect(
      screen.queryByText(/Crittable is at capacity/i),
    ).not.toBeInTheDocument();
  });
});
