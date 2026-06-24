"""Optional input-side classifier for blatant prompt-injection attempts.

Toggle via ``INPUT_GUARDRAIL_ENABLED`` (default true).

Two layers (security audit H5):

1. A cheap, deterministic **local pre-filter** that matches structural
   chat-template control tokens (``<|im_start|>``, ``[INST]``,
   ``<<SYS>>`` …). These never appear in legitimate tabletop prose, so a
   hit is a high-precision injection signature — we block it without an
   LLM call (cheaper, and resilient to a guardrail-tier outage). We
   deliberately do NOT match natural-language phrases like "ignore
   previous instructions": this is a *security* tabletop, so participants
   legitimately quote injection payloads while discussing an attack, and
   a prose-level denylist would silently eat real exercise content. That
   nuance is left to the context-aware LLM classifier.
2. The LLM classifier (``LLM_MODEL_GUARDRAIL``, default Haiku). Only
   ``prompt_injection`` triggers a hard block; anything else (off-topic,
   casual, terse, confused) is ``on_topic`` because tabletop responses
   are inherently messy and false positives silently lose real
   submissions. The classifier prompt (see ``_GUARDRAIL_CLASSIFIER`` in
   ``prompts.py``) instructs the model to prefer ``on_topic`` when in
   doubt.

**Fail-closed (H5).** On classifier error/timeout we now return
``"unverified"`` instead of silently allowing the message. The caller
(``submission_pipeline``) fails *closed* for player turns — the message
is held and the player gets a retryable "couldn't verify, resend"
prompt — so a slow/429'd/timed-out classifier can no longer wave an
injection through unscreened (the guardrail timeout is deliberately
shorter than the play tier, so the old fail-*open* path skipped
screening but still answered the turn). The creator path stays fail-open
(low risk, and avoids locking the session owner out on a flaky upstream).
"""

from __future__ import annotations

import re
from typing import Literal

from ..config import Settings
from ..logging_setup import get_logger
from .prompts import build_guardrail_system_blocks
from .protocol import ChatClient

GuardrailVerdict = Literal["on_topic", "prompt_injection", "unverified"]

_logger = get_logger("llm.guardrail")

# Structural chat-template / role-delimiter control tokens. An attacker
# smuggles these to forge a fake "system"/"assistant" turn inside the
# model's context. They are never legitimate tabletop prose, so matching
# them is high-precision (zero false positives on real chat) — unlike a
# natural-language denylist, which WOULD misfire on this app's security
# audience. Kept as a module constant so tests pin the exact set and a
# future addition lands in one place.
_CONTROL_TOKEN_RE = re.compile(
    r"<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>"
    r"|\[/?INST\]"
    r"|<</?SYS>>",
    re.IGNORECASE,
)


def _has_control_tokens(message: str) -> bool:
    """True iff ``message`` contains a structural injection control token."""

    return _CONTROL_TOKEN_RE.search(message) is not None


class InputGuardrail:
    def __init__(self, *, llm: ChatClient, settings: Settings) -> None:
        self._llm = llm
        self._settings = settings

    async def classify(self, *, message: str) -> GuardrailVerdict:
        if not self._settings.input_guardrail_enabled:
            return "on_topic"
        # Layer 1 — deterministic local pre-filter. A structural control
        # token is an unambiguous injection signature; block it without
        # spending a classifier call (and catch it even when the
        # classifier tier is down). High precision → no false-positive
        # risk on legitimate prose, so this never gates a real player.
        if _has_control_tokens(message):
            _logger.warning(
                "guardrail_control_token_block",
                preview=message[:120],
            )
            return "prompt_injection"
        # Layer 2 — LLM classifier.
        try:
            result = await self._llm.acomplete(
                tier="guardrail",
                system_blocks=build_guardrail_system_blocks(),
                messages=[{"role": "user", "content": message}],
                # Wide enough to receive ``prompt_injection`` (~4 tokens
                # alone) — the prior 4-token cap could truncate the verdict
                # word and make the substring match unreliable.
                # Per-tier default from settings.max_tokens_for("guardrail").
            )
        except Exception as exc:
            # H5 — fail CLOSED. Previously this returned ``on_topic``
            # (fail open), which waved a message through unscreened
            # whenever the classifier tier was slow / 429'd / timed out
            # (its timeout is deliberately shorter than the play tier, so
            # a slow provider skipped screening but still answered the
            # turn). We now return ``unverified``; the submission pipeline
            # holds the PLAYER message and prompts a retry, while the
            # creator path treats it as on_topic (low risk, no lock-out on
            # a flaky upstream). The LLM client already logs
            # ``upstream_llm_error`` at WARNING with the provider
            # request_id, so ops keeps the trace ID.
            _logger.warning("guardrail_classifier_failed", error=str(exc))
            return "unverified"

        text = "".join(
            block.get("text", "")
            for block in result.content
            if block.get("type") == "text"
        ).strip().lower()
        # The prompt asks for "exactly one word"; some models hedge
        # with a brief justification anyway. The substring match
        # below still works, but a verbose verdict wastes tokens at
        # the per-message classifier rate and signals that a model
        # swap or prompt drift is taking us off the constrained
        # surface. Log so the drift is visible in the audit stream.
        word_count = len(text.split())
        if word_count > 3:
            _logger.warning(
                "guardrail_verdict_verbose",
                word_count=word_count,
                preview=text[:120],
            )
        # Only flag the unambiguous attack signal. Everything else —
        # including the legacy "off_topic" verdict — is treated as
        # on_topic because tabletop participants legitimately produce
        # short / casual / out-of-character / role-playing replies that
        # the classifier can mistake for off-topic.
        if "prompt_injection" in text:
            return "prompt_injection"
        return "on_topic"
