# Testing LLM-driven code

How to write tests for code that talks to the LLM client.

## TL;DR

Use `MockChatClient` from `tests.mock_chat_client`:

```python
from tests.mock_chat_client import (
    MockChatClient,
    install_mock_chat_client,
    llm_result,
    text_block,
    tool_block,
    setup_then_play_script,
)

@pytest.fixture
def client():
    app = create_app()
    with TestClient(app) as c:
        install_mock_chat_client(c)
        yield c


def test_my_feature(client):
    install_mock_chat_client(
        client,
        scripts={
            "play": [
                llm_result(
                    text_block("I'll broadcast now."),
                    tool_block("broadcast", {"message": "Hello team"}),
                    stop_reason="tool_use",
                ),
            ],
        },
    )
    # … exercise the app, then assert
```

`MockChatClient` is a sibling implementation of the `ChatClient` ABC.
It plugs in via `app.state.llm = mock` (handled by
`install_mock_chat_client`) so tests don't depend on the production
`LiteLLMChatClient` ever instantiating.

## Worked examples

### Plain text response

```python
mock = MockChatClient({
    "guardrail": [llm_result(text_block("on_topic"))]
})
client.app.state.llm = mock
# app calls guardrail.classify(); mock returns the scripted result
```

### Forced tool call

```python
mock = MockChatClient({
    "play": [
        llm_result(
            tool_block("broadcast", {"message": "Hi everyone."}),
            stop_reason="tool_use",
        ),
    ],
})
```

### Multi-turn with tool result feedback

The strict-retry path: model emits a tool, dispatcher replies with
`is_error=True`, model self-corrects on next call.

```python
mock = MockChatClient({
    "play": [
        # turn 1: model calls broadcast with bad arg
        llm_result(
            tool_block("broadcast", {"wrong_field": "x"}),
            stop_reason="tool_use",
        ),
        # turn 2 (after dispatcher rejection): model retries correctly
        llm_result(
            tool_block("broadcast", {"message": "Hello team"}),
            stop_reason="tool_use",
        ),
    ],
})
```

### End-to-end exercise via setup_then_play_script

For integration tests that drive a full session lifecycle, use the
canonical 3-tier helper:

```python
from tests.mock_chat_client import setup_then_play_script

scripts = setup_then_play_script(
    role_ids=["ciso_id", "ir_id"],
    extension_tool=None,           # or "lookup_threat_intel" etc.
    fire_critical=True,            # whether the script injects a critical event mid-play
)
install_mock_chat_client(client, scripts)
client.post(f"/api/sessions/{sid}/setup/skip?token={tok}")
client.post(f"/api/sessions/{sid}/start?token={tok}")
# … now drive turns from the test
```

The helper returns scripts for `setup`, `play`, and `aar` tiers in one
call.

### Inspecting what the model was asked

`MockChatClient.calls` returns a snapshot of every kwarg the test made
the mock receive — useful for asserting the engine sent the right tier,
tool_choice, max_tokens, etc.

```python
mock = MockChatClient({"play": [...]})
client.app.state.llm = mock
# … exercise something that triggers a play call
assert mock.calls[0]["tier"] == "play"
assert mock.calls[0]["tool_choice"] == {"type": "any"}
assert {t["name"] for t in mock.calls[0]["tools"]} == {"broadcast", "address_role"}
```

### Exhausted-script auto-end

When the script for a tier is empty, `MockChatClient` returns a benign
`end_session` tool_use so the play-tier driver advances to ENDED instead
of looping. Tests that drive a session through play without a full
script still terminate cleanly.

## Why `install_mock_chat_client` (not `app.state.llm = mock`)

`SessionManager`, `InputGuardrail`, and (lazily) `AARGenerator` each
capture a reference to the LLM client at construction time. Writing
just to `app.state.llm` doesn't update those captured references —
they keep pointing at whatever client the lifespan built, and the
tests silently call the real backend with a dummy API key (→ HTTP
401).

`install_mock_chat_client` updates **every** reference holder
atomically:

```python
def install_mock_chat_client(test_client, scripts=None):
    mock = MockChatClient(scripts=scripts)
    state = test_client.app.state
    state.llm = mock
    manager = getattr(state, "manager", None)
    if manager is not None:
        manager._llm = mock
        guardrail = getattr(manager, "_guardrail", None)
        if guardrail is not None:
            guardrail._llm = mock
    return mock
```

## Testing the LLM client itself

Unit tests for the wire-format translators (Anthropic ↔ OpenAI shape
conversions) live in `tests/test_litellm_translators.py`. They use
plain stub objects — see `_StubResponse` / `_StubMessage` /
`_StubUsage` for the pattern. Don't reach for `MockChatClient` there;
the goal is to test the translator in isolation, not at the ABC layer.

Integration tests for `LiteLLMChatClient` end-to-end behavior live in
`tests/test_llm_backend_seam.py` (factory selection, hardening,
in-flight tracking, cost-cap registration, etc.). These instantiate
the real client with `Settings()` and exercise behavior that doesn't
require a live API call.

Live API tests that hit the real provider live in `tests/live/`. They
use the production code path through `LiteLLMChatClient`.

```bash
backend/scripts/run-live-tests.sh                # full suite
backend/scripts/run-live-tests.sh -k test_aar    # pytest filter
```

## Common gotchas

### "My test is hitting the real Anthropic API with the dummy key"

You probably wrote `client.app.state.llm = MockChatClient(...)`
instead of `install_mock_chat_client(client, ...)`. The captured
references in the manager / guardrail still point at the lifespan-
built real client. See "Why `install_mock_chat_client`" above.

### "I'm assert-ing on `mock.messages.calls` and getting AttributeError"

`MockChatClient` doesn't have `.messages` — use `mock.calls`
directly. (The `.messages` indirection was an artifact of the legacy
`MockAnthropic` mock that targeted the Anthropic SDK transport
surface; that mock is gone as of #195.)

### "I need to mock streaming"

`MockChatClient.astream` synthesizes `text_delta` events from the
scripted result's text blocks, then yields a terminal `complete`
event with the same `LLMResult`. Same script shape as `acomplete` —
the test just consumes the events:

```python
async for event in client.app.state.llm.astream(
    tier="play", system_blocks=[], messages=[], ...
):
    if event["type"] == "text_delta":
        print(event["text"])
    elif event["type"] == "complete":
        result = event["result"]
```

For tool-only responses (no text), `astream` skips straight to the
`complete` event — see
`tests/test_mock_chat_client.py::test_astream_tool_call_response_emits_no_text_deltas`.

## Reference

- Mock implementation: [`backend/tests/mock_chat_client.py`](../backend/tests/mock_chat_client.py)
- Mock tests: [`backend/tests/test_mock_chat_client.py`](../backend/tests/test_mock_chat_client.py)
- Translator unit tests: [`backend/tests/test_litellm_translators.py`](../backend/tests/test_litellm_translators.py)
- ABC contract: [`backend/app/llm/protocol.py`](../backend/app/llm/protocol.py)
