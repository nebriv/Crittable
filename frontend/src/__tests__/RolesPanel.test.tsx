import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RolesPanel } from "../components/RolesPanel";
import { api, RoleView } from "../api/client";

const SESSION_ID = "sess-123";
const CREATOR_TOKEN = "creator-token";

const baseRoles: RoleView[] = [
  {
    id: "role-creator",
    label: "Facilitator",
    kind: "player",
    is_creator: true,
    display_name: "Owner",
  } as RoleView,
  {
    id: "role-soc",
    label: "SOC Analyst",
    kind: "player",
    is_creator: false,
    display_name: null,
  } as RoleView,
];

describe("RolesPanel — issue #82 (no on-screen tokens)", () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    // Default: real timers. Vitest fake timers and React Testing
    // Library's `waitFor` polling don't compose cleanly (waitFor uses
    // setTimeout internally for its timeout boundary), so individual
    // tests that need to skip a wall-clock wait opt in to fake timers
    // and avoid `waitFor` for that segment — see the Copy-link test.
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("Copy link writes to clipboard, never renders the URL, and reverts after the flash window", async () => {
    // Fake timers from the start: the 2s revert in markCopied is a
    // setTimeout that we need to advance deterministically. Pre-fix
    // (PR #89 v1) this used `waitFor(..., { timeout: 3000 })` which
    // spent a real 2s of wall-clock per run and Copilot flagged as
    // flaky under CI load. ``advanceTimersByTimeAsync`` flushes both
    // the timer queue and pending microtasks, so the awaits inside
    // the click handler still resolve.
    vi.useFakeTimers();

    const reissue = vi
      .spyOn(api, "reissueRole")
      .mockResolvedValue({
        token: "secret-token-do-not-show",
        join_url: `https://example.test/play/${SESSION_ID}/secret-token-do-not-show`,
      });

    render(
      <RolesPanel
        sessionId={SESSION_ID}
        creatorToken={CREATOR_TOKEN}
        roles={baseRoles}
        busy={false}
        onRoleAdded={vi.fn()}
        onRoleChanged={vi.fn()}
        onError={vi.fn()}
        connectedRoleIds={new Set()}
        focusedRoleIds={new Set()}
      />,
    );

    // Accessible name stays "Copy join link" so screen readers don't
    // double-announce. Visual label flips Copy link → Copied!.
    const button = screen.getByRole("button", { name: /Copy join link/i });
    fireEvent.click(button);

    // Flush microtasks (api.reissueRole + writeText awaits) without
    // advancing the 2s revert timer. Wrapped in act() so the React
    // state updates triggered by the click handler's awaits are
    // batched cleanly (avoids "not wrapped in act(...)" warnings).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(reissue).toHaveBeenCalled();
    expect(writeText).toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("secret-token-do-not-show"),
    );

    // Token must NEVER appear in the rendered DOM.
    expect(screen.queryByText(/secret-token-do-not-show/)).toBeNull();    // Visual badge transitions to COPIED! (mono uppercase).
    expect(button.textContent).toMatch(/Copied!/i);
    // Bottom-of-panel success toast confirms for users with eyes elsewhere.
    expect(screen.getByTestId("roles-panel-hint").textContent).toMatch(
      /Join link for SOC Analyst copied/,
    );
    // sr-only live region carries the audible confirmation.
    expect(screen.getByRole("status").textContent).toMatch(
      /Join link for SOC Analyst copied/,
    );

    // Fast-forward past the 2s flash window — deterministic, no
    // wall-clock wait. act() wraps the state update fired by the
    // setTimeout cleanup in markCopied.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(button.textContent).toMatch(/Copy link/i);
  });

  it("Add role does not render the new role's URL on screen", async () => {
    const onRoleAdded = vi.fn();
    const newRoleId = "role-legal";
    const newRoleLabel = "Legal";

    const addSpy = vi.spyOn(api, "addRole").mockResolvedValue({
      role_id: newRoleId,
      token: "another-secret-token",
      join_url: `https://example.test/play/${SESSION_ID}/another-secret-token`,
      label: newRoleLabel,
      display_name: null,
    });

    render(
      <RolesPanel
        sessionId={SESSION_ID}
        creatorToken={CREATOR_TOKEN}
        roles={baseRoles}
        busy={false}
        onRoleAdded={onRoleAdded}
        onRoleChanged={vi.fn()}
        onError={vi.fn()}
        connectedRoleIds={new Set()}
        focusedRoleIds={new Set()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/IR Lead/i), {
      target: { value: newRoleLabel },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add role/i }));

    await waitFor(() => expect(addSpy).toHaveBeenCalled());
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    await waitFor(() => expect(onRoleAdded).toHaveBeenCalled());

    // Token must not appear anywhere in the DOM, even briefly.
    expect(screen.queryByText(/another-secret-token/)).toBeNull();
    // The form input was cleared.
    expect(
      (screen.getByPlaceholderText(/IR Lead/i) as HTMLInputElement).value,
    ).toBe("");
    // Bottom-of-panel toast confirms the add+copy succeeded so a creator
    // looking at the form (not the new role row) still gets feedback.
    await waitFor(() =>
      expect(screen.getByTestId("roles-panel-hint").textContent).toMatch(
        /Added "Legal" — join link copied/,
      ),
    );
  });

  it("Kick & reissue copies the new link, surfaces a hint, never renders the URL", async () => {
    const onRoleChanged = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const revoke = vi.spyOn(api, "revokeRole").mockResolvedValue({
      token: "fresh-kick-token",
      join_url: `https://example.test/play/${SESSION_ID}/fresh-kick-token`,
    });

    render(
      <RolesPanel
        sessionId={SESSION_ID}
        creatorToken={CREATOR_TOKEN}
        roles={baseRoles}
        busy={false}
        onRoleAdded={vi.fn()}
        onRoleChanged={onRoleChanged}
        onError={vi.fn()}
        connectedRoleIds={new Set()}
        focusedRoleIds={new Set()}
      />,
    );

    // Post-redesign: "Kick & reissue" button text was tightened to just
    // "KICK" (mono uppercase brand button); the title attribute still
    // carries the full description.
    fireEvent.click(screen.getByRole("button", { name: /Kick/i }));
    expect(confirmSpy).toHaveBeenCalled();

    await waitFor(() => expect(revoke).toHaveBeenCalled());
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    await waitFor(() => expect(onRoleChanged).toHaveBeenCalled());

    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("fresh-kick-token"),
    );

    // Token must not appear in the DOM.
    expect(screen.queryByText(/fresh-kick-token/)).toBeNull();

    // Confirmation hint at the bottom of the panel — recovery surface
    // if the in-button flash was missed.
    await waitFor(() =>
      expect(screen.getByTestId("roles-panel-hint").textContent).toMatch(
        /Kicked\. New join link for SOC Analyst copied/,
      ),
    );
  });

  it("renders tri-state status dot per role: blue (active), yellow (joined+idle), grey (not joined)", () => {
    const roles: RoleView[] = [
      {
        id: "role-creator",
        label: "Facilitator",
        kind: "player",
        is_creator: true,
        display_name: "Owner",
      } as RoleView,
      {
        id: "role-active",
        label: "SOC Analyst",
        kind: "player",
        is_creator: false,
        display_name: "Ben",
      } as RoleView,
      {
        id: "role-idle",
        label: "Legal",
        kind: "player",
        is_creator: false,
        display_name: "Sam",
      } as RoleView,
      {
        id: "role-not-joined",
        label: "TEST",
        kind: "player",
        is_creator: false,
        display_name: null,
      } as RoleView,
    ];

    render(
      <RolesPanel
        sessionId={SESSION_ID}
        creatorToken={CREATOR_TOKEN}
        roles={roles}
        busy={false}
        onRoleAdded={vi.fn()}
        onRoleChanged={vi.fn()}
        onError={vi.fn()}
        connectedRoleIds={
          new Set(["role-creator", "role-active", "role-idle"])
        }
        focusedRoleIds={new Set(["role-creator", "role-active"])}
      />,
    );

    // Title attribute carries the human-readable status; it's the
    // most stable selector since the colour class lives on the dot
    // span sibling and Testing Library doesn't expose accessible
    // names for ``aria-hidden`` elements.
    expect(screen.getAllByTitle("Active").length).toBe(2); // creator + active
    expect(screen.getAllByTitle("Joined, tab not active").length).toBe(1);
    expect(screen.getAllByTitle("Not joined").length).toBe(1);

    // Buttons live below the name — no longer inline with it. The
    // pre-redesign layout overlapped buttons across the role label.
    const remove = screen.getAllByRole("button", { name: /remove/i });
    expect(remove.length).toBe(3); // 3 non-creator roles

    // The per-role lowercase "not joined" caption that appeared
    // inline with the role name pre-redesign is now gone — the
    // colour-coded dot already conveys it. We do still emit the
    // capital-N "Not joined" string into a screen-reader-only span
    // so AT users get the same signal, so the assertion is
    // case-sensitive on the visible-style lowercase form.
    const list = screen.getByRole("list");
    expect(list.textContent ?? "").not.toMatch(/not joined/);
  });

  it("Copy link surfaces an inline error when clipboard write fails (not bubbled to onError)", async () => {
    vi.spyOn(api, "reissueRole").mockResolvedValue({
      token: "secret-token-do-not-show",
      join_url: `https://example.test/play/${SESSION_ID}/secret-token-do-not-show`,
    });
    writeText.mockRejectedValueOnce(new Error("permission denied"));
    const onError = vi.fn();

    render(
      <RolesPanel
        sessionId={SESSION_ID}
        creatorToken={CREATOR_TOKEN}
        roles={baseRoles}
        busy={false}
        onRoleAdded={vi.fn()}
        onRoleChanged={vi.fn()}
        onError={onError}
        connectedRoleIds={new Set()}
        focusedRoleIds={new Set()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Copy join link/i }),
    );

    // Inline error hint shows up next to the button — not bubbled
    // through onError, so the error doesn't render far away in the
    // page-level banner.
    await waitFor(() =>
      expect(screen.getByTestId("roles-panel-error").textContent).toMatch(
        /Could not copy link/i,
      ),
    );
    expect(onError).not.toHaveBeenCalled();
    expect(screen.queryByText(/secret-token-do-not-show/)).toBeNull();

    // Button stays as Copy link (no false success badge).
    expect(
      (screen.getByRole("button", { name: /Copy join link/i }) as HTMLElement)
        .textContent,
    ).toMatch(/Copy link/i);
  });
});
