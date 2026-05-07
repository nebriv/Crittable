"""Helpers shared by every ``ChatClient`` implementation.

Internal-only — name starts with ``_`` to mark it as a package-internal
module. Stateless helpers that don't care which provider they run
against: tool_choice validation, deprecated-sampling-param stripping,
cache-breakpoint placement, and ``compute_cost_usd`` (single
authoritative cost source for both backends — talks to LiteLLM's
pricing JSON instead of the now-deleted local table).

# litellm import + hardening lives here

Both ``ChatClient`` implementations import from this module, so any
path that boots a backend ends up with litellm hardened
(callback registries zeroed, telemetry off). The Anthropic-direct
backend now also reads its cost from LiteLLM's pricing table, so
``import litellm`` happens via this module on the Anthropic-only
path too.

``LITELLM_MODE=PRODUCTION`` is set *before* ``import litellm`` to
skip the library's import-time ``dotenv.load_dotenv()`` (which would
silently load a contributor's ``.env`` and re-arm the very third-party
telemetry we wipe in ``_harden_litellm_globals``).
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any

os.environ.setdefault("LITELLM_MODE", "PRODUCTION")

import litellm

from ..logging_setup import get_logger

_logger = get_logger("llm._shared")


# Every callback list LiteLLM reads from at completion time. Names and
# count come from auditing ``litellm/__init__.py`` — keep in sync with
# upstream. The presence check + raise ensures a LiteLLM upgrade that
# adds a new list breaks loudly here, not silently in production where
# the new list might surface a leak path.
_LITELLM_CALLBACK_REGISTRIES: tuple[str, ...] = (
    "input_callback",
    "success_callback",
    "failure_callback",
    "service_callback",
    "audit_log_callbacks",
    "callbacks",
    # ``_async_*`` lists are populated lazily from the sync lists at
    # first call. We zero them too so any pre-existing async-side
    # registration is also cleared.
    "_async_input_callback",
    "_async_success_callback",
    "_async_failure_callback",
)


def harden_litellm_globals() -> None:
    """Wipe every callback registry LiteLLM reads, plus phone-home telemetry.

    Idempotent. Called once at module load (so any path that imports
    ``_shared`` gets a hardened litellm) and again from
    ``LiteLLMChatClient.__init__`` (defense against a third party
    that imported and re-populated a callback list between our module
    load and client construction).

    Raises ``RuntimeError`` if a registry the security review identified
    has disappeared from the library — that means LiteLLM's API changed
    and the audit needs to be redone before we can trust this module.
    """

    for name in _LITELLM_CALLBACK_REGISTRIES:
        if not hasattr(litellm, name):
            raise RuntimeError(
                f"litellm API drift: expected callback registry {name!r} not found. "
                "Re-run the Phase-1 security audit (see issue #193) before allowing "
                "the LiteLLM backend to handle traffic."
            )
        registry = getattr(litellm, name)
        try:
            registry.clear()
        except AttributeError:
            setattr(litellm, name, [])

    litellm.telemetry = False
    litellm.suppress_debug_info = True


harden_litellm_globals()

# Allowlist of acceptable ``tool_choice`` shapes at the internal API
# boundary. Validates the kwarg before either backend forwards it. If a
# future caller (e.g. a less-trusted extension dispatch path) tries to
# pass an arbitrary forced-tool, this rejects loudly.
#
# Currently used:
#   - ``{"type": "any"}`` — strict-retry path forcing some tool call.
#   - ``{"type": "tool", "name": ...}`` — AAR forcing ``finalize_report``.
#   - ``{"type": "auto"}`` / ``{"type": "none"}`` — explicit defaults.
_VALID_TOOL_CHOICE_TYPES = frozenset({"auto", "any", "none", "tool"})


def validate_tool_choice(tool_choice: dict[str, Any] | None) -> None:
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


# Model id prefixes that reject the ``temperature`` parameter at the API
# boundary (HTTP 400 ``temperature is deprecated for this model``).
# Anthropic's Opus 4.x family deprecates the param; sending it produces
# the failure mode that broke AAR generation in production. Both Anthropic-
# direct and LiteLLM-routed paths hit the same Opus models, so the
# stripping logic must run for both.
_MODELS_REJECTING_TEMPERATURE: tuple[str, ...] = (
    "claude-opus-4-",
)
# Same shape, kept separate because top_p deprecation may diverge from
# temperature on future models. Currently empty — Opus 4.x accepts
# top_p — but the plumbing is here so a regression is a one-tuple
# update away from being fixed.
_MODELS_REJECTING_TOP_P: tuple[str, ...] = ()


def strip_deprecated_sampling_params(
    model: str, kwargs: dict[str, Any]
) -> list[str]:
    """Drop sampling params the target model rejects.

    Returns the list of dropped param names so the caller can audit-log
    the strip. Mutates ``kwargs`` in place. Called immediately before
    the SDK / LiteLLM call so the strip applies regardless of which
    code path assembled the kwargs.

    Strips by **bare model name prefix**, so ``claude-opus-4-7`` and
    ``anthropic/claude-opus-4-7`` both match — the LiteLLM client
    passes the prefixed form, and stripping the prefix here keeps the
    function shape provider-agnostic.
    """

    bare = model.split("/", 1)[1] if "/" in model else model
    dropped: list[str] = []
    if "temperature" in kwargs and any(
        bare.startswith(p) for p in _MODELS_REJECTING_TEMPERATURE
    ):
        dropped.append("temperature")
        kwargs.pop("temperature", None)
    if "top_p" in kwargs and any(
        bare.startswith(p) for p in _MODELS_REJECTING_TOP_P
    ):
        dropped.append("top_p")
        kwargs.pop("top_p", None)
    return dropped


def reconcile_tool_choice(
    kept_tools: list[dict[str, Any]] | None,
    tool_choice: dict[str, Any] | None,
    *,
    logger: Any | None = None,
    tier: str | None = None,
) -> dict[str, Any] | None:
    """Drop ``tool_choice`` if every tool got filtered out.

    Anthropic (and the OpenAI-compatible spec) rejects requests that
    carry ``tool_choice`` without any ``tools`` — HTTP 400
    ``tool_choice may only be specified while providing tools``.
    The phase-policy filter can strip every tool the caller passed
    (e.g. a ``setup_tools`` set sent through a ``play`` tier path),
    leaving us in exactly that state.

    Returns the reconciled ``tool_choice`` (possibly ``None``). Logs a
    WARNING on the drop so the regression is observable per CLAUDE.md
    "Logging rules" (a silently dropped ``tool_choice`` could otherwise
    hide a phase-policy regression that's eating the strict-retry path).
    """

    if tool_choice is None:
        return None
    if kept_tools:
        return tool_choice
    if logger is not None:
        logger.warning(
            "tool_choice_dropped_no_tools",
            tier=tier,
            original_type=tool_choice.get("type"),
            note=(
                "tool_choice was set but every tool got filtered out by "
                "phase_policy — dropping tool_choice to avoid HTTP 400"
            ),
        )
    return None


def with_system_cache(
    blocks: list[dict[str, Any]],
    *,
    logger: Any | None = None,
) -> list[dict[str, Any]]:
    """Place a cache breakpoint on the *first* system block.

    The convention across the prompt builders (``build_play_system_blocks``,
    ``build_setup_system_blocks``, ``build_aar_system_blocks``,
    ``build_guardrail_system_blocks``) is **stable content first**: the
    first block carries identity / mission / hard boundaries / tool
    protocol / frozen plan — content that does not change turn-to-turn
    within a session. Subsequent blocks (when present) carry volatile
    content (presence column, follow-ups, rate-limit notices).

    Putting ``cache_control`` on the first block tells Anthropic to
    cache the prefix [tools + first_block]. Volatile content in any
    later block sits *after* the breakpoint, gets re-processed cheaply
    each turn, and never invalidates the cached prefix. On a typical
    play turn this turns ~5-7k input tokens into cache_reads at ~10%
    of normal input price.

    Anthropic supports up to 4 cache breakpoints per request; this
    function uses 1. The other 3 are available — see
    ``with_message_cache`` below for the multi-turn message-history
    breakpoint.

    Both backends (Anthropic-direct + LiteLLM-routed) call this — the
    LiteLLM-direct provider transformer hoists the marked system
    blocks back into the Anthropic ``system=`` kwarg verbatim, so the
    breakpoint round-trips. Validated by side-by-side comparison in
    issue #193 Phase 0.

    Returns a NEW list — never aliases the caller's. If the first
    block is non-dict (a future bug or a misbehaving extension prompt
    builder), returns the input unchanged with a WARNING; reaching
    inside a non-Mapping with ``**`` would raise ``TypeError`` and the
    breakage would surface mid-turn instead of as a clean log line.
    """

    if not blocks:
        return list(blocks)
    out: list[dict[str, Any]] = [dict(b) if isinstance(b, dict) else b for b in blocks]
    first = out[0]
    if not isinstance(first, dict):
        if logger is not None:
            logger.warning(
                "system_cache_skipped",
                reason="non_dict_block",
                block_type=type(first).__name__,
            )
        return out
    out[0] = {**first, "cache_control": {"type": "ephemeral"}}
    return out


def with_message_cache(
    messages: list[dict[str, Any]],
    *,
    logger: Any | None = None,
) -> list[dict[str, Any]]:
    """Place a cache breakpoint on the last message in the conversation.

    For multi-turn play, the messages array grows as the conversation
    progresses but the *prefix* (everything before the latest content)
    is identical between turns. Placing a breakpoint on the last
    message of turn N means turn N+1 reads the entire prior
    conversation from cache instead of reprocessing it.

    The breakpoint goes on the last message regardless of role — this
    is the standard multi-turn pattern from Anthropic's docs.

    The content of the last message may already be a list of blocks
    (recovery path with tool_results). In that case we add
    ``cache_control`` to the last block. For string-content messages we
    convert to a single text block carrying the cache marker.

    Always returns a NEW list — never aliases the caller's list.
    On the empty-input or non-coercible-content paths the returned
    copy carries no cache marker (logged at WARNING when ``logger``
    is provided).
    """

    if not messages:
        return list(messages)
    out = [dict(m) for m in messages]
    last = dict(out[-1])
    content = last.get("content")
    if isinstance(content, str):
        last["content"] = [
            {
                "type": "text",
                "text": content,
                "cache_control": {"type": "ephemeral"},
            }
        ]
    elif isinstance(content, list) and content:
        new_content = [dict(b) if isinstance(b, dict) else b for b in content]
        for i in range(len(new_content) - 1, -1, -1):
            blk = new_content[i]
            if isinstance(blk, dict):
                blk["cache_control"] = {"type": "ephemeral"}
                break
        last["content"] = new_content
    else:
        if logger is not None:
            logger.warning(
                "message_cache_skipped",
                reason="non_coercible_content",
                content_type=type(content).__name__,
                role=last.get("role"),
            )
        return out
    out[-1] = last
    return out


def compute_cost_usd(
    model: str,
    usage: Mapping[str, int],
) -> float:
    """Cost in USD for a completion, sourced from LiteLLM's pricing JSON.

    Single authoritative cost calculator for the engine. Both
    ``ChatClient`` backends call this — the Anthropic-direct path used
    to consult a hand-maintained local pricing table that drifted out
    of date (Opus 4.7 was listed at $15/M input vs. the actual $5/M;
    Haiku was listed at $0.80/M vs. the actual $1.00/M). Switching
    every cost lookup to ``litellm.cost_per_token`` removes that
    drift surface — LiteLLM ships a community-maintained
    ``model_prices_and_context_window.json`` covering ~100 providers,
    refreshed on every release.

    Accepts a normalized usage dict shape (Anthropic-style) keyed by
    ``input``, ``output``, ``cache_read``, ``cache_creation``. Both
    backends already produce this shape — Anthropic-direct's
    ``input_tokens`` is the non-cache portion natively;
    LiteLLM-routed's ``_usage_to_normalized_dict`` derives it by
    subtracting cache reads + creation from OpenAI's all-inclusive
    ``prompt_tokens``.

    Returns 0.0 for unknown models (logged WARNING) so a missing
    pricing entry never raises into the call site. The downstream
    ``llm_call_complete`` log emits the cost; a 0.0 there alongside a
    ``compute_cost_usd_unknown_model`` warning is the operator's
    signal to file a bug or update LiteLLM.
    """

    try:
        prompt_cost, completion_cost = litellm.cost_per_token(
            model=model,
            prompt_tokens=int(usage.get("input", 0) or 0),
            completion_tokens=int(usage.get("output", 0) or 0),
            cache_creation_input_tokens=int(usage.get("cache_creation", 0) or 0),
            cache_read_input_tokens=int(usage.get("cache_read", 0) or 0),
        )
    except Exception as exc:
        _logger.warning(
            "compute_cost_usd_unknown_model",
            model=model,
            error=str(exc),
            note=(
                "litellm.cost_per_token raised — model not in LiteLLM's "
                "pricing JSON. Returning 0.0; cost will under-report until "
                "the model is added upstream or here."
            ),
        )
        return 0.0
    return float(prompt_cost) + float(completion_cost)


__all__ = [
    "compute_cost_usd",
    "harden_litellm_globals",
    "reconcile_tool_choice",
    "strip_deprecated_sampling_params",
    "validate_tool_choice",
    "with_message_cache",
    "with_system_cache",
]
