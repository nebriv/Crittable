"""Unit tests for the LiteLLM wire-format translators (Phase 2 of #193).

These exercise the four helpers in ``app.llm.clients.litellm_client``
that adapt internal Anthropic-shaped data to LiteLLM/OpenAI-shaped wire
data and back. No live API calls — pure transformation tests so a
regression in the translator catches at unit-test speed instead of
during a Phase-7 live run that costs money.

Coverage map:

  * ``_to_openai_tools``        — Anthropic ``input_schema`` → OpenAI
                                   ``parameters``, with ``type:"function"``
                                   wrapper.
  * ``_to_openai_tool_choice``  — every ``{"type": ...}`` shape →
                                   OpenAI string / dict equivalent.
                                   Phase 0 PoC validated the wire
                                   behavior; this test locks the
                                   translation step in code.
  * ``_to_openai_messages``     — system block hoisting, tool_use →
                                   ``tool_calls`` split, tool_result →
                                   separate ``role:"tool"`` message,
                                   ``is_error`` → ``"ERROR: …"`` prefix.
  * ``_from_litellm_response``  — LiteLLM ``ModelResponse`` →
                                   Anthropic-shaped ``LLMResult``,
                                   including ``finish_reason`` →
                                   ``stop_reason`` mapping and the
                                   four-key normalized usage dict.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from app.llm.clients.litellm_client import (
    _from_litellm_response,
    _to_openai_messages,
    _to_openai_tool_choice,
    _to_openai_tools,
)

# ---------------------------------------------------------------------------
# _to_openai_tools
# ---------------------------------------------------------------------------


def test_to_openai_tools_wraps_in_function_envelope() -> None:
    tools = [
        {
            "name": "broadcast",
            "description": "Send a message to all roles.",
            "input_schema": {
                "type": "object",
                "properties": {"message": {"type": "string"}},
                "required": ["message"],
            },
        }
    ]
    result = _to_openai_tools(tools)
    assert result == [
        {
            "type": "function",
            "function": {
                "name": "broadcast",
                "description": "Send a message to all roles.",
                "parameters": {
                    "type": "object",
                    "properties": {"message": {"type": "string"}},
                    "required": ["message"],
                },
            },
        }
    ]


def test_to_openai_tools_returns_none_for_empty() -> None:
    """Empty tool list → None (some providers fault on []). Same for None input."""

    assert _to_openai_tools(None) is None
    assert _to_openai_tools([]) is None


def test_to_openai_tools_preserves_complex_schema() -> None:
    """Real production schemas have nested arrays + required fields. The
    translator must not flatten them or drop ``items`` (which broke the
    AAR generator pre-#90)."""

    tools = [
        {
            "name": "propose_scenario_plan",
            "description": "...",
            "input_schema": {
                "type": "object",
                "properties": {
                    "narrative_arc": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "beat": {"type": "integer"},
                                "label": {"type": "string"},
                            },
                            "required": ["beat", "label"],
                        },
                    }
                },
                "required": ["narrative_arc"],
            },
        }
    ]
    result = _to_openai_tools(tools)
    assert result is not None
    schema = result[0]["function"]["parameters"]
    assert schema["properties"]["narrative_arc"]["items"]["required"] == ["beat", "label"]


# ---------------------------------------------------------------------------
# _to_openai_tool_choice
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "internal, openai",
    [
        (None, None),
        ({"type": "auto"}, "auto"),
        ({"type": "any"}, "required"),
        ({"type": "none"}, "none"),
        (
            {"type": "tool", "name": "finalize_report"},
            {"type": "function", "function": {"name": "finalize_report"}},
        ),
    ],
)
def test_to_openai_tool_choice(internal: Any, openai: Any) -> None:
    assert _to_openai_tool_choice(internal) == openai


def test_to_openai_tool_choice_rejects_tool_without_name() -> None:
    with pytest.raises(ValueError, match="requires 'name'"):
        _to_openai_tool_choice({"type": "tool"})


def test_to_openai_tool_choice_rejects_unknown_type() -> None:
    with pytest.raises(ValueError, match="unknown tool_choice"):
        _to_openai_tool_choice({"type": "what"})


