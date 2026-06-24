/**
 * Tests for the Facilitator-level invite-code probe + gate render
 * orchestration. The gate component itself is covered in
 * ``InviteGate.test.tsx``; this file pins the orchestration contract:
 *
 * - The wizard does NOT render while the mount-time probe is in flight.
 * - The wizard renders when the server reports the gate is off.
 * - A returning visitor with ANY stored code skips the gate (the code
 *   is carried forward optimistically; a stale one is rejected at
 *   create time, not by a mount-time oracle — that oracle was removed
 *   server-side). The stored value is preserved, not cleared.
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
    });
    render(<Facilitator />);
    expect(
      await screen.findByLabelText(/invite code/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/What happened, when, at what severity/i),
    ).not.toBeInTheDocument();
  });

  it("skips the gate (and preserves the stored code) for a returning visitor on a gated deploy", async () => {
    // Post-oracle-removal: the mount probe only reports ``required``,
    // so ANY stored code is carried forward optimistically and the gate
    // is skipped. A stale code is no longer caught here — it's rejected
    // at create time (covered in the create-403 path), where the user
    // is re-prompted. The stored value is NOT cleared on mount.
    window.localStorage.setItem(INVITE_CODE_STORAGE_KEY, "tabletop-2026");
    vi.spyOn(api, "getInviteStatus").mockResolvedValue({
      required: true,
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

  it("clears the stored code and shows the wizard when the gate is off", async () => {
    // When the server reports no gate, a leftover stored code is
    // dropped so a later flip back to gated can't accept a now-
    // untrusted value. (This is the one mount-time path that still
    // clears storage; the invalid-code clear moved to the create-403
    // handler.)
    window.localStorage.setItem(INVITE_CODE_STORAGE_KEY, "leftover");
    vi.spyOn(api, "getInviteStatus").mockResolvedValue({
      required: false,
    });
    render(<Facilitator />);
    expect(
      await screen.findByPlaceholderText(
        /What happened, when, at what severity/i,
      ),
    ).toBeInTheDocument();
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
