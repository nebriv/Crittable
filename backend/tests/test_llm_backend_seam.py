"""ABC-seam regression tests for the LiteLLM-routed chat client.

Locks in the contracts the multi-provider migration established:

  * The factory in ``app.main`` always returns a ``LiteLLMChatClient``.
  * ``LiteLLMChatClient`` is a real ``ChatClient`` subclass.
  * ``litellm`` is hardened on import: the nine callback registries
    listed in the security audit are empty, ``LITELLM_MODE`` is set to
    ``"PRODUCTION"``, and ``telemetry`` is off. Any one of these
    regressing risks scenario data exfiltrating to a third-party SaaS
    that just happens to have its API key in a contributor's ``.env``.
  * ``_normalize_model_name`` is correct against the real strings
    LiteLLM returns from each provider — caught H4 in QA review.
  * ``install_litellm_cost_tracking`` registers + tears down cleanly,
    in-place, without leaking state between fixture scopes.
  * The cost handler is an ``isinstance(_, CustomLogger)``-passing
    object so LiteLLM's dispatcher actually invokes it (the QA C1
    finding that flipped the cap from "would silently fail" to
    "actually fires").
"""

from __future__ import annotations

import os
from typing import Any
from unittest.mock import MagicMock

import pytest

from app.config import Settings, get_settings

# -- Factory ---------------------------------------------------------------


def test_factory_resolves_litellm_backend() -> None:
    from app.llm.clients.litellm_client import LiteLLMChatClient
    from app.main import _build_chat_client

    settings = Settings(LLM_API_KEY="dummy")
    client = _build_chat_client(settings)
    assert isinstance(client, LiteLLMChatClient)


# -- LiteLLMChatClient skeleton -------------------------------------------


def test_litellm_client_is_chat_client_subclass() -> None:
    from app.llm.clients.litellm_client import LiteLLMChatClient
    from app.llm.protocol import ChatClient

    assert issubclass(LiteLLMChatClient, ChatClient)


# test_litellm_astream_raises_not_implemented removed in Phase 3 —
# astream is now implemented. End-to-end stream behavior is exercised
# by the live smoke test in /tmp/litellm-poc/phase3_smoke.py.


@pytest.mark.asyncio
async def test_astream_releases_in_flight_slot_on_cancel() -> None:
    """The ``try/finally`` on ``_end_call`` must release the in-flight
    slot when the consumer cancels mid-stream (e.g. WS disconnect
    during a play turn). Without this, the activity panel shows
    "AI play 999s" forever. Locks the contract per Phase 3 review L4.
    """

    import asyncio
    from unittest.mock import AsyncMock, patch

    from app.llm.clients.litellm_client import LiteLLMChatClient

    client = LiteLLMChatClient(settings=Settings(LLM_API_KEY="dummy"))

    # Build a mock stream that hangs on the second chunk so the consumer
    # can cancel it mid-flight.
    chunks_emitted = 0

    async def _hanging_stream() -> Any:
        nonlocal chunks_emitted

        class _Chunk:
            choices = [type("C", (), {"delta": type("D", (), {"content": "x"})()})()]  # noqa: RUF012

        async def _gen():
            nonlocal chunks_emitted
            yield _Chunk()
            chunks_emitted += 1
            # Hang forever so the consumer cancels.
            await asyncio.Future()

        return _gen()

    with patch(
        "app.llm.clients.litellm_client.litellm.acompletion",
        new=AsyncMock(side_effect=_hanging_stream),
    ):
        async def _consume() -> None:
            async for _ in client.astream(
                tier="play",
                system_blocks=[{"type": "text", "text": "x"}],
                messages=[{"role": "user", "content": "go"}],
                max_tokens=100,
                session_id="test-session",
            ):
                pass

        task = asyncio.create_task(_consume())
        # Let the stream emit one chunk + start hanging.
        await asyncio.sleep(0.05)
        task.cancel()
        # Drain the cancellation
        try:
            await task
        except (asyncio.CancelledError, BaseException):
            pass

        # The in-flight slot for "test-session" must be empty even
        # though the stream was cancelled mid-flight.
        assert client.in_flight_for("test-session") == [], (
            "WS-disconnect cancel did not release the in-flight slot — "
            "activity panel would show stuck call forever"
        )


# -- LiteLLM hardening at import ------------------------------------------


def test_litellm_mode_set_to_production() -> None:
    """Importing the litellm client must set LITELLM_MODE=PRODUCTION
    *before* litellm itself loads, so litellm's import-time
    ``dotenv.load_dotenv()`` is skipped (it would otherwise pull a
    contributor's ``.env`` into ``os.environ``).
    """

    # Touch the module to ensure it has been imported in this process.
    import app.llm.clients.litellm_client  # noqa: F401

    assert os.environ.get("LITELLM_MODE") == "PRODUCTION"


def test_litellm_callback_registries_are_empty() -> None:
    """Every callback list LiteLLM reads at completion time must be
    cleared after the litellm client is imported. A non-empty list
    risks scenario data + participant chat exfiltrating to whatever
    SaaS callback was registered (LangSmith, Langfuse, Helicone, etc.).
    """

    import litellm

    import app.llm.clients.litellm_client  # noqa: F401

    for name in (
        "input_callback",
        "success_callback",
        "failure_callback",
        "service_callback",
        "audit_log_callbacks",
        "callbacks",
        "_async_input_callback",
        "_async_success_callback",
        "_async_failure_callback",
    ):
        assert hasattr(litellm, name), f"litellm.{name} missing — re-audit"
        assert list(getattr(litellm, name)) == [], (
            f"litellm.{name} is non-empty after import — telemetry leak risk"
        )


