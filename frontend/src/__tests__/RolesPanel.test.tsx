import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Copy link writes to clipboard, never renders the URL, and reverts after the flash window", async () => {
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
      />,
    );

    // Accessible name stays "Copy join link" so screen readers don't
    // double-announce. Visual label flips Copy link → Copied!.
    const button = screen.getByRole("button", { name: /Copy join link/i });
    fireEvent.click(button);

    await waitFor(() => expect(reissue).toHaveBeenCalled());
    await waitFor(() => expect(writeText).toHaveBeenCalled());

    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("secret-token-do-not-show"),
    );

    // Token must NEVER appear in the rendered DOM.
    expect(screen.queryByText(/secret-token-do-not-show/)).toBeNull();

    // Visual badge transitions to Copied!.
    await waitFor(() => expect(button.textContent).toMatch(/Copied!/));

    // Bottom-of-panel success toast confirms for users with eyes
    // elsewhere.
    expect(screen.getByTestId("roles-panel-hint").textContent).toMatch(
      /Join link for SOC Analyst copied/,
    );

    // sr-only live region carries the audible confirmation.
    expect(
      screen.getByRole("status").textContent,
    ).toMatch(/Join link for SOC Analyst copied/);

    // After ~2s the visual badge reverts.
    await waitFor(
      () => expect(button.textContent).toMatch(/Copy link/),
      { timeout: 3000 },
    );
  }, 5000);

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
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Kick & reissue/i }),
    );
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
    ).toMatch(/Copy link/);
  });
});
