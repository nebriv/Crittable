"""Unit tests for the live-test cost cap.

Lives at ``backend/tests/`` (NOT under ``tests/live/``) so it runs in
every CI pass regardless of whether ``ANTHROPIC_API_KEY`` is set. The
tracker logic is pure Python (token-count -> USD math + threshold
check); the only piece that touches the network is the
``AsyncAnthropic.__init__`` patch wired up in the live conftest, and
that's tested separately by exercising the patched-init wrapper
against a stub instance.

What this file locks:

1. The dollar-cap math matches ``app.llm.cost.estimate_usd`` so the
   test cap matches what the product itself reports.
2. Repeated low-cost calls don't drift past the cap silently — each
   ``record`` call rechecks and flips ``abort_message`` once.
3. Bad ``LIVE_TEST_COST_CAP_USD`` values fall back to the default
   rather than disabling the guardrail (typo'd cap should NEVER
   silently uncork the budget).
4. The ``_wrap_messages_create`` wrapper is idempotent — repeated
   wraps on the same client don't double-count.
"""

from __future__ import annotations

from typing import Any

import pytest

from tests.live import cost_cap


@pytest.fixture(autouse=True)
def _reset_cost_cap_state(monkeypatch: pytest.MonkeyPatch) -> None:
    """Each test starts with a fresh tracker so state from a prior
    test doesn't leak. Also clears the env var so ``_read_cap_usd``
    sees the default unless a test sets it explicitly.
    """

    monkeypatch.delenv(cost_cap.ENV_VAR_NAME, raising=False)
    cost_cap.reset_tracker_for_tests()


class _StubUsage:
    """Mimics ``anthropic.types.Usage``: just the four token counts
    we read.
    """

    def __init__(
        self,
        *,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cache_read_input_tokens: int = 0,
        cache_creation_input_tokens: int = 0,
    ) -> None:
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.cache_read_input_tokens = cache_read_input_tokens
        self.cache_creation_input_tokens = cache_creation_input_tokens


# ---------------------------------------------------------------- env parsing


def test_default_cap_when_env_unset() -> None:
    """No env var -> the documented default."""

    assert cost_cap._read_cap_usd() == cost_cap.DEFAULT_CAP_USD


def test_env_value_parsed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(cost_cap.ENV_VAR_NAME, "2.50")
    assert cost_cap._read_cap_usd() == 2.50


def test_zero_disables_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(cost_cap.ENV_VAR_NAME, "0")
    tracker = cost_cap._CostTracker(cap_usd=cost_cap._read_cap_usd())
    assert tracker.cap_enabled is False


