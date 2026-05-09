/**
 * Component tests for the issue #191 creator-only banner.
 *
 * Pins the operator-visible copy per category, the status-page link
 * shape, and the ``request_id`` / ``HTTP <status>`` trace footer.
 * Locks the dismiss handler contract for the parent (Facilitator).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { UpstreamLlmErrorBanner } from "../components/UpstreamLlmErrorBanner";
import type { ServerEvent } from "../lib/ws";

type UpstreamErrorEvent = Extract<ServerEvent, { type: "error" }>;

function makeEvent(
  partial: Partial<UpstreamErrorEvent> = {},
): UpstreamErrorEvent {
  return {
    type: "error",
    scope: "upstream_llm",
    category: "overloaded",
    status_code: 529,
    request_id: "req_test_abc",
    retry_hint_seconds: null,
    ...partial,
  };
}

describe("UpstreamLlmErrorBanner", () => {
  it("renders overloaded copy + status-page link with safe rel attrs", () => {
    render(<UpstreamLlmErrorBanner event={makeEvent()} onDismiss={() => {}} />);
    expect(
      screen.getByText("Anthropic API overloaded."),
    ).toBeInTheDocument();
    expect(screen.getByText(/UPSTREAM · OVERLOADED/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /status\.claude\.com/ });
    expect(link).toHaveAttribute("href", "https://status.claude.com/");
    // Open-in-new-tab safety: ``rel`` must include ``noreferrer`` and
    // ``noopener`` so the popup cannot navigate the opener via
    // ``window.opener``.
    const rel = link.getAttribute("rel") ?? "";
    expect(rel).toContain("noreferrer");
    expect(rel).toContain("noopener");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("renders rate-limited copy with retry-after seconds when provided", () => {
    render(
      <UpstreamLlmErrorBanner
        event={makeEvent({
          category: "rate_limited",
          status_code: 429,
          retry_hint_seconds: 42,
        })}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText("Rate-limited by Anthropic.")).toBeInTheDocument();
    expect(
      screen.getByText(/Anthropic suggests retrying after 42s/),
    ).toBeInTheDocument();
  });

  it("renders rate-limited fallback copy when retry_hint_seconds absent", () => {
    render(
      <UpstreamLlmErrorBanner
        event={makeEvent({
          category: "rate_limited",
          status_code: 429,
          retry_hint_seconds: null,
        })}
        onDismiss={() => {}}
      />,
    );
    expect(
      screen.getByText(/Try again in 30–60s/),
    ).toBeInTheDocument();
  });

  it("renders timeout copy with no status code when none provided", () => {
    render(
      <UpstreamLlmErrorBanner
        event={makeEvent({
          category: "timeout",
          status_code: null,
          retry_hint_seconds: null,
        })}
        onDismiss={() => {}}
      />,
    );
    expect(
      screen.getByText("Connection to Anthropic timed out."),
    ).toBeInTheDocument();
    // Status code is absent — the trace line should NOT show "HTTP".
    expect(screen.queryByText(/HTTP/)).toBeNull();
  });

  it("renders server_error copy with HTTP status in the trace line", () => {
    render(
      <UpstreamLlmErrorBanner
        event={makeEvent({
          category: "server_error",
          status_code: 500,
          request_id: null,
        })}
        onDismiss={() => {}}
      />,
    );
    expect(
      screen.getByText("Anthropic returned a server error."),
    ).toBeInTheDocument();
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
  });

  it("renders unknown-category fallback copy", () => {
    // Defensive: ``category`` is optional in the union; defaults to
    // unknown copy so a future backend that emits a new category
    // doesn't render a blank banner.
    render(
      <UpstreamLlmErrorBanner
        event={makeEvent({ category: undefined as never })}
        onDismiss={() => {}}
      />,
    );
    expect(
      screen.getByText(/Unexpected error reached Crittable/),
    ).toBeInTheDocument();
  });

  it("renders trace footer with both HTTP code and req id when both present", () => {
    render(
      <UpstreamLlmErrorBanner
        event={makeEvent({ status_code: 529, request_id: "req_xyz" })}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText(/HTTP 529/)).toBeInTheDocument();
    expect(screen.getByText(/req req_xyz/)).toBeInTheDocument();
  });

  it("hides the trace footer when status_code AND request_id are absent", () => {
    render(
      <UpstreamLlmErrorBanner
        event={makeEvent({ status_code: null, request_id: null })}
        onDismiss={() => {}}
      />,
    );
    expect(screen.queryByText(/HTTP/)).toBeNull();
    expect(screen.queryByText(/req /)).toBeNull();
  });

  it("calls onDismiss when the dismiss button is clicked", () => {
    const onDismiss = vi.fn();
    render(<UpstreamLlmErrorBanner event={makeEvent()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("uses role=alert + aria-live=assertive for screen-reader urgency", () => {
    render(<UpstreamLlmErrorBanner event={makeEvent()} onDismiss={() => {}} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });
});
