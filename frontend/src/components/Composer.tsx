import {
  ChangeEvent,
  FormEvent,
  KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ImpersonateOption } from "../lib/proxy";
import { MentionPopover } from "./MentionPopover";
import {
  MentionRosterEntry,
  filterMentionRoster,
  nextHighlightIndex,
  optionIdFor,
  readMentionContext,
  scanBodyForMentions,
} from "./mentionPopoverUtils";

// ``ImpersonateOption`` lives in ``../lib/proxy`` so the helper that
// builds the dropdown options and the consumer here can't drift on
// the shape of ``offTurn`` (issue #80, Copilot review on PR #91).
// See ``lib/proxy.ts`` for the field-by-field contract.

/**
 * Wave 1 (issue #134): per-submission intent. ``"ready"`` means the
 * player is signalling "I'm done — AI may advance once everyone
 * else is ready"; ``"discuss"`` means "I'm contributing to discussion,
 * keep my seat open". The composer's two submit buttons map 1:1 onto
 * these values.
 */
export type SubmissionIntent = "ready" | "discuss";

/**
 * Wave 2 (composer mentions + facilitator routing).
 *
 * One mention occurrence in the composer's text. ``start`` and ``end``
 * are caret positions in the visible body text; ``target`` is either a
 * real ``role_id`` or the literal ``"facilitator"`` token. The
 * marks are the source of truth for which mentions exist — the visible
 * body text is decorative. This is the "mark/resolve, never regex"
 * invariant from the chat-declutter plan (§5.1, §6.6).
 */
export interface MentionMark {
  start: number;
  end: number;
  target: string;
}

interface Props {
  enabled: boolean;
  placeholder: string;
  /** Visible label above the textarea. Issue #78: parents render
   * "Your turn" when ``isMyTurn`` and "Add a comment" / "Your message"
   * otherwise so the at-a-glance signal isn't lost when the composer
   * stays enabled for out-of-turn sidebar comments. */
  label?: string;
  /**
   * ``asRoleId`` is omitted for normal submissions (use the local
   * participant's role). When the creator picks a different role from
   * the impersonate dropdown, that role's id is forwarded so the parent
   * can call the proxy endpoint.
   *
   * ``intent`` (Wave 1): the player's per-submission ready signal.
   * Always one of ``"ready"`` / ``"discuss"`` — never undefined, the
   * composer always knows which button was pressed. The parent forwards
   * this to the WS payload.
   *
   * ``mentions`` (Wave 2): structural mention targets parsed from the
   * composer's marks. Order-preserving, de-duplicated. Plain
   * ``role_id`` entries surface the @-highlight to the addressed role;
   * the literal ``"facilitator"`` token (alias ``@ai`` / ``@gm``
   * resolved client-side) triggers the server-side AI interject.
   */
  onSubmit: (
    text: string,
    intent: SubmissionIntent,
    mentions: string[],
    asRoleId?: string,
  ) => void;
  /**
   * Wave 2: roster the popover offers. The local participant's own
   * role should be EXCLUDED upstream so a player doesn't ``@`` themself.
   * The synthetic facilitator entry is rendered automatically — do
   * not include it here. Defaults to ``[]`` so legacy callers that
   * don't pass a roster still get a working composer (the facilitator
   * entry alone keeps the popover functional).
   */
  mentionRoster?: MentionRosterEntry[];
  /**
   * When ``true``, the local participant has already signalled ready
   * for the current turn. The composer surfaces this as a small
   * "Currently ready ✓" hint and primes the secondary button to
   * "Walk back ready" so the player can re-open discussion if needed.
   * Wave 1 (issue #134).
   */
  isCurrentlyReady?: boolean;
  /**
   * When ``true``, the composer hides the "Submit, still discussing"
   * button. Used for out-of-turn / interjection submissions where
   * intent doesn't apply (the message lands in the transcript and is
   * never part of the ready quorum). Defaults to ``false`` so a normal
   * active-turn composer always shows both buttons.
   */
  hideDiscussButton?: boolean;
  /** Optional callback fired on debounced typing start/stop transitions. */
  onTypingChange?: (typing: boolean) => void;
  /**
   * Solo-test impersonation list. Empty / undefined hides the dropdown.
   * Populated only for the creator and only with *other* active roles
   * (the creator's own seat is always the implicit default).
   */
  impersonateOptions?: ImpersonateOption[];
  /** Label for the local participant's own seat (shown as the default). */
  selfLabel?: string;
  /**
   * Incrementing counter the parent flips when a submit was REJECTED
   * (e.g. WS ``error`` event with ``scope === "submit_response"``).
   * On bump, the composer restores the last-attempted text instead of
   * leaving the textarea blank — so a player who hit Submit a half-
   * second after their turn closed doesn't lose their reply.
   */
  submitErrorEpoch?: number;
}

