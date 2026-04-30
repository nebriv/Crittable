import { act, fireEvent, render } from "@testing-library/react";
import { useCallback, useLayoutEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStickyScroll } from "../lib/useStickyScroll";

/**
 * JSdom doesn't compute layout, so ``scrollHeight`` / ``clientHeight``
 * default to 0 and ``scrollTop`` writes are forwarded to a stub. The
 * shims below let a test prescribe geometry on the rendered ``<div>``,
 * observe ``scrollTop`` writes, and dispatch ``scroll`` events to
 * exercise the hook's event-driven pin tracking.
 *
 * The shims are scoped to this file's ``beforeEach`` / ``afterEach`` so
 * they don't leak into other test suites.
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
      // Mirror the browser's behaviour: scrollTop is clamped to
      // ``max(0, min(value, scrollHeight - clientHeight))``. Without
      // this clamp the post-hoc-distance bug we just fixed wouldn't
      // be reproducible in tests.
      const g = readGeometry(this);
      const max = Math.max(0, g.scrollHeight - g.clientHeight);
      const clamped = Math.max(0, Math.min(value, max));
      setGeometry(this, { scrollTop: clamped });
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
   *  ``streamingActive`` flag that Play.tsx / Facilitator.tsx pass
   *  alongside ``messageCount``. */
  streamingActive?: boolean;
  /** Total content height. Tests prescribe this to simulate an
   *  overflowing transcript. The harness deliberately does NOT set
   *  ``scrollTop`` from props — that dimension is owned by the hook
   *  and by the test's direct ``setGeometry`` calls between renders. */
  scrollHeight: number;
  clientHeight: number;
  /** Conditionally render the scroll element. Lets a test simulate
   *  the production scenario where the hook lives in a long-lived
   *  parent (Facilitator) and the scroll element is mounted /
   *  unmounted by phase / session changes. */
  mountElement?: boolean;
  bindForceScroll?: (fn: () => void) => void;
}

/**
 * Test harness that wires ``useStickyScroll`` to a div and applies
 * the prescribed scrollHeight + clientHeight via a useLayoutEffect
 * declared **before** the hook call so the geometry is in place when
 * the hook's own layout effect runs and reads it.
 */
