"""LiteLLM-routed ``ChatClient`` implementation.

Routes every LLM call through ``litellm.acompletion`` so any of the ~100
providers LiteLLM supports (Azure OpenAI, AWS Bedrock, Vertex AI,
OpenRouter, OpenAI-direct, vLLM/LocalAI, etc.) works as a Crittable
backend with no code change — just env config. Selected via
``LLM_BACKEND=litellm``. See `docs/llm_providers.md` and issue #193.

# Internal vocabulary stays Anthropic-shaped

Callers pass us Anthropic-shaped data (content blocks, ``tool_use`` /
``tool_result``, ``cache_control: ephemeral``, ``stop_reason``) and we
return ``LLMResult`` with the same shape. The OpenAI/LiteLLM wire
translation lives entirely in the helpers below; nothing in
``turn_driver``, ``dispatch``, or ``manager`` knows we're routing through
LiteLLM. See `CLAUDE.md` § "Model-output trust boundary" for why this
discipline matters.

# Security-relevant side effects live in ``app.llm._shared``

Importing ``_shared`` is what sets ``LITELLM_MODE=PRODUCTION`` (skipping
litellm's import-time ``dotenv.load_dotenv()``) and zeroes every
callback registry the library reads. Both ``ChatClient`` backends import
from ``_shared``, so any boot path produces a hardened litellm —
including the Anthropic-direct path, which now reads cost from
LiteLLM's pricing JSON via ``compute_cost_usd``. Calling
``harden_litellm_globals()`` again from this client's constructor is
defense-in-depth against a third-party that imported litellm between
our module load and client construction.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

import litellm

from ...config import ModelTier, Settings
from ...logging_setup import get_logger
from .._shared import (
    compute_cost_usd,
    harden_litellm_globals,
    reconcile_tool_choice,
    strip_deprecated_sampling_params,
    validate_tool_choice,
    with_message_cache,
    with_system_cache,
)
from ..protocol import ChatClient, LLMResult

if TYPE_CHECKING:
    pass

_logger = get_logger("llm.clients.litellm")


# ---------------------------------------------------------------------------
# Wire-format translators (internal Anthropic shape ↔ LiteLLM/OpenAI shape)
# ---------------------------------------------------------------------------

# Map from internal Anthropic-shaped ``stop_reason`` to OpenAI-shaped
# ``finish_reason`` and back. We keep the internal vocabulary Anthropic-
# shaped so consumer code doesn't have to know about the swap.
_OPENAI_TO_ANTHROPIC_FINISH = {
    "stop": "end_turn",
    "tool_calls": "tool_use",
    "length": "max_tokens",
    "content_filter": "stop_sequence",
    "function_call": "tool_use",
}

# Allowlist of LiteLLM provider prefixes we recognize. ``LLM_MODEL_<TIER>``
# overrides outside this set fall through to LiteLLM's default-route
# logic, which can dispatch to a provider we don't intend (security
# review M3 on issue #193). Operators wanting a new provider should add
# its prefix here in the same PR that documents it in
# ``docs/llm_providers.md``.
_KNOWN_PROVIDER_PREFIXES = frozenset(
    {
        "anthropic",
        "bedrock",
        "vertex_ai",
        "azure",
        "openai",
        "openrouter",
        "openai_like",
        "ollama",
        "vllm",
    }
)

# Allowlist of kwargs we forward to ``litellm.acompletion``. Anything
# else means our explicit-build discipline drifted, which would re-open
# the per-call telemetry-callback bypass closed in Phase 1 (security
# review C2). Asserted at the bottom of ``_build_call_kwargs``.
_ALLOWED_LITELLM_KWARGS = frozenset(
    {
        "model",
        "messages",
        "stream",
        "max_tokens",
        "api_base",
        "api_key",
        "num_retries",
        "timeout",
        "tools",
        "tool_choice",
        "temperature",
        "top_p",
    }
)


def _resolves_to_anthropic(settings: Settings) -> bool:
    """Whether any tier in ``settings`` lands on the ``anthropic/`` family.

    The LiteLLM startup gate uses this to decide whether ``LLM_API_KEY``
    is required: a deploy that points every tier at ``openai/...`` or
    ``bedrock/...`` doesn't need it (LiteLLM auto-discovers the
    provider-native env var); a deploy where any tier still targets
    Anthropic does. Mirrors the per-call check in ``_build_call_kwargs``.
    """

    tiers: tuple[ModelTier, ...] = ("play", "setup", "aar", "guardrail")
    for tier in tiers:
        bare = settings.model_for(tier)
        if "/" in bare:
            if bare.split("/", 1)[0] == "anthropic":
                return True
        elif bare.startswith("claude-"):
            return True
    return False


def _to_openai_tools(
    tools: list[dict[str, Any]] | None,
) -> list[dict[str, Any]] | None:
    """Anthropic ``{name, description, input_schema}`` → OpenAI
    ``{type:"function", function:{name, description, parameters}}``.

    Returns ``None`` for empty/missing input so we don't pass an empty
    array to LiteLLM (some providers fault on it).
    """

    if not tools:
        return None
    return [
        {
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t.get("description", ""),
                "parameters": t.get("input_schema", {"type": "object", "properties": {}}),
            },
        }
        for t in tools
    ]


def _to_openai_tool_choice(
    tool_choice: dict[str, Any] | None,
) -> Any:
    """Anthropic-shaped ``tool_choice`` → OpenAI-shaped.

    * ``{"type": "auto"}``  → ``"auto"``
    * ``{"type": "any"}``   → ``"required"`` (force *some* tool)
    * ``{"type": "none"}``  → ``"none"``
    * ``{"type": "tool", "name": X}`` → ``{"type": "function", "function": {"name": X}}``

    ``None`` passes through.
    """

    if tool_choice is None:
        return None
    t = tool_choice.get("type")
    if t == "auto":
        return "auto"
    if t == "any":
        return "required"
    if t == "none":
        return "none"
    if t == "tool":
        name = tool_choice.get("name")
        if not name:
            raise ValueError("tool_choice type='tool' requires 'name'")
        return {"type": "function", "function": {"name": name}}
    raise ValueError(f"unknown tool_choice shape: {tool_choice!r}")


def _to_openai_messages(
    system_blocks: list[dict[str, Any]],
    messages: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Internal Anthropic-shaped messages → OpenAI/LiteLLM-shaped messages.

    Three structural translations land here:

    1. **System prompt position.** Anthropic takes ``system=[…]`` as a
       separate kwarg; OpenAI puts it as the first message with
       ``role:"system"``. We preserve the content blocks (which carry
       ``cache_control: ephemeral``) — LiteLLM passes them through to
       Anthropic verbatim, validated in PoC T3.

    2. **Assistant tool calls.** Anthropic encodes them as
       ``content: [{"type":"tool_use", "id", "name", "input"}, …]``.
       OpenAI uses a separate ``tool_calls`` list on the assistant
       message; arguments are JSON strings.

    3. **User tool results.** Anthropic encodes them as a user message
       with ``content: [{"type":"tool_result", "tool_use_id", "content",
       "is_error"}, …]``. OpenAI requires each tool result as its own
       ``role:"tool"`` message. **Order is preserved** within the user
       message — interleaved ``[text, tool_result, text]`` becomes
       ``[user(text), tool, user(text)]`` so the OpenAI contract
       (tool messages immediately after the assistant turn that issued
       the tool_calls) holds even if a future caller inserts text
       around tool_result blocks.

    The ``is_error: True`` flag is encoded as an ``"ERROR: "`` prefix
    in the content string — verified in PoC T2 to round-trip the
    strict-retry self-correction behavior.
    """

    out: list[dict[str, Any]] = []

    # System prompt as the first message. Preserve the content-block
    # list so cache_control passes through.
    if system_blocks:
        out.append({"role": "system", "content": list(system_blocks)})

    for msg in messages:
        role = msg.get("role")
        content = msg.get("content")

        # String content — pass straight through.
        if isinstance(content, str):
            out.append({"role": role, "content": content})
            continue

        if not isinstance(content, list):
            # Defensive: unknown shape gets coerced to empty string so
            # we don't 400 the request. Logged at WARNING with a
            # truncated repr so the regression is observable.
            _logger.warning(
                "litellm_message_unexpected_content",
                role=role,
                content_type=type(content).__name__,
                preview=repr(content)[:120],
            )
            out.append({"role": role, "content": ""})
            continue

        if role == "assistant":
            out.append(_assistant_message_from_blocks(content))
            continue

        if role == "user":
            out.extend(_user_messages_from_blocks(content))
            continue

        # Other roles (e.g. unknown extensions) — pass through.
        out.append({"role": role, "content": content})

    return out