def test_garbage_value_falls_back_to_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A typo'd cap should NEVER silently disable the guardrail —
    fall back to the conservative default instead.
    """

    monkeypatch.setenv(cost_cap.ENV_VAR_NAME, "not-a-number")
    assert cost_cap._read_cap_usd() == cost_cap.DEFAULT_CAP_USD


def test_negative_value_falls_back_to_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(cost_cap.ENV_VAR_NAME, "-5")
    assert cost_cap._read_cap_usd() == cost_cap.DEFAULT_CAP_USD


def test_blank_string_uses_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(cost_cap.ENV_VAR_NAME, "   ")
    assert cost_cap._read_cap_usd() == cost_cap.DEFAULT_CAP_USD


# ---------------------------------------------------------------- accumulation


def test_record_accumulates_cost() -> None:
    tracker = cost_cap._CostTracker(cap_usd=10.0)
    tracker.record(
        model="claude-sonnet-4-6",
        usage=_StubUsage(input_tokens=1_000_000, output_tokens=0),
    )
    # claude-sonnet-4-6 input is $3.00 / 1M tokens
    assert tracker.cumulative_usd == pytest.approx(3.00)
    assert tracker.calls == 1

    tracker.record(
        model="claude-sonnet-4-6",
        usage=_StubUsage(input_tokens=0, output_tokens=1_000_000),
    )
    # plus $15.00 output
    assert tracker.cumulative_usd == pytest.approx(18.00)
    assert tracker.calls == 2


def test_record_with_no_usage_is_noop() -> None:
    """Some streaming responses don't carry ``usage`` until completion;
    skipping them silently is safer than crashing the test suite.
    """

    tracker = cost_cap._CostTracker(cap_usd=10.0)
    tracker.record(model="claude-sonnet-4-6", usage=None)
    assert tracker.cumulative_usd == 0.0
    assert tracker.calls == 0


def test_unknown_model_uses_default_pricing() -> None:
    """A future model not yet in ``_PRICES`` shouldn't crash — it
    bills at the documented default rate (claude-sonnet-4-6).
    """

    tracker = cost_cap._CostTracker(cap_usd=10.0)
    tracker.record(
        model="claude-future-9-9",
        usage=_StubUsage(input_tokens=1_000_000, output_tokens=0),
    )
    assert tracker.cumulative_usd == pytest.approx(3.00)


def test_cache_tokens_count_toward_total() -> None:
    """Cache-read / cache-creation are billed at separate rates — make
    sure the cap respects them too.
    """

    tracker = cost_cap._CostTracker(cap_usd=10.0)
    tracker.record(
        model="claude-sonnet-4-6",
        usage=_StubUsage(
            input_tokens=0,
            output_tokens=0,
            cache_read_input_tokens=1_000_000,
            cache_creation_input_tokens=0,
        ),
    )
    # cache-read on sonnet: $0.30 / 1M
    assert tracker.cumulative_usd == pytest.approx(0.30)


# ---------------------------------------------------------------- abort behaviour


def test_abort_fires_once_when_cap_exceeded() -> None:
    import re

    tracker = cost_cap._CostTracker(cap_usd=1.00)
    # First call: $0.30 cumulative -> under cap.
    tracker.record(
        model="claude-haiku-4-5",
        usage=_StubUsage(input_tokens=375_000, output_tokens=0),
    )
    assert tracker.abort_message is None

    # Second call pushes us past $1: $0.30 + $0.80 = $1.10
    tracker.record(
        model="claude-sonnet-4-6",
        usage=_StubUsage(input_tokens=0, output_tokens=53_334),
    )
    assert tracker.abort_message is not None
    assert "exceeded" in tracker.abort_message.lower()

    # Pin the format contract: the message must contain
    # "$cumulative > $cap" with the cap value pinning to the configured
    # cap. Regex catches a format-string regression that substring
    # matching wouldn't.
    match = re.search(r"\$([\d.]+) > \$([\d.]+)", tracker.abort_message)
    assert match is not None, tracker.abort_message
    assert float(match.group(2)) == pytest.approx(1.00)

    # The user-agent finding required "what's billed" be explicit
    # and the "narrow the suite" hint be concrete.
    assert "billed" in tracker.abort_message
    assert "-k" in tracker.abort_message


def test_cap_equality_does_not_abort() -> None:
    """Cumulative == cap is NOT an abort — the cap is strictly
    greater-than. Pins the boundary so a future ``>`` -> ``>=`` typo
    is caught.
    """

    tracker = cost_cap._CostTracker(cap_usd=3.00)
    tracker.record(
        model="claude-sonnet-4-6",
        usage=_StubUsage(input_tokens=1_000_000, output_tokens=0),
    )
    assert tracker.cumulative_usd == pytest.approx(3.00)
    assert tracker.abort_message is None


def test_just_over_cap_does_abort() -> None:
    """One-token-over the cap fires the abort — the strict ``>`` is
    sensitive enough to catch a $0.000003 overshoot.
    """

    tracker = cost_cap._CostTracker(cap_usd=3.00)
    tracker.record(
        model="claude-sonnet-4-6",
        usage=_StubUsage(input_tokens=1_000_001, output_tokens=0),
    )
    assert tracker.cumulative_usd > 3.00
    assert tracker.abort_message is not None

    # Third call: abort_message stays the same — we don't keep
    # rewriting it (would be noisy and obscure the original trigger).
    first_message = tracker.abort_message
    tracker.record(
        model="claude-sonnet-4-6",
        usage=_StubUsage(input_tokens=0, output_tokens=10_000),
    )
    assert tracker.abort_message is first_message


def test_disabled_cap_never_aborts() -> None:
    tracker = cost_cap._CostTracker(cap_usd=0.0)
    tracker.record(
        model="claude-opus-4-7",
        # Opus output is $75/M — 100K tokens = $7.50, way over the
        # default cap, but cap=0 means disabled.
        usage=_StubUsage(input_tokens=0, output_tokens=100_000),
    )
    assert tracker.abort_message is None
    assert tracker.cumulative_usd == pytest.approx(7.50)


# ---------------------------------------------------------------- wrapper hygiene


class _StubMessages:
    def __init__(self) -> None:
        self.calls = 0

    async def create(self, **_: Any) -> Any:
        self.calls += 1

        class _Resp:
            usage = _StubUsage(input_tokens=100, output_tokens=200)
            model = "claude-sonnet-4-6"

        return _Resp()


class _StubClient:
    def __init__(self) -> None:
        self.messages = _StubMessages()


@pytest.mark.asyncio
async def test_wrap_messages_create_records_usage() -> None:
    client = _StubClient()
    cost_cap._wrap_messages_create(client)

    resp = await client.messages.create(model="claude-sonnet-4-6")
    tracker = cost_cap.get_tracker()
    assert tracker.calls == 1
    assert tracker.cumulative_usd > 0
    # Returned response is unchanged so callers see what they expect.
    assert getattr(resp, "model", None) == "claude-sonnet-4-6"


@pytest.mark.asyncio
async def test_wrap_is_idempotent() -> None:
    """Wrapping the same client twice doesn't double-count the next
    call. Otherwise a future caller invoking ``_wrap_messages_create``
    explicitly (the belt-and-braces in the ``anthropic_client``
    fixture) would corrupt the count.
    """

    client = _StubClient()
    cost_cap._wrap_messages_create(client)
    cost_cap._wrap_messages_create(client)
    cost_cap._wrap_messages_create(client)

    await client.messages.create(model="claude-sonnet-4-6")
    tracker = cost_cap.get_tracker()
    assert tracker.calls == 1


def test_wrap_tolerates_missing_messages_attr() -> None:
    """Some test stubs and partially-mocked clients omit the
    ``messages`` attribute; the wrapper should no-op rather than
    explode and break the autouse fixture.
    """

    class _Bare:
        pass

    cost_cap._wrap_messages_create(_Bare())  # must not raise


@pytest.mark.asyncio
async def test_wrap_create_falls_back_to_response_model_when_kwarg_omitted() -> None:
    """The wrapped ``messages.create`` should record the model from
    ``resp.model`` when ``model=`` isn't passed as a kwarg. Catches a
    regression where the fallback chain is broken.
    """

    class _StubMessages:
        async def create(self, **_kwargs: Any) -> Any:
            class _Resp:
                usage = _StubUsage(input_tokens=1_000_000, output_tokens=0)
                model = "claude-sonnet-4-6"

            return _Resp()

    class _StubClient:
        def __init__(self) -> None:
            self.messages = _StubMessages()

    client = _StubClient()
    cost_cap._wrap_messages_create(client)
    await client.messages.create()  # no model kwarg
    tracker = cost_cap.get_tracker()
    # 1M input tokens at sonnet's $3/M rate = $3.00, proving the model
    # fell back from kwargs to resp.model rather than to the unknown-model
    # default (which is the same rate today, but the assertion pins the
    # path).
    assert tracker.cumulative_usd == pytest.approx(3.00)


# ---------------------------------------------------------------- stream wrapper


class _StubFinalMessage:
    def __init__(self) -> None:
        self.usage = _StubUsage(input_tokens=100, output_tokens=200)
        self.model = "claude-sonnet-4-6"


class _StubStream:
    def __init__(self) -> None:
        self.get_final_message_calls = 0

    async def get_final_message(self) -> Any:
        self.get_final_message_calls += 1
        return _StubFinalMessage()


class _StubStreamManager:
    """Mimics ``anthropic.AsyncMessageStreamManager``: an async context
    manager whose ``__aenter__`` yields a stream object that supports
    ``get_final_message()``.
    """

    def __init__(self) -> None:
        self.aenter_calls = 0
        self.aexit_calls = 0
        self.stream = _StubStream()

    async def __aenter__(self) -> _StubStream:
        self.aenter_calls += 1
        return self.stream

    async def __aexit__(self, *_exc: Any) -> bool:
        self.aexit_calls += 1
        return False


class _StubMessagesWithStream:
    def __init__(self) -> None:
        self.last_manager: _StubStreamManager | None = None

    async def create(self, **_: Any) -> Any:  # required for wrap to install
        class _R:
            usage = _StubUsage()
            model = "claude-sonnet-4-6"

        return _R()

    def stream(self, **_kwargs: Any) -> _StubStreamManager:
        self.last_manager = _StubStreamManager()
        return self.last_manager


class _StubClientWithStream:
    def __init__(self) -> None:
        self.messages = _StubMessagesWithStream()


@pytest.mark.asyncio
async def test_wrap_stream_records_usage_via_get_final_message() -> None:
    """The wrapped ``messages.stream`` must record the final usage
    via ``stream.get_final_message()``. This is the path exercised by
    production's ``LLMClient.astream``.

    Critically: ``async with mgr as stream`` looks up dunders on
    ``type(mgr)``, not the instance. The wrapper has to return a
    wrapping CM CLASS, not just patch ``mgr.__aenter__`` on the
    instance. This test catches that exact bug.
    """

    client = _StubClientWithStream()
    cost_cap._wrap_messages_create(client)

    async with client.messages.stream(model="claude-sonnet-4-6") as stream:
        final = await stream.get_final_message()
        assert final.model == "claude-sonnet-4-6"

    tracker = cost_cap.get_tracker()
    assert tracker.calls == 1, (
        "stream wrapper didn't record — likely the dunder-on-instance "
        "trap (manager.__aenter__ = ... is silently ignored by `async with`)"
    )
    assert tracker.cumulative_usd > 0


@pytest.mark.asyncio
async def test_wrap_stream_kwargs_model_takes_precedence() -> None:
    """``messages.stream(model='x')`` should bill against ``x``, not
    against the resp.model. Mirrors the create-path test above.
    """

    client = _StubClientWithStream()
    cost_cap._wrap_messages_create(client)

    async with client.messages.stream(model="claude-haiku-4-5") as stream:
        await stream.get_final_message()

    # Haiku rates: $0.80/M input × 100 tokens = $0.00008
    #              $4.00/M output × 200 tokens = $0.0008
    #              total ~$0.00088
    tracker = cost_cap.get_tracker()
    assert tracker.cumulative_usd == pytest.approx(0.00088, rel=1e-3)


@pytest.mark.asyncio
async def test_wrap_stream_aexit_propagates_exceptions() -> None:
    """An exception inside the ``async with`` block must propagate
    through the wrapper unchanged — the wrapper isn't a swallower.
    """

    client = _StubClientWithStream()
    cost_cap._wrap_messages_create(client)

    class _Sentinel(Exception):
        pass

    with pytest.raises(_Sentinel):
        async with client.messages.stream(model="claude-sonnet-4-6"):
            raise _Sentinel("inside the with block")

    # The inner manager's __aexit__ should still have been called so
    # the SDK can clean up the streaming connection.
    assert client.messages.last_manager is not None
    assert client.messages.last_manager.aexit_calls == 1