def test_litellm_telemetry_off() -> None:
    import litellm

    import app.llm.clients.litellm_client  # noqa: F401

    assert litellm.telemetry is False


# -- _normalize_model_name -------------------------------------------------


@pytest.mark.parametrize(
    "raw, expected",
    [
        # Anthropic-direct, dated id (the common case)
        ("claude-haiku-4-5-20251001", "claude-haiku-4-5"),
        ("claude-sonnet-4-6-20240620", "claude-sonnet-4-6"),
        ("claude-opus-4-7-20251101", "claude-opus-4-7"),
        # Anthropic-direct, bare name
        ("claude-haiku-4-5", "claude-haiku-4-5"),
        # LiteLLM ``anthropic/`` provider prefix
        ("anthropic/claude-haiku-4-5-20251001", "claude-haiku-4-5"),
        # Empty
        ("", ""),
        # Bedrock-style (provider prefix stripped to first '/'; date-suffix
        # pattern doesn't match the ``-v1:0`` suffix so the result stays
        # un-mappable, which is the correct fallback signal — see
        # _normalize_model_name docstring.)
        (
            "bedrock/anthropic.claude-3-5-sonnet-20240620-v1:0",
            "anthropic.claude-3-5-sonnet-20240620-v1:0",
        ),
    ],
)
def test_normalize_model_name(raw: str, expected: str) -> None:
    from tests.live.cost_cap import _normalize_model_name

    assert _normalize_model_name(raw) == expected


# -- install_litellm_cost_tracking ----------------------------------------


def test_install_litellm_cost_tracking_registers_and_tears_down() -> None:
    import litellm

    from tests.live.cost_cap import install_litellm_cost_tracking

    callbacks_before = list(litellm.callbacks)
    teardown = install_litellm_cost_tracking()
    try:
        assert len(litellm.callbacks) == len(callbacks_before) + 1
        # Handler is in-place inserted at index 0, not via list rebinding.
        from litellm.integrations.custom_logger import CustomLogger

        assert isinstance(litellm.callbacks[0], CustomLogger), (
            "handler must be a CustomLogger subclass; LiteLLM ignores other types"
        )
    finally:
        teardown()
    assert list(litellm.callbacks) == callbacks_before


def test_install_litellm_cost_tracking_teardown_is_idempotent() -> None:
    import litellm

    from tests.live.cost_cap import install_litellm_cost_tracking

    teardown = install_litellm_cost_tracking()
    teardown()
    teardown()  # Second call must not raise even if handler already removed.
    # And the registry should still be empty (or at least not contain duplicates).
    assert litellm.callbacks.count(litellm.callbacks[0]) <= 1 if litellm.callbacks else True


# -- Cost handler integration --------------------------------------------


def test_cost_handler_records_via_response_cost(monkeypatch: pytest.MonkeyPatch) -> None:
    """When LiteLLM populates ``kwargs['response_cost']``, the handler
    uses it directly instead of falling back to ``compute_cost_usd``.
    Important for non-Anthropic providers whose model ids LiteLLM's
    pricing JSON doesn't know — ``response_cost`` is the per-call
    authoritative number LiteLLM computes from the live response.
    """

    from tests.live.cost_cap import (
        _build_litellm_cost_handler,
        get_tracker,
        reset_tracker_for_tests,
    )

    monkeypatch.setenv("LIVE_TEST_COST_CAP_USD", "10.00")
    reset_tracker_for_tests()
    handler = _build_litellm_cost_handler()

    response = MagicMock()
    response.usage = MagicMock()
    response.usage.input_tokens = 100
    response.usage.output_tokens = 50
    response.usage.cache_read_input_tokens = 0
    response.usage.cache_creation_input_tokens = 0
    response.model = "bedrock/anthropic.claude-3-5-sonnet-20240620-v1:0"

    handler.log_success_event(
        kwargs={
            "model": "bedrock/anthropic.claude-3-5-sonnet-20240620-v1:0",
            "response_cost": 0.0234,
            "litellm_call_id": "test-call-1",
        },
        response_obj=response,
        start_time=None,
        end_time=None,
    )

    assert get_tracker().cumulative_usd == pytest.approx(0.0234)
    assert get_tracker().calls == 1