def _assistant_message_from_blocks(blocks: list[Any]) -> dict[str, Any]:
    """Anthropic assistant content blocks → one OpenAI assistant message.

    Text blocks are concatenated into ``message.content``; tool_use
    blocks become ``message.tool_calls``. If both are empty we emit
    ``content=""`` rather than ``None`` because OpenAI rejects
    ``content=null`` without ``tool_calls``.
    """

    text_parts: list[str] = []
    tool_calls: list[dict[str, Any]] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype == "text":
            text_parts.append(block.get("text", ""))
        elif btype == "tool_use":
            tool_calls.append(
                {
                    "id": block.get("id", ""),
                    "type": "function",
                    "function": {
                        "name": block.get("name", ""),
                        "arguments": json.dumps(block.get("input", {})),
                    },
                }
            )

    if text_parts and tool_calls:
        return {
            "role": "assistant",
            "content": "".join(text_parts),
            "tool_calls": tool_calls,
        }
    if tool_calls:
        return {"role": "assistant", "content": None, "tool_calls": tool_calls}
    if text_parts:
        return {"role": "assistant", "content": "".join(text_parts)}
    # Defensive: empty assistant turn. OpenAI rejects content=null
    # without tool_calls, so emit an empty string + a WARNING.
    _logger.warning("litellm_empty_assistant_message", note="no text or tool_use blocks")
    return {"role": "assistant", "content": ""}


