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

  it("Copy link writes to clipboard and never renders the URL", async () => {
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

    const button = screen.getByRole("button", { name: /Copy link/i });
    fireEvent.click(button);

    await waitFor(() => expect(reissue).toHaveBeenCalled());
    await waitFor(() => expect(writeText).toHaveBeenCalled());

    // The clipboard write got a URL containing the token — that's expected.
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("secret-token-do-not-show"),
    );

    // Button label transitions to "Copied!"
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Copied!/ })).toBeInTheDocument(),
    );

    // The token must NEVER appear in the rendered DOM.
    expect(screen.queryByText(/secret-token-do-not-show/)).toBeNull();
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
  });

  it("Copy link surfaces an error when clipboard write fails", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: /Copy link/i }));

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0][0]).toMatch(/clipboard/i);
    expect(screen.queryByText(/secret-token-do-not-show/)).toBeNull();
    // Button stays as "Copy link" (no false success).
    expect(
      screen.getByRole("button", { name: /Copy link/i }),
    ).toBeInTheDocument();
  });
});
