"""Shared player-side submission pipeline.

Both the WebSocket handler in ``app/ws/routes.py`` and the dev-tools
``ScenarioRunner`` deterministic driver go through this module so the
validation / truncation / input-side guardrail steps happen in ONE
place. Pre-extraction the runner called ``manager.submit_response``
directly and skipped all three — meaning replayed scenarios couldn't
catch regressions in the truncation marker, the guardrail block path,
or any future server-side input check the WS handler grows.

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

from dataclasses import dataclass
from typing import TYPE_CHECKING

from ..logging_setup import get_logger

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
    """

    content: str
    truncated: bool
    original_len: int
    blocked: bool
    blocked_verdict: str | None
    advanced: bool


async def prepare_and_submit_player_response(
    *,
    manager: SessionManager,
    session_id: str,
    role_id: str,
    content: str,
) -> SubmissionOutcome:
    """Validate, truncate, classify, and submit one player response.

    Mirrors the WS handler's pre-``submit_response`` work so a
    runner-driven submission goes through the same code path a real
    browser-tab submission would. See module docstring for what's
    NOT included.
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
        )

    advanced = await manager.submit_response(
        session_id=session_id, role_id=role_id, content=content
    )
    return SubmissionOutcome(
        content=content,
        truncated=truncated,
        original_len=original_len,
        blocked=False,
        blocked_verdict=None,
        advanced=advanced,
    )