function Harness({
  messageCount,
  streamingActive = false,
  scrollHeight,
  clientHeight,
  mountElement = true,
  bindForceScroll,
}: HarnessProps) {
  const elRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!elRef.current) return;
    setGeometry(elRef.current, { scrollHeight, clientHeight });
  });

  const { scrollRef, forceScrollToBottom } = useStickyScroll<HTMLDivElement>([
    messageCount,
    streamingActive,
  ]);

  useLayoutEffect(() => {
    bindForceScroll?.(forceScrollToBottom);
  }, [bindForceScroll, forceScrollToBottom]);

  // ``scrollRef`` is memoized inside the hook (useCallback). The
  // combined callback below stays stable too. Stability matters: an
  // unstable ref callback would detach + re-attach on every render
  // and the hook detaches its scroll listener / ResizeObserver on
  // every detach — which would silently lose pin tracking.
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
    // that overflows the viewport. The hook starts pinned, so the
    // first commit with overflowing content scrolls to the bottom.
    const { getByTestId } = render(
      <Harness messageCount={20} scrollHeight={2000} clientHeight={400} />,
    );
    const el = getByTestId("scroll-region");
    // scrollTop is clamped by the browser-shim to max(0, scrollHeight
    // - clientHeight) = 1600. That is the visual bottom — distance
    // from bottom = scrollHeight - scrollTop - clientHeight = 0.
    expect(el.scrollTop).toBe(1600);
  });

  it("follows new content while pinned (browser-clamp regression net)", () => {
    // The pre-rewrite hook bug: after a "follow" pin, scrollTop is
    // clamped to scrollHeight-clientHeight, NOT scrollHeight. The next
    // dep change re-evaluated distance from the post-clamp scrollTop
    // and read the user as "scrolled up" by clientHeight. New content
    // would NOT pin. The event-driven model fixes this — pinnedRef
    // tracks the user's intent, not a post-hoc distance metric.
    const { getByTestId, rerender } = render(
      <Harness messageCount={20} scrollHeight={2000} clientHeight={400} />,
    );
    const el = getByTestId("scroll-region");
    expect(el.scrollTop).toBe(1600);

    // New message arrives — transcript grows below the user.
    rerender(
      <Harness messageCount={21} scrollHeight={2200} clientHeight={400} />,
    );
    // pinnedRef is still true (user hasn't scrolled), so pin to new
    // bottom: scrollTop clamped to 2200 - 400 = 1800.
    expect(el.scrollTop).toBe(1800);
  });

  it("unpins when the user scrolls up", () => {
    const { getByTestId, rerender } = render(
      <Harness messageCount={20} scrollHeight={2000} clientHeight={400} />,
    );
    const el = getByTestId("scroll-region");
    expect(el.scrollTop).toBe(1600);

    // User scrolls up. The shim clamps scrollTop and stores it; we
    // dispatch a synthetic scroll event so the hook's listener fires.
    setGeometry(el, { scrollTop: 500 });
    fireEvent.scroll(el);

    // New message arrives. Pinned was flipped to false → leave alone.
    rerender(
      <Harness messageCount={21} scrollHeight={2200} clientHeight={400} />,
    );
    expect(el.scrollTop).toBe(500);
  });

  it("re-pins when the user scrolls back to the bottom", () => {
    const { getByTestId, rerender } = render(
      <Harness messageCount={20} scrollHeight={2000} clientHeight={400} />,
    );
    const el = getByTestId("scroll-region");
    expect(el.scrollTop).toBe(1600);

    // Scroll up → unpin.
    setGeometry(el, { scrollTop: 500 });
    fireEvent.scroll(el);
    rerender(
      <Harness messageCount={21} scrollHeight={2200} clientHeight={400} />,
    );
    expect(el.scrollTop).toBe(500);

    // Scroll back to bottom → re-pin.
    setGeometry(el, { scrollTop: 1800 });
    fireEvent.scroll(el);

    // Next content arrival should pin again.
    rerender(
      <Harness messageCount={22} scrollHeight={2400} clientHeight={400} />,
    );
    expect(el.scrollTop).toBe(2000);
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
    expect(el.scrollTop).toBe(1600);

    // Scroll up.
    setGeometry(el, { scrollTop: 100 });
    fireEvent.scroll(el);

    // Local submit — hook pins synchronously and re-pins.
    act(() => {
      force?.();
    });
    expect(el.scrollTop).toBe(1600);

    // Subsequent content arrives — still pinned (force re-pinned).
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
    expect(el.scrollTop).toBe(1700);
  });

  it("returns to honoring the user's scroll position after a force-scroll", () => {
    // Regression net: after one force-scroll, a subsequent user
    // scroll-up should still unpin them; the force shouldn't latch.
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
    expect(el.scrollTop).toBe(1600);

    // Force-scroll.
    act(() => {
      force?.();
    });
    expect(el.scrollTop).toBe(1600);

    // User scrolls up afterwards.
    setGeometry(el, { scrollTop: 200 });
    fireEvent.scroll(el);

    // Next content arrives — leave alone, user is unpinned.
    rerender(
      <Harness
        messageCount={21}
        scrollHeight={2200}
        clientHeight={400}
        bindForceScroll={(fn) => {
          force = fn;
        }}
      />,
    );
    expect(el.scrollTop).toBe(200);
  });

  it("re-pins when the scroll element remounts within the same hook instance", () => {
    // Production scenario: Facilitator's ``handleNewSession()`` resets
    // ``state`` to ``null`` and routes back to the intro screen,
    // unmounting the chat scroll region. A new session re-mounts a
    // fresh element. The hook itself stays mounted (Facilitator
    // persists), so per-element state would carry over and a stale
    // unpinned flag would skip the auto-pin on the new session. The
    // hook resets pinnedRef to true on every re-attach to defend
    // against this.
    const { getByTestId, queryByTestId, rerender } = render(
      <Harness messageCount={20} scrollHeight={2000} clientHeight={400} />,
    );
    const el1 = getByTestId("scroll-region");
    expect(el1.scrollTop).toBe(1600);

    // Unmount the scroll element. Hook stays mounted; scrollRef is
    // called with null on detach.
    rerender(
      <Harness
        messageCount={20}
        scrollHeight={2000}
        clientHeight={400}
        mountElement={false}
      />,
    );
    expect(queryByTestId("scroll-region")).toBeNull();

    // Re-mount with a fresh element + fresh content.
    rerender(
      <Harness
        messageCount={30}
        scrollHeight={3000}
        clientHeight={400}
        mountElement={true}
      />,
    );
    const el2 = getByTestId("scroll-region");
    expect(el2.scrollTop).toBe(2600);
  });

  it("re-pins after unmount + remount of the parent", () => {
    // Different from the within-hook-instance remount above: this
    // unmounts and remounts the entire harness (and therefore the hook
    // instance). Catches a different class of regression — that
    // pinnedRef defaults are correct on a fresh hook.
    const { getByTestId, unmount } = render(
      <Harness messageCount={20} scrollHeight={2000} clientHeight={400} />,
    );
    const el1 = getByTestId("scroll-region");
    expect(el1.scrollTop).toBe(1600);
    unmount();

    const { getByTestId: getByTestId2 } = render(
      <Harness messageCount={30} scrollHeight={3000} clientHeight={400} />,
    );
    const el2 = getByTestId2("scroll-region");
    expect(el2.scrollTop).toBe(2600);
  });

  it("waits for overflow before consuming the initial-mount pin", () => {
    // A user who joins early (transcript empty / shorter than the
    // viewport) shouldn't have the initial-mount branch fire and
    // settle in a way that leaves them stuck once content does
    // overflow. With pinnedRef defaulting to true and remaining true
    // until the user actively scrolls away, an early non-overflow
    // render is a no-op (scrollTop = scrollHeight = clientHeight) and
    // the first overflowing render pins to the new bottom.
    const { getByTestId, rerender } = render(
      <Harness messageCount={0} scrollHeight={400} clientHeight={400} />,
    );
    const el = getByTestId("scroll-region");
    // Browser-clamp shim: max(0, 400 - 400) = 0. The hook's "pin to
    // bottom" wrote scrollTop = 400 → clamp to 0.
    expect(el.scrollTop).toBe(0);

    // First real content arrives — transcript now overflows.
    rerender(
      <Harness messageCount={20} scrollHeight={2000} clientHeight={400} />,
    );
    // pinnedRef stayed true → pin to new bottom (clamped).
    expect(el.scrollTop).toBe(1600);
  });

  it("follows new content when only the streaming flag flips", () => {
    // ``streamingActive`` flipping is the dominant runtime signal
    // because chunk events fire much more often than
    // ``message_complete``. Verify that flag-only deps changes still
    // pin a pinned user.
    const { getByTestId, rerender } = render(
      <Harness
        messageCount={20}
        scrollHeight={2000}
        clientHeight={400}
        streamingActive={false}
      />,
    );
    const el = getByTestId("scroll-region");
    expect(el.scrollTop).toBe(1600);

    rerender(
      <Harness
        messageCount={20}
        scrollHeight={2400}
        clientHeight={400}
        streamingActive={true}
      />,
    );
    expect(el.scrollTop).toBe(2000);
  });
});