# ---------------------------------------------------------------------------
# _to_openai_messages
# ---------------------------------------------------------------------------


def test_messages_string_content_passes_through() -> None:
    msgs = _to_openai_messages([], [{"role": "user", "content": "hello"}])
    assert msgs == [{"role": "user", "content": "hello"}]


def test_messages_system_block_becomes_first_message() -> None:
    """System blocks (list of content blocks with ``cache_control``) are
    hoisted to the first ``role:"system"`` message. The blocks are
    preserved verbatim so cache_control round-trips to Anthropic.
    """

    system = [
        {
            "type": "text",
            "text": "You are Claude.",
            "cache_control": {"type": "ephemeral"},
        },
        {"type": "text", "text": "Volatile context."},
    ]
    msgs = _to_openai_messages(system, [{"role": "user", "content": "ok"}])
    assert msgs[0]["role"] == "system"
    assert msgs[0]["content"] == system
    assert msgs[1] == {"role": "user", "content": "ok"}


def test_messages_assistant_tool_use_becomes_tool_calls() -> None:
    """Anthropic encodes assistant tool calls as ``content: [{"type":"tool_use", ...}]``.
    OpenAI uses a separate ``tool_calls`` field on the assistant message,
    with ``arguments`` as a JSON string.
    """

    msgs = _to_openai_messages(
        [],
        [
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "Let me check."},
                    {
                        "type": "tool_use",
                        "id": "tu_001",
                        "name": "broadcast",
                        "input": {"message": "Hello team"},
                    },
                ],
            }
        ],
    )
    assert msgs[0]["role"] == "assistant"
    assert msgs[0]["content"] == "Let me check."
    assert msgs[0]["tool_calls"] == [
        {
            "id": "tu_001",
            "type": "function",
            "function": {
                "name": "broadcast",
                "arguments": json.dumps({"message": "Hello team"}),
            },
        }
    ]


def test_messages_tool_result_becomes_separate_tool_message() -> None:
    """Anthropic tool results live inside a ``role:"user"`` message as
    ``content: [{"type":"tool_result", "tool_use_id":..., "content":...}]``.
    OpenAI uses a separate ``role:"tool"`` message with ``tool_call_id``.
    """

    msgs = _to_openai_messages(
        [],
        [
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "tu_001",
                        "content": "broadcasted.",
                    }
                ],
            }
        ],
    )
    assert msgs == [
        {"role": "tool", "tool_call_id": "tu_001", "content": "broadcasted."}
    ]


def test_messages_is_error_prefixes_content_with_error_marker() -> None:
    """``is_error: True`` on a ``tool_result`` is encoded as an
    ``"ERROR: …"`` prefix on the content string. Verified in PoC T2 to
    round-trip the strict-retry self-correction behavior.
    """

    msgs = _to_openai_messages(
        [],
        [
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "tu_001",
                        "content": "missing required field 'role_id'",
                        "is_error": True,
                    }
                ],
            }
        ],
    )
    assert msgs[0]["content"] == "ERROR: missing required field 'role_id'"


def test_messages_tool_result_list_content_flattens_text_blocks() -> None:
    """Anthropic supports tool_result content as ``[{"type":"text", "text":...}]``
    for richer payloads. We flatten the text portions for OpenAI.
    """

    msgs = _to_openai_messages(
        [],
        [
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "tu_001",
                        "content": [
                            {"type": "text", "text": "part 1. "},
                            {"type": "text", "text": "part 2."},
                        ],
                    }
                ],
            }
        ],
    )
    assert msgs[0]["content"] == "part 1. part 2."


def test_messages_user_with_tool_results_and_text() -> None:
    """A user message may carry tool results AND new text. The tool
    results come out as ``role:"tool"`` messages; the text becomes a
    follow-on ``role:"user"`` message in the original order.
    """

    msgs = _to_openai_messages(
        [],
        [
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "tu_001",
                        "content": "ok",
                    },
                    {"type": "text", "text": "now what?"},
                ],
            }
        ],
    )
    assert msgs == [
        {"role": "tool", "tool_call_id": "tu_001", "content": "ok"},
        {"role": "user", "content": "now what?"},
    ]


