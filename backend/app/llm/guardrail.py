"""Optional input-side classifier for blatant prompt-injection attempts.

Toggle via ``INPUT_GUARDRAIL_ENABLED`` (default true). On classifier failure
we fall *open* (allow + warn) so a flaky upstream never silently breaks
sessions.

The classifier is intentionally narrow: only ``prompt_injection`` triggers
a hard block. Anything else (off-topic, casual, terse, confused) is treated
as ``on_topic`` because tabletop responses are inherently messy and false
positives silently lose real participant submissions. The classifier
prompt itself (see ``_GUARDRAIL_CLASSIFIER`` in ``prompts.py``) instructs
the model to be conservative and prefer ``on_topic`` when in doubt.
"""

from __future__ import annotations

from typing import Literal

from ..config import Settings
from ..logging_setup import get_logger
from .prompts import build_guardrail_system_blocks
from .protocol import ChatClient

GuardrailVerdict = Literal["on_topic", "prompt_injection"]

_logger = get_logger("llm.guardrail")


class InputGuardrail:
    def __init__(self, *, llm: ChatClient, settings: Settings) -> None:
        self._llm = llm
        self._settings = settings

    async def classify(self, *, message: str) -> GuardrailVerdict:
        if not self._settings.input_guardrail_enabled:
            return "on_topic"
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
        except Exception as exc:  # fall open
            _logger.warning("guardrail_classifier_failed", error=str(exc))
            return "on_topic"

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
