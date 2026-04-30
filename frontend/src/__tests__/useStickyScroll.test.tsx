import { act, render } from "@testing-library/react";
import { useCallback, useLayoutEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStickyScroll } from "../lib/useStickyScroll";

/**
 * JSdom doesn't compute layout, so ``scrollHeight`` / ``clientHeight``
 * default to 0 — which would skip every scroll branch in the hook.
 * Override the prototype getters so the test can prescribe the
 * geometry of the rendered ``<div>`` and assert on the (also shimmed)
 * ``scrollTop`` setter to verify the hook actually scrolled.
 *
 * The shims are scoped to this file's ``beforeEach`` / ``afterEach``
 * so they don't leak into other test suites.
 */
interface Geometry {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

const geom = new WeakMap<HTMLElement, Geometry>();

function setGeometry(el: HTMLElement, partial: Partial<Geometry>): void {
  const prev =
    geom.get(el) ?? { scrollHeight: 0, clientHeight: 0, scrollTop: 0 };
  geom.set(el, { ...prev, ...partial });
}

function readGeometry(el: HTMLElement): Geometry {
  return geom.get(el) ?? { scrollHeight: 0, clientHeight: 0, scrollTop: 0 };
}

let originalScrollHeight: PropertyDescriptor | undefined;
let originalClientHeight: PropertyDescriptor | undefined;
let originalScrollTop: PropertyDescriptor | undefined;

beforeEach(() => {
  originalScrollHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );
  originalClientHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientHeight",
  );
  originalScrollTop = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollTop",
  );

  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return readGeometry(this).scrollHeight;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return readGeometry(this).clientHeight;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return readGeometry(this).scrollTop;
    },
    set(this: HTMLElement, value: number) {
      setGeometry(this, { scrollTop: value });
    },
  });
});

afterEach(() => {
  if (originalScrollHeight) {
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollHeight",
      originalScrollHeight,
    );
  }
  if (originalClientHeight) {
    Object.defineProperty(
      HTMLElement.prototype,
      "clientHeight",
      originalClientHeight,
    );
  }
  if (originalScrollTop) {
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollTop",
      originalScrollTop,
    );
  }
});

interface HarnessProps {
  /** Bumping this is the test-side proxy for "a new message arrived" — it
   *  changes the deps array the hook watches. */
  messageCount: number;
  /** Second-channel deps signal: stands in for the production
   *  ``streamingActive`` flag that Play.tsx and Facilitator.tsx pass
   *  alongside ``messageCount``. Lets the test verify that flipping
   *  ``streamingActive`` alone (no message added) still re-triggers
   *  the slack-follow — which is the dominant runtime signal because
   *  chunk events fire much more often than ``message_complete``. */
  streamingActive?: boolean;
  /** Total content height. Tests prescribe this to simulate an
   *  overflowing transcript. The harness deliberately does NOT set
   *  ``scrollTop`` from props — that dimension is owned by the hook
   *  (and by direct ``setGeometry`` calls between rerenders) so the
   *  geometry layout effect can't accidentally clobber what the hook
   *  just wrote. */
  scrollHeight: number;
  clientHeight: number;
  /** Conditionally render the scroll element. Lets a test simulate
   *  the production scenario where the hook lives in a long-lived
   *  parent (Facilitator) and the scroll element is mounted /
   *  unmounted by phase / session changes — e.g.
   *  ``handleNewSession`` resets to the intro screen, then a new
   *  session re-mounts the scroll div within the same hook instance.
   *  The hook must reset its per-element state on identity change so
   *  the new element gets the initial-pin treatment. */
  mountElement?: boolean;
  bindForceScroll?: (fn: () => void) => void;
  slack?: number;
}

/**
 * Test harness that wires ``useStickyScroll`` to a div and applies the
 * prescribed scroll-extent geometry via a ``useLayoutEffect`` declared
 * **before** the hook call so the geometry is in place when the hook's
 * own layout effect runs and reads ``scrollHeight``.
 */