def test_messages_unknown_content_shape_logs_and_passes_empty() -> None:
    """Defensive: unexpected content shape doesn't 400 the request.
    Empty string content + WARNING log so a regression is observable.
    """

    msgs = _to_openai_messages([], [{"role": "user", "content": 42}])
    assert msgs == [{"role": "user", "content": ""}]


# ---------------------------------------------------------------------------
# _from_litellm_response
# ---------------------------------------------------------------------------


class _StubFunction:
    """Plain object — MagicMock's ``name`` collides with its mock-name kwarg."""

    def __init__(self, *, name: str, arguments: str) -> None:
        self.name = name
        self.arguments = arguments


class _StubToolCall:
    def __init__(self, *, tool_id: str, name: str, arguments: str) -> None:
        self.id = tool_id
        self.function = _StubFunction(name=name, arguments=arguments)


class _StubMessage:
    def __init__(
        self, *, content: str | None, tool_calls: list[_StubToolCall] | None
    ) -> None:
        self.content = content
        self.tool_calls = tool_calls


class _StubChoice:
    def __init__(self, *, message: _StubMessage, finish_reason: str) -> None:
        self.message = message
        self.finish_reason = finish_reason


class _StubUsage:
    """Mirrors litellm Usage attrs we read. ``prompt_tokens_details``
    is intentionally None so the cache-read fallback path stays inert
    when the tests pass explicit cache token counts.

    LiteLLM's ``prompt_tokens`` includes cache_read + cache_creation
    (OpenAI convention). The test helper accepts a ``base_input``
    (Anthropic-shape, non-cached) and computes the right total so the
    translator's ``input = prompt_tokens - cache_read - cache_creation``
    math recovers the original ``base_input``.
    """

    def __init__(
        self,
        *,
        prompt_tokens: int,
        completion_tokens: int,
        cache_creation: int,
        cache_read: int,
    ) -> None:
        # Caller-supplied ``prompt_tokens`` is the OpenAI-shape total
        # (already includes cache reads + writes). Don't add to it.
        self.prompt_tokens = prompt_tokens
        self.completion_tokens = completion_tokens
        self.cache_creation_input_tokens = cache_creation
        self.cache_read_input_tokens = cache_read
        self.prompt_tokens_details = None


class _StubResponse:
    def __init__(self, *, choices: list[_StubChoice], usage: _StubUsage) -> None:
        self.choices = choices
        self.usage = usage


def _make_response(
    *,
    content: str | None,
    tool_calls: list[dict[str, Any]] | None,
    finish_reason: str,
    prompt_tokens: int = 100,
    completion_tokens: int = 50,
    cache_creation: int = 0,
    cache_read: int = 0,
) -> _StubResponse:
    """Build a stub shaped like ``litellm.ModelResponse``."""

    stub_calls = (
        [
            _StubToolCall(
                tool_id=tc["id"], name=tc["name"], arguments=tc["arguments"]
            )
            for tc in tool_calls
        ]
        if tool_calls
        else None
    )
    return _StubResponse(
        choices=[
            _StubChoice(
                message=_StubMessage(content=content, tool_calls=stub_calls),
                finish_reason=finish_reason,
            )
        ],
        usage=_StubUsage(
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            cache_creation=cache_creation,
            cache_read=cache_read,
        ),
    )


def test_from_response_text_only() -> None:
    response = _make_response(
        content="Hello there.",
        tool_calls=None,
        finish_reason="stop",
    )
    result = _from_litellm_response(response, model="claude-haiku-4-5")
    assert result.content == [{"type": "text", "text": "Hello there."}]
    assert result.stop_reason == "end_turn"
    assert result.usage == {"input": 100, "output": 50, "cache_read": 0, "cache_creation": 0}


def test_from_response_tool_call() -> None:
    response = _make_response(
        content=None,
        tool_calls=[
            {
                "id": "tu_001",
                "name": "broadcast",
                "arguments": json.dumps({"message": "Hello team"}),
            }
        ],
        finish_reason="tool_calls",
    )
    result = _from_litellm_response(response, model="claude-haiku-4-5")
    assert result.content == [
        {
            "type": "tool_use",
            "id": "tu_001",
            "name": "broadcast",
            "input": {"message": "Hello team"},
        }
    ]
    assert result.stop_reason == "tool_use"


