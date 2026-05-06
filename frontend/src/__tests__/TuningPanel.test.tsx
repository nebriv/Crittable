import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { SetupWizard, type SetupParts } from "../components/setup/SetupWizard";
import { DEFAULT_SESSION_FEATURES, type Difficulty, type SessionFeatures } from "../api/client";

/**
 * Issue #33-lite — TuningPanel (Step 2) interaction coverage.
 *
 * The Facilitator owns the canonical state; the wizard mirrors it
 * via setDifficulty / setDurationMinutes / setFeatures. These tests
 * use a thin host component with real ``useState`` so we can assert
 * the visual / DOM outputs match the propagated state, not just that
 * a setter was called with the right shape (the latter is a weaker
 * regression net — catches the "passed plain object instead of
 * functional updater" bug class but not the "render didn't update"
 * one).
 */

const EMPTY_PARTS: SetupParts = {
  scenario: "",
  team: "",
  environment: "",
  constraints: "",
};

interface HostProps {
  initialDifficulty?: Difficulty;
  initialDuration?: number;
  initialFeatures?: SessionFeatures;
}

function Host({
  initialDifficulty = "standard",
  initialDuration = 60,
  initialFeatures = { ...DEFAULT_SESSION_FEATURES },
}: HostProps) {
  const [difficulty, setDifficulty] = useState<Difficulty>(initialDifficulty);
  const [durationMinutes, setDurationMinutes] = useState(initialDuration);
  const [features, setFeatures] = useState<SessionFeatures>(initialFeatures);
  return (
    <SetupWizard
      phase="intro"
      setupParts={EMPTY_PARTS}
      setSetupParts={vi.fn()}
      creatorLabel="CISO"
      setCreatorLabel={vi.fn()}
      creatorDisplayName="Alice"
      setCreatorDisplayName={vi.fn()}
      setupRoleSlots={[
        {
          key: "IC",
          code: "IC",
          label: "Incident Commander",
          active: true,
          builtin: true,
        },
      ]}
      setSetupRoleSlots={vi.fn()}
      setupRoleDraft=""
      setSetupRoleDraft={vi.fn()}
      devMode={false}
      setDevMode={vi.fn()}
      busy={false}
      busyMessage={null}
      error={null}
      onSubmit={vi.fn((e) => e.preventDefault())}
      difficulty={difficulty}
      setDifficulty={setDifficulty}
      durationMinutes={durationMinutes}
      setDurationMinutes={setDurationMinutes}
      features={features}
      setFeatures={setFeatures}
    />
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

function advanceToStep2() {
  // Step 1 → Step 2 advance is a button click (not a form submit).
  fireEvent.click(screen.getByText(/NEXT · ENVIRONMENT/i));
}

describe("TuningPanel — defaults render correctly", () => {
  it("standard difficulty chip is selected by default", () => {
    render(<Host />);
    advanceToStep2();
    const standard = screen.getByRole("radio", { name: /STANDARD/i });
    expect(standard).toHaveAttribute("aria-checked", "true");
  });

  it("duration label reads 60 MIN by default", () => {
    render(<Host />);
    advanceToStep2();
    expect(screen.getByText(/^60 MIN$/i)).toBeInTheDocument();
  });

  it("first three feature checkboxes default ON, media OFF", () => {
    render(<Host />);
    advanceToStep2();
    // Each checkbox sits inside a label whose accessible name is
    // the toggle label.
    const adv = screen.getByRole("checkbox", { name: /Active adversary/i });
    const time = screen.getByRole("checkbox", { name: /Time pressure/i });
    const exec = screen.getByRole("checkbox", { name: /Executive escalation/i });
    const media = screen.getByRole("checkbox", { name: /Media \/ PR pressure/i });
    expect(adv).toBeChecked();
    expect(time).toBeChecked();
    expect(exec).toBeChecked();
    expect(media).not.toBeChecked();
  });

  it("FROZEN ON ROLL indicator appears in the legend", () => {
    render(<Host />);
    advanceToStep2();
    expect(screen.getByText(/FROZEN ON ROLL/i)).toBeInTheDocument();
  });
});

describe("TuningPanel — interactions update visible state", () => {
  it("clicking HARD chip flips the selected radio + updates the description", () => {
    render(<Host />);
    advanceToStep2();
    fireEvent.click(screen.getByRole("radio", { name: /HARD/i }));
    expect(screen.getByRole("radio", { name: /HARD/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: /STANDARD/i })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    // Difficulty descriptor flips to the "Literal execution" copy.
    expect(screen.getByText(/Literal execution/i)).toBeInTheDocument();
  });

  it("ArrowRight on the selected chip moves to next chip (radiogroup nav)", () => {
    render(<Host />);
    advanceToStep2();
    const standardChip = screen.getByRole("radio", { name: /STANDARD/i });
    standardChip.focus();
    fireEvent.keyDown(standardChip, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: /HARD/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("ArrowLeft from EASY wraps to HARD (cyclic radiogroup nav)", () => {
    render(<Host initialDifficulty="easy" />);
    advanceToStep2();
    const easyChip = screen.getByRole("radio", { name: /EASY/i });
    easyChip.focus();
    fireEvent.keyDown(easyChip, { key: "ArrowLeft" });
    expect(screen.getByRole("radio", { name: /HARD/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("changing the slider updates the displayed minutes", () => {
    render(<Host />);
    advanceToStep2();
    const slider = screen.getByLabelText(/Target duration in minutes/i);
    fireEvent.change(slider, { target: { value: "120" } });
    expect(screen.getByText(/^120 MIN$/i)).toBeInTheDocument();
  });

  it("toggling media checkbox flips ONLY that toggle (no cross-feature blowaway)", () => {
    render(<Host />);
    advanceToStep2();
    const adv = screen.getByRole("checkbox", { name: /Active adversary/i });
    const media = screen.getByRole("checkbox", { name: /Media \/ PR pressure/i });
    expect(adv).toBeChecked();
    expect(media).not.toBeChecked();
    fireEvent.click(media);
    // Adversary stays ON; media flips ON.
    expect(adv).toBeChecked();
    expect(media).toBeChecked();
  });

  it("toggling a feature swaps its description between ON/OFF prose", () => {
    render(<Host />);
    advanceToStep2();
    // Default: time_pressure ON → "Critical injects fire on deadlines" copy.
    expect(
      screen.getByText(/Critical injects fire on deadlines/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /Time pressure/i }));
    // OFF copy: "No deadline framing on injects".
    expect(
      screen.getByText(/No deadline framing on injects/i),
    ).toBeInTheDocument();
  });
});
