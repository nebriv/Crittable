import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Auto-pin a scrollable region to the bottom on new content unless the
 * user has scrolled up to re-read earlier content.
 *
 * ## Why event-driven instead of post-hoc distance math
 *
 * The original (#79) implementation read ``scrollHeight - scrollTop -
 * clientHeight`` from inside a layout effect that fired on dep change,
 * and pinned only if that distance was below a slack window. That
 * design was broken for two reasons that bit us in production:
 *
 * 1. **The browser clamps ``scrollTop``.** Setting
 *    ``el.scrollTop = el.scrollHeight`` doesn't store ``scrollHeight``
 *    — it stores ``min(scrollHeight, scrollHeight - clientHeight)``,
 *    which is the bottom-of-overflow position. So after a "follow"
 *    pin, ``scrollTop`` reads as ``scrollHeight - clientHeight``, NOT
 *    ``scrollHeight``. The next time content lands, the math sees the
 *    user as having scrolled up by ``clientHeight`` and bails.
 * 2. **Content added below shifts the user's relative position.**
 *    When a new message lands, ``scrollHeight`` grows but ``scrollTop``
 *    doesn't. The user *was* at the bottom a frame ago; now the
 *    distance check reads them as scrolled up by the height of the
 *    new content and bails. Worse, layout shifts above the chat
 *    (the "Your turn" banner appearing) shrink ``clientHeight`` and
 *    move the math even further off the rails.
 *
 * The robust pattern (Slack / Discord / every chat app) is to track a
 * ``pinned`` flag updated **from scroll events** — i.e. only the
 * user's deliberate scroll can unpin them, and content arriving below
 * a pinned user always follows. That's what this hook does.
 *
 * ## Behaviors
 *
 * 1. **Initial mount.** Element starts pinned. The first commit with
 *    overflowing content scrolls to the bottom unconditionally, so a
 *    participant joining mid-exercise lands on the latest message.
 *
 * 2. **Pinned + new content.** Layout effect runs on dep change (new
 *    message, streaming flag flip). If pinned, scroll to bottom.
 *
 * 3. **Pinned + container resize.** A ResizeObserver watches the
 *    scroll element. When the chat region shrinks (e.g. the "Your
 *    turn" banner appears above and the section's flex layout
 *    redistributes height), if pinned, re-pin to the new bottom so
 *    the user doesn't get visually "left behind" by the shrink.
 *
 * 4. **User scrolls.** A ``scroll`` listener checks
 *    ``scrollHeight - scrollTop - clientHeight``. Within a small
 *    tolerance (``PINNED_TOLERANCE``) → pinned. Otherwise → unpinned.
 *    The hook will leave them alone until they scroll back to the
 *    bottom (or call ``forceScrollToBottom``).
 *
 * 5. **Force-scroll.** ``forceScrollToBottom()`` re-pins synchronously
 *    and scrolls. Use after a local user action (submit, force-
 *    advance) so the user sees their own action commit even if they'd
 *    been reading older content.
 *
 * 6. **Unread indicator.** When ``deps`` change while the user is
 *    unpinned, ``hasUnreadBelow`` flips to true so the caller can
 *    surface a "New messages below ↓" chip. Clears when the user
 *    scrolls back to the bottom (re-pin) or calls
 *    ``forceScrollToBottom``. The flag is intentionally a boolean
 *    (not a count) — callers that want a count can derive it from
 *    their own state by tracking the message count delta between
 *    "first unread arrived" and "now".
 *
 * ## Why a callback ref
 *
 * A regular ``useRef`` would race in the Play.tsx flow: the snapshot
 * loads while JoinIntro is still showing → chat element mounts later
 * with no further dep change → effect never re-runs with a non-null
 * ref. The callback ref bumps an internal counter on attach so the
 * layout effect re-fires once the element is actually in the DOM.
 */

/** Tolerance for "user is at the bottom" comparisons. Browsers report
 *  fractional values for these dimensions on hi-DPI displays, and any
 *  layout that uses sub-pixel rounding can leave the bottom-most
 *  scrollTop a pixel or two short of ``scrollHeight - clientHeight``.
 *  4px is small enough that a deliberate scroll-up is still detected
 *  and large enough that we don't unpin from rounding noise. */
const PINNED_TOLERANCE = 4;

export interface UseStickyScrollResult<T extends HTMLElement = HTMLDivElement> {
  scrollRef: (el: T | null) => void;
  forceScrollToBottom: () => void;
  /** True when content arrived (a dep changed) while the user was
   *  unpinned. Caller surfaces this as a "New messages below" chip
   *  whose onClick calls ``forceScrollToBottom``. Clears when the
   *  user scrolls back to the bottom or force-scrolls. */
  hasUnreadBelow: boolean;
}

export function useStickyScroll<T extends HTMLElement = HTMLDivElement>(
  deps: ReadonlyArray<unknown>,
): UseStickyScrollResult<T> {
  const elRef = useRef<T | null>(null);
  // ``pinnedRef`` is the authoritative answer to "should we follow new
  // content to the bottom?". It's a ref (not state) so reading and
  // writing it doesn't trigger re-renders — scroll events fire many
  // times per second.
  const pinnedRef = useRef(true);
  // Detach handler for the currently attached element's scroll +
  // ResizeObserver. Stored in a ref so the callback ref can invoke
  // it before attaching to a new element.
  const detachRef = useRef<(() => void) | null>(null);
  // Bumped each time the callback ref attaches a new element. Including
  // it in the layout-effect deps guarantees the effect re-runs once the
  // element is in the DOM, even if the caller's ``deps`` haven't
  // changed since the previous render. (This is the JoinIntro → chat
  // transition race in Play.tsx.)
  const [refVersion, setRefVersion] = useState(0);
  // Unread-content flag for the chip surface. Mirrored in ``unreadRef``
  // so non-render code paths (the scroll handler, force-scroll) can
  // read the current value without going through a state setter.
  const [hasUnreadBelow, setHasUnreadBelow] = useState(false);
  const unreadRef = useRef(false);
  const setUnread = useCallback((next: boolean) => {
    if (unreadRef.current !== next) {
      unreadRef.current = next;
      setHasUnreadBelow(next);
    }
  }, []);

  const isAtBottom = useCallback((el: T) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= PINNED_TOLERANCE;
  }, []);

  const pinToBottom = useCallback((el: T, reason: string) => {
    el.scrollTop = el.scrollHeight;
    console.debug("[scroll] pin", {
      reason,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
  }, []);

  const scrollRef = useCallback(
    (el: T | null) => {
      // Detach listeners from the old element first.
      if (detachRef.current) {
        detachRef.current();
        detachRef.current = null;
      }

      elRef.current = el;

      if (el !== null) {
        // Fresh element starts pinned. If the user immediately scrolls
        // up before any content arrives, the scroll handler will flip
        // pinnedRef to false.
        pinnedRef.current = true;

        const onScroll = () => {
          const nowPinned = isAtBottom(el);
          if (pinnedRef.current !== nowPinned) {
            pinnedRef.current = nowPinned;
            console.debug(
              nowPinned ? "[scroll] re-pinned" : "[scroll] unpinned",
              {
                scrollHeight: el.scrollHeight,
                scrollTop: el.scrollTop,
                clientHeight: el.clientHeight,
              },
            );
            // Re-pinning means the user has caught up to the bottom;
            // clear the unread chip.
            if (nowPinned) {
              setUnread(false);
            }
          }
        };
        el.addEventListener("scroll", onScroll, { passive: true });

        // ResizeObserver catches layout shifts that change the chat
        // region's height without the user touching anything — e.g.
        // the "Your turn" banner appearing above the grid causes the
        // flex section to shrink, which leaves a previously-pinned
        // user a few hundred pixels above the new bottom. Re-pin in
        // that case so the layout shift never moves them off the
        // latest beat. We deliberately re-pin even when the resize
        // doesn't perfectly align with a content change — the
        // alternative ("only re-pin on content arrival") loses the
        // user's bottom anchor in exactly the production scenario
        // that triggered this rewrite.
        let resizeObserver: ResizeObserver | null = null;
        if (typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(() => {
            if (pinnedRef.current && elRef.current === el) {
              pinToBottom(el, "resize");
            }
          });
          resizeObserver.observe(el);
        }

        detachRef.current = () => {
          el.removeEventListener("scroll", onScroll);
          resizeObserver?.disconnect();
        };

        // Bump refVersion so the layout effect below re-fires now that
        // the element is in the DOM and ready to be measured.
        setRefVersion((v) => v + 1);
      }
    },
    [isAtBottom, pinToBottom, setUnread],
  );

  // Detach on unmount.
  useEffect(() => {
    return () => {
      if (detachRef.current) {
        detachRef.current();
        detachRef.current = null;
      }
    };
  }, []);

  const forceScrollToBottom = useCallback(() => {
    pinnedRef.current = true;
    setUnread(false);
    const el = elRef.current;
    if (el) {
      pinToBottom(el, "force");
    }
  }, [pinToBottom, setUnread]);

  // Pin to bottom on dep change if pinned. The dep-driven path covers
  // "new message arrived" (messageCount changed) and "streaming flag
  // toggled" (streamingActive changed). The ResizeObserver path above
  // covers layout shifts; together they handle every scenario the
  // post-hoc distance math used to miss.
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el) return;
    if (!pinnedRef.current) {
      // New content arrived while the user was scrolled up. Flag
      // unread so the caller's chip appears. The chip's onClick will
      // call ``forceScrollToBottom`` which re-pins and clears the
      // flag.
      setUnread(true);
      console.debug("[scroll] leave-alone (unpinned, marking unread)", {
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
      });
      return;
    }
    pinToBottom(el, "deps");
    // The deps array is intentionally dynamic: callers pass whatever
    // signals "content changed" (message count, streaming flag, etc.).
    // The eslint rule can't statically verify that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, refVersion]);

  return { scrollRef, forceScrollToBottom, hasUnreadBelow };
}