def _user_messages_from_blocks(blocks: list[Any]) -> list[dict[str, Any]]:
    """Anthropic user content blocks → one or more OpenAI messages.

    Walks the blocks once preserving order: text becomes a
    ``role:"user"`` message (concatenated with adjacent text), each
    ``tool_result`` becomes its own ``role:"tool"`` message.
    Interleaved ``[text-A, tool_result, text-B]`` → ``[user(text-A),
    tool, user(text-B)]`` so the OpenAI contract holds.
    """

    out: list[dict[str, Any]] = []
    text_buffer: list[str] = []

    def _flush_text() -> None:
        if text_buffer:
            out.append({"role": "user", "content": "".join(text_buffer)})
            text_buffer.clear()

    for block in blocks:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype == "text":
            text_buffer.append(block.get("text", ""))
            continue
        if btype == "tool_result":
            _flush_text()
            inner = block.get("content", "")
            if isinstance(inner, list):
                # Anthropic supports list-content for richer tool_result
                # payloads (e.g. text + image). Flatten the text portions.
                inner = "".join(
                    b.get("text", "") if isinstance(b, dict) and b.get("type") == "text" else ""
                    for b in inner
                )
            elif not isinstance(inner, str):
                inner = str(inner)
            if block.get("is_error"):
                inner = f"ERROR: {inner}"
            out.append(
                {
                    "role": "tool",
                    "tool_call_id": block.get("tool_use_id", ""),
                    "content": inner,
                }
            )

    _flush_text()
    return out


