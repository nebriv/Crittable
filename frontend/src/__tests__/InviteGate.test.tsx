/**
 * Component tests for the soft anti-strangers invite gate.
 *
 * Pins the contract <Facilitator/> depends on: the user can submit a
 * code, the submit path revalidates against ``api.getInviteStatus``,
 * valid codes persist to localStorage + call ``onValidated``, invalid
 * ones surface an inline error without storing anything, and a
 * ``staleNotice`` prop renders the operator-rotated-code recovery
 * banner. The stored-code revalidation on mount is <Facilitator/>'s
 * responsibility (covered in ``Facilitator.intro.test.tsx``), not
 * the gate's — keeping it here would split the source of truth.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../api/client";
import { InviteGate } from "../components/InviteGate";
import { readStoredInviteCode } from "../lib/inviteCodeStorage";

describe("InviteGate", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("calls onValidated and persists the code when the server accepts it", async () => {
    const onValidated = vi.fn();
    vi.spyOn(api, "getInviteStatus").mockResolvedValue({
      required: true,
      valid: true,
    });
    render(<InviteGate onValidated={onValidated} />);

    fireEvent.change(screen.getByLabelText(/invite code/i), {
      target: { value: "tabletop-2026" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(onValidated).toHaveBeenCalledWith("tabletop-2026");
    });
    expect(readStoredInviteCode()).toBe("tabletop-2026");
  });

  it("surfaces an inline error and does not persist when the server rejects", async () => {
    const onValidated = vi.fn();
    vi.spyOn(api, "getInviteStatus").mockResolvedValue({
      required: true,
      valid: false,
    });
    render(<InviteGate onValidated={onValidated} />);

    fireEvent.change(screen.getByLabelText(/invite code/i), {
      target: { value: "wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/didn't match/i);
    });
    expect(onValidated).not.toHaveBeenCalled();
    expect(readStoredInviteCode()).toBeNull();
  });

  it("blocks submit on an empty / whitespace-only code without probing the server", async () => {
    const onValidated = vi.fn();
    const probe = vi.spyOn(api, "getInviteStatus");
    render(<InviteGate onValidated={onValidated} />);

    fireEvent.change(screen.getByLabelText(/invite code/i), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    expect(screen.getByRole("alert")).toHaveTextContent(/enter the invite code/i);
    expect(probe).not.toHaveBeenCalled();
    expect(onValidated).not.toHaveBeenCalled();
  });

  it("surfaces a network error instead of silently dropping the submit", async () => {
    const onValidated = vi.fn();
    vi.spyOn(api, "getInviteStatus").mockRejectedValue(new Error("boom"));
    render(<InviteGate onValidated={onValidated} />);

    fireEvent.change(screen.getByLabelText(/invite code/i), {
      target: { value: "tabletop-2026" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/boom/);
    });
    expect(onValidated).not.toHaveBeenCalled();
    expect(readStoredInviteCode()).toBeNull();
  });

  it("renders the staleNotice banner above the input when provided", () => {
    render(
      <InviteGate
        onValidated={() => undefined}
        staleNotice="Your invite code is no longer valid."
      />,
    );
    expect(
      screen.getByText(/no longer valid/i),
    ).toBeInTheDocument();
  });
});
