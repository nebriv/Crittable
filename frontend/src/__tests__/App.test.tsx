import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "../App";

describe("App", () => {
  it("renders the facilitator landing by default", () => {
    render(<App />);
    // Post-redesign: the homepage is a brand-styled <Landing/> with the
    // hero headline "Roll a tabletop in 5 minutes." (Inter h1).
    expect(
      screen.getByRole("heading", { name: /Roll a tabletop in 5 minutes/i }),
    ).toBeInTheDocument();
  });
});