export function Composer({
  enabled,
  placeholder,
  label,
  onSubmit,
  onTypingChange,
  impersonateOptions,
  selfLabel,
  submitErrorEpoch,
  isCurrentlyReady = false,
  hideDiscussButton = false,
  mentionRoster = [],
}: Props) {
  const [text, setText] = useState("");
  // Wave 2: source-of-truth list of mention occurrences in ``text``.
  // Every visible ``@<token>`` should have a matching mark; the
  // submit handler derives ``mentions[]`` from this list, not from
  // regex on the body. Marks are kept sorted by ``start`` so the
  // shift logic on edits stays simple.
  const [marks, setMarks] = useState<MentionMark[]>([]);
  // Mention popover state. ``triggerIndex`` is the position of the
  // ``@`` keystroke that opened the popover; ``query`` is the
  // typeahead substring after it. ``null`` triggerIndex means the
  // popover is closed.
  const [mentionTrigger, setMentionTrigger] = useState<number | null>(null);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionHighlight, setMentionHighlight] = useState(0);
  // Empty string == speak as the local participant. Anything else is a
  // role_id passed up to the parent for proxy submission.
  const [asRoleId, setAsRoleId] = useState<string>("");
  // Heartbeat-based typing indicator (issue #77). Pre-fix the
  // sender emitted exactly one ``typing_start`` after a 1.5 s
  // continuous-typing gate and one ``typing_stop`` after 3.5 s of
  // idle. If either packet was dropped, or the user paused briefly
  // and the receiver TTL fired before they resumed, the indicator
  // vanished mid-typing and didn't come back. Switching to a
  // 1 Hz heartbeat: while the user is actively typing AND has hit
  // a key since the last beat, we re-emit ``typing_start`` every
  // ~1 s, which refreshes the receiver-side TTL. ``typing_stop``
  // still fires on idle / submit / disable / unmount.
  //
  // ``dirtySinceBeat`` is the gate — without it, the heartbeat
  // would keep firing across long pauses (defeating the point).
  // We mark dirty on every keystroke, clear on every beat, and
  // skip the beat send when not dirty. The idle timer (separate
  // from the heartbeat interval) still fires the explicit stop
  // after STOP_AFTER_IDLE_MS so the receiver doesn't have to
  // wait for the TTL sweep to evict.
  //
  // ``pendingStartTimer`` keeps a single fat-finger keystroke from
  // broadcasting a ghost indicator (UI/UX review BLOCK B-1; original
  // issue #53). When it fires we count keystrokes-since-schedule:
  // <2 means the user typed once and stopped (no broadcast); ≥2
  // means they're really at the keyboard (start fires + heartbeat
  // begins). Without the count gate the timer would still emit
  // start for a single keystroke that didn't clear the textarea —
  // Copilot review on PR #99.
  // Textarea ref — needed for the mention popover so insertion can
  // restore the caret + focus after committing a pick (otherwise the
  // browser parks the cursor at position 0).
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Stable id for the popover's ``role="listbox"`` so the textarea
  // can carry ``aria-controls`` + ``aria-activedescendant`` to the
  // currently-highlighted option.
  const listboxId = useId();
  // Memoised filter slice — used both by the textarea's ARIA
  // ``aria-activedescendant`` and the popover render. We pass the
  // popover its own copy too, but the ARIA wire here needs the size
  // up-front to decide whether to set the attribute at all (an empty
  // slice should not point at a missing option).
  const mentionVisible = useMemo(
    () =>
      mentionTrigger != null
        ? filterMentionRoster(mentionQuery, mentionRoster)
        : [],
    [mentionTrigger, mentionQuery, mentionRoster],
  );
  const mentionVisibleSize = mentionVisible.length;
  const mentionActiveTarget =
    mentionVisibleSize > 0
      ? mentionVisible[Math.min(mentionHighlight, mentionVisibleSize - 1)]
          ?.target ?? ""
      : "";
  // UI/UX review BLOCK B1: when the composer is anchored near the
  // bottom of the viewport (the common case — there's a sticky
  // ``BottomActionBar`` below it on both Play and Facilitator),
  // a downward popover would clip behind the bar and disappear
  // mid-typing. Measure the textarea's distance from the viewport
  // bottom each time the popover opens; if the popover's natural
  // height (``max-h-56`` = 224px + a few px of padding) wouldn't
  // fit below, render it ABOVE the textarea instead. We re-measure
  // on a window resize so a viewport change mid-popover-open
  // doesn't leave the popover stuck on the wrong side.
  const [openMentionUpward, setOpenMentionUpward] = useState(false);
  useLayoutEffect(() => {
    if (mentionTrigger == null) return;
    const node = textareaRef.current;
    if (!node) return;
    const POPOVER_HEIGHT_PX = 240;
    function measure() {
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setOpenMentionUpward(spaceBelow < POPOVER_HEIGHT_PX);
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [mentionTrigger]);
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingStartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTyping = useRef(false);
  const dirtySinceBeat = useRef(false);
  const keystrokesInGate = useRef(0);
  const TYPING_START_DELAY_MS = 500;
  const HEARTBEAT_MS = 1000;
  const STOP_AFTER_IDLE_MS = 2500;
  // Last text the user attempted to submit. Held outside React state
  // so we can restore it without an extra render on the success path.
  const lastAttemptedRef = useRef<string>("");
  // Track the last epoch we've already handled so the restore-on-error
  // effect only fires when the parent actually bumps the counter, not
  // on initial mount.
  const handledErrorEpochRef = useRef<number | undefined>(submitErrorEpoch);

  function submit(intent: SubmissionIntent) {
    if (!enabled || !text.trim()) return;
    const trimmed = text.trim();
    lastAttemptedRef.current = trimmed;
    // Wave 2: derive the submit-time mention list from two sources:
    //   1. Popover-picked marks (authoritative for picked tokens —
    //      a mark survives subsequent text edits and pins the
    //      target even if the visible label happens to match a
    //      different role).
    //   2. Body-scan fallback (resolves tokens the user typed
    //      literally without using the popover — e.g. ``@facilitator``
    //      from muscle memory). Bounded by the alias set + the
    //      session roster; never an arbitrary regex.
    // Both sources flow into a single de-duped, order-preserving
    // list. The server still trusts ``mentions[]`` as the source of
    // routing intent — the body text is decorative.
    const seen = new Set<string>();
    const submittedMentions: string[] = [];
    for (const m of [...marks].sort((a, b) => a.start - b.start)) {
      if (seen.has(m.target)) continue;
      seen.add(m.target);
      submittedMentions.push(m.target);
    }
    for (const target of scanBodyForMentions(trimmed, mentionRoster)) {
      if (seen.has(target)) continue;
      seen.add(target);
      submittedMentions.push(target);
    }
    onSubmit(trimmed, intent, submittedMentions, asRoleId || undefined);
    setText("");
    setMarks([]);
    closeMentionPopover();
    // Reset back to "speak as me" after every submit so the next message
    // doesn't accidentally post under the previous proxy role. Sticky
    // proxy mode was a real footgun in solo testing.
    setAsRoleId("");
    // Tear down the heartbeat + idle timers and emit a final
    // typing_stop so peers don't keep showing us as typing for
    // the length of TYPING_VISIBLE_MS after we just submitted.
    emitTypingStop("submit");
  }

  function closeMentionPopover() {
    setMentionTrigger(null);
    setMentionQuery("");
    setMentionHighlight(0);
  }

  /**
   * Insert the picked roster entry at the trigger position. Replaces
   * the typed query (e.g. ``"di"``) with the canonical token (e.g.
   * ``"facilitator"`` for the synthetic AI entry; ``"CISO"`` for a
   * real role). Records a matching mark so the submit-time derivation
   * can rebuild ``mentions[]`` without parsing the body.
   *
   * ``opts.keepFocus`` controls whether to re-focus the textarea
   * after committing. ``true`` (default) is the Enter/click path —
   * focus stays in the composer so the user can keep typing.
   * ``false`` is the Tab path — we leave focus alone so the
   * browser's native Tab advance lands on the next focusable
   * element (UI/UX review BLOCK B2).
   */
  function insertMention(
    entry: MentionRosterEntry,
    opts: { keepFocus?: boolean } = {},
  ) {
    const keepFocus = opts.keepFocus ?? true;
    const triggerIndex = mentionTrigger;
    if (triggerIndex == null) return;
    const ta = textareaRef.current;
    const caretEnd = ta?.selectionEnd ?? text.length;
    // The visible insertion is always ``@`` + canonical insertLabel.
    // For the synthetic facilitator the canonical token is also the
    // insert label so aliases (``@ai``, ``@gm``) resolve to the
    // canonical visible string.
    const inserted = `@${entry.insertLabel}`;
    const before = text.slice(0, triggerIndex);
    const after = text.slice(caretEnd);
    // Append a space after the mention so the next keystroke doesn't
    // accidentally extend the @-token (and so the popover trigger
    // logic stops finding the same ``@`` after commit).
    const next = `${before}${inserted} ${after}`;
    const insertedEnd = triggerIndex + inserted.length;
    const newCaret = insertedEnd + 1; // after the trailing space

    // Shift any existing marks AFTER the trigger so their offsets
    // stay aligned with the post-insert text. Marks BEFORE the
    // trigger are unaffected.
    const replacedRangeLen = caretEnd - triggerIndex; // length we replaced
    const shift = inserted.length + 1 - replacedRangeLen; // +1 for trailing space
    const shifted: MentionMark[] = [];
    for (const m of marks) {
      if (m.end <= triggerIndex) {
        shifted.push(m);
      } else if (m.start >= caretEnd) {
        shifted.push({
          start: m.start + shift,
          end: m.end + shift,
          target: m.target,
        });
      }
      // Marks that overlap the replaced range are dropped — they
      // wouldn't be addressable anyway since the user is replacing
      // their visible text.
    }
    shifted.push({
      start: triggerIndex,
      end: insertedEnd,
      target: entry.target,
    });
    shifted.sort((a, b) => a.start - b.start);

    setText(next);
    setMarks(shifted);
    closeMentionPopover();
    // Move caret past the inserted token + space. Defer to the next
    // tick so React commits the value first; otherwise selectionStart
    // is set against the stale value and the cursor jumps.
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      if (keepFocus) {
        node.focus();
      }
      // The caret update is safe regardless of focus state — if the
      // user Tab'd off, the next time they Tab back the caret will
      // already be where they expect it.
      node.setSelectionRange(newCaret, newCaret);
    });
  }

  function handle(e: FormEvent) {
    // Form-submit (Enter key in textarea, primary button click) maps
    // to the "ready" intent — the standard "I'm done, AI may advance"
    // signal. The "Submit, still discussing" button calls
    // ``submit("discuss")`` directly and bypasses this handler.
    e.preventDefault();
    submit("ready");
  }

  // Restore the last-attempted text when the parent signals a submit
  // rejection. Without this, the optimistic ``setText("")`` above
  // would silently eat the player's reply on a "role cannot submit on
  // this turn" race.
  useEffect(() => {
    if (submitErrorEpoch === undefined) return;
    if (submitErrorEpoch === handledErrorEpochRef.current) return;
    handledErrorEpochRef.current = submitErrorEpoch;
    if (lastAttemptedRef.current) {
      setText(lastAttemptedRef.current);
    }
  }, [submitErrorEpoch]);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Wave 2: when the mention popover is open it absorbs the
    // navigation keys (ArrowUp/Down/Enter/Escape/Tab) so the
    // composer's submit / newline behaviour doesn't fire mid-pick.
    // The popover's filtered slice is recomputed here so we don't
    // re-render the popover before clamping the highlight.
    if (mentionTrigger != null) {
      const visible = filterMentionRoster(mentionQuery, mentionRoster);
      if (e.key === "Escape") {
        e.preventDefault();
        closeMentionPopover();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionHighlight(
          nextHighlightIndex(mentionHighlight, 1, visible.length),
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionHighlight(
          nextHighlightIndex(mentionHighlight, -1, visible.length),
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (visible.length === 0) {
          // Nothing to commit — fall through to the normal
          // Enter/Tab handler so the user isn't trapped if their
          // query matched zero entries.
          closeMentionPopover();
        } else {
          // UI/UX review BLOCK B2: Enter and Tab both commit, but
          // Tab MUST also let the browser advance focus to the
          // next focusable element — otherwise a keyboard-only
          // user is trapped in the textarea, having to press Tab
          // a second time after every commit. Enter keeps focus
          // on the textarea (typical chat composer behaviour); Tab
          // commits + lets the native Tab advance fire by NOT
          // preventDefault'ing.
          const entry = visible[mentionHighlight] ?? visible[0];
          if (e.key === "Tab") {
            insertMention(entry, { keepFocus: false });
            // No e.preventDefault — the browser's Tab advance runs.
          } else {
            e.preventDefault();
            insertMention(entry, { keepFocus: true });
          }
          return;
        }
      }
    }

    // Enter submits as ready; Shift+Enter inserts a newline.
    // Ctrl/Cmd+Enter submits as discuss (Wave 1 / issue #134 UI/UX
    // review HIGH — gives keyboard-only operators a path to the
    // secondary action; pre-fix the discuss button was mouse-only).
    // IME composition events (Japanese / Chinese / Korean input)
    // keep the default newline behavior so accepting a candidate
    // doesn't accidentally send the message.
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    if (!enabled || !text.trim()) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+Enter (Win/Linux) or Cmd+Enter (macOS) → discuss.
      // Gated on ``showDiscussButton`` (not ``hideDiscussButton``)
      // so the shortcut matches the button's visibility exactly —
      // the discuss button is also hidden for off-turn proxy
      // submissions (``proxyIsOffTurn``), and the keyboard path
      // must not surface a hidden affordance.
      if (showDiscussButton) {
        submit("discuss");
      }
      return;
    }
    handle(e as unknown as FormEvent);
  }

  function teardownTypingTimers() {
    if (heartbeatTimer.current) {
      clearInterval(heartbeatTimer.current);
      heartbeatTimer.current = null;
    }
    if (idleTimer.current) {
      clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
    if (pendingStartTimer.current) {
      clearTimeout(pendingStartTimer.current);
      pendingStartTimer.current = null;
    }
    keystrokesInGate.current = 0;
  }

  // Reasons logged at every emitTypingStop call site so a "stuck
  // typing indicator in production" report has a breadcrumb to
  // bisect the cause (idle / submit / clear / disable / unmount).
  // Per CLAUDE.md logging-and-debuggability policy.
  function emitTypingStop(reason: string) {
    teardownTypingTimers();
    if (isTyping.current) {
      isTyping.current = false;
      dirtySinceBeat.current = false;
      onTypingChange?.(false);
      console.debug("[composer] typing_stop", { reason });
    }
  }

  function reconcileMarks(prev: string, next: string): MentionMark[] {
    // Wave 2 invariant (plan §4.6): a popover-picked mention must
    // survive subsequent text edits unless the user actually edited
    // INTO the mention's token, in which case the mark is dropped
    // whole.
    //
    // Strategy: compute the edit range (longest common prefix +
    // suffix between ``prev`` and ``next``), then for each mark
    //   * mark ENTIRELY BEFORE the edit          → unchanged
    //   * mark ENTIRELY AFTER the edit           → shift by delta
    //   * mark OVERLAPS the edit (or touches it) → drop
    //
    // The previous implementation compared ``prev.slice(m.start,
    // m.end)`` with ``next.slice(m.start, m.end)`` at fixed offsets
    // — so any insertion/deletion BEFORE the mention shifted indices
    // and the mark was incorrectly dropped, breaking the documented
    // invariant. Copilot review on PR #152.
    if (prev === next) return marks;

    // Longest common prefix.
    const maxPrefix = Math.min(prev.length, next.length);
    let prefix = 0;
    while (prefix < maxPrefix && prev[prefix] === next[prefix]) prefix++;

    // Longest common suffix, bounded so it can't overlap the prefix
    // (otherwise a single-character insert in a long unchanged
    // string would overcount the suffix and we'd miscompute delta).
    let suffix = 0;
    const maxSuffix = Math.min(prev.length - prefix, next.length - prefix);
    while (
      suffix < maxSuffix &&
      prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]
    ) {
      suffix++;
    }

    const editStart = prefix;
    const editPrevEnd = prev.length - suffix;
    const editNextEnd = next.length - suffix;
    const delta = editNextEnd - editPrevEnd;

    const out: MentionMark[] = [];
    for (const m of marks) {
      if (m.end <= editStart) {
        // Mark sits entirely in the unchanged prefix — keep as-is.
        out.push(m);
      } else if (m.start >= editPrevEnd) {
        // Mark sits entirely in the unchanged suffix — shift by the
        // length delta. The substring at ``[m.start+delta,
        // m.end+delta)`` in ``next`` is byte-for-byte identical to
        // ``prev[m.start, m.end)`` because both sit inside the
        // common-suffix region; no re-verification needed.
        out.push({
          start: m.start + delta,
          end: m.end + delta,
          target: m.target,
        });
      }
      // else: mark's range overlaps the edited span — drop it. This
      // covers backspace-into-token, paste-over-token, select-all-
      // replace, and any partial-token mutation. Plan §4.6's
      // "backspace into a mark removes the WHOLE mark" is preserved.
    }
    return out;
  }

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    const caret = e.target.selectionStart ?? value.length;
    setMarks(reconcileMarks(text, value));
    setText(value);
    // Wave 2: detect the ``@<query>`` context at the caret and either
    // open the popover with a fresh query or close it when the user
    // navigated outside any mention trigger. ``readMentionContext``
    // returns ``null`` for "no active mention here" — that's the
    // close path.
    const ctx = readMentionContext(value, caret);
    if (ctx) {
      // Reset the highlight to 0 only when the trigger position
      // CHANGED (new ``@``). Re-typing within the same trigger keeps
      // the user's last navigated index so a typeahead refinement
      // doesn't yank the highlight back to top.
      if (mentionTrigger !== ctx.atIndex) {
        setMentionHighlight(0);
      }
      setMentionTrigger(ctx.atIndex);
      setMentionQuery(ctx.query);
    } else if (mentionTrigger != null) {
      closeMentionPopover();
    }
    if (!enabled || !onTypingChange) return;
    // If the textarea is now empty (e.g. user cleared with
    // backspace), tear down the heartbeat + emit stop. Holding
    // "typing" on an empty composer is misleading.
    if (!value.trim()) {
      emitTypingStop("textarea cleared");
      return;
    }
    if (!isTyping.current) {
      keystrokesInGate.current += 1;
      if (!pendingStartTimer.current) {
        // First keystroke since silence: schedule a delayed
        // ``typing_start`` so a single fat-finger doesn't
        // surface a ghost indicator on every peer (UI/UX
        // review BLOCK B-1; original issue #53). The gate
        // requires ≥2 keystrokes before firing — without that
        // count check, a single keystroke that doesn't clear
        // the textarea still emitted start when the timer
        // fired (Copilot review on PR #99).
        pendingStartTimer.current = setTimeout(() => {
          pendingStartTimer.current = null;
          const count = keystrokesInGate.current;
          keystrokesInGate.current = 0;
          if (!enabled) return;
          if (count < 2) {
            // User typed once and stopped — don't broadcast.
            // The idle timer (still scheduled) will tear down
            // any state when STOP_AFTER_IDLE_MS elapses.
            return;
          }
          isTyping.current = true;
          dirtySinceBeat.current = false;
          onTypingChange?.(true);
          if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
          heartbeatTimer.current = setInterval(() => {
            // Re-check enabled in case the turn flipped between
            // beats.
            if (!enabled || !isTyping.current) return;
            if (!dirtySinceBeat.current) return;
            onTypingChange?.(true);
            dirtySinceBeat.current = false;
          }, HEARTBEAT_MS);
        }, TYPING_START_DELAY_MS);
      }
    } else {
      // Already typing — just mark dirty so the next heartbeat
      // tick sends a refresh.
      dirtySinceBeat.current = true;
    }
    // Refresh the idle timer on every keystroke. When it fires
    // we emit ``typing_stop`` and clear the heartbeat.
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(
      () => emitTypingStop("idle"),
      STOP_AFTER_IDLE_MS,
    );
  }

  useEffect(() => {
    return () => {
      // Unmount cleanup — clear timers + send a final stop so
      // peers don't see a stuck "X is typing…" indicator for
      // the length of TYPING_VISIBLE_MS after we navigate away.
      // Use ``teardownTypingTimers`` rather than inline clears so
      // every ref is nulled: a non-null but cancelled timer ID in
      // ``pendingStartTimer.current`` would prevent future typing
      // sessions from scheduling a new gate timer (issue #77).
      teardownTypingTimers();
      if (isTyping.current && onTypingChange) {
        isTyping.current = false;
        onTypingChange(false);
        console.debug("[composer] typing_stop", { reason: "unmount" });
      }
    };
  }, [onTypingChange]);

  // When the turn ends mid-typing burst the composer goes
  // ``disabled`` but the timers are still in flight. Without this
  // hook the indicator would linger on other clients for the
  // remaining TTL window after the turn flipped, falsely
  // suggesting we're still composing.
  useEffect(() => {
    if (enabled) return;
    emitTypingStop("disabled");
    // emitTypingStop is stable per render; only re-run when
    // ``enabled`` flips so we don't churn on onTypingChange
    // identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const hasImpersonate = (impersonateOptions?.length ?? 0) > 0;
  // Wave 1 (issue #134) UI/UX review HIGH: when the creator
  // impersonates an off-turn role via the proxy dropdown, that
  // role is not part of the ready quorum — hide the discuss button
  // so the creator can't accidentally mark an off-turn role
  // "discussing" (the backend would record ``intent=None`` for an
  // interjection regardless, but the UI shouldn't offer a button
  // that won't move any visible quorum).
  const proxyOptionSelected = asRoleId
    ? (impersonateOptions ?? []).find((o) => o.id === asRoleId)
    : undefined;
  const proxyIsOffTurn = Boolean(proxyOptionSelected?.offTurn);
  const showDiscussButton = !hideDiscussButton && !proxyIsOffTurn;

  return (
    <form
      onSubmit={handle}
      className="flex flex-col gap-2 rounded-r-3 border-t border-ink-600 bg-ink-850 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <label
          className="mono text-[10px] font-bold uppercase tracking-[0.20em] text-signal"
          htmlFor="composer"
        >
          {label ? `RESPONDING AS · ${label.toUpperCase()}` : "RESPONDING AS · YOU"}
        </label>
        {hasImpersonate ? (
          <label className="mono flex items-center gap-1 text-[10px] uppercase tracking-[0.10em] text-ink-300">
            Respond as
            <select
              value={asRoleId}
              onChange={(e) => setAsRoleId(e.target.value)}
              disabled={!enabled}
              className="mono rounded-r-1 border border-ink-500 bg-ink-900 px-1 py-0.5 text-[11px] text-ink-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal disabled:opacity-50"
              title="Creator-only solo-test helper. Submit on behalf of another active role."
            >
              <option value="">{selfLabel ?? "self"} (you)</option>
              {(impersonateOptions ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                  {o.offTurn ? " — sidebar (off-turn)" : " (proxy)"}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {asRoleId ? (() => {
        const selected = (impersonateOptions ?? []).find(
          (o) => o.id === asRoleId,
        );
        const offTurn = Boolean(selected?.offTurn);
        return (
          <div
            className="mono flex flex-wrap items-center justify-between gap-2 rounded-r-1 border border-warn bg-warn-bg px-2 py-1 text-[11px] uppercase tracking-[0.04em] text-warn"
            role="status"
            aria-live="polite"
          >
            <span>
              Submitting as{" "}
              <span className="font-bold">
                {selected?.label ?? asRoleId}
              </span>{" "}
              {offTurn ? "(sidebar — not a turn answer)" : "(proxy)"}
            </span>
            <button
              type="button"
              onClick={() => setAsRoleId("")}
              className="mono rounded-r-1 border border-warn px-2 py-0.5 text-[10px] font-bold uppercase text-warn hover:bg-warn/20"
            >
              Back to {selfLabel ?? "me"}
            </button>
          </div>
        );
      })() : null}
      <div className="relative">
        <textarea
          id="composer"
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={!enabled}
          rows={3}
          // Wave 2: ARIA wiring for the mention popover. The textarea
          // claims combobox semantics so screen readers announce the
          // currently-highlighted option as the user types and arrows
          // through the listbox. ``aria-controls`` always points at
          // the listbox id; ``aria-expanded`` flips with the popover
          // visibility; ``aria-activedescendant`` is set only when the
          // popover is open AND has results.
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={mentionTrigger != null}
          aria-controls={listboxId}
          aria-activedescendant={
            mentionTrigger != null && mentionVisibleSize > 0
              ? optionIdFor(listboxId, mentionActiveTarget)
              : undefined
          }
          aria-autocomplete="list"
          className={`w-full rounded-r-1 border bg-ink-900 p-3 text-sm text-ink-100 sans focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal-deep disabled:opacity-50 ${
            asRoleId ? "border-warn" : "border-signal-deep"
          }`}
        />
        {mentionTrigger != null ? (
          <MentionPopover
            query={mentionQuery}
            roster={mentionRoster}
            listboxId={listboxId}
            highlightedIndex={mentionHighlight}
            setHighlightedIndex={setMentionHighlight}
            onSelect={(entry) => insertMention(entry, { keepFocus: true })}
            onDismiss={closeMentionPopover}
            openUpward={openMentionUpward}
          />
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="mono text-[10px] uppercase tracking-[0.04em] text-ink-400">
          <kbd className="mono rounded-r-1 border border-ink-500 bg-ink-800 px-1 text-[10px] text-ink-100">Enter</kbd>{" "}
          ready,{" "}
          {showDiscussButton ? (
            <>
              <kbd className="mono rounded-r-1 border border-ink-500 bg-ink-800 px-1 text-[10px] text-ink-100">Ctrl</kbd>+
              <kbd className="mono rounded-r-1 border border-ink-500 bg-ink-800 px-1 text-[10px] text-ink-100">Enter</kbd>{" "}
              discuss,{" "}
            </>
          ) : null}
          <kbd className="mono rounded-r-1 border border-ink-500 bg-ink-800 px-1 text-[10px] text-ink-100">Shift</kbd>+
          <kbd className="mono rounded-r-1 border border-ink-500 bg-ink-800 px-1 text-[10px] text-ink-100">Enter</kbd>{" "}
          newline,{" "}
          {/* Wave 2 / User-Persona review HIGH H1: surface the ``@``
              affordance in the canonical keyboard-hints row so a
              first-time player learns about mentions without
              accidentally hitting the key. ``@facilitator`` is
              named explicitly because that's the canonical AI-
              routing token. */}
          <kbd className="mono rounded-r-1 border border-ink-500 bg-ink-800 px-1 text-[10px] text-ink-100">@</kbd>{" "}
          mention (try{" "}
          <kbd className="mono rounded-r-1 border border-ink-500 bg-ink-800 px-1 text-[10px] text-ink-100">@facilitator</kbd>
          {" "}for AI)
          {isCurrentlyReady && showDiscussButton ? (
            <>
              {" · "}
              <span className="text-signal" aria-live="polite">
                You're marked ready
              </span>
            </>
          ) : null}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {showDiscussButton ? (
            <button
              type="button"
              onClick={() => submit("discuss")}
              disabled={!enabled || !text.trim()}
              title={
                isCurrentlyReady
                  ? "Type a follow-up and submit it as discussion — clears your ready signal."
                  : "Post without marking ready. Turn stays open for more discussion."
              }
              className="mono rounded-r-1 border border-ink-400 bg-ink-800 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-ink-100 hover:border-signal-deep hover:bg-ink-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isCurrentlyReady ? "UNREADY ↺" : "STILL DISCUSSING →"}
            </button>
          ) : null}
          <button
            type="submit"
            disabled={!enabled || !text.trim()}
            title={
              hideDiscussButton
                ? "Send this sidebar message"
                : "Send this message AND mark yourself ready — AI advances once everyone is ready"
            }
            className={`mono rounded-r-1 px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.18em] focus-visible:outline focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50 ${
              asRoleId
                ? "bg-warn text-ink-900 hover:bg-warn/80 focus-visible:outline-warn"
                : "bg-signal text-ink-900 hover:bg-signal-bright focus-visible:outline-signal-bright"
            }`}
          >
            {(() => {
              if (asRoleId) {
                const selected = (impersonateOptions ?? []).find(
                  (o) => o.id === asRoleId,
                );
                return selected?.offTurn
                  ? "SUBMIT (SIDEBAR) →"
                  : "SUBMIT (PROXY) →";
              }
              if (hideDiscussButton) return "SUBMIT →";
              return "SUBMIT & READY →";
            })()}
          </button>
        </div>
      </div>
    </form>
  );
}