function Harness({
  messageCount,
  streamingActive = false,
  scrollHeight,
  clientHeight,
  mountElement = true,
  bindForceScroll,
  slack,
}: HarnessProps) {
  const elRef = useRef<HTMLDivElement | null>(null);

  // Apply scrollHeight + clientHeight first so the hook's layout
  // effect (declared inside useStickyScroll, *after* this hook) reads
  // the prescribed values. Crucially, do not write ``scrollTop`` —
  // that's the dimension the hook controls and we'd clobber the
  // hook's write if we set it from props on every render.
  useLayoutEffect(() => {
    if (!elRef.current) return;
    setGeometry(elRef.current, { scrollHeight, clientHeight });
  });

  const { scrollRef, forceScrollToBottom } = useStickyScroll<HTMLDivElement>(
    [messageCount, streamingActive],
    slack !== undefined ? { slack } : undefined,
  );

  useLayoutEffect(() => {
    bindForceScroll?.(forceScrollToBottom);
  }, [bindForceScroll, forceScrollToBottom]);

  // ``scrollRef`` is memoized inside the hook (useCallback with []),
  // so this combined callback is stable too. Stability matters: an
  // unstable ref callback would detach + re-attach on every render,
  // and the hook's scrollRef bumps an internal nonce on each non-null
  // attach — which compounds into a re-render loop.
  const combinedRef = useCallback(
    (node: HTMLDivElement | null) => {
      elRef.current = node;
      scrollRef(node);
    },
    [scrollRef],
  );

  return mountElement ? (
    <div data-testid="scroll-region" ref={combinedRef}>
      {Array.from({ length: messageCount }, (_, i) => (
        <div key={i}>message {i}</div>
      ))}
    </div>
  ) : (
    <div data-testid="placeholder">no scroll region rendered</div>
  );
}

