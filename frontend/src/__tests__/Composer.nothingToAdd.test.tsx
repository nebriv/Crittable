import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "../components/Composer";
import type { ImpersonateOption } from "../lib/proxy";

// Coverage for the "READY — NOTHING TO ADD →" shortcut on Composer.
//
// The shortcut posts a literal ``Nothing to add.`` with
// ``intent="ready"`` so a player on the active turn can ready up
// without typing filler. Visibility rules are conditional, so each
// case is asserted explicitly — a regression that flips one of these
// off would silently bring back the "creator never sees a way to
// finish their turn" complaint that motivated the affordance.

function renderComposer(
  overrides: Partial<React.ComponentProps<typeof Composer>> = {},
) {
  const onSubmit = vi.fn();
  const utils = render(
    <Composer
      enabled={true}
      placeholder="Type something"
      label="Your turn"
      onSubmit={onSubmit}
      {...overrides}
    />,
  );
  return { ...utils, onSubmit };
}

const NOTHING_TO_ADD_RE = /ready[\s—-]+nothing to add/i;

describe("Composer NOTHING TO ADD shortcut", () => {
  it("renders when the role is on an active turn and not yet ready", () => {
    renderComposer();
    expect(
      screen.getByRole("button", { name: NOTHING_TO_ADD_RE }),
    ).toBeTruthy();
  });

  it("submits 'Nothing to add.' with intent=ready and no mentions", () => {
    const { onSubmit } = renderComposer();
    fireEvent.click(screen.getByRole("button", { name: NOTHING_TO_ADD_RE }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(
      "Nothing to add.",
      "ready",
      [],
      undefined,
    );
  });

  it("hides once the user starts typing — typed content uses SUBMIT & READY", () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText(
      "Type something",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "actually I have a question" } });
    expect(
      screen.queryByRole("button", { name: NOTHING_TO_ADD_RE }),
    ).toBeNull();
  });

  it("hides when the role has already marked ready", () => {
    renderComposer({ isCurrentlyReady: true });
    expect(
      screen.queryByRole("button", { name: NOTHING_TO_ADD_RE }),
    ).toBeNull();
  });

  it("hides for off-turn / sidebar submissions (hideDiscussButton=true)", () => {
    renderComposer({ hideDiscussButton: true });
    expect(
      screen.queryByRole("button", { name: NOTHING_TO_ADD_RE }),
    ).toBeNull();
  });

  it("is disabled when the composer itself is disabled", () => {
    renderComposer({ enabled: false });
    const button = screen.queryByRole("button", { name: NOTHING_TO_ADD_RE });
    // The button still renders so a re-enabled composer doesn't have
    // its layout shift, but it must not fire onSubmit while disabled.
    expect(button).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  // QA review MINOR-1: the visibility predicate also gates on
  // ``!asRoleId`` and ``!proxyIsOffTurn``. The other tests cover
  // 3 of the 5 conditions; these two lock the remaining footguns
  // the inline comment in Composer.tsx calls out — proxying a
  // "Nothing to add." for another role would re-affirm a ready
  // signal on someone else's behalf, which is exactly the wrong
  // shape for this affordance.
  it("hides while impersonating another role (asRoleId set)", () => {
    const impersonateOptions: ImpersonateOption[] = [
      { id: "ciso", label: "CISO", offTurn: false },
    ];
    const { container } = renderComposer({ impersonateOptions });
    const select = container.querySelector(
      "select",
    ) as HTMLSelectElement | null;
    if (!select) throw new Error("expected an impersonate <select>");
    fireEvent.change(select, { target: { value: "ciso" } });
    expect(
      screen.queryByRole("button", { name: NOTHING_TO_ADD_RE }),
    ).toBeNull();
  });

  it("hides when impersonating an off-turn role (proxyIsOffTurn)", () => {
    const impersonateOptions: ImpersonateOption[] = [
      { id: "soc", label: "SOC", offTurn: true },
    ];
    const { container } = renderComposer({ impersonateOptions });
    const select = container.querySelector(
      "select",
    ) as HTMLSelectElement | null;
    if (!select) throw new Error("expected an impersonate <select>");
    fireEvent.change(select, { target: { value: "soc" } });
    expect(
      screen.queryByRole("button", { name: NOTHING_TO_ADD_RE }),
    ).toBeNull();
  });
});