def test_from_response_text_and_tool_call() -> None:
    """Anthropic emits text + tool_use blocks in the same response.
    OpenAI puts text in ``message.content`` and tools in ``tool_calls``.
    Translator reconstructs both, text first.
    """

    response = _make_response(
        content="Let me look that up.",
        tool_calls=[
            {
                "id": "tu_001",
                "name": "get_weather",
                "arguments": json.dumps({"city": "Paris"}),
            }
        ],
        finish_reason="tool_calls",
    )
    result = _from_litellm_response(response, model="claude-haiku-4-5")
    assert result.content[0] == {"type": "text", "text": "Let me look that up."}
    assert result.content[1]["type"] == "tool_use"
    assert result.content[1]["input"] == {"city": "Paris"}


def test_from_response_max_tokens_maps_to_max_tokens_stop_reason() -> None:
    """OpenAI's ``finish_reason: length`` maps to Anthropic's ``stop_reason: max_tokens``.
    The truncation-detection path in ``turn_driver._check_truncation``
    keys on ``"max_tokens"``, so this mapping is load-bearing.
    """

    response = _make_response(
        content="the quick brown fox",
        tool_calls=None,
        finish_reason="length",
    )
    result = _from_litellm_response(response, model="claude-haiku-4-5")
    assert result.stop_reason == "max_tokens"


def test_from_response_cache_tokens_round_trip() -> None:
    """The four-key usage dict is what ``compute_cost_usd`` reads.

    LiteLLM's ``prompt_tokens`` convention includes cache reads + cache
    creation tokens; Anthropic's ``input_tokens`` is the non-cached
    portion only. The translator subtracts the cache portions out so
    downstream cost calculation doesn't double-count. Caught by the
    side-by-side comparison post-Phase-3 where warm-cache calls were
    being charged ~10x too much.

    Here ``prompt_tokens=3500`` represents the OpenAI total, with
    ``cache_creation=3483`` of those being cache writes — leaving 17
    non-cached input tokens.
    """

    response = _make_response(
        content="ok",
        tool_calls=None,
        finish_reason="stop",
        prompt_tokens=3500,
        completion_tokens=10,
        cache_creation=3483,
        cache_read=0,
    )
    result = _from_litellm_response(response, model="claude-sonnet-4-6")
    assert result.usage == {
        "input": 17,
        "output": 10,
        "cache_read": 0,
        "cache_creation": 3483,
    }
    # estimated_usd should be > 0 on a known model.
    assert result.estimated_usd > 0


def test_from_response_warm_cache_subtracts_cache_read_from_input() -> None:
    """Warm-cache scenario: prompt_tokens includes cache_read tokens.
    Without the subtract, we'd charge full input pricing on tokens that
    only cost 10% (cache read rate). This test locks the fix.
    """

    response = _make_response(
        content="ok",
        tool_calls=None,
        finish_reason="stop",
        prompt_tokens=3693,
        completion_tokens=4,
        cache_creation=0,
        cache_read=3690,
    )
    result = _from_litellm_response(response, model="claude-sonnet-4-6")
    assert result.usage["input"] == 3, (
        "warm-cache call: prompt_tokens=3693 should split into "
        "input=3 (non-cached) + cache_read=3690"
    )
    assert result.usage["cache_read"] == 3690


def test_from_response_input_clamped_at_zero() -> None:
    """If for some reason prompt_tokens < cache_read + cache_creation
    (provider rounding quirk), input clamps at 0 rather than going
    negative.
    """

    response = _make_response(
        content="ok",
        tool_calls=None,
        finish_reason="stop",
        prompt_tokens=10,
        completion_tokens=4,
        cache_creation=20,
        cache_read=0,
    )
    result = _from_litellm_response(response, model="claude-sonnet-4-6")
    assert result.usage["input"] == 0