def test_cost_handler_dedupes_double_dispatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """LiteLLM fires sync + async callbacks for the same call. Recording
    twice would over-count. Dedupe key is ``litellm_call_id``.
    """

    from tests.live.cost_cap import (
        _build_litellm_cost_handler,
        get_tracker,
        reset_tracker_for_tests,
    )

    monkeypatch.setenv("LIVE_TEST_COST_CAP_USD", "10.00")
    reset_tracker_for_tests()
    handler = _build_litellm_cost_handler()

    response = MagicMock()
    response.usage = MagicMock()
    response.usage.input_tokens = 100
    response.usage.output_tokens = 50
    response.usage.cache_read_input_tokens = 0
    response.usage.cache_creation_input_tokens = 0
    response.model = "claude-haiku-4-5"

    kwargs = {
        "model": "claude-haiku-4-5",
        "response_cost": 0.001,
        "litellm_call_id": "dedupe-test",
    }
    handler.log_success_event(kwargs=kwargs, response_obj=response,
                              start_time=None, end_time=None)

    import asyncio
    asyncio.run(handler.async_log_success_event(
        kwargs=kwargs, response_obj=response, start_time=None, end_time=None,
    ))

    # Both fired; we should have recorded exactly once.
    assert get_tracker().calls == 1


# -- _resolve_wire_model + provider-prefix allowlist --------------------------


def test_resolve_wire_model_auto_prefixes_claude_bare() -> None:
    """Bare ``claude-...`` names are auto-prefixed with ``anthropic/``."""

    from app.llm.clients.litellm_client import LiteLLMChatClient

    client = LiteLLMChatClient(settings=Settings(
        LLM_API_KEY="dummy", LLM_MODEL="claude-haiku-4-5"
    ))
    assert client._resolve_wire_model("guardrail") == "anthropic/claude-haiku-4-5"


def test_resolve_wire_model_passes_through_known_providers() -> None:
    """Provider-qualified ids in the allowlist pass through verbatim."""

    from app.llm.clients.litellm_client import LiteLLMChatClient

    client = LiteLLMChatClient(settings=Settings(
        LLM_API_KEY="dummy",
        LLM_MODEL_AAR="bedrock/anthropic.claude-opus-4-7",
    ))
    assert client._resolve_wire_model("aar") == "bedrock/anthropic.claude-opus-4-7"


def test_resolve_wire_model_rejects_unknown_provider_prefix() -> None:
    """Typos and unrecognized prefixes fail loud — operator must add
    them to the allowlist + document in docs/llm_providers.md.
    """

    from app.llm.clients.litellm_client import LiteLLMChatClient

    client = LiteLLMChatClient(settings=Settings(
        LLM_API_KEY="dummy",
        LLM_MODEL_PLAY="anthropic-direct/claude-sonnet-4-6",
    ))
    with pytest.raises(RuntimeError, match="unrecognized provider prefix"):
        client._resolve_wire_model("play")


def test_resolve_wire_model_rejects_unknown_bare_name() -> None:
    """A bare model id that isn't ``claude-...`` is treated as
    ambiguous — the operator must qualify it with a provider prefix
    rather than letting us guess.
    """

    from app.llm.clients.litellm_client import LiteLLMChatClient

    client = LiteLLMChatClient(settings=Settings(
        LLM_API_KEY="dummy",
        LLM_MODEL_GUARDRAIL="my-finetuned-model",
    ))
    with pytest.raises(RuntimeError, match="provider-qualified"):
        client._resolve_wire_model("guardrail")


# -- _build_call_kwargs allowlist (Sec H1) ------------------------------------


def test_build_call_kwargs_only_emits_allowed_keys() -> None:
    """Defense-in-depth: ``_build_call_kwargs`` may not produce any
    kwarg outside ``_ALLOWED_LITELLM_KWARGS``. Per security review C2,
    a ``callbacks`` / ``success_callback`` kwarg leaking into
    ``litellm.acompletion`` re-arms the disabled telemetry registries.
    """

    from app.llm.clients.litellm_client import (
        _ALLOWED_LITELLM_KWARGS,
        LiteLLMChatClient,
    )

    client = LiteLLMChatClient(settings=Settings(LLM_API_KEY="dummy"))
    kwargs, _ = client._build_call_kwargs(
        tier="guardrail",
        system_blocks=[{"type": "text", "text": "be brief"}],
        messages=[{"role": "user", "content": "hi"}],
        tools=None,
        max_tokens=10,
        tool_choice=None,
        extension_tool_names=None,
    )
    leak = set(kwargs) - _ALLOWED_LITELLM_KWARGS
    assert leak == set(), (
        f"unexpected kwargs leaking to litellm.acompletion: {leak}; "
        "see security review C2 on issue #193"
    )
    # Specific telemetry-bypass keys we actively defend against
    assert "callbacks" not in kwargs
    assert "success_callback" not in kwargs
    assert "failure_callback" not in kwargs
    assert "metadata" not in kwargs


# -- reconcile_tool_choice ----------------------------------------------------


def test_reconcile_tool_choice_drops_when_no_tools() -> None:
    """``tool_choice`` without ``tools`` produces HTTP 400 from Anthropic.
    The reconciliation drops it and logs a WARNING so a phase-policy
    regression that ate every tool is observable.
    """

    from app.llm._shared import reconcile_tool_choice

    # No tools kept → tool_choice dropped
    assert reconcile_tool_choice([], {"type": "any"}) is None
    # Tools kept → tool_choice passes through
    assert reconcile_tool_choice([{"name": "x"}], {"type": "any"}) == {"type": "any"}
    # No tool_choice supplied → no-op regardless
    assert reconcile_tool_choice([], None) is None


# -- strip_deprecated_sampling_params with provider prefix --------------------


