/**
 * Component tests for the soft anti-strangers invite gate.
 *
 * Pins the contract <Facilitator/> depends on AFTER the invite-status
 * oracle removal: the user can submit a code, a non-empty code is
 * persisted to localStorage and handed up via ``onValidated`` WITHOUT a
 * pre-validation probe (the match oracle was removed server-side — the
 * code is validated on the create-session call instead), an empty /
 * whitespace-only code is blocked inline, and a ``staleNotice`` prop
 * renders the operator-rotated-code recovery banner.
 *
 * The mount-time probe + the create-time 403 re-prompt are
 * <Facilitator/>'s responsibility (covered in Facilitator.inviteGate /
 * Facilitator.atCapacity tests), not the gate's.
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

  it("persists the code and calls onValidated without probing the server", async () => {
    const onValidated = vi.fn();
    // The gate must NOT hit the status endpoint on submit anymore.
    const probe = vi.spyOn(api, "getInviteStatus");
    render(<InviteGate onValidated={onValidated} />);

    fireEvent.change(screen.getByLabelText(/invite code/i), {
      target: { value: "tabletop-2026" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(onValidated).toHaveBeenCalledWith("tabletop-2026");
    });
    expect(readStoredInviteCode()).toBe("tabletop-2026");
    expect(probe).not.toHaveBeenCalled();
  });

  it("trims surrounding whitespace before persisting and handing up", async () => {
    const onValidated = vi.fn();
    render(<InviteGate onValidated={onValidated} />);

    fireEvent.change(screen.getByLabelText(/invite code/i), {
      target: { value: "  tabletop-2026  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(onValidated).toHaveBeenCalledWith("tabletop-2026");
    });
    expect(readStoredInviteCode()).toBe("tabletop-2026");
  });

  it("blocks submit on an empty / whitespace-only code without storing or handing up", async () => {
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
