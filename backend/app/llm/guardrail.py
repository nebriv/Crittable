"""Optional input-side classifier for blatant off-topic / injection attempts.

Toggle via ``INPUT_GUARDRAIL_ENABLED`` (default true). On classifier failure
we fall *open* (allow + warn) so a flaky upstream never silently breaks
sessions.
"""

from __future__ import annotations

from typing import Literal

from ..config import Settings
from ..logging_setup import get_logger
from .client import LLMClient
from .prompts import build_guardrail_system_blocks

GuardrailVerdict = Literal["on_topic", "off_topic", "prompt_injection"]

_logger = get_logger("llm.guardrail")


class InputGuardrail:
    def __init__(self, *, llm: LLMClient, settings: Settings) -> None:
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
                max_tokens=4,
            )
        except Exception as exc:  # fall open
            _logger.warning("guardrail_classifier_failed", error=str(exc))
            return "on_topic"

        text = "".join(
            block.get("text", "")
            for block in result.content
            if block.get("type") == "text"
        ).strip().lower()
        if "prompt_injection" in text:
            return "prompt_injection"
        if "off_topic" in text:
            return "off_topic"
        return "on_topic"