def test_from_response_invalid_json_args_falls_back_to_empty_dict() -> None:
    """If LiteLLM emits malformed tool-call arguments JSON we fall back
    to ``{}`` rather than raising — the strict-retry path will catch
    an empty input and ask the model to re-emit.
    """

    response = _make_response(
        content=None,
        tool_calls=[{"id": "tu_001", "name": "broadcast", "arguments": "not json"}],
        finish_reason="tool_calls",
    )
    result = _from_litellm_response(response, model="claude-haiku-4-5")
    assert result.content[0]["input"] == {}


def test_from_response_empty_choices_returns_safe_zero_result() -> None:
    """Some providers (Azure content-filter blocks) return ``choices=[]``.
    Reading ``response.choices[0]`` would IndexError. The defensive guard
    returns a safe zero-cost LLMResult so the caller can decide what to
    do, rather than crashing the turn driver mid-loop.
    """

    class _EmptyChoicesResp:
        choices: list[Any] = []  # noqa: RUF012  (one-shot test stub)
        usage = None

    result = _from_litellm_response(_EmptyChoicesResp(), model="claude-haiku-4-5")
    assert result.content == []
    assert result.stop_reason == "end_turn"
    assert result.usage == {"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0}
    assert result.estimated_usd == 0.0


def test_from_response_no_content_no_tool_calls() -> None:
    """Model returned literally nothing — content blocks list is empty,
    but the result is still a valid ``LLMResult`` with a stop_reason.
    Logged at WARNING for observability.
    """

    response = _make_response(content=None, tool_calls=None, finish_reason="stop")
    result = _from_litellm_response(response, model="claude-haiku-4-5")
    assert result.content == []
    assert result.stop_reason == "end_turn"


def test_from_response_cache_via_prompt_tokens_details() -> None:
    """The public path for cache-token counts is
    ``usage.prompt_tokens_details.cached_tokens`` /
    ``cache_creation_tokens``. Some LiteLLM versions only populate that
    path (not the underscore-prefixed private attrs). The translator
    must read the public path first.
    """

    class _Details:
        cached_tokens = 1234
        cache_creation_tokens = 567

    class _UsagePublic:
        prompt_tokens = 2000
        completion_tokens = 50
        prompt_tokens_details = _Details()
        # Direct attrs deliberately absent — only the public path is set.

    response_obj = _StubResponse(
        choices=[
            _StubChoice(
                message=_StubMessage(content="ok", tool_calls=None),
                finish_reason="stop",
            )
        ],
        usage=_UsagePublic(),  # type: ignore[arg-type]
    )
    result = _from_litellm_response(response_obj, model="claude-haiku-4-5")
    assert result.usage["cache_read"] == 1234
    assert result.usage["cache_creation"] == 567


# ---------------------------------------------------------------------------
# Order preservation in _to_openai_messages
# ---------------------------------------------------------------------------


def test_messages_text_tool_result_text_preserves_order() -> None:
    """Interleaved ``[text, tool_result, text]`` must round-trip as
    ``[user(text), tool, user(text)]`` in source order so the OpenAI
    contract holds (tool messages immediately after the assistant turn
    that issued the tool_calls).
    """

    msgs = _to_openai_messages(
        [],
        [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "before"},
                    {
                        "type": "tool_result",
                        "tool_use_id": "tu_001",
                        "content": "result",
                    },
                    {"type": "text", "text": "after"},
                ],
            }
        ],
    )
    assert msgs == [
        {"role": "user", "content": "before"},
        {"role": "tool", "tool_call_id": "tu_001", "content": "result"},
        {"role": "user", "content": "after"},
    ]


def test_messages_assistant_empty_blocks_emits_empty_string() -> None:
    """Defensive: assistant content with no text and no tool_use blocks
    becomes ``content=""`` rather than ``content=None``. OpenAI rejects
    null content without tool_calls.
    """

    msgs = _to_openai_messages(
        [], [{"role": "assistant", "content": [{"type": "unknown"}]}]
    )
    assert msgs == [{"role": "assistant", "content": ""}]


