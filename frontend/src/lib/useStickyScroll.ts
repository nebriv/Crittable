import { useCallback, useLayoutEffect, useRef, useState } from "react";

/**
 * Auto-pin a scrollable region to the bottom on new content unless the
 * user has scrolled up to re-read earlier content. Three behaviors:
 *
 * 1. **Initial mount with content.** When the scroll element first
 *    attaches and has overflowing content, pin it to the bottom
 *    unconditionally so a participant joining mid-exercise lands on the
 *    latest beat. (Pre-fix, the slack check below read scrollTop=0 as
 *    "user has scrolled up" and stranded them at the top of the
 *    transcript — issue #79.)
 *
 * 2. **Incoming content while pinned.** When ``deps`` change and the
 *    user is within ``slack`` px of the bottom, follow the chat down.
 *    If they've scrolled up beyond the slack window, leave their
 *    position alone so the transcript doesn't yank under them.
 *
 * 3. **Force-scroll on local action.** ``forceScrollToBottom()`` pins
 *    to the bottom on the next render regardless of slack. Use this
 *    after a local user action (submit, force-advance) so the user
 *    sees their own action commit, even if they happen to be reading
 *    older content.
 *
 * The returned ``scrollRef`` is a callback ref. Attach it to the
 * scrollable element instead of a plain ``useRef`` so the hook learns
 * exactly when the element mounts — a regular ``useEffect`` keyed on
 * ``deps`` won't re-run when the ref attaches if the deps haven't
 * changed, which is the exact race that bit Play.tsx (snapshot loaded
 * while JoinIntro was still showing → chat element mounted later with
 * no further dep change → effect never re-ran with a non-null ref).
 */
export interface UseStickyScrollResult<T extends HTMLElement = HTMLDivElement> {
  scrollRef: (el: T | null) => void;
  forceScrollToBottom: () => void;
}

export function useStickyScroll<T extends HTMLElement = HTMLDivElement>(
  deps: ReadonlyArray<unknown>,
  options: { slack?: number } = {},
): UseStickyScrollResult<T> {
  const slack = options.slack ?? 120;
  const elRef = useRef<T | null>(null);
  const didInitialScrollRef = useRef(false);
  const lastForceNonceRef = useRef(0);
  // ``refVersion`` is bumped each time the callback ref attaches a new
  // element. Including it in the layout-effect deps guarantees the
  // effect re-runs once the element is in the DOM, even if the caller's
  // ``deps`` happen not to have changed since the previous render.
  const [refVersion, setRefVersion] = useState(0);
  const [forceNonce, setForceNonce] = useState(0);

  const scrollRef = useCallback((el: T | null) => {
    const previous = elRef.current;
    elRef.current = el;
    if (el !== previous) {
      // Element identity changed. Reset per-element state so a
      // remount within the same hook instance gets fresh initial-pin
      // treatment. Without this, Facilitator's ``handleNewSession()``
      // (which routes back to the intro screen — unmounting the
      // scroll region — and a new session remounts a fresh one) would
      // skip the initial-pin branch and re-introduce the #79
      // stuck-at-top bug for the second exercise of the same tab.
      // Same scenario applies to anything that swaps the scroll
      // element while keeping the parent component mounted.
      didInitialScrollRef.current = false;
    }
    if (el !== null) {
      setRefVersion((v) => v + 1);
    }
  }, []);

  const forceScrollToBottom = useCallback(() => {
    setForceNonce((n) => n + 1);
  }, []);

  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el) return;

    if (!didInitialScrollRef.current) {
      // First commit with the element attached. Pin to bottom so a
      // participant joining mid-exercise lands on the latest message
      // rather than the top of a long transcript. We only mark the
      // initial scroll as "done" once content actually overflows —
      // otherwise an empty / short initial render (transcript with
      // 0 messages) would consume the initial-scroll branch, and a
      // later content arrival would fall through to the slack check
      // and read scrollTop=0 as "user scrolled up". Repeating the
      // pin while there's no overflow is harmless: setting
      // ``scrollTop`` on a non-scrollable element is a no-op.
      if (el.scrollHeight <= el.clientHeight) {
        // Nothing to scroll yet (empty transcript, or layout hasn't
        // settled). Wait for the next render to retry.
        return;
      }
      el.scrollTop = el.scrollHeight;
      didInitialScrollRef.current = true;
      lastForceNonceRef.current = forceNonce;
      console.debug("[scroll] initial-pin", {
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      });
      return;
    }

    if (forceNonce !== lastForceNonceRef.current) {
      // ``forceScrollToBottom`` was called since the previous run.
      // Pin unconditionally — the user just took a local action and
      // wants to see the result. Tracking the last-seen nonce (rather
      // than the original ``forceNonce > 0`` shortcut) is what keeps
      // the slack check working *after* a force-scroll: once the
      // nonce is stable again we go back to honoring the user's
      // scroll position.
      el.scrollTop = el.scrollHeight;
      lastForceNonceRef.current = forceNonce;
      console.debug("[scroll] force-pin", {
        scrollHeight: el.scrollHeight,
        nonce: forceNonce,
      });
      return;
    }

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < slack) {
      el.scrollTop = el.scrollHeight;
      console.debug("[scroll] follow", {
        scrollHeight: el.scrollHeight,
        distanceFromBottom,
        slack,
      });
    } else {
      // Logged so a "scroll didn't follow my new message" report can
      // be correlated to the user's scroll position. Without this the
      // UI just sits there silently.
      console.debug("[scroll] leave-alone", {
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        distanceFromBottom,
        slack,
      });
    }
    // The deps array is intentionally dynamic: callers pass whatever
    // signals "content changed" (message count, streaming flag, etc.).
    // The eslint rule can't statically verify that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, refVersion, forceNonce, slack]);

  return { scrollRef, forceScrollToBottom };
}
