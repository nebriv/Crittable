import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "../App";

describe("App", () => {
  it("renders the marketing home at /", () => {
    render(<App />);
    // Post-redesign-round-3: `/` is a stateless marketing landing
    // ("Tabletop exercises for security teams."). The "Roll new
    // session" form moved to `/new` (Facilitator's intro phase).
    expect(
      screen.getByRole("heading", { name: /Tabletop exercises/i }),
    ).toBeInTheDocument();
  });
});