def test_messages_assistant_multiple_tool_calls_produces_list() -> None:
    """Parallel tool calls in one assistant turn — Anthropic emits multiple
    ``tool_use`` content blocks, OpenAI expects them as a single
    ``tool_calls`` list on one assistant message. Each call keeps its
    own id so the model + dispatcher can match results to invocations.
    """

    msgs = _to_openai_messages(
        [],
        [
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "Calling two tools."},
                    {
                        "type": "tool_use",
                        "id": "tu_001",
                        "name": "broadcast",
                        "input": {"message": "team"},
                    },
                    {
                        "type": "tool_use",
                        "id": "tu_002",
                        "name": "set_active_roles",
                        "input": {"role_groups": [["r1"]]},
                    },
                ],
            }
        ],
    )
    assert msgs[0]["role"] == "assistant"
    assert msgs[0]["content"] == "Calling two tools."
    tool_calls = msgs[0]["tool_calls"]
    assert len(tool_calls) == 2
    assert tool_calls[0]["id"] == "tu_001"
    assert tool_calls[0]["function"]["name"] == "broadcast"
    assert tool_calls[1]["id"] == "tu_002"
    assert tool_calls[1]["function"]["name"] == "set_active_roles"


def test_messages_user_multiple_tool_results_preserves_order() -> None:
    """Sequential ``tool_result`` blocks in one user message — the
    OpenAI contract requires each as its own ``role:"tool"`` message,
    in the order they were produced. The dispatcher emits results in
    invocation order, so order preservation is what guarantees the
    model can match them to the right call.
    """

    msgs = _to_openai_messages(
        [],
        [
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": "tu_001", "content": "first"},
                    {"type": "tool_result", "tool_use_id": "tu_002", "content": "second"},
                ],
            }
        ],
    )
    assert msgs == [
        {"role": "tool", "tool_call_id": "tu_001", "content": "first"},
        {"role": "tool", "tool_call_id": "tu_002", "content": "second"},
    ]


def test_round_trip_anthropic_tool_call_scenario() -> None:
    """Property-style: a complete Anthropic-shaped exchange round-trips
    through ``_to_openai_messages`` (forward) and ``_from_litellm_response``
    (reverse) without losing structural information.

    Locks the seam: anything ``dispatch.py`` / ``turn_driver.py`` saw
    on the Anthropic-direct path keeps the same shape under LiteLLM.
    """

    import json as _json

    # Forward: build OpenAI-shape from Anthropic-shape.
    openai_msgs = _to_openai_messages(
        [{"type": "text", "text": "You are Claude.", "cache_control": {"type": "ephemeral"}}],
        [
            {"role": "user", "content": "Look up the weather."},
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "On it."},
                    {
                        "type": "tool_use",
                        "id": "tu_w",
                        "name": "get_weather",
                        "input": {"city": "Paris", "country": "FR"},
                    },
                ],
            },
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": "tu_w", "content": "Sunny, 22C"},
                ],
            },
        ],
    )

    # System block (with cache_control) must survive verbatim — LiteLLM's
    # Anthropic transformer hoists it back to ``system=`` with the
    # breakpoint intact.
    assert openai_msgs[0]["role"] == "system"
    assert openai_msgs[0]["content"][0]["cache_control"] == {"type": "ephemeral"}

    # Tool call args were JSON-stringified; round-trip them.
    assistant_msg = next(m for m in openai_msgs if m["role"] == "assistant")
    args_str = assistant_msg["tool_calls"][0]["function"]["arguments"]
    assert _json.loads(args_str) == {"city": "Paris", "country": "FR"}

    # Tool result became its own ``role:"tool"`` message with the
    # original tool_use_id intact.
    tool_msg = next(m for m in openai_msgs if m["role"] == "tool")
    assert tool_msg["tool_call_id"] == "tu_w"
    assert tool_msg["content"] == "Sunny, 22C"

    # Reverse: LiteLLM response → Anthropic-shape ``LLMResult``.
    response = _make_response(
        content=None,
        tool_calls=[
            {"id": "tu_x", "name": "get_weather", "arguments": _json.dumps({"city": "Tokyo"})}
        ],
        finish_reason="tool_calls",
    )
    result = _from_litellm_response(response, model="claude-haiku-4-5")
    tool_use = result.content[0]
    assert tool_use["type"] == "tool_use"
    assert tool_use["id"] == "tu_x"
    assert tool_use["name"] == "get_weather"
    # JSON args round-trip back to dict (matches Anthropic SDK shape).
    assert tool_use["input"] == {"city": "Tokyo"}
    # stop_reason normalized back to Anthropic vocabulary.
    assert result.stop_reason == "tool_use"


