/**
 * Tests for the Facilitator-level invite-code probe + gate render
 * orchestration. The gate component itself is covered in
 * ``InviteGate.test.tsx``; this file pins the orchestration contract:
 *
 * - The wizard does NOT render while the mount-time probe is in flight.
 * - The wizard renders when the server reports the gate is off.
 * - A returning visitor with a stored + still-valid code skips the
 *   gate entirely (no wizard-filling-then-bouncing UX from the
 *   user-agent review HIGH-1).
 * - A returning visitor with a stored + invalid code lands on the
 *   gate (stored value cleared) without filling the wizard first.
 * - A first-time visitor on a gated deploy lands on the gate.
 *
 * The WS module is stubbed because the test stays on the intro phase
 * and never opens a session, but the import path runs ``new WsClient``
 * inside the connect effect anyway.
 */
import { render, screen, waitFor } from "@testing-library/react";
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

import { api } from "../api/client";
import { Facilitator } from "../pages/Facilitator";
import {
  INVITE_CODE_STORAGE_KEY,
  readStoredInviteCode,
} from "../lib/inviteCodeStorage";

describe("Facilitator — invite-code probe orchestration", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("shows the loading state while the mount-time probe is in flight", async () => {
    // Probe never resolves → component sticks on the loader. ``aria-busy``
    // on the section is the marker.
    vi.spyOn(api, "getInviteStatus").mockReturnValue(
      new Promise(() => undefined),
    );
    render(<Facilitator />);
    expect(
      await screen.findByLabelText(/checking access/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/What happened, when, at what severity/i),
    ).not.toBeInTheDocument();
  });

  it("renders the wizard when the server reports no gate", async () => {
    vi.spyOn(api, "getInviteStatus").mockResolvedValue({
      required: false,
      valid: null,
    });
    render(<Facilitator />);
    expect(
      await screen.findByPlaceholderText(
        /What happened, when, at what severity/i,
      ),
    ).toBeInTheDocument();
  });

  it("renders the gate (not the wizard) on a first-time visit to a gated deploy", async () => {
    vi.spyOn(api, "getInviteStatus").mockResolvedValue({
      required: true,
      valid: null,
    });
    render(<Facilitator />);
    expect(
      await screen.findByLabelText(/invite code/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/What happened, when, at what severity/i),
    ).not.toBeInTheDocument();
  });

  it("skips the gate for a returning visitor whose stored code is still valid", async () => {
    window.localStorage.setItem(INVITE_CODE_STORAGE_KEY, "tabletop-2026");
    vi.spyOn(api, "getInviteStatus").mockResolvedValue({
      required: true,
      valid: true,
    });
    render(<Facilitator />);
    expect(
      await screen.findByPlaceholderText(
        /What happened, when, at what severity/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/invite code/i)).not.toBeInTheDocument();
    expect(readStoredInviteCode()).toBe("tabletop-2026");
  });

  it("clears storage + shows the gate when a returning visitor's stored code is no longer valid", async () => {
    // The user-agent review HIGH-1 — a returning visitor with a
    // rotated-since-last-visit code MUST NOT fill out the wizard
    // first. The revalidation lives at the Facilitator probe.
    window.localStorage.setItem(INVITE_CODE_STORAGE_KEY, "old-code");
    vi.spyOn(api, "getInviteStatus").mockResolvedValue({
      required: true,
      valid: false,
    });
    render(<Facilitator />);
    expect(
      await screen.findByLabelText(/invite code/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/What happened, when, at what severity/i),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(readStoredInviteCode()).toBeNull();
    });
  });

  it("falls open to the wizard on a probe network error rather than soft-bricking", async () => {
    vi.spyOn(api, "getInviteStatus").mockRejectedValue(new Error("offline"));
    render(<Facilitator />);
    expect(
      await screen.findByPlaceholderText(
        /What happened, when, at what severity/i,
      ),
    ).toBeInTheDocument();
  });
});
