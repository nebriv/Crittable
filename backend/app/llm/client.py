"""Anthropic-direct ``ChatClient`` implementation.

Wraps ``anthropic.AsyncAnthropic`` and adapts it to the provider-agnostic
``ChatClient`` ABC defined in ``app.llm.protocol``.

Responsibilities:

* hold a single shared client instance,
* expose a typed ``acomplete`` that the SessionManager / export pipeline call,
* attach a prompt-cache breakpoint on the system block,
* keep a hook (``set_transport``) so tests can inject a deterministic transport,
* track in-flight calls per session so the creator's activity panel can show
  "AI processing for 12s" in real time.

The full streaming relay over the WebSocket lives in the SessionManager / WS
layer; this client returns either a complete response or an async-iterator of
events depending on ``stream``.

Sibling implementation: ``app.llm.clients.litellm_client.LiteLLMChatClient``
routes via LiteLLM and supports ~100 providers (Azure OpenAI, Bedrock,
Vertex AI, OpenRouter, OpenAI-direct, etc.). The active backend is selected
by the ``LLM_BACKEND`` env var, wired in ``app.main``.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any, Protocol

from ..config import ModelTier, Settings
from ..logging_setup import get_logger
from ._shared import (
    compute_cost_usd,
    harden_litellm_globals,
    reconcile_tool_choice,
    strip_deprecated_sampling_params,
    validate_tool_choice,
    with_message_cache,
    with_system_cache,
)
from .errors import classify_upstream_error
from .protocol import ChatClient, LLMResult

if TYPE_CHECKING:
    pass

_logger = get_logger("llm.client")

class _AnthropicCallable(Protocol):
    """Minimal surface the wrapper depends on. Concrete impl = AsyncAnthropic.messages."""

    async def create(self, **kwargs: Any) -> Any: ...
    def stream(self, **kwargs: Any) -> Any: ...


class LLMClient(ChatClient):
    """Anthropic-direct ``ChatClient``. Owns the AsyncAnthropic instance for the process."""

    def __init__(self, *, settings: Settings) -> None:
        super().__init__()
        # Defense-in-depth: re-zero litellm callback registries here too.
        # _shared.py runs them once at import time, but this constructor
        # symmetry with LiteLLMChatClient guards against a third party
        # that imported litellm and re-populated a list between the
        # _shared import and our boot. Idempotent.
        harden_litellm_globals()
        self._settings = settings
        self._client: Any | None = None
        self._lock = asyncio.Lock()
        self._transport: _AnthropicCallable | None = None
        self._closed = False

    # ---------------------------------------------------------------- setup
    def set_transport(self, transport: _AnthropicCallable) -> None:
        """Inject a deterministic transport for tests. Bypasses the real client."""

        self._transport = transport

    async def _messages_for_tier(self, tier: ModelTier) -> _AnthropicCallable:
        """Resolve the messages-API surface for a tier, applying any
        per-tier timeout override via ``with_options``.

        The base ``AsyncAnthropic`` client carries the global timeout
        (``LLM_TIMEOUT_S``); ``settings.timeout_for(tier)`` either
        returns the same value (no override) or a tier-specific one.
        ``with_options`` is the SDK's per-call surface — cheap.
        """

        base = await self._messages()
        if self._transport is not None:
            # Tests inject a flat transport that doesn't model with_options.
            return base
        per_tier = self._settings.timeout_for(tier)
        if abs(per_tier - self._settings.llm_timeout_s) < 1e-6:
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
                        "api_key": self._settings.require_llm_api_key(),
                        "max_retries": self._settings.llm_max_retries,
                        "timeout": self._settings.llm_timeout_s,
                    }
                    if self._settings.llm_api_base:
                        # Operators can point the engine at any
                        # Anthropic-compatible endpoint (Bedrock proxy,
                        # OpenRouter anthropic-compat, internal LLM
                        # gateway, etc). See docs/llm_providers.md.
                        kwargs["base_url"] = self._settings.llm_api_base
                        _logger.info(
                            "llm_api_base_override",
                            base_url=self._settings.llm_api_base,
                        )
                        # Insecure-scheme warning. Plain ``http://`` to a
                        # non-localhost host means every prompt + tool
                        # call (containing scenario data + participant
                        # chat) egresses in cleartext. Localhost loopback
                        # is fine for local-LLM-via-litellm.
                        from urllib.parse import urlparse

                        parsed = urlparse(self._settings.llm_api_base)
                        host = (parsed.hostname or "").lower()
                        loopback = host in {"localhost", "127.0.0.1", "::1"} or host.startswith(
                            "127."
                        )
                        if parsed.scheme == "http" and not loopback:
                            _logger.warning(
                                "llm_api_base_insecure",
                                base_url=self._settings.llm_api_base,
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
        ``"auto"`` behavior.

        ``max_tokens`` defaults to the per-tier value resolved from
        ``settings.max_tokens_for(tier)``; an explicit caller value
        wins.
        """

        model = self.model_for(tier)
        if max_tokens is None:
            max_tokens = self._settings.max_tokens_for(tier)
        kwargs: dict[str, Any] = {
            "model": model,
            "system": with_system_cache(system_blocks, logger=_logger),
            "messages": with_message_cache(messages, logger=_logger),
            "max_tokens": max_tokens,
        }
        kept: list[dict[str, Any]] = []
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
        validate_tool_choice(tool_choice)
        # Drop tool_choice if every tool was filtered out — Anthropic
        # rejects ``tool_choice`` without ``tools`` with HTTP 400.
        reconciled_tc = reconcile_tool_choice(kept, tool_choice, logger=_logger, tier=tier)
        if reconciled_tc:
            kwargs["tool_choice"] = reconciled_tc
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
            dropped_params = strip_deprecated_sampling_params(model, kwargs)
            if dropped_params:
                _logger.info(
                    "llm_call_params_stripped",
                    tier=tier,
                    model=model,
                    dropped=dropped_params,
                )
            response = await api.create(**kwargs)
        except Exception as exc:
            _logger.warning(
                "llm_call_failed",
                tier=tier,
                model=model,
                duration_ms=int((time.monotonic() - started) * 1000),
                error=str(exc),
            )
            classified = classify_upstream_error(exc)
            if classified is not None:
                _logger.warning(
                    "upstream_llm_error",
                    audit_kind="upstream_llm_error",
                    tier=tier,
                    model=model,
                    category=classified.category,
                    status_code=classified.status_code,
                    request_id=classified.request_id,
                    retry_hint_seconds=classified.retry_hint_seconds,
                )
                raise classified from exc
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

        Mid-stream events:
          * ``text_delta`` — incremental text from the model.
          * ``tool_use_start`` — emitted at ``content_block_start`` for
            a ``tool_use`` block; carries ``name`` so callers can react
            the moment the model commits to a specific tool (e.g. the
            setup-tier driver broadcasts a ``setup_drafting_plan`` WS
            event when ``name == "propose_scenario_plan"``). Anthropic
            streams the full block metadata at start, so the name is
            available before any input deltas arrive.

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
            "system": with_system_cache(system_blocks, logger=_logger),
            "messages": with_message_cache(messages, logger=_logger),
            "max_tokens": max_tokens,
        }
        kept: list[dict[str, Any]] = []
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
        validate_tool_choice(tool_choice)
        # Drop tool_choice if every tool was filtered out (HTTP 400 protection).
        reconciled_tc = reconcile_tool_choice(kept, tool_choice, logger=_logger, tier=tier)
        if reconciled_tc:
            kwargs["tool_choice"] = reconciled_tc
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
        dropped_params = strip_deprecated_sampling_params(model, kwargs)
        if dropped_params:
            _logger.info(
                "llm_call_params_stripped",
                tier=tier,
                model=model,
                dropped=dropped_params,
            )
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
                        if etype == "content_block_start":
                            block = getattr(event, "content_block", None)
                            if (
                                block is not None
                                and getattr(block, "type", None) == "tool_use"
                            ):
                                yield {
                                    "type": "tool_use_start",
                                    "name": getattr(block, "name", None),
                                }
                        elif etype == "content_block_delta":
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
                classified = classify_upstream_error(exc)
                if classified is not None:
                    _logger.warning(
                        "upstream_llm_error",
                        audit_kind="upstream_llm_error",
                        tier=tier,
                        model=model,
                        stream=True,
                        category=classified.category,
                        status_code=classified.status_code,
                        request_id=classified.request_id,
                        retry_hint_seconds=classified.retry_hint_seconds,
                    )
                    raise classified from exc
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
    return LLMResult(
        model=model,
        content=content,
        stop_reason=stop_reason,
        usage=usage,
        estimated_usd=compute_cost_usd(model, usage),
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


__all__ = ["LLMClient", "_AnthropicCallable"]