def _from_litellm_response(response: Any, *, model: str) -> LLMResult:
    """LiteLLM ``ModelResponse`` → internal ``LLMResult``.

    Reconstructs the Anthropic-shaped ``content`` block list from the
    OpenAI-shaped ``message.content`` (string) + ``message.tool_calls``
    (list). Maps ``finish_reason`` back to ``stop_reason``.

    Defensive against three real-world response shapes:

      * Empty ``choices`` (some providers return this on content-filter
        blocks; Azure does this for safety-violation responses).
      * Both ``content`` and ``tool_calls`` null/empty (model returned
        nothing — silent dead end).
      * Cache-token attrs accessed via the public ``prompt_tokens_details``
        path FIRST, with the ``_cache_*_input_tokens`` private attrs as
        fallback. The Pydantic ``PrivateAttr`` declaration in litellm's
        ``Usage`` is the public-shape contract; relying on the
        underscore name is fragile across versions (caught by QA review).

    Cost is computed by ``compute_cost_usd`` from ``_shared`` (single
    authoritative source for both backends — talks to LiteLLM's
    pricing JSON regardless of which backend produced the response).
    """

    choices = getattr(response, "choices", None) or []
    if not choices:
        _logger.warning("litellm_response_empty_choices", model=model)
        return LLMResult(
            model=model,
            content=[],
            stop_reason="end_turn",
            usage={"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0},
            estimated_usd=0.0,
        )

    choice = choices[0]
    message = choice.message

    content_blocks: list[dict[str, Any]] = []
    if getattr(message, "content", None):
        content_blocks.append({"type": "text", "text": message.content})
    for tc in getattr(message, "tool_calls", None) or []:
        try:
            args = json.loads(tc.function.arguments)
        except (json.JSONDecodeError, AttributeError, TypeError):
            args = {}
        content_blocks.append(
            {
                "type": "tool_use",
                "id": tc.id,
                "name": tc.function.name,
                "input": args,
            }
        )

    finish = getattr(choice, "finish_reason", None)
    stop_reason: str | None = (
        _OPENAI_TO_ANTHROPIC_FINISH.get(finish, finish) if finish else None
    )
    if not content_blocks:
        _logger.warning(
            "litellm_response_empty_content",
            model=model,
            finish_reason=finish,
            note="model returned neither text nor tool calls",
        )

    usage = getattr(response, "usage", None)
    usage_dict = _usage_to_normalized_dict(usage)
    return LLMResult(
        model=model,
        content=content_blocks,
        stop_reason=stop_reason,
        usage=usage_dict,
        estimated_usd=compute_cost_usd(model, usage_dict),
    )


def _usage_to_normalized_dict(usage: Any) -> dict[str, int]:
    """LiteLLM Usage → four-key normalized dict.

    Reads cache-token counts from the **public** ``prompt_tokens_details``
    fields first (``cached_tokens`` and ``cache_creation_tokens``),
    falling back to the underscore-prefixed private attrs. The public
    path is the documented contract; the private attrs work today via
    Pydantic's ``SafeAttributeModel`` passthrough but could vanish on a
    LiteLLM upgrade. Caught by QA review C1 on issue #193.

    # The ``input`` field needs surgery

    OpenAI's ``prompt_tokens`` includes cached + creation token counts;
    Anthropic's ``input_tokens`` is the **non-cached** portion only.
    Internal callers + ``compute_cost_usd`` expect the Anthropic
    convention (non-cached input + cache_read + cache_creation are
    additive, no double-count). LiteLLM surfaces both shapes — we
    normalize by subtracting the cache portions out of prompt_tokens.

    Without this, a warm-cache call reports input=3693 + cache_read=3690
    instead of input=3 + cache_read=3690, and ``compute_cost_usd``
    charges full input pricing on tokens that should have cost 10%
    (cache read rate). Caught by side-by-side comparison run vs. the
    Anthropic-direct path post-Phase-3.
    """

    if usage is None:
        return {"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0}

    details = getattr(usage, "prompt_tokens_details", None)
    # Truthy-or chains skip a legitimate 0 ("no cache hit on this call"),
    # so prefer the first attribute that is *present* (not None) over the
    # first that is non-zero. ``getattr(..., None)`` returns None when
    # absent; an explicit 0 stops the fallback chain correctly.
    def _first_present(*candidates: int | None) -> int:
        for value in candidates:
            if value is not None:
                return int(value)
        return 0

    cache_read = _first_present(
        getattr(details, "cached_tokens", None),
        getattr(usage, "cache_read_input_tokens", None),
        getattr(usage, "_cache_read_input_tokens", None),
    )
    cache_creation = _first_present(
        getattr(details, "cache_creation_tokens", None),
        getattr(usage, "cache_creation_input_tokens", None),
        getattr(usage, "_cache_creation_input_tokens", None),
    )
    prompt_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
    # Subtract cache reads + writes to recover the Anthropic-shape
    # ``input_tokens`` (non-cached portion). Clamp at zero in case of
    # provider rounding / overlap quirks.
    base_input = max(0, prompt_tokens - cache_read - cache_creation)
    return {
        "input": base_input,
        "output": int(getattr(usage, "completion_tokens", 0) or 0),
        "cache_read": cache_read,
        "cache_creation": cache_creation,
    }


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class LiteLLMChatClient(ChatClient):
    """LiteLLM-backed ``ChatClient``. acomplete lands in Phase 2; astream in Phase 3."""

    def __init__(self, *, settings: Settings) -> None:
        super().__init__()
        # Re-harden in case a third party imported ``litellm`` after our
        # module load and re-populated a callback list (e.g. an extension
        # that calls ``litellm.success_callback.append("langfuse")``).
        # Idempotent.
        harden_litellm_globals()

        self._settings = settings
        self._closed = False
        self._warned_insecure_base_url = False

    async def aclose(self) -> None:
        # LiteLLM holds no per-instance resources we own; per-call httpx
        # clients live inside the library. Idempotent.
        self._closed = True

    def model_for(self, tier: ModelTier) -> str:
        # Internal callers see bare names; the wire model id is built in
        # ``_resolve_wire_model`` below.
        return self._settings.model_for(tier)

    def _resolve_wire_model(self, tier: ModelTier) -> str:
        """Build the LiteLLM model id for the wire call.

        Three cases:

          1. **Bare ``claude-…`` name.** Auto-prefix with ``anthropic/``.
             The vast majority of deployments hit Anthropic; this is the
             happy path.
          2. **Provider-qualified id (contains ``/``).** Validate the
             prefix against ``_KNOWN_PROVIDER_PREFIXES`` so a typo like
             ``anthropic-direct/...`` (or worse, ``evil/path``) fails
             loud at first call. Operators adding a new provider must
             land it in the allowlist *and* document it in
            ``docs/llm_providers.md`` — same PR.
          3. **Unknown bare name** (e.g. ``my-finetuned-model``). Refuse
             to guess — raise a ``RuntimeError`` directing the operator
             to set the fully-qualified id explicitly. Avoids silently
             routing to the wrong provider.
        """

        bare = self._settings.model_for(tier)
        if "/" in bare:
            prefix = bare.split("/", 1)[0]
            if prefix not in _KNOWN_PROVIDER_PREFIXES:
                raise RuntimeError(
                    f"unrecognized provider prefix {prefix!r} in model id {bare!r} "
                    f"for tier {tier}. Allowlist: {sorted(_KNOWN_PROVIDER_PREFIXES)}. "
                    "Add the prefix to _KNOWN_PROVIDER_PREFIXES and document the "
                    "deployment recipe in docs/llm_providers.md before using it."
                )
            return bare
        if bare.startswith("claude-"):
            return f"anthropic/{bare}"
        raise RuntimeError(
            f"LLM_BACKEND=litellm requires a provider-qualified model id "
            f"(e.g. 'bedrock/...', 'openai/...', 'vertex_ai/...'); got bare "
            f"{bare!r} for tier {tier}. Set LLM_MODEL_{tier.upper()} "
            "to the fully-qualified form."
        )

    def _maybe_warn_insecure_base_url(self) -> None:
        """One-shot warning when ``LLM_API_BASE`` looks unsafe.

        Two checks:

          1. Plain ``http://`` to a non-loopback host — prompts and
             participant chat egress in cleartext. Mirrors the same
             warning in ``app.llm.client._messages``.
          2. Any scheme to a link-local address (``169.254.0.0/16`` or
             IPv6 ``fe80::/10``) — almost certainly a metadata-service
             SSRF target, no legitimate operator points at IMDS for
             LLM traffic. Warn even on https. (Sec L4 on issue #193.)

        Once-per-instance cardinality — busy sessions would otherwise
        spam the log.
        """

        if self._warned_insecure_base_url:
            return
        url = self._settings.llm_api_base
        if not url:
            return
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
        loopback = (
            host in {"localhost", "127.0.0.1", "::1", "0.0.0.0"}
            or host.startswith("127.")
        )
        link_local = host.startswith("169.254.") or host.startswith("fe80:")

        if link_local:
            _logger.warning(
                "litellm_base_url_link_local",
                base_url=url,
                hint=(
                    "Link-local target — almost certainly a metadata-service "
                    "SSRF address. Refusing to silently exfiltrate prompts."
                ),
            )
        elif parsed.scheme == "http" and not loopback:
            _logger.warning(
                "litellm_base_url_insecure",
                base_url=url,
                hint=(
                    "Plain http:// to a non-loopback host: prompts + "
                    "participant chat will egress in cleartext. Use "
                    "https:// or a loopback proxy."
                ),
            )
        self._warned_insecure_base_url = True

    def _build_call_kwargs(
        self,
        *,
        tier: ModelTier,
        system_blocks: list[dict[str, Any]],
        messages: list[dict[str, Any]],
        stream: bool = False,
        tools: list[dict[str, Any]] | None,
        max_tokens: int,
        tool_choice: dict[str, Any] | None,
        extension_tool_names: frozenset[str] | None,
    ) -> tuple[dict[str, Any], str]:
        """Assemble the kwargs for ``litellm.acompletion``.

        Per-call kwargs are built explicitly here — never pass through
        caller-supplied ``**kwargs``. ``litellm.acompletion(success_callback=[…])``
        is read at request time and would re-arm the disabled telemetry
        registries (security review C2 on issue #193).
        """

        wire_model = self._resolve_wire_model(tier)
        validate_tool_choice(tool_choice)

        # Engine-side tool gate. Drop anything not in the tier's
        # ``allowed_tool_names`` (plus extension tools for play). Pre-fix
        # a misbehaving caller could pass ``SETUP_TOOLS`` to a play call
        # and the model would have access to ``ask_setup_question``
        # mid-exercise.
        from ...sessions.phase_policy import filter_allowed_tools

        kept_tools, dropped_tool_names = (
            filter_allowed_tools(tier, tools or [], extension_tool_names=extension_tool_names)
            if tools
            else ([], [])
        )
        if dropped_tool_names:
            _logger.warning(
                "phase_policy_dropped_tools",
                tier=tier,
                dropped=dropped_tool_names,
            )

        # Drop tool_choice if every tool was filtered out — Anthropic
        # rejects ``tool_choice`` without ``tools`` with HTTP 400. Same
        # bug surface we hardened against in app.llm.client.
        reconciled_tool_choice = reconcile_tool_choice(
            kept_tools, tool_choice, logger=_logger, tier=tier
        )

        # Apply Anthropic cache_control breakpoints to system blocks +
        # the last message before translation. The OpenAI-shape
        # ``messages[0].content`` carries the marked system blocks
        # verbatim; LiteLLM's Anthropic transformer hoists them back to
        # the ``system=`` kwarg with cache_control intact. Without this,
        # the LiteLLM backend would silently miss caching in production
        # (validated by side-by-side comparison post-Phase-3).
        cached_system = with_system_cache(system_blocks, logger=_logger)
        cached_messages = with_message_cache(messages, logger=_logger)

        kwargs: dict[str, Any] = {
            "model": wire_model,
            "messages": _to_openai_messages(cached_system, cached_messages),
            "max_tokens": max_tokens,
        }
        if stream:
            kwargs["stream"] = True
        if self._settings.llm_api_base:
            kwargs["api_base"] = self._settings.llm_api_base
        # ``LLM_API_KEY`` is provider-agnostic in name only — its *value*
        # is whatever credential the operator put in. Forwarding it to
        # every provider would mean an Anthropic key shipped to OpenAI
        # on the very first ``LLM_BACKEND=litellm LLM_MODEL_PLAY=openai/...``
        # deploy, which is both a footgun and a credential exfiltration
        # risk (key now logged in OpenAI's auth-failure response). So:
        # only forward ``LLM_API_KEY`` to wire models in the
        # ``anthropic/*`` family. For every other provider, omit the
        # ``api_key`` kwarg and let LiteLLM auto-discover the
        # provider-native env var (``OPENAI_API_KEY``,
        # ``OPENROUTER_API_KEY``, ``AWS_*``, ``GOOGLE_APPLICATION_CREDENTIALS``,
        # …) — same env vars the LiteLLM docs use, no Crittable-specific
        # convention layered on top.
        wire_provider = wire_model.split("/", 1)[0] if "/" in wire_model else None
        if wire_provider == "anthropic":
            api_key = self._settings.require_llm_api_key()
            if api_key:
                kwargs["api_key"] = api_key
        elif self._settings.llm_api_key is not None:
            # Operator has ``LLM_API_KEY`` set but is targeting a
            # non-Anthropic provider — surface this so a misconfigured
            # cutover (operator forgot to switch from Anthropic key to
            # OpenAI key) is observable in the audit log instead of a
            # mysterious 401 from the wrong provider.
            _logger.debug(
                "litellm_api_key_not_forwarded",
                tier=tier,
                wire_provider=wire_provider,
                note=(
                    "LLM_API_KEY is set but the wire model targets a "
                    "non-Anthropic provider — deferring to LiteLLM's "
                    "auto-discovery of the provider-native env var "
                    "(OPENAI_API_KEY / AWS_* / GOOGLE_APPLICATION_CREDENTIALS / etc.)"
                ),
            )
        kwargs["num_retries"] = self._settings.llm_max_retries
        kwargs["timeout"] = self._settings.timeout_for(tier)

        openai_tools = _to_openai_tools(kept_tools)
        if openai_tools:
            kwargs["tools"] = openai_tools
        openai_tool_choice = _to_openai_tool_choice(reconciled_tool_choice)
        if openai_tool_choice is not None:
            kwargs["tool_choice"] = openai_tool_choice

        temperature = self._settings.temperature_for(tier)
        if temperature is not None:
            kwargs["temperature"] = temperature
        top_p = self._settings.top_p_for(tier)
        if top_p is not None:
            kwargs["top_p"] = top_p

        dropped_params = strip_deprecated_sampling_params(wire_model, kwargs)
        if dropped_params:
            _logger.info(
                "llm_call_params_stripped",
                tier=tier,
                model=wire_model,
                dropped=dropped_params,
            )

        # Defense-in-depth assertion: anything that lands in this dict
        # gets forwarded to ``litellm.acompletion``, which reads
        # ``callbacks`` / ``success_callback`` / etc. from kwargs at
        # request time and re-arms the disabled telemetry registries
        # (security review C2 on issue #193). Catching unexpected keys
        # here means the explicit-build discipline can't quietly drift.
        unexpected = set(kwargs) - _ALLOWED_LITELLM_KWARGS
        if unexpected:
            raise RuntimeError(
                f"unexpected kwargs leaking to litellm.acompletion: {sorted(unexpected)}. "
                "Add to _ALLOWED_LITELLM_KWARGS only after security review."
            )

        return kwargs, wire_model

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
        if max_tokens is None:
            max_tokens = self._settings.max_tokens_for(tier)
        self._maybe_warn_insecure_base_url()
        kwargs, wire_model = self._build_call_kwargs(
            tier=tier,
            system_blocks=system_blocks,
            messages=messages,
            tools=tools,
            max_tokens=max_tokens,
            tool_choice=tool_choice,
            extension_tool_names=extension_tool_names,
        )
        bare_model = self.model_for(tier)
        _logger.info(
            "llm_call_start",
            tier=tier,
            model=wire_model,
            stream=False,
            tools=len(tools or []),
            messages=len(messages),
            max_tokens=max_tokens,
            temperature=kwargs.get("temperature"),
            top_p=kwargs.get("top_p"),
            tool_choice=tool_choice.get("type") if tool_choice else None,
        )
        call = self._begin_call(
            session_id=session_id, tier=tier, model=wire_model, stream=False
        )
        started = time.monotonic()
        try:
            response = await litellm.acompletion(**kwargs)
        except Exception as exc:
            _logger.warning(
                "llm_call_failed",
                tier=tier,
                model=wire_model,
                duration_ms=int((time.monotonic() - started) * 1000),
                error=str(exc),
            )
            raise
        finally:
            self._end_call(session_id, call)

        result = _from_litellm_response(response, model=bare_model)
        _logger.info(
            "llm_call_complete",
            tier=tier,
            model=wire_model,
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
        """Streamed completion. Yields ``text_delta`` events as the
        model produces text + a terminal ``complete`` event with the
        final ``LLMResult``.

        # Streaming is a typing pulse, not a content channel

        Both frontends (``Play.tsx`` and ``Facilitator.tsx``)
        explicitly *ignore* the content of ``message_chunk`` events —
        they're used purely as a "model is still alive" signal that
        flips ``setStreamingActive(true)``. The actual text gets
        rendered from the snapshot refresh after ``message_complete``.
        That collapses the streaming translator from "the hard part"
        to "trivial":

          * Mid-stream we emit ``text_delta`` events for any text
            content in a delta. Fidelity doesn't matter; the frontend
            throws the content away.
          * Tool-call deltas are *ignored mid-stream*. Their partial
            JSON arguments accumulate inside LiteLLM via
            ``stream_chunk_builder`` which we call at the end. This
            sidesteps the known-fragile ``input_json_delta`` accumulation
            path entirely.
          * At stream end, the assembled ``ModelResponse`` runs through
            the same ``_from_litellm_response`` translator as
            ``acomplete``, so a streamed response and a non-streamed
            response produce identical ``LLMResult`` shapes downstream.

        # Concurrency

        ``try/finally`` (not ``try/except``) on the in-flight slot
        release — ``CancelledError`` is ``BaseException`` so a
        WS-disconnect-cancel mid-stream would otherwise leak the slot
        forever (the activity panel would show "AI play 999s" until
        process restart). Same pattern as the Anthropic-direct
        ``astream``.
        """

        if max_tokens is None:
            max_tokens = self._settings.max_tokens_for(tier)
        self._maybe_warn_insecure_base_url()
        kwargs, wire_model = self._build_call_kwargs(
            tier=tier,
            system_blocks=system_blocks,
            messages=messages,
            stream=True,
            tools=tools,
            max_tokens=max_tokens,
            tool_choice=tool_choice,
            extension_tool_names=extension_tool_names,
        )
        bare_model = self.model_for(tier)
        _logger.info(
            "llm_call_start",
            tier=tier,
            model=wire_model,
            stream=True,
            tools=len(tools or []),
            messages=len(messages),
            max_tokens=max_tokens,
            temperature=kwargs.get("temperature"),
            top_p=kwargs.get("top_p"),
            tool_choice=tool_choice.get("type") if tool_choice else None,
        )
        call = self._begin_call(
            session_id=session_id, tier=tier, model=wire_model, stream=True
        )
        started = time.monotonic()

        chunks: list[Any] = []
        text_buffer: list[str] = []
        chunk_warn_logged = False
        # Best-effort ``tool_use_start`` emission. OpenAI-shaped streams
        # surface the function name in the first chunk that introduces a
        # given ``tool_calls[i]`` index (subsequent chunks carry only
        # incremental ``arguments`` deltas). We dedupe by ``(index, id)``
        # — NOT by tool name — so a model that calls the same tool twice
        # in one stream emits two ``tool_use_start`` events, matching
        # the Anthropic-direct path (which fires once per
        # ``content_block_start``). Any provider that doesn't emit the
        # name in chunk-form simply produces no event — callers treat
        # the absence as "no early signal," not "no tool call," and the
        # final assembled response still carries the tool_use.
        # Wrapped in try/except per chunk so a misshapen delta never
        # breaks the stream itself.
        seen_tool_calls: set[tuple[int | None, str | None]] = set()
        try:
            try:
                stream = await litellm.acompletion(**kwargs)
                async for chunk in stream:
                    chunks.append(chunk)
                    if (
                        not chunk_warn_logged
                        and len(chunks) > _CHUNK_WARN_THRESHOLD
                    ):
                        _logger.warning(
                            "llm_stream_chunk_overflow",
                            tier=tier,
                            model=wire_model,
                            chunks=len(chunks),
                            threshold=_CHUNK_WARN_THRESHOLD,
                            note=(
                                "stream emitted unusually many chunks; check "
                                "for a provider stuck in keep-alive without "
                                "emitting a final-chunk marker"
                            ),
                        )
                        chunk_warn_logged = True
                    try:
                        for choice in getattr(chunk, "choices", None) or []:
                            delta = getattr(choice, "delta", None)
                            tool_calls = (
                                getattr(delta, "tool_calls", None)
                                if delta is not None
                                else None
                            )
                            for tc in tool_calls or []:
                                fn = getattr(tc, "function", None)
                                name = (
                                    getattr(fn, "name", None)
                                    if fn is not None
                                    else None
                                )
                                if not name:
                                    continue
                                # Per-call identity: ``index`` is the
                                # OpenAI-shaped per-stream tool-call slot
                                # (``0``, ``1``, ...); ``id`` is the
                                # provider-issued call id. Either alone
                                # is enough to distinguish two calls of
                                # the same tool; we key on the tuple so
                                # providers that emit only one of them
                                # still dedupe correctly within a stream.
                                tc_index = getattr(tc, "index", None)
                                tc_id = getattr(tc, "id", None)
                                key = (tc_index, tc_id)
                                if key in seen_tool_calls:
                                    continue
                                seen_tool_calls.add(key)
                                yield {"type": "tool_use_start", "name": name}
                    except Exception as exc:
                        _logger.debug(
                            "litellm_tool_use_start_detect_failed",
                            tier=tier,
                            model=wire_model,
                            error=str(exc),
                        )
                    delta_text = _delta_content(chunk)
                    if delta_text:
                        text_buffer.append(delta_text)
                        yield {"type": "text_delta", "text": delta_text}
            except Exception as exc:
                _logger.warning(
                    "llm_call_failed",
                    tier=tier,
                    model=wire_model,
                    duration_ms=int((time.monotonic() - started) * 1000),
                    stream=True,
                    error=str(exc),
                )
                raise
        finally:
            self._end_call(session_id, call)

        # Reconstruct the final response from the chunks. ``messages``
        # kwarg is forwarded to ``stream_chunk_builder`` so it can pick
        # the right Choice subtype — see litellm/main.py:7375.
        final = litellm.stream_chunk_builder(chunks, messages=kwargs["messages"])
        if final is None:
            # Empty / pathological stream — emit a complete event so
            # the caller's ``async for`` loop terminates rather than
            # hanging, but with ``stop_reason=None`` to signal the
            # absent termination explicitly. Truncation-detection
            # downstream keys on ``"max_tokens"`` so ``None`` is a
            # safe sentinel; metrics paths that rely on a recognized
            # stop_reason will skip this turn.
            _logger.warning(
                "llm_stream_empty",
                tier=tier,
                model=wire_model,
                chunks=len(chunks),
                note="stream_chunk_builder returned None — provider emitted no usable chunks",
            )
            empty_result = LLMResult(
                model=bare_model,
                content=[],
                stop_reason=None,
                usage={"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0},
                estimated_usd=0.0,
            )
            yield {"type": "complete", "result": empty_result, "text": ""}
            return

        result = _from_litellm_response(final, model=bare_model)
        _logger.info(
            "llm_call_complete",
            tier=tier,
            model=wire_model,
            stream=True,
            duration_ms=int((time.monotonic() - started) * 1000),
            usage=result.usage,
            estimated_usd=round(result.estimated_usd, 6),
            stop_reason=result.stop_reason,
            tool_uses=sum(1 for b in result.content if b.get("type") == "tool_use"),
            text_chars=sum(len(c) for c in text_buffer),
        )
        yield {"type": "complete", "result": result, "text": "".join(text_buffer)}


def _delta_content(chunk: Any) -> str | None:
    """Pull text content from a streamed chunk, if any.

    LiteLLM normalizes streaming to OpenAI's ``ChatCompletionChunk``
    shape regardless of upstream provider; ``chunk.choices[0].delta.content``
    holds incremental text. Tool-call deltas live in
    ``delta.tool_calls`` and we deliberately ignore them mid-stream
    (see ``astream`` docstring).

    Defensive against three real chunk shapes: missing ``choices``
    attr, empty ``choices`` list, and ``choices == None`` (some Bedrock
    proxies emit this on keep-alive pings).
    """

    try:
        choice = chunk.choices[0]
    except (AttributeError, IndexError, TypeError):
        return None
    delta = getattr(choice, "delta", None)
    if delta is None:
        return None
    content = getattr(delta, "content", None)
    return content if isinstance(content, str) and content else None


# Soft tripwire on chunk accumulation. A pathological provider that
# never emits a final-chunk marker would let ``chunks`` grow without
# bound. 5000 is comfortably above any real-world play turn (typical:
# 50–200 chunks; 4-minute worst case ~12k); when we cross this the log
# is the signal an operator can act on before the process OOMs.
_CHUNK_WARN_THRESHOLD = 5000


__all__ = ["LiteLLMChatClient"]