def test_from_response_usage_none_returns_zero_dict() -> None:
    """Defensive: response with ``usage=None`` (provider-specific edge
    case, e.g. some Bedrock failure modes) yields a zero usage dict
    so ``compute_cost_usd`` doesn't crash on missing fields.
    """

    response = _StubResponse(
        choices=[_StubChoice(message=_StubMessage(content="ok", tool_calls=None), finish_reason="stop")],
        usage=None,  # type: ignore[arg-type]
    )
    result = _from_litellm_response(response, model="claude-haiku-4-5")
    assert result.usage == {"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0}
    assert result.estimated_usd == 0.0


def test_messages_assistant_tool_use_only_keeps_null_content() -> None:
    """Assistant message that's purely a tool call emits ``content=None``
    (correct OpenAI shape — null content + tool_calls list is valid).
    """

    msgs = _to_openai_messages(
        [],
        [
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "id": "tu_001",
                        "name": "broadcast",
                        "input": {"message": "hi"},
                    }
                ],
            }
        ],
    )
    assert msgs[0]["role"] == "assistant"
    assert msgs[0]["content"] is None
    assert len(msgs[0]["tool_calls"]) == 1


# ---------------------------------------------------------------------------
# _delta_content — streaming chunk text extraction (Phase 3)
# ---------------------------------------------------------------------------


class _StubDelta:
    def __init__(self, content: str | None = None) -> None:
        self.content = content


class _StubStreamChoice:
    def __init__(self, delta: _StubDelta) -> None:
        self.delta = delta


class _StubChunk:
    def __init__(self, *, content: str | None = None, choices: list[Any] | None = None) -> None:
        self.choices = (
            choices if choices is not None else [_StubStreamChoice(_StubDelta(content))]
        )


def test_delta_content_returns_text() -> None:
    """Normal chunk with text delta → returns the text string."""

    from app.llm.clients.litellm_client import _delta_content

    assert _delta_content(_StubChunk(content="hello ")) == "hello "


def test_delta_content_returns_none_for_empty() -> None:
    """Empty content / None / non-string → None (filtered before yielding)."""

    from app.llm.clients.litellm_client import _delta_content

    assert _delta_content(_StubChunk(content=None)) is None
    assert _delta_content(_StubChunk(content="")) is None


def test_delta_content_handles_missing_choices() -> None:
    """Defensive: chunk with empty choices list (some providers do this
    on the very first or last chunk) → None, doesn't crash.
    """

    from app.llm.clients.litellm_client import _delta_content

    assert _delta_content(_StubChunk(choices=[])) is None


def test_delta_content_handles_no_delta_attr() -> None:
    """Tool-call-only chunks have ``delta.content == None``; we ignore them."""

    from app.llm.clients.litellm_client import _delta_content

    class _NoDelta:
        choices = [type("X", (), {"delta": None})()]  # noqa: RUF012  (test stub)

    assert _delta_content(_NoDelta()) is None


def test_delta_content_handles_choices_is_none() -> None:
    """Some Bedrock proxies emit ``chunk.choices = None`` on keep-alive
    pings. Subscripting ``None`` raises ``TypeError``; our defensive
    catch covers it. Verified by Phase 3 review M1.
    """

    from app.llm.clients.litellm_client import _delta_content

    class _ChoicesNone:
        choices = None

    assert _delta_content(_ChoicesNone()) is None


def test_messages_non_serializable_tool_input_raises() -> None:
    """``json.dumps`` on a non-serializable input must propagate, not
    silently fall back to ``{}``. Otherwise the model would see a
    stripped replay of its own tool call and the strict-retry path
    breaks. Locks the contract per security review L5 on issue #193.
    """

    import datetime

    with pytest.raises(TypeError):
        _to_openai_messages(
            [],
            [
                {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "tu_001",
                            "name": "log_at",
                            "input": {"when": datetime.datetime.now()},
                        }
                    ],
                }
            ],
        )
