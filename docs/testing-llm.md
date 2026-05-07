# Testing LLM-driven code

How to write tests for code that talks to the LLM client. Two mock
systems coexist transitionally; this page documents both, calls the
preferred path, and lays out the migration plan.

## TL;DR

For new tests, use `MockChatClient` from `tests.mock_chat_client`:

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
`install_mock_chat_client`) and works regardless of which backend
(`LLM_BACKEND=anthropic` or `litellm`) the lifespan would otherwise
have built.

The legacy `MockAnthropic` from `tests.mock_anthropic` (still used by
~18 existing test files) mocks the Anthropic SDK transport via
`LLMClient.set_transport(MockAnthropic(scripts).messages)`. It works
only with `LLM_BACKEND=anthropic`. Migration to `MockChatClient` is
mechanical and tracked in the follow-up cleanup issue.

## When to use which mock

| Situation | Use |
|---|---|
| Writing a new test (any kind) | `MockChatClient` |
| Touching an existing test that uses `MockAnthropic` and you have time to migrate | `MockChatClient` (migrate it; it's a few-line change per test, see the worked example below) |
| Touching a test that uses `MockAnthropic` and you DON'T have time to migrate | Leave `MockAnthropic` as-is (still works under default backend) |
| Testing the `ChatClient` ABC contract directly (e.g. lifecycle, in-flight tracking) | `MockChatClient` |
| Testing transport-level Anthropic SDK behavior | `MockAnthropic` (this category is going away when `LLMClient` is deleted) |

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
call. It mirrors the legacy `mock_anthropic.setup_then_play_script` for
parity during the transition.

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

The legacy `MockAnthropic` + `set_transport` pattern sidestepped this
problem because it modified the *internals* of a single `LLMClient`
instance shared by all reference holders. `MockChatClient` is a
sibling class — replacing it requires touching every holder.

## Migrating an existing test from MockAnthropic

The change is mechanical. Old:

```python
from tests.mock_anthropic import MockAnthropic, setup_then_play_script

mock = MockAnthropic(scripts)
client.app.state.llm.set_transport(mock.messages)
# …
assert mock.messages.calls[0]["tier"] == "play"
```

New:

```python
from tests.mock_chat_client import (
    MockChatClient,
    install_mock_chat_client,
    setup_then_play_script,
)

mock = install_mock_chat_client(client, scripts)
# …
assert mock.calls[0]["tier"] == "play"
```

Three substitutions:

1. `from tests.mock_anthropic import MockAnthropic` → `from tests.mock_chat_client import MockChatClient, install_mock_chat_client`
2. `client.app.state.llm.set_transport(MockAnthropic(scripts).messages)` → `install_mock_chat_client(client, scripts)`
3. `mock.messages.calls` → `mock.calls`

For tests that build `_Response`/`_ContentBlock` directly:

```python
# Old
from tests.mock_anthropic import _Response, _ContentBlock
interject = _Response(
    content=[_ContentBlock(type="tool_use", name="broadcast",
                           input={"message": "Hi"}, id="tu_b")],
    stop_reason="tool_use",
)
mock = MockAnthropic({"play": [interject]})

# New
from tests.mock_chat_client import (
    MockChatClient, install_mock_chat_client, llm_result, tool_block,
)
interject = llm_result(
    tool_block("broadcast", {"message": "Hi"}, block_id="tu_b"),
    stop_reason="tool_use",
)
mock = install_mock_chat_client(client, {"play": [interject]})
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
the real client with `Settings(LLM_BACKEND="litellm")` and exercise
behavior that doesn't require a live API call.

Live API tests that hit the real provider live in `tests/live/`. They
use the production code path through whichever backend `LLM_BACKEND`
selects — when in doubt, run them under both backends:

```bash
LLM_API_KEY=$LIVE_TEST_LLM_API_KEY pytest tests/live/  # default backend
LLM_API_KEY=$LIVE_TEST_LLM_API_KEY LLM_BACKEND=litellm pytest tests/live/
```

Both pass against the same Anthropic API in their respective shapes —
the LiteLLM migration itself was validated end-to-end this way (issue
#193); only mechanical legacy-path cleanup remains in #195.

## Common gotchas

### "My test is hitting the real Anthropic API with the dummy key"

You probably wrote `client.app.state.llm = MockChatClient(...)`
instead of `install_mock_chat_client(client, ...)`. The captured
references in the manager / guardrail still point at the lifespan-
built real client. See "Why `install_mock_chat_client`" above.

### "My test doesn't pass with `LLM_BACKEND=litellm`"

If it uses `MockAnthropic.set_transport`, that's expected — the
legacy mock targets the Anthropic-direct path only. Migrate to
`MockChatClient` (see the worked example above) or skip the test
under the LiteLLM backend.

### "I'm assert-ing on `mock.messages.calls` and getting AttributeError"

`MockChatClient` doesn't have `.messages` — use `mock.calls`
directly. The `messages` indirection was an artifact of mocking the
`AsyncAnthropic.messages` SDK surface; at the ABC layer, the mock
client itself records the calls.

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
- Migration tracking: GitHub issue #195