describe("useStickyScroll", () => {
  it("pins to the bottom on initial mount when content overflows", () => {
    // Issue #79: a player joining mid-exercise lands on a transcript
    // that overflows the viewport. The pre-fix slack check read
    // scrollTop=0 as "user has scrolled up" and stranded them at the
    // top. The hook's initial-mount branch overrides that.
    const { getByTestId } = render(
      <Harness messageCount={20} scrollHeight={2000} clientHeight={400} />,
    );
    const el = getByTestId("scroll-region");
    expect(el.scrollTop).toBe(2000);
  });

  it("follows new content when the user is near the bottom", () => {
    const { getByTestId, rerender } = render(
      <Harness messageCount={20} scrollHeight={2000} clientHeight={400} />,
    );
    const el = getByTestId("scroll-region");
    // Initial mount pinned us to the bottom (2000).
    expect(el.scrollTop).toBe(2000);

    // A new message arrives; transcript grew. User stayed pinned at
    // the previous bottom (2000) so they're well within the slack
    // window of the new bottom (2200) — pin should follow.
    rerender(
      <Harness messageCount={21} scrollHeight={2200} clientHeight={400} />,
    );
    expect(el.scrollTop).toBe(2200);
  });

  it("leaves the user alone when they have scrolled up beyond the slack window", () => {
    const { getByTestId, rerender } = render(
      <Harness messageCount={20} scrollHeight={2000} clientHeight={400} />,
    );
    const el = getByTestId("scroll-region");
    expect(el.scrollTop).toBe(2000);

    // User scrolls up well outside the 120px slack window.
    setGeometry(el, { scrollTop: 500 });

    // A new message arrives.
    rerender(
      <Harness messageCount={21} scrollHeight={2200} clientHeight={400} />,
    );

    // distanceFromBottom = 2200 - 500 - 400 = 1300 >> 120 → no scroll.
    expect(el.scrollTop).toBe(500);
  });

  it("force-scrolls to the bottom even when the user has scrolled up", () => {
    let force: (() => void) | null = null;
    const { getByTestId, rerender } = render(
      <Harness
        messageCount={20}
        scrollHeight={2000}
        clientHeight={400}
        bindForceScroll={(fn) => {
          force = fn;
        }}
      />,
    );
    const el = getByTestId("scroll-region");
    expect(el.scrollTop).toBe(2000);

    // User scrolls up far from the bottom.
    setGeometry(el, { scrollTop: 100 });

    // Local submit fires + a message lands.
    act(() => {
      force?.();
    });
    rerender(
      <Harness
        messageCount={21}
        scrollHeight={2100}
        clientHeight={400}
        bindForceScroll={(fn) => {
          force = fn;
        }}
      />,
    );

    // Force-scroll bypasses the slack check; pin to bottom.
    expect(el.scrollTop).toBe(2100);
  });

  it("returns to honoring the slack window after a force-scroll", () => {
    // Regression net for the bug in the pre-fix Facilitator effect:
    // once forceScrollNonce > 0, the slack check was bypassed
    // forever. The hook tracks the last-seen nonce so a one-shot
    // force-scroll doesn't permanently override the user's scroll
    // position.
    let force: (() => void) | null = null;
    const { getByTestId, rerender } = render(
      <Harness
        messageCount={20}
        scrollHeight={2000}
        clientHeight={400}
        bindForceScroll={(fn) => {
          force = fn;
        }}
      />,
    );
    const el = getByTestId("scroll-region");
    expect(el.scrollTop).toBe(2000);

    // Local submit force-scrolls to bottom on the next message.
    act(() => {
      force?.();
    });
    rerender(
      <Harness
        messageCount={21}
        scrollHeight={2100}
        clientHeight={400}
        bindForceScroll={(fn) => {
          force = fn;
        }}
      />,
    );
    expect(el.scrollTop).toBe(2100);

    // Now the user scrolls up to re-read.
    setGeometry(el, { scrollTop: 200 });
    rerender(
      <Harness
        messageCount={22}
        scrollHeight={2200}
        clientHeight={400}
        bindForceScroll={(fn) => {
          force = fn;
        }}
      />,
    );

    // distanceFromBottom = 2200 - 200 - 400 = 1600 > 120 → leave alone.
    // The pre-fix bug would have re-pinned to 2200.
    expect(el.scrollTop).toBe(200);
  });

  it("respects a custom slack window", () => {
    const { getByTestId, rerender } = render(
      <Harness
        messageCount={20}
        slack={30}
        scrollHeight={2000}
        clientHeight={400}
      />,
    );
    const el = getByTestId("scroll-region");
    expect(el.scrollTop).toBe(2000);

    // User scrolls up 50px (just outside the tighter 30px slack).
    setGeometry(el, { scrollTop: 1550 });
    rerender(
      <Harness
        messageCount={21}
        slack={30}
        scrollHeight={2050}
        clientHeight={400}
      />,
    );

    // distanceFromBottom = 2050 - 1550 - 400 = 100 > 30 → no scroll.
    expect(el.scrollTop).toBe(1550);
  });

  it("follows new content when only the streaming flag flips", () => {
    // Streaming-chunk events fire much more often than
    // ``message_complete``, so ``streamingActive`` flipping (without
    // ``messageCount`` changing) is the dominant runtime signal that
    // the chat is growing. Verify the slack-follow path triggers from
    // the streaming flag alone.
    const { getByTestId, rerender } = render(
      <Harness
        messageCount={20}
        scrollHeight={2000}
        clientHeight={400}
        streamingActive={false}
      />,
    );
    const el = getByTestId("scroll-region");
    // Initial mount pin.
    expect(el.scrollTop).toBe(2000);

    // Streaming kicks in. Chunk text expands the transcript.
    // ``messageCount`` is unchanged — only ``streamingActive`` flips.
    rerender(
      <Harness
        messageCount={20}
        scrollHeight={2400}
        clientHeight={400}
        streamingActive={true}
      />,
    );
    // distanceFromBottom = 2400 - 2000 - 400 = 0 → well within slack.
    // Pin should follow.
    expect(el.scrollTop).toBe(2400);
  });

  it("handles back-to-back force-scrolls without sticking", () => {
    // Two ``forceScrollToBottom()`` calls in quick succession (e.g. a
    // proxy submit immediately followed by a force-advance) should
    // both pin to bottom, and the slack check should still resume
    // honouring the user's scroll position once the nonce stabilizes.
    let force: (() => void) | null = null;
    const { getByTestId, rerender } = render(
      <Harness
        messageCount={20}
        scrollHeight={2000}
        clientHeight={400}
        bindForceScroll={(fn) => {
          force = fn;
        }}
      />,
    );
    const el = getByTestId("scroll-region");
    expect(el.scrollTop).toBe(2000);

    // First force-scroll + new message.
    act(() => {
      force?.();
    });
    rerender(
      <Harness
        messageCount={21}
        scrollHeight={2100}
        clientHeight={400}
        bindForceScroll={(fn) => {
          force = fn;
        }}
      />,
    );
    expect(el.scrollTop).toBe(2100);

    // User scrolls up between the two forces.
    setGeometry(el, { scrollTop: 50 });

    // Second force-scroll + another new message.
    act(() => {
      force?.();
    });
    rerender(
      <Harness
        messageCount={22}
        scrollHeight={2200}
        clientHeight={400}
        bindForceScroll={(fn) => {
          force = fn;
        }}
      />,
    );
    // Each force bump consumed; second must still pin to bottom.
    expect(el.scrollTop).toBe(2200);

    // After the second force settles, slack check should resume:
    // user scrolls up again, next message arrives without a force.
    setGeometry(el, { scrollTop: 100 });
    rerender(
      <Harness
        messageCount={23}
        scrollHeight={2300}
        clientHeight={400}
        bindForceScroll={(fn) => {
          force = fn;
        }}
      />,
    );
    // distanceFromBottom = 2300 - 100 - 400 = 1800 > 120 → leave alone.
    expect(el.scrollTop).toBe(100);
  });

  it("re-pins when the scroll element remounts within the same hook instance", () => {
    // Production scenario: Facilitator's ``handleNewSession()`` resets
    // ``state`` to ``null`` and routes back to the intro screen,
    // unmounting the chat scroll region. A new session then re-mounts
    // a fresh scroll element. The hook itself stays mounted (the
    // Facilitator component persists), so per-element state like
    // ``didInitialScrollRef`` would carry over from the previous
    // session and skip the initial pin on the new element — re-
    // introducing the #79 stuck-at-top bug for the second exercise of
    // the same browser tab. The hook resets that flag on element
    // identity change to defend against this.
    const { getByTestId, queryByTestId, rerender } = render(
      <Harness messageCount={20} scrollHeight={2000} clientHeight={400} />,
    );
    const el1 = getByTestId("scroll-region");
    expect(el1.scrollTop).toBe(2000);

    // Unmount the scroll region (e.g. routing back to the intro
    // screen). The hook stays mounted; ``scrollRef`` is called with
    // null on detach.
    rerender(
      <Harness
        messageCount={20}
        scrollHeight={2000}
        clientHeight={400}
        mountElement={false}
      />,
    );
    expect(queryByTestId("scroll-region")).toBeNull();

    // Re-mount the scroll region with a fresh element (e.g. starting
    // a new session). The hook should treat this as a new initial
    // mount and pin to the bottom of the new content.
    rerender(
      <Harness
        messageCount={30}
        scrollHeight={3000}
        clientHeight={400}
        mountElement={true}
      />,
    );
    const el2 = getByTestId("scroll-region");
    expect(el2.scrollTop).toBe(3000);
  });

  it("re-pins to bottom after unmount + remount", () => {
    // A user routing away (e.g. opening the join intro again) and
    // routing back unmounts and remounts the component. The new mount
    // should re-fire the initial-pin branch — ``didInitialScrollRef``
    // is per-hook-instance and resets on remount.
    const { getByTestId, unmount } = render(
      <Harness messageCount={20} scrollHeight={2000} clientHeight={400} />,
    );
    const el1 = getByTestId("scroll-region");
    expect(el1.scrollTop).toBe(2000);
    unmount();

    // Remount with a different transcript.
    const { getByTestId: getByTestId2 } = render(
      <Harness messageCount={30} scrollHeight={3000} clientHeight={400} />,
    );
    const el2 = getByTestId2("scroll-region");
    // Fresh hook instance → didInitialScrollRef = false → pin.
    expect(el2.scrollTop).toBe(3000);
  });

  it("waits for overflow before consuming the initial-mount pin", () => {
    // A user who joins early (transcript empty / shorter than the
    // viewport) shouldn't have the initial-mount branch fire and mark
    // itself as done while there's nothing to scroll. Otherwise the
    // first message that overflows would fall through to the slack
    // check and read scrollTop=0 as "user has scrolled up."
    const { getByTestId, rerender } = render(
      <Harness messageCount={0} scrollHeight={400} clientHeight={400} />,
    );
    const el = getByTestId("scroll-region");
    // No overflow yet; hook didn't write scrollTop. Default is 0.
    expect(el.scrollTop).toBe(0);

    // First real content arrives — transcript now overflows. The
    // initial-mount branch should still be live (didInitial wasn't
    // marked done in the no-overflow render) and pin to bottom.
    rerender(
      <Harness messageCount={20} scrollHeight={2000} clientHeight={400} />,
    );
    expect(el.scrollTop).toBe(2000);
  });
});
