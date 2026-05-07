"""Shared player-side submission pipeline.

Both the WebSocket handler in ``app/ws/routes.py`` and the dev-tools
``ScenarioRunner`` deterministic driver go through this module so the
validation / truncation / input-side guardrail steps happen in ONE
place. Pre-extraction the runner called ``manager.submit_response``
directly and skipped all three — meaning replayed scenarios couldn't
catch regressions in the truncation marker, the guardrail block path,
or any future server-side input check the WS handler grows.

Wave 2 (composer mentions + facilitator routing) adds the structural
``mentions`` list to the pipeline contract. The composer sends a
list of mention targets — either real ``role_id`` values or the
literal ``"facilitator"`` token (synthetic AI target with aliases
``@ai`` / ``@gm`` resolved client-side). The pipeline is the single
input-side gate that drops unknown entries (with a ``mention_dropped``
audit line) and caps oversized lists; downstream code reads the
cleaned list as ground truth.

The pipeline returns a structured ``SubmissionOutcome`` rather than
sending response frames itself. The WS handler converts the outcome
to ``submission_truncated`` / ``guardrail_blocked`` JSON frames the
submitting socket consumes; the runner logs the outcome and continues
(the dev's tab is watching via WS broadcasts triggered downstream by
``submit_response`` itself, not via per-submission ack frames).

What's NOT in this pipeline (intentionally):

* WS framing, auth, origin check, token-version check — those are
  connection-level concerns the WS handler enforces at upgrade time.
  The runner is in-process and uses the manager directly; there's
  no socket to authenticate.
* ``run_play_turn`` / ``run_interject`` post-submission dispatch —
  those are tier-specific and live in the WS handler / runner
  respectively. The runner's deterministic mode never calls
  ``run_play_turn`` (no LLM in the replay path).
* Dedupe window — enforced inside ``manager.submit_response`` itself
  via ``_enforce_dedupe_window``; both call sites inherit it.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING

from ..logging_setup import get_logger
from .turn_engine import SubmissionIntent

if TYPE_CHECKING:
    from .manager import SessionManager

_logger = get_logger("sessions.submission_pipeline")


class EmptySubmissionError(ValueError):
    """Raised when content is empty after stripping. Callers convert
    this to a WS error frame (handler) or skip the step (runner)."""


@dataclass
class SubmissionOutcome:
    """Result of one player submission going through the pipeline.

    ``content`` is the final string that landed in ``session.messages``
    — possibly truncated with the ``[message truncated by server]``
    marker appended. ``truncated`` / ``original_len`` let the WS
    handler emit ``submission_truncated`` info frames.

    ``blocked`` is True only when the input-side guardrail returned
    ``"prompt_injection"``. In that case ``submit_response`` was NOT
    called and ``advanced`` is False — the message never lands in
    the transcript.

    ``advanced`` reflects ``manager.submit_response``'s return: True
    means the turn is now ``AI_PROCESSING`` and the caller should
    drive the next AI turn (or, in deterministic replay, inject the
    recorded AI fallout).

    ``mentions`` is the cleaned list the message was persisted with
    (Wave 2). The WS handler reads this to decide whether to fire
    ``run_interject`` (``"facilitator"`` present, AI not paused).
    Empty when the submission carried no mentions OR every entry
    was dropped by validation; either way the routing branch
    short-circuits to "no AI side effect."
    """

    content: str
    truncated: bool
    original_len: int
    blocked: bool
    blocked_verdict: str | None
    advanced: bool
    mentions: list[str]


# Wave 2: maximum number of mention entries accepted per submission.
# A real composer popover offers one click per mention; a list this
# long is malformed-client / abuse, not a normal flow. Cap with a
# WARNING log so an operator can spot a misbehaving client. Excess
# entries are dropped; valid prefix is kept.
_MENTIONS_CAP = 16

# Wave 2: per-entry character cap. Real ``role_id`` values are short
# alphanumerics (12 chars); the ``"facilitator"`` literal is 11. A
# 64-char ceiling has 5x headroom for any plausible future schema
# change but blocks a 1MB string from landing in ``Message.mentions``
# or in the audit log. Sec review L2.
_MENTION_ENTRY_MAX_CHARS = 64

# Wave 2: per-entry truncation length used when echoing rejected
# input into the ``mention_dropped`` audit. A malicious client could
# ship megabyte-sized strings — we want them visible in the log
# (so an operator can see the abuse signature) without inflating the
# log volume. 80 chars matches the ``content_preview`` pattern
# elsewhere in the manager. Sec review L1.
_MENTION_LOG_PREVIEW_CHARS = 80

# Wave 2: per-list truncation count used when echoing the
# ``submitted`` / ``dropped`` lists into the ``mention_dropped``
# audit. A malicious client can ship a 10000-entry array; even with
# per-entry truncation that's still ~800KB of log per request. Cap
# the audit echo at this many entries — operators see the head of
# the abuse pattern (which is sufficient to identify the misbehaving
# client) without paying the storage cost for the full payload.
# Total counts are reported separately so the truncation is visible.
# Copilot review on PR #152.
_MENTION_LOG_LIST_PREVIEW = 32

# Wave 2: synthetic mention target for the AI. Plain ``@<role>``
# mentions resolve to a real ``role_id``; ``@facilitator`` (and the
# client-side aliases ``@ai`` / ``@gm``) resolve to this literal
# token. The WS handler branches on its presence to decide whether
# to fire ``run_interject``.
FACILITATOR_MENTION_TOKEN = "facilitator"


def _preview_for_log(value: object) -> object:
    """Cap one mention-list entry to a bounded shape suitable for
    logging. Strings are truncated; everything else passes through
    unchanged so the structlog payload still reflects the actual
    type the wire carried (e.g. ``42``, ``None``, ``{...}``).
    """

    if isinstance(value, str) and len(value) > _MENTION_LOG_PREVIEW_CHARS:
        return value[:_MENTION_LOG_PREVIEW_CHARS] + "..."
    return value


def _bounded_log_list(values: Sequence[object]) -> list[object]:
    """Cap one mention list to the first ``_MENTION_LOG_LIST_PREVIEW``
    entries and apply per-entry preview truncation. Used to bound the
    audit-log payload when echoing back ``submitted`` / ``dropped``
    arrays from a (possibly abusive) client.

    The total length of the original list is reported separately as
    a ``..._total`` field so an operator can see the truncation
    happened. Cheap iteration: we only walk the head, never the tail.

    ``Sequence[object]`` rather than ``list[object]`` so the caller
    can pass either ``list[str]`` (clean kept entries) or
    ``list[object]`` (heterogeneous wire payload) without an
    invariance compile error.
    """

    head = values[:_MENTION_LOG_LIST_PREVIEW]
    return [_preview_for_log(v) for v in head]


async def prepare_and_submit_player_response(
    *,
    manager: SessionManager,
    session_id: str,
    role_id: str,
    content: str,
    intent: SubmissionIntent = "ready",
    expected_token_version: int | None = None,
    mentions: list[str] | None = None,
) -> SubmissionOutcome:
    """Validate, truncate, classify, and submit one player response.

    Mirrors the WS handler's pre-``submit_response`` work so a
    runner-driven submission goes through the same code path a real
    browser-tab submission would. See module docstring for what's
    NOT included.

    ``intent`` (Wave 1, issue #134): "ready" signals the player is done
    talking and the AI may advance once every active role has signaled
    ready; "discuss" leaves the player in the turn so the team can
    keep talking. Defaults to "ready" so legacy callers (test fixtures,
    pre-Wave-1 scenarios) get the historical "submit-and-advance"
    behavior. The WS handler must always pass an explicit value
    parsed from the wire payload.

    ``mentions`` (Wave 2): structural mention targets from the
    composer. Each entry is either (a) a current ``role_id`` in the
    session or (b) the literal ``"facilitator"`` token. Unknown / non-
    string / oversized entries are dropped with a ``mention_dropped``
    WARNING log; the cleaned list is passed to ``submit_response``
    and surfaced on the returned ``SubmissionOutcome`` so the WS
    handler can branch on ``"facilitator"`` membership without
    re-fetching the persisted message.
    """

    if not content.strip():
        raise EmptySubmissionError("submission content is empty")

    cap = manager.settings().max_participant_submission_chars
    original_len = len(content)
    truncated = False
    if original_len > cap:
        content = content[:cap] + "\n[message truncated by server]"
        truncated = True
        _logger.info(
            "submission_truncated",
            session_id=session_id,
            role_id=role_id,
            cap=cap,
            original_len=original_len,
        )

    # Wave 2: validate the structural mentions list. Pulled out of
    # the WS / proxy handlers so the dev-tools runner exercises the
    # same drop-unknown-and-log path. ``manager`` carries the live
    # session, so we resolve role_ids against the current roster
    # rather than trusting the wire.
    cleaned_mentions = await validate_mentions(
        manager=manager,
        session_id=session_id,
        role_id=role_id,
        submitted=mentions,
    )

    # Input-side guardrail classifies the message. Only
    # ``prompt_injection`` blocks; ``off_topic`` and similar verdicts
    # flow through to ``submit_response``. Matches the WS handler
    # gate exactly.
    verdict = await manager.guardrail().classify(message=content)
    if verdict == "prompt_injection":
        _logger.warning(
            "submission_blocked_by_guardrail",
            session_id=session_id,
            role_id=role_id,
            verdict=verdict,
            content_preview=content[:120],
        )
        return SubmissionOutcome(
            content=content,
            truncated=truncated,
            original_len=original_len,
            blocked=True,
            blocked_verdict=verdict,
            advanced=False,
            mentions=cleaned_mentions,
        )

    advanced = await manager.submit_response(
        session_id=session_id,
        role_id=role_id,
        content=content,
        intent=intent,
        expected_token_version=expected_token_version,
        mentions=cleaned_mentions,
    )
    return SubmissionOutcome(
        content=content,
        truncated=truncated,
        original_len=original_len,
        blocked=False,
        blocked_verdict=None,
        advanced=advanced,
        mentions=cleaned_mentions,
    )


async def validate_mentions(
    *,
    manager: SessionManager,
    session_id: str,
    role_id: str,
    submitted: list[str] | None,
) -> list[str]:
    """Drop unknown / non-string / oversized mention entries.

    Wave 2 (composer mentions). The composer-side mark/resolve state
    is the source of truth on the client; this is the server-side
    counter-check. Each entry is kept iff it's all of:
      * a string (not ``None``, not a number, not a dict),
      * non-empty after stripping nothing — empty strings are dropped,
      * ≤ ``_MENTION_ENTRY_MAX_CHARS`` long (defense in depth — a
        legitimate ``role_id`` is ~12 chars, the synthetic
        ``"facilitator"`` literal is 11),
      * either the literal ``"facilitator"`` token (synthetic AI
        target) OR a current ``role_id`` on the session.

    Anything else — non-string types, empty strings, role_ids that
    refer to a removed / never-existed role, the literal ``"creator"``
    or other near-misses, oversized strings — is dropped. The full
    list is also capped at ``_MENTIONS_CAP`` entries; excess is
    truncated with a WARNING so a misbehaving client surfaces in the
    audit log.

    Logs at WARNING (not INFO) when any entry is dropped because drops
    are correctness-affecting (the @-highlight + facilitator routing
    both read from this list); a silent drop turns into a "the AI
    didn't answer my question" mystery later. Per-entry strings are
    truncated to ``_MENTION_LOG_PREVIEW_CHARS`` in the log payload to
    bound log volume on a megabyte-string abuse payload (Security
    review L1).

    Note on locking: the roster snapshot is read OUTSIDE the per-
    session lock that ``submit_response`` later acquires. A role
    revoked between the two reads could see its (now-stale) id pass
    validation here; the downstream ``submit_response`` then either
    persists the stale id (harmless — it's just a routing string,
    never an auth grant) or rejects the whole submission via
    ``expected_token_version``. Reading under the lock would require
    threading the manager's lock acquisition into this module and
    isn't worth it for the metadata-only consequence (Security
    review M1).
    """

    if not submitted:
        return []

    if not isinstance(submitted, list):
        _logger.warning(
            "mention_dropped",
            session_id=session_id,
            role_id=role_id,
            reason="payload_not_a_list",
            submitted_type=type(submitted).__name__,
        )
        return []

    # Cap up front so a 10_000-entry payload doesn't pay the
    # per-entry validation cost for the dropped tail.
    capped = submitted[:_MENTIONS_CAP]
    cap_dropped: list[object] = list(submitted[_MENTIONS_CAP:])

    session = await manager.get_session(session_id)
    valid_role_ids = {r.id for r in session.roles}

    kept: list[str] = []
    dropped: list[object] = list(cap_dropped)
    seen: set[str] = set()
    for entry in capped:
        if not isinstance(entry, str) or not entry:
            dropped.append(entry)
            continue
        if len(entry) > _MENTION_ENTRY_MAX_CHARS:
            # Sec review L2: a legit mention target fits well under
            # this cap; an oversized string is malformed-client or
            # abuse signal. Drop without trying to interpret.
            dropped.append(entry)
            continue
        if entry == FACILITATOR_MENTION_TOKEN or entry in valid_role_ids:
            if entry in seen:
                # Composer should already de-dupe, but a malformed
                # client could repeat. Strip duplicates to keep the
                # routing branch idempotent.
                continue
            seen.add(entry)
            kept.append(entry)
        else:
            dropped.append(entry)

    if dropped:
        # Bound BOTH per-entry size AND list length when echoing into
        # the audit. Per-entry truncation alone (Sec review L1) caps
        # one string at ~80 chars; without the list-length cap, a
        # 10000-entry payload still produces ~800KB of log per
        # request. ``submitted_total`` / ``dropped_total`` make the
        # truncation visible to an operator inspecting the audit.
        # Copilot review on PR #152.
        _logger.warning(
            "mention_dropped",
            session_id=session_id,
            role_id=role_id,
            submitted=_bounded_log_list(submitted),
            submitted_total=len(submitted),
            dropped=_bounded_log_list(dropped),
            dropped_total=len(dropped),
            kept=kept,
            cap=_MENTIONS_CAP,
            entry_max_chars=_MENTION_ENTRY_MAX_CHARS,
            log_list_preview=_MENTION_LOG_LIST_PREVIEW,
        )

    return kept
