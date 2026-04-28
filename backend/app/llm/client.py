"""Thin wrapper around `anthropic.AsyncAnthropic`.

Phase-2 responsibilities:
* hold a single shared client instance,
* expose a typed ``acomplete`` that the SessionManager / export pipeline call,
* attach a prompt-cache breakpoint on the system block,
* keep a hook (`set_transport`) so tests can inject a deterministic transport.

The full streaming relay over the WebSocket lives in the SessionManager / WS
layer; this client returns either a complete response or an async-iterator of
events depending on ``stream``.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any, Protocol

from ..config import ModelTier, Settings
from ..logging_setup import get_logger
from .cost import estimate_usd

_logger = get_logger("llm.client")


class _AnthropicCallable(Protocol):
    """Minimal surface the wrapper depends on. Concrete impl = AsyncAnthropic.messages."""

    async def create(self, **kwargs: Any) -> Any: ...
    def stream(self, **kwargs: Any) -> Any: ...


class LLMResult:
    """Resolved (non-streamed) response with a cost estimate attached."""

    def __init__(
        self,
        *,
        model: str,
        content: list[dict[str, Any]],
        stop_reason: str | None,
        usage: dict[str, int],
        estimated_usd: float,
    ) -> None:
        self.model = model
        self.content = content
        self.stop_reason = stop_reason
        self.usage = usage
        self.estimated_usd = estimated_usd


class LLMClient:
    """Wrapper that owns the AsyncAnthropic instance for the process."""

    def __init__(self, *, settings: Settings) -> None:
        self._settings = settings
        self._client: Any | None = None
        self._lock = asyncio.Lock()
        self._transport: _AnthropicCallable | None = None
        self._closed = False

    # ---------------------------------------------------------------- setup
    def set_transport(self, transport: _AnthropicCallable) -> None:
        """Inject a deterministic transport for tests. Bypasses the real client."""

        self._transport = transport

    async def _messages(self) -> _AnthropicCallable:
        if self._transport is not None:
            return self._transport
        if self._client is None:
            async with self._lock:
                if self._client is None:
                    from anthropic import AsyncAnthropic

                    self._client = AsyncAnthropic(
                        api_key=self._settings.require_anthropic_key(),
                        max_retries=self._settings.anthropic_max_retries,
                    )
        from typing import cast

        return cast(_AnthropicCallable, self._client.messages)

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._client is not None:
            close = getattr(self._client, "aclose", None)
            if close is not None:
                await close()

    # ----------------------------------------------------------------- API
    def model_for(self, tier: ModelTier) -> str:
        return self._settings.model_for(tier)

    async def acomplete(
        self,
        *,
        tier: ModelTier,
        system_blocks: list[dict[str, Any]],
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        max_tokens: int = 1024,
    ) -> LLMResult:
        """One-shot, non-streamed completion. Streaming for play turns goes via
        :meth:`astream`."""

        model = self.model_for(tier)
        kwargs: dict[str, Any] = {
            "model": model,
            "system": _with_cache(system_blocks),
            "messages": messages,
            "max_tokens": max_tokens,
        }
        if tools:
            kwargs["tools"] = tools

        api = await self._messages()
        response = await api.create(**kwargs)

        return _normalize_response(response, model=model)

    async def astream(
        self,
        *,
        tier: ModelTier,
        system_blocks: list[dict[str, Any]],
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        max_tokens: int = 1024,
    ) -> AsyncIterator[dict[str, Any]]:
        """Yield streamed events. The terminal event has ``type == "complete"``
        and carries the final ``LLMResult`` under the ``result`` key."""

        model = self.model_for(tier)
        kwargs: dict[str, Any] = {
            "model": model,
            "system": _with_cache(system_blocks),
            "messages": messages,
            "max_tokens": max_tokens,
        }
        if tools:
            kwargs["tools"] = tools

        api = await self._messages()
        stream = api.stream(**kwargs)
        text_buffer: list[str] = []
        async with stream as s:
            async for event in s:
                etype = getattr(event, "type", None)
                if etype == "content_block_delta":
                    delta = getattr(event, "delta", None)
                    if delta is not None and getattr(delta, "type", None) == "text_delta":
                        text_buffer.append(delta.text)
                        yield {"type": "text_delta", "text": delta.text}
                # Other event types aren't surfaced in MVP — the SessionManager
                # consumes the resolved final response below.
            final = await s.get_final_message()
        result = _normalize_response(final, model=model)
        yield {"type": "complete", "result": result, "text": "".join(text_buffer)}


def _with_cache(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Place a cache breakpoint on the *last* system block.

    Anthropic supports up to 4 cache breakpoints; placing one at the end of
    the system block is the pattern that gives us per-session reuse for the
    stable identity/mission/plan content.
    """

    if not blocks:
        return blocks
    out = [dict(b) for b in blocks]
    out[-1] = {**out[-1], "cache_control": {"type": "ephemeral"}}
    return out


def _normalize_response(response: Any, *, model: str) -> LLMResult:
    """Coerce an Anthropic response (or a test-mock dict) into an :class:`LLMResult`."""

    if isinstance(response, dict):
        content = response.get("content", [])
        stop_reason = response.get("stop_reason")
        usage_obj = response.get("usage", {}) or {}
    else:
        content_list = getattr(response, "content", []) or []
        content = [
            block if isinstance(block, dict) else _block_to_dict(block)
            for block in content_list
        ]
        stop_reason = getattr(response, "stop_reason", None)
        usage_obj = _usage_to_dict(getattr(response, "usage", None))

    usage = {
        "input": int(usage_obj.get("input_tokens", 0) or 0),
        "output": int(usage_obj.get("output_tokens", 0) or 0),
        "cache_read": int(usage_obj.get("cache_read_input_tokens", 0) or 0),
        "cache_creation": int(usage_obj.get("cache_creation_input_tokens", 0) or 0),
    }
    estimated = estimate_usd(
        model=model,
        input_tokens=usage["input"],
        output_tokens=usage["output"],
        cache_read_tokens=usage["cache_read"],
        cache_creation_tokens=usage["cache_creation"],
    )
    return LLMResult(
        model=model,
        content=content,
        stop_reason=stop_reason,
        usage=usage,
        estimated_usd=estimated,
    )


def _block_to_dict(block: Any) -> dict[str, Any]:
    btype = getattr(block, "type", None)
    if btype == "text":
        return {"type": "text", "text": getattr(block, "text", "")}
    if btype == "tool_use":
        return {
            "type": "tool_use",
            "id": getattr(block, "id", ""),
            "name": getattr(block, "name", ""),
            "input": getattr(block, "input", {}) or {},
        }
    return {"type": btype or "unknown"}


def _usage_to_dict(usage: Any) -> dict[str, Any]:
    if usage is None:
        return {}
    if isinstance(usage, dict):
        return usage
    return {
        "input_tokens": getattr(usage, "input_tokens", 0),
        "output_tokens": getattr(usage, "output_tokens", 0),
        "cache_read_input_tokens": getattr(usage, "cache_read_input_tokens", 0),
        "cache_creation_input_tokens": getattr(usage, "cache_creation_input_tokens", 0),
    }


__all__ = ["LLMClient", "LLMResult", "_AnthropicCallable"]
