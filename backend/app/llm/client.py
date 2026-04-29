"""Thin wrapper around `anthropic.AsyncAnthropic`.

Phase-2 responsibilities:
* hold a single shared client instance,
* expose a typed ``acomplete`` that the SessionManager / export pipeline call,
* attach a prompt-cache breakpoint on the system block,
* keep a hook (`set_transport`) so tests can inject a deterministic transport,
* track in-flight calls per session so the creator's activity panel can show
  "AI processing for 12s" in real time.

The full streaming relay over the WebSocket lives in the SessionManager / WS
layer; this client returns either a complete response or an async-iterator of
events depending on ``stream``.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Protocol

from ..config import ModelTier, Settings
from ..logging_setup import get_logger
from .cost import estimate_usd

_logger = get_logger("llm.client")

# Allowlist of acceptable ``tool_choice`` shapes. Validates the kwarg at the
# call boundary so a future caller (e.g. a less-trusted extension dispatch
# path) can't pass an arbitrary forced-tool that side-effects beyond what
# the engine intends. Currently only the strict-retry path uses
# ``{"type": "any"}``.
_VALID_TOOL_CHOICE_TYPES = frozenset({"auto", "any", "none", "tool"})


def _validate_tool_choice(tool_choice: dict[str, Any] | None) -> None:
    if tool_choice is None:
        return
    if not isinstance(tool_choice, dict) or "type" not in tool_choice:
        raise ValueError(
            f"tool_choice must be a dict with a 'type' key; got {tool_choice!r}"
        )
    if tool_choice["type"] not in _VALID_TOOL_CHOICE_TYPES:
        raise ValueError(
            f"tool_choice type must be one of {sorted(_VALID_TOOL_CHOICE_TYPES)}; "
            f"got {tool_choice['type']!r}"
        )


@dataclass
class InFlightCall:
    """One active LLM call. Used by the creator's activity panel."""

    tier: str
    model: str
    stream: bool
    started_at: float  # time.monotonic() seconds


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
        # In-flight tracker: session_id -> list of InFlightCall (in case the
        # session manager dispatches the AAR while a guardrail call is also
        # active; rare but possible).
        self._in_flight: dict[str, list[InFlightCall]] = {}

    def in_flight_for(self, session_id: str) -> list[InFlightCall]:
        """Snapshot of active LLM calls for a session. Safe from any thread."""

        return list(self._in_flight.get(session_id, ()))

    def _begin_call(
        self,
        *,
        session_id: str | None,
        tier: ModelTier,
        model: str,
        stream: bool,
    ) -> InFlightCall | None:
        if not session_id:
            return None
        call = InFlightCall(tier=tier, model=model, stream=stream, started_at=time.monotonic())
        self._in_flight.setdefault(session_id, []).append(call)
        return call

    def _end_call(self, session_id: str | None, call: InFlightCall | None) -> None:
        if session_id and call is not None:
            bucket = self._in_flight.get(session_id)
            if bucket and call in bucket:
                bucket.remove(call)
            if bucket is not None and not bucket:
                self._in_flight.pop(session_id, None)

    # ---------------------------------------------------------------- setup
    def set_transport(self, transport: _AnthropicCallable) -> None:
        """Inject a deterministic transport for tests. Bypasses the real client."""

        self._transport = transport

    async def _messages_for_tier(self, tier: ModelTier) -> _AnthropicCallable:
        """Resolve the messages-API surface for a tier, applying any
        per-tier timeout override via ``with_options``.

        The base ``AsyncAnthropic`` client carries the global timeout
        (``ANTHROPIC_TIMEOUT_S``); ``settings.timeout_for(tier)`` either
        returns the same value (no override) or a tier-specific one.
        ``with_options`` is the SDK's per-call surface — cheap.
        """

        base = await self._messages()
        if self._transport is not None:
            # Tests inject a flat transport that doesn't model with_options.
            return base
        per_tier = self._settings.timeout_for(tier)
        if abs(per_tier - self._settings.anthropic_timeout_s) < 1e-6:
            return base
        # ``self._client`` is the AsyncAnthropic; ``with_options`` returns
        # a derived client; we want its ``messages`` surface.
        from typing import cast

        derived = self._client.with_options(timeout=per_tier)  # type: ignore[union-attr]
        return cast(_AnthropicCallable, derived.messages)

    async def _messages(self) -> _AnthropicCallable:
        if self._transport is not None:
            return self._transport
        if self._client is None:
            async with self._lock:
                if self._client is None:
                    from anthropic import AsyncAnthropic

                    kwargs: dict[str, Any] = {
                        "api_key": self._settings.require_anthropic_key(),
                        "max_retries": self._settings.anthropic_max_retries,
                        "timeout": self._settings.anthropic_timeout_s,
                    }
                    if self._settings.anthropic_base_url:
                        # Operators can point the engine at any
                        # Anthropic-compatible endpoint (Bedrock proxy,
                        # OpenRouter anthropic-compat, internal LLM
                        # gateway, etc). See docs/llm_providers.md.
                        kwargs["base_url"] = self._settings.anthropic_base_url
                        _logger.info(
                            "anthropic_base_url_override",
                            base_url=self._settings.anthropic_base_url,
                        )
                        # Insecure-scheme warning. Plain ``http://`` to a
                        # non-localhost host means every prompt + tool
                        # call (containing scenario data + participant
                        # chat) egresses in cleartext. Localhost loopback
                        # is fine for local-LLM-via-litellm.
                        from urllib.parse import urlparse

                        parsed = urlparse(self._settings.anthropic_base_url)
                        host = (parsed.hostname or "").lower()
                        loopback = host in {"localhost", "127.0.0.1", "::1"} or host.startswith(
                            "127."
                        )
                        if parsed.scheme == "http" and not loopback:
                            _logger.warning(
                                "anthropic_base_url_insecure",
                                base_url=self._settings.anthropic_base_url,
                                hint=(
                                    "Plain http:// to a non-loopback host: prompts"
                                    " + participant chat will egress in cleartext."
                                    " Use https:// or a loopback proxy."
                                ),
                            )
                    self._client = AsyncAnthropic(**kwargs)
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
        max_tokens: int | None = None,
        session_id: str | None = None,
        tool_choice: dict[str, Any] | None = None,
        extension_tool_names: frozenset[str] | None = None,
    ) -> LLMResult:
        """One-shot, non-streamed completion. Streaming for play turns goes via
        :meth:`astream`.

        ``tool_choice`` maps directly to Anthropic's parameter — pass
        ``{"type": "any"}`` to force the model to emit at least one tool
        call (used by the strict-retry path), or omit it for the default
        ``"auto"`` behaviour.

        ``max_tokens`` defaults to the per-tier value resolved from
        ``settings.max_tokens_for(tier)``; an explicit caller value
        wins.
        """

        model = self.model_for(tier)
        if max_tokens is None:
            max_tokens = self._settings.max_tokens_for(tier)
        kwargs: dict[str, Any] = {
            "model": model,
            "system": _with_cache(system_blocks),
            "messages": messages,
            "max_tokens": max_tokens,
        }
        if tools:
            # Engine-side tool gate. Drop anything not in the tier's
            # ``allowed_tool_names`` (plus ``extension_tool_names`` for
            # the play tier). Pre-fix a misbehaving caller could pass
            # ``SETUP_TOOLS`` to a play call and the model would have
            # access to ``ask_setup_question`` mid-exercise.
            from ..sessions.phase_policy import filter_allowed_tools

            kept, dropped = filter_allowed_tools(
                tier, tools, extension_tool_names=extension_tool_names
            )
            if dropped:
                _logger.warning(
                    "phase_policy_dropped_tools",
                    tier=tier,
                    dropped=dropped,
                )
            if kept:
                kwargs["tools"] = kept
        _validate_tool_choice(tool_choice)
        if tool_choice:
            kwargs["tool_choice"] = tool_choice
        temperature = self._settings.temperature_for(tier)
        if temperature is not None:
            kwargs["temperature"] = temperature
        top_p = self._settings.top_p_for(tier)
        if top_p is not None:
            kwargs["top_p"] = top_p

        _logger.info(
            "llm_call_start",
            tier=tier,
            model=model,
            stream=False,
            tools=len(tools or []),
            messages=len(messages),
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            tool_choice=tool_choice.get("type") if tool_choice else None,
        )
        call = self._begin_call(session_id=session_id, tier=tier, model=model, stream=False)
        started = time.monotonic()
        try:
            api = await self._messages_for_tier(tier)
            response = await api.create(**kwargs)
        except Exception as exc:
            _logger.warning(
                "llm_call_failed",
                tier=tier,
                model=model,
                duration_ms=int((time.monotonic() - started) * 1000),
                error=str(exc),
            )
            raise
        finally:
            self._end_call(session_id, call)

        result = _normalize_response(response, model=model)
        _logger.info(
            "llm_call_complete",
            tier=tier,
            model=model,
            duration_ms=int((time.monotonic() - started) * 1000),
            usage=result.usage,
            estimated_usd=round(result.estimated_usd, 6),
            stop_reason=result.stop_reason,
            tool_uses=sum(1 for b in result.content if b.get("type") == "tool_use"),
        )
        return result

    async def astream(
        self,
        *,
        tier: ModelTier,
        system_blocks: list[dict[str, Any]],
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        max_tokens: int | None = None,
        session_id: str | None = None,
        tool_choice: dict[str, Any] | None = None,
        extension_tool_names: frozenset[str] | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Yield streamed events. The terminal event has ``type == "complete"``
        and carries the final ``LLMResult`` under the ``result`` key.

        ``tool_choice`` is passed through to Anthropic. Use ``{"type":
        "any"}`` on the strict-retry path to guarantee a tool call.

        ``max_tokens`` defaults to the per-tier value resolved from
        ``settings.max_tokens_for(tier)``.
        """

        model = self.model_for(tier)
        if max_tokens is None:
            max_tokens = self._settings.max_tokens_for(tier)
        kwargs: dict[str, Any] = {
            "model": model,
            "system": _with_cache(system_blocks),
            "messages": messages,
            "max_tokens": max_tokens,
        }
        if tools:
            # Engine-side tool gate. Drop anything not in the tier's
            # ``allowed_tool_names`` (plus ``extension_tool_names`` for
            # the play tier). Pre-fix a misbehaving caller could pass
            # ``SETUP_TOOLS`` to a play call and the model would have
            # access to ``ask_setup_question`` mid-exercise.
            from ..sessions.phase_policy import filter_allowed_tools

            kept, dropped = filter_allowed_tools(
                tier, tools, extension_tool_names=extension_tool_names
            )
            if dropped:
                _logger.warning(
                    "phase_policy_dropped_tools",
                    tier=tier,
                    dropped=dropped,
                )
            if kept:
                kwargs["tools"] = kept
        _validate_tool_choice(tool_choice)
        if tool_choice:
            kwargs["tool_choice"] = tool_choice
        temperature = self._settings.temperature_for(tier)
        if temperature is not None:
            kwargs["temperature"] = temperature
        top_p = self._settings.top_p_for(tier)
        if top_p is not None:
            kwargs["top_p"] = top_p

        _logger.info(
            "llm_call_start",
            tier=tier,
            model=model,
            stream=True,
            tools=len(tools or []),
            messages=len(messages),
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            tool_choice=tool_choice.get("type") if tool_choice else None,
        )
        call = self._begin_call(session_id=session_id, tier=tier, model=model, stream=True)
        started = time.monotonic()
        api = await self._messages_for_tier(tier)
        stream = api.stream(**kwargs)
        text_buffer: list[str] = []
        # try/finally rather than try/except: ``CancelledError`` is BaseException
        # so a WS-disconnect-cancel mid-stream would otherwise leak the
        # in-flight entry forever (the activity panel would show "AI play
        # 999.9s" until the process restarts).
        try:
            try:
                async with stream as s:
                    async for event in s:
                        etype = getattr(event, "type", None)
                        if etype == "content_block_delta":
                            delta = getattr(event, "delta", None)
                            if (
                                delta is not None
                                and getattr(delta, "type", None) == "text_delta"
                            ):
                                text_buffer.append(delta.text)
                                yield {"type": "text_delta", "text": delta.text}
                    final = await s.get_final_message()
            except Exception as exc:
                _logger.warning(
                    "llm_call_failed",
                    tier=tier,
                    model=model,
                    duration_ms=int((time.monotonic() - started) * 1000),
                    stream=True,
                    error=str(exc),
                )
                raise
        finally:
            self._end_call(session_id, call)
        result = _normalize_response(final, model=model)
        _logger.info(
            "llm_call_complete",
            tier=tier,
            model=model,
            stream=True,
            duration_ms=int((time.monotonic() - started) * 1000),
            usage=result.usage,
            estimated_usd=round(result.estimated_usd, 6),
            stop_reason=result.stop_reason,
            tool_uses=sum(1 for b in result.content if b.get("type") == "tool_use"),
            text_chars=sum(len(c) for c in text_buffer),
        )
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