def test_strip_temperature_through_provider_prefix() -> None:
    """When the LiteLLM client passes ``model="anthropic/claude-opus-4-7"``,
    the bare-name check still has to match the Opus prefix and strip
    ``temperature``. Otherwise the same Opus deprecation that broke AAR
    generation pre-#90 returns under the LiteLLM backend.
    """

    from app.llm._shared import strip_deprecated_sampling_params

    kwargs = {"temperature": 0.5, "model": "anthropic/claude-opus-4-7"}
    dropped = strip_deprecated_sampling_params("anthropic/claude-opus-4-7", kwargs)
    assert dropped == ["temperature"]
    assert "temperature" not in kwargs

    # Sanity: bare name also still strips
    kwargs2 = {"temperature": 0.5}
    dropped2 = strip_deprecated_sampling_params("claude-opus-4-7", kwargs2)
    assert dropped2 == ["temperature"]
    assert "temperature" not in kwargs2

    # Non-Opus models keep temperature
    kwargs3 = {"temperature": 0.5}
    dropped3 = strip_deprecated_sampling_params("anthropic/claude-haiku-4-5", kwargs3)
    assert dropped3 == []
    assert kwargs3["temperature"] == 0.5


# -- Insecure base URL warning ------------------------------------------------


def test_insecure_base_url_warns_on_link_local(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Link-local addresses (169.254.x.x and fe80::) are SSRF metadata
    targets — warn even on https. Sec L4 on issue #193.

    structlog renders to stdout as JSON, so we check the captured
    output for the structured ``event`` field rather than going
    through pytest's caplog (which only sees the stdlib logging
    module).
    """

    from app.llm.clients.litellm_client import LiteLLMChatClient

    monkeypatch.setenv("LLM_API_BASE", "https://169.254.169.254/proxy")
    client = LiteLLMChatClient(settings=Settings(LLM_API_KEY="dummy"))
    capsys.readouterr()  # drain anything from construction
    client._maybe_warn_insecure_base_url()
    out = capsys.readouterr().out
    assert "litellm_base_url_link_local" in out


def test_insecure_base_url_warns_on_plain_http(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Plain http:// to a non-loopback host — cleartext leak."""

    from app.llm.clients.litellm_client import LiteLLMChatClient

    monkeypatch.setenv("LLM_API_BASE", "http://10.0.0.5/proxy")
    client = LiteLLMChatClient(settings=Settings(LLM_API_KEY="dummy"))
    capsys.readouterr()
    client._maybe_warn_insecure_base_url()
    out = capsys.readouterr().out
    assert "litellm_base_url_insecure" in out


