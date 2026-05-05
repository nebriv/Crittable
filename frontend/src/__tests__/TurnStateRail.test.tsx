/**
 * Component tests for the TURN STATE rail (issue #111).
 *
 * Pins the determinate-vs-sweep contract that the brand mock and the
 * backend's ``progress_pct`` field cooperate to produce:
 *
 *   - Without ``progressPct`` (or ``null`` / ``undefined``): the
 *     active row renders the indeterminate ``tt-stream`` sweep
 *     (decorative; ``aria-hidden``).
 *   - With a numeric ``progressPct``: the active row renders a
 *     determinate width-driven bar with ``role="progressbar"`` +
 *     ``aria-valuemin/max/now``.
 *
 * Both behaviors are acceptance criteria from the issue.
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TurnStateRail } from "../components/brand/TurnStateRail";

describe("TurnStateRail", () => {
  it("renders the indeterminate sweep when progressPct is omitted", () => {
    const { container, queryByRole } = render(
      <TurnStateRail state="AI_PROCESSING" />,
    );
    // No determinate progressbar.
    expect(queryByRole("progressbar")).toBeNull();
    // Sweep child is present and uses the ``animate-tt-stream`` class
    // hook so the global ``prefers-reduced-motion`` rule disables it.
    const sweep = container.querySelector(".animate-tt-stream");
    expect(sweep).not.toBeNull();
  });

  it("renders the indeterminate sweep when progressPct is null", () => {
    const { queryByRole } = render(
      <TurnStateRail state="AI_PROCESSING" progressPct={null} />,
    );
    expect(queryByRole("progressbar")).toBeNull();
  });

  it("renders a determinate bar with aria-valuenow when progressPct is set", () => {
    const { getByRole } = render(
      <TurnStateRail state="AI_PROCESSING" progressPct={0.42} />,
    );
    const bar = getByRole("progressbar");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
  });

  it("treats progressPct=0 as a real value (not nullish)", () => {
    const { getByRole } = render(
      <TurnStateRail state="AWAITING_PLAYERS" progressPct={0} />,
    );
    const bar = getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
  });

  it("clamps progressPct to [0, 1]", () => {
    const high = render(
      <TurnStateRail state="AI_PROCESSING" progressPct={1.5} />,
    );
    expect(high.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
    high.unmount();

    const low = render(
      <TurnStateRail state="AI_PROCESSING" progressPct={-0.2} />,
    );
    expect(low.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
  });

  it("does not render a progressbar when no step is active", () => {
    // ``state=null`` collapses to no active row → no bar of any kind.
    const { queryByRole, container } = render(
      <TurnStateRail state={null} progressPct={0.5} />,
    );
    expect(queryByRole("progressbar")).toBeNull();
    expect(container.querySelector(".animate-tt-stream")).toBeNull();
  });

  it("only renders the bar on the active row, not on done/pending rows", () => {
    // ``AI_PROCESSING`` is mid-flight: SETUP and BRIEFING are done,
    // AWAITING_PLAYERS and ENDED are pending. Only AI_PROCESSING's
    // row hosts the determinate bar.
    const { getAllByRole } = render(
      <TurnStateRail state="AI_PROCESSING" progressPct={0.7} />,
    );
    const bars = getAllByRole("progressbar");
    expect(bars).toHaveLength(1);
  });
});