def test_insecure_base_url_quiet_on_loopback(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Loopback (localhost / 127.x / ::1) is fine for local-LLM gateways."""

    from app.llm.clients.litellm_client import LiteLLMChatClient

    for url in ("http://localhost:8000", "http://127.0.0.1", "http://[::1]"):
        monkeypatch.setenv("LLM_API_BASE", url)
        client = LiteLLMChatClient(settings=Settings(LLM_API_KEY="dummy"))
        capsys.readouterr()
        client._maybe_warn_insecure_base_url()
        out = capsys.readouterr().out
        assert "litellm_base_url_insecure" not in out, (
            f"loopback URL {url!r} unexpectedly warned: {out}"
        )
        assert "litellm_base_url_link_local" not in out


def test_cost_handler_failure_event_is_noop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Recording on failure double-counts retries (429 → retry → 200).
    The base CustomLogger's no-op default is preserved.
    """

    from tests.live.cost_cap import (
        _build_litellm_cost_handler,
        get_tracker,
        reset_tracker_for_tests,
    )

    monkeypatch.setenv("LIVE_TEST_COST_CAP_USD", "10.00")
    reset_tracker_for_tests()
    handler = _build_litellm_cost_handler()

    response = MagicMock()
    response.usage = MagicMock()
    response.usage.input_tokens = 100
    response.model = "claude-haiku-4-5"

    handler.log_failure_event(
        kwargs={"model": "claude-haiku-4-5", "response_cost": 0.001,
                "litellm_call_id": "failure-test"},
        response_obj=response, start_time=None, end_time=None,
    )

    assert get_tracker().calls == 0


# -- Integration: acomplete + astream end-to-end via mocked litellm ---------


@pytest.mark.asyncio
async def test_acomplete_forwards_correct_kwargs_to_litellm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end: ``LiteLLMChatClient.acomplete`` builds kwargs via
    ``_build_call_kwargs`` and forwards them to ``litellm.acompletion``.
    The kwargs must include the wire model id, OpenAI-shape messages
    (system block hoisted with ``cache_control`` injected), and stop
    short of leaking unexpected keys.
    """

    from unittest.mock import AsyncMock, patch

    from app.llm.clients.litellm_client import (
        _ALLOWED_LITELLM_KWARGS,
        LiteLLMChatClient,
    )

    fake_response = MagicMock()
    fake_response.choices = [MagicMock()]
    fake_response.choices[0].message = MagicMock(content="ok", tool_calls=None)
    fake_response.choices[0].finish_reason = "stop"
    fake_response.usage = MagicMock(
        prompt_tokens=10,
        completion_tokens=5,
        cache_creation_input_tokens=0,
        cache_read_input_tokens=0,
        prompt_tokens_details=None,
    )

    captured: dict[str, Any] = {}

    async def _fake_acompletion(**kwargs: Any) -> Any:
        captured.update(kwargs)
        return fake_response

    monkeypatch.setenv("LLM_API_KEY", "dummy")
    monkeypatch.setenv("LLM_MODEL", "claude-haiku-4-5")
    client = LiteLLMChatClient(settings=Settings())

    with patch(
        "app.llm.clients.litellm_client.litellm.acompletion",
        new=AsyncMock(side_effect=_fake_acompletion),
    ):
        await client.acomplete(
            tier="guardrail",
            system_blocks=[{"type": "text", "text": "Be brief."}],
            messages=[{"role": "user", "content": "hi"}],
            max_tokens=20,
        )

    # No leaks past the allowlist.
    assert set(captured).issubset(_ALLOWED_LITELLM_KWARGS), (
        f"unexpected kwargs leaking: {set(captured) - _ALLOWED_LITELLM_KWARGS}"
    )
    # Wire model includes the provider prefix.
    assert captured["model"].startswith("anthropic/claude-haiku-4-5")
    # Cache_control was injected by _build_call_kwargs even though the
    # caller didn't supply it (production-shape fix from #193).
    sys_msg = captured["messages"][0]
    assert sys_msg["role"] == "system"
    assert sys_msg["content"][0]["cache_control"] == {"type": "ephemeral"}


@pytest.mark.asyncio
async def test_astream_accumulates_chunks_and_reconstructs_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end: ``LiteLLMChatClient.astream`` iterates over the
    chunk iterator from ``litellm.acompletion(stream=True)``, emits
    text_delta events for any text content, then calls
    ``stream_chunk_builder`` and yields a terminal ``complete`` event
    with a reconstructed ``LLMResult``.
    """

    from unittest.mock import AsyncMock, patch
    from unittest.mock import MagicMock as _MagicMock

    from app.llm.clients.litellm_client import LiteLLMChatClient

    # Three text-only chunks, then end of stream.
    def _chunk(text: str | None) -> Any:
        c = _MagicMock()
        c.choices = [_MagicMock()]
        c.choices[0].delta = _MagicMock(content=text)
        return c

    async def _fake_stream(**_kwargs: Any) -> Any:
        async def _gen() -> Any:
            for piece in ("Hello", " ", "world."):
                yield _chunk(piece)
        return _gen()

    final_response = _MagicMock()
    final_response.choices = [_MagicMock()]
    final_response.choices[0].message = _MagicMock(content="Hello world.", tool_calls=None)
    final_response.choices[0].finish_reason = "stop"
    final_response.usage = _MagicMock(
        prompt_tokens=20,
        completion_tokens=4,
        cache_creation_input_tokens=0,
        cache_read_input_tokens=0,
        prompt_tokens_details=None,
    )

    monkeypatch.setenv("LLM_API_KEY", "dummy")
    monkeypatch.setenv("LLM_MODEL", "claude-haiku-4-5")
    client = LiteLLMChatClient(settings=Settings())

    with patch(
        "app.llm.clients.litellm_client.litellm.acompletion",
        new=AsyncMock(side_effect=_fake_stream),
    ), patch(
        "app.llm.clients.litellm_client.litellm.stream_chunk_builder",
        return_value=final_response,
    ):
        events = []
        async for event in client.astream(
            tier="guardrail",
            system_blocks=[{"type": "text", "text": "x"}],
            messages=[{"role": "user", "content": "hi"}],
            max_tokens=20,
        ):
            events.append(event)

    # Three text_delta events from the chunks, plus one terminal complete.
    text_events = [e for e in events if e["type"] == "text_delta"]
    complete_events = [e for e in events if e["type"] == "complete"]
    assert [e["text"] for e in text_events] == ["Hello", " ", "world."]
    assert len(complete_events) == 1
    assert complete_events[0]["result"].stop_reason == "end_turn"
    assert complete_events[0]["text"] == "Hello world."


def test_hardening_is_idempotent_across_instances() -> None:
    """Each ``LiteLLMChatClient.__init__`` re-runs ``_harden_litellm_globals``.
    A second instance must not leave callbacks populated from a stray
    third-party append between the first and second construction.
    """

    import litellm

    from app.llm.clients.litellm_client import LiteLLMChatClient

    settings = Settings(LLM_API_KEY="dummy")
    LiteLLMChatClient(settings=settings)
    # Simulate a stray third-party append between inits.
    litellm.success_callback.append("langfuse")  # type: ignore[arg-type]
    LiteLLMChatClient(settings=settings)
    # The second init must have wiped it.
    assert litellm.success_callback == []
    assert litellm.callbacks == []


def test_build_call_kwargs_empty_tools_yields_no_tools_kwarg() -> None:
    """``tools=[]`` and ``tools=None`` both produce a kwargs dict with
    no ``tools`` key — empty list would otherwise reach
    ``litellm.acompletion`` and some providers fault on it.
    """

    from app.llm.clients.litellm_client import LiteLLMChatClient

    settings = Settings(LLM_API_KEY="dummy")
    client = LiteLLMChatClient(settings=settings)

    for tools_value in (None, []):
        kwargs, _ = client._build_call_kwargs(
            tier="guardrail",
            system_blocks=[{"type": "text", "text": "x"}],
            messages=[{"role": "user", "content": "hi"}],
            tools=tools_value,
            max_tokens=10,
            tool_choice=None,
            extension_tool_names=None,
        )
        assert "tools" not in kwargs, f"tools key leaked with input {tools_value!r}"


def test_build_call_kwargs_drops_tool_choice_when_phase_policy_strips_all_tools() -> None:
    """End-to-end: when ``filter_allowed_tools`` strips every tool the
    caller passed (e.g. setup-tier tools fed to the play tier),
    ``reconcile_tool_choice`` drops ``tool_choice`` so Anthropic
    doesn't HTTP-400 with ``tool_choice without tools``.
    """

    from app.llm.clients.litellm_client import LiteLLMChatClient

    settings = Settings(LLM_API_KEY="dummy")
    client = LiteLLMChatClient(settings=settings)

    # Pass a setup-tier tool to a play-tier call. ``filter_allowed_tools``
    # drops it; ``reconcile_tool_choice`` then drops the tool_choice.
    kwargs, _ = client._build_call_kwargs(
        tier="play",
        system_blocks=[{"type": "text", "text": "x"}],
        messages=[{"role": "user", "content": "hi"}],
        tools=[{"name": "ask_setup_question", "description": "...", "input_schema": {}}],
        max_tokens=10,
        tool_choice={"type": "any"},
        extension_tool_names=None,
    )
    assert "tools" not in kwargs
    assert "tool_choice" not in kwargs


# -- Provider-specific api_key forwarding (issue #193 fix #2) ----------------


def test_build_call_kwargs_passes_api_key_for_anthropic_wire_model() -> None:
    """Anthropic wire models still get ``api_key`` from ``LLM_API_KEY`` —
    LiteLLM auto-discovers ``ANTHROPIC_API_KEY``, but our convention is
    the provider-agnostic ``LLM_API_KEY`` and we must forward it
    explicitly for the SDK to authenticate.
    """

    from app.llm.clients.litellm_client import LiteLLMChatClient

    settings = Settings(LLM_API_KEY="anthropic-key", LLM_MODEL="claude-haiku-4-5")
    client = LiteLLMChatClient(settings=settings)
    kwargs, wire_model = client._build_call_kwargs(
        tier="guardrail",
        system_blocks=[{"type": "text", "text": "x"}],
        messages=[{"role": "user", "content": "hi"}],
        tools=None,
        max_tokens=10,
        tool_choice=None,
        extension_tool_names=None,
    )
    assert wire_model.startswith("anthropic/")
    assert kwargs["api_key"] == "anthropic-key"


def test_build_call_kwargs_omits_api_key_for_non_anthropic_wire_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the wire model targets OpenAI / Bedrock / Vertex / etc., we
    must NOT forward ``LLM_API_KEY`` — that key is for whatever provider
    the operator picked, and slamming it into a different provider's
    auth header (a) won't authenticate, (b) leaks the credential into
    the wrong vendor's auth-failure log. Let LiteLLM auto-discover from
    ``OPENAI_API_KEY`` / ``AWS_*`` / ``GOOGLE_APPLICATION_CREDENTIALS``.
    """

    from app.llm.clients.litellm_client import LiteLLMChatClient

    monkeypatch.setenv("LLM_API_KEY", "anthropic-key")
    monkeypatch.setenv("LLM_MODEL", "openai/gpt-4.1-mini")
    get_settings.cache_clear()
    client = LiteLLMChatClient(settings=get_settings())
    kwargs, wire_model = client._build_call_kwargs(
        tier="guardrail",
        system_blocks=[{"type": "text", "text": "x"}],
        messages=[{"role": "user", "content": "hi"}],
        tools=None,
        max_tokens=10,
        tool_choice=None,
        extension_tool_names=None,
    )
    assert wire_model == "openai/gpt-4.1-mini"
    assert "api_key" not in kwargs, (
        "LLM_API_KEY must not be forwarded to a non-Anthropic wire model — "
        "let LiteLLM auto-discover the provider-native env var (issue #193 fix #2)"
    )


def test_build_call_kwargs_for_non_anthropic_works_with_no_llm_api_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A LiteLLM deploy targeting only non-Anthropic providers must boot
    and build kwargs without ``LLM_API_KEY`` set — the contributor /
    operator authenticates via ``OPENAI_API_KEY`` / ``AWS_*`` /
    ``GOOGLE_APPLICATION_CREDENTIALS`` which LiteLLM auto-discovers at
    request time. Pre-fix this raised ``RuntimeError`` from
    ``require_llm_api_key`` on every call.
    """

    from app.llm.clients.litellm_client import LiteLLMChatClient

    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.setenv("LLM_MODEL", "openai/gpt-4.1-mini")
    get_settings.cache_clear()
    client = LiteLLMChatClient(settings=get_settings())
    kwargs, _ = client._build_call_kwargs(
        tier="guardrail",
        system_blocks=[{"type": "text", "text": "x"}],
        messages=[{"role": "user", "content": "hi"}],
        tools=None,
        max_tokens=10,
        tool_choice=None,
        extension_tool_names=None,
    )
    assert "api_key" not in kwargs


def test_resolves_to_anthropic_helper(monkeypatch: pytest.MonkeyPatch) -> None:
    """The startup gate uses ``_resolves_to_anthropic`` to decide
    whether to require ``LLM_API_KEY`` under ``litellm-routed``.
    """

    from app.llm.clients.litellm_client import _resolves_to_anthropic

    # Default model is Claude — resolves true.
    monkeypatch.delenv("LLM_MODEL", raising=False)
    for tier in ("PLAY", "SETUP", "AAR", "GUARDRAIL"):
        monkeypatch.delenv(f"LLM_MODEL_{tier}", raising=False)
    get_settings.cache_clear()
    assert _resolves_to_anthropic(Settings(LLM_API_KEY="dummy")) is True

    # Explicit anthropic/ prefix — true.
    assert (
        _resolves_to_anthropic(
            Settings(LLM_API_KEY="dummy", LLM_MODEL="anthropic/claude-haiku-4-5")
        )
        is True
    )
    # OpenAI everywhere — false.
    assert (
        _resolves_to_anthropic(
            Settings(
                LLM_API_KEY="dummy",
                LLM_MODEL="openai/gpt-4.1-mini",
                LLM_MODEL_PLAY="openai/gpt-4.1",
                LLM_MODEL_SETUP="openai/gpt-4.1",
                LLM_MODEL_AAR="openai/gpt-4.1",
                LLM_MODEL_GUARDRAIL="openai/gpt-4.1-mini",
            )
        )
        is False
    )
    # Mixed — at least one tier hits Anthropic, so true.
    assert (
        _resolves_to_anthropic(
            Settings(
                LLM_API_KEY="dummy",
                LLM_MODEL="openai/gpt-4.1-mini",
                LLM_MODEL_AAR="claude-opus-4-7",
            )
        )
        is True
    )


def test_create_app_skips_llm_api_key_gate_for_non_anthropic_litellm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end startup gate: ``litellm-routed`` + every tier
    targeting a non-Anthropic provider must boot with no ``LLM_API_KEY``
    set. Pre-fix the ``cfg.require_llm_api_key()`` in ``create_app``
    raised at import time, breaking the whole non-Anthropic deployment
    story.
    """

    from app.config import reset_settings_cache
    from app.main import create_app

    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.setenv("LLM_MODEL", "openai/gpt-4.1-mini")
    for tier in ("PLAY", "SETUP", "AAR", "GUARDRAIL"):
        monkeypatch.setenv(f"LLM_MODEL_{tier}", "openai/gpt-4.1-mini")
    reset_settings_cache()
    # Should not raise.
    app = create_app()
    assert app is not None


def test_create_app_still_requires_llm_api_key_for_anthropic_via_litellm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``litellm-routed`` with at least one tier on ``anthropic/...``
    still requires ``LLM_API_KEY`` — LiteLLM looks for ``ANTHROPIC_API_KEY``
    by default but our convention is the provider-agnostic
    ``LLM_API_KEY``, so the gate must catch a missing one before the
    first call site.
    """

    from app.config import reset_settings_cache
    from app.main import create_app

    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.setenv("LLM_MODEL", "anthropic/claude-haiku-4-5")
    for tier in ("PLAY", "SETUP", "AAR", "GUARDRAIL"):
        monkeypatch.delenv(f"LLM_MODEL_{tier}", raising=False)
    reset_settings_cache()
    with pytest.raises(RuntimeError, match="LLM_API_KEY is required"):
        create_app()


# -- Unified cost path via litellm.cost_per_token (issue #193 fix #3) --------


def test_compute_cost_usd_prices_anthropic_via_litellm_pricing_json() -> None:
    """The unified ``compute_cost_usd`` helper sources every cost from
    LiteLLM's pricing JSON — no more local hand-maintained table that
    drifts (the deleted ``app/llm/cost.py`` had Opus 4.7 listed at
    $15/M input vs the actual $5/M, off by 3x). Both backends use
    this helper so cost reporting is consistent regardless of the
    wire provider.
    """

    from app.llm._shared import compute_cost_usd

    # claude-haiku-4-5 per LiteLLM: input=$1.00/M, output=$5.00/M
    cost = compute_cost_usd(
        "claude-haiku-4-5",
        {"input": 1_000_000, "output": 0, "cache_read": 0, "cache_creation": 0},
    )
    assert cost == pytest.approx(1.00)


def test_compute_cost_usd_prices_openai_models() -> None:
    """A non-Anthropic provider produces a sensible cost — proves the
    unified path actually works for the target use case (enterprise
    deployments routing to OpenAI / Bedrock / Vertex). Pre-unification
    this returned 0.0 because the local table didn't know OpenAI rates.
    """

    from app.llm._shared import compute_cost_usd

    cost = compute_cost_usd(
        "gpt-4.1-mini",
        {"input": 1_000_000, "output": 1_000_000, "cache_read": 0, "cache_creation": 0},
    )
    assert cost > 0


def test_compute_cost_usd_returns_zero_for_unknown_model() -> None:
    """Unknown models return 0.0 with a logged warning rather than
    raising. The downstream ``llm_call_complete`` log emits a 0.0
    cost line alongside the ``compute_cost_usd_unknown_model`` warning,
    so a missing pricing entry surfaces in audit.
    """

    from app.llm._shared import compute_cost_usd

    cost = compute_cost_usd(
        "definitely-not-a-real-model-id-9999",
        {"input": 100, "output": 50, "cache_read": 0, "cache_creation": 0},
    )
    assert cost == 0.0


def test_compute_cost_usd_includes_cache_token_pricing() -> None:
    """Cache-read and cache-creation are billed at distinct rates;
    the helper must pass both kwargs through to ``cost_per_token`` or
    the cache-cost normalization in ``_usage_to_normalized_dict``
    becomes meaningless. Anthropic cache-read is ~10% of fresh input;
    cache-creation is ~125% of fresh input (write surcharge).
    """

    from app.llm._shared import compute_cost_usd

    plain_input = compute_cost_usd(
        "claude-haiku-4-5",
        {"input": 1000, "output": 0, "cache_read": 0, "cache_creation": 0},
    )
    same_tokens_as_cache_read = compute_cost_usd(
        "claude-haiku-4-5",
        {"input": 0, "output": 0, "cache_read": 1000, "cache_creation": 0},
    )
    same_tokens_as_cache_creation = compute_cost_usd(
        "claude-haiku-4-5",
        {"input": 0, "output": 0, "cache_read": 0, "cache_creation": 1000},
    )
    # Cache_read is cheaper than the same volume of fresh input.
    assert same_tokens_as_cache_read > 0
    assert same_tokens_as_cache_read < plain_input
    # Cache_creation is more expensive than fresh input (write surcharge).
    assert same_tokens_as_cache_creation > plain_input


# -- with_system_cache defensive path (issue #193 fix #6) --------------------


def test_with_system_cache_skips_non_dict_block_with_warning() -> None:
    """A non-dict element in ``blocks`` (future bug or a misbehaving
    extension prompt builder) used to raise ``TypeError`` mid-turn. The
    defensive path returns the input unchanged and logs a WARNING so
    the regression surfaces in audit logs instead.
    """

    from app.llm._shared import with_system_cache

    class _CapturingLogger:
        def __init__(self) -> None:
            self.calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []

        def warning(self, *args: Any, **kwargs: Any) -> None:
            self.calls.append((args, kwargs))

    logger = _CapturingLogger()
    src = ["this-is-not-a-dict"]
    out = with_system_cache(src, logger=logger)
    # Returns input shape unchanged.
    assert out == ["this-is-not-a-dict"]
    # Doesn't alias the caller's list (mutation of out must not bleed back).
    assert out is not src
    # Logged the skip with structured kwargs (locks the schema so a future
    # refactor that moves the message into kwargs / args doesn't silently
    # pass — per Product review on issue #193 fixes).
    assert len(logger.calls) == 1
    args, kwargs = logger.calls[0]
    assert args == ("system_cache_skipped",)
    assert kwargs.get("reason") == "non_dict_block"
    assert kwargs.get("block_type") == "str"


@pytest.mark.asyncio
async def test_acomplete_pipes_cost_through_unified_helper(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end: ``acomplete`` must price its result via
    ``compute_cost_usd`` (the unified helper) so a non-Anthropic
    deploy reports actual cost. Pre-unification a regression that
    dropped the wire_provider threading would silently fall back to
    a local Anthropic-only table — that table is now deleted, so
    this test instead asserts the unified helper produces a non-zero
    cost end-to-end for an OpenAI wire model.
    """

    from unittest.mock import AsyncMock, patch

    from app.llm.clients.litellm_client import LiteLLMChatClient

    fake_response = MagicMock()
    fake_response.choices = [MagicMock()]
    fake_response.choices[0].message = MagicMock(content="ok", tool_calls=None)
    fake_response.choices[0].finish_reason = "stop"
    fake_response.usage = MagicMock(
        spec_set=[
            "prompt_tokens",
            "completion_tokens",
            "cache_creation_input_tokens",
            "cache_read_input_tokens",
            "prompt_tokens_details",
        ],
        prompt_tokens=100,
        completion_tokens=50,
        cache_creation_input_tokens=0,
        cache_read_input_tokens=0,
        prompt_tokens_details=None,
    )
    monkeypatch.setenv("LLM_MODEL", "openai/gpt-4.1-mini")
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    get_settings.cache_clear()
    client = LiteLLMChatClient(settings=get_settings())

    with patch(
        "app.llm.clients.litellm_client.litellm.acompletion",
        new=AsyncMock(return_value=fake_response),
    ):
        result = await client.acomplete(
            tier="guardrail",
            system_blocks=[{"type": "text", "text": "x"}],
            messages=[{"role": "user", "content": "hi"}],
            max_tokens=10,
        )
    # OpenAI gpt-4.1-mini is in LiteLLM's pricing JSON — non-zero cost
    # proves the unified helper picked up the right rates.
    assert result.estimated_usd > 0


def test_with_system_cache_returns_new_list() -> None:
    """The helper must never alias the caller's list — downstream
    mutation of the cached return must not bleed back into the prompt
    builder's source.
    """

    from app.llm._shared import with_system_cache

    src = [{"type": "text", "text": "x"}]
    out = with_system_cache(src)
    assert out is not src
    # Original input is untouched (no cache_control injected in place).
    assert "cache_control" not in src[0]
    # Output has the marker.
    assert out[0]["cache_control"] == {"type": "ephemeral"}
