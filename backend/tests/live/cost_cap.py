"""Per-run dollar cap for the live-API test suite.

Tracks cumulative LLM spend across every call made by tests in
``backend/tests/live/`` and aborts the suite once the cumulative cost
crosses the configured cap. Without this, a runaway loop or a stray
``pytest --count=N`` could quietly torch the live-test budget.

Two cost-recording paths
========================

Crittable supports two LLM backends (``LLM_BACKEND=anthropic|litellm``).
The cap covers both:

* **Anthropic-direct.** ``_wrap_messages_create`` patches
  ``AsyncAnthropic.messages.create`` and ``.stream`` and is hooked up via
  the session-scoped autouse fixture in ``conftest.py``. Records on every
  ``messages.create`` response and on ``stream.get_final_message()``.
* **LiteLLM.** ``install_litellm_cost_tracking`` registers a
  ``litellm.callbacks`` handler that records on every successful and
  failed completion. Same fixture installs both — a single pytest run
  can exercise either backend without rewiring.

Both paths feed the same module-singleton ``_CostTracker``, so the cap
fires regardless of which backend is in use.

Why we need this even with low per-test cost
--------------------------------------------

The standing suite is ~$1.40 / full run. CI runs it on a path filter
plus ``workflow_dispatch`` (no scheduled cron — see
``docs/tool-design.md``); a misconfigured workflow that fan-outs into
N parallel jobs (or a contributor who pushes 30 times in an hour while
iterating) can multiply that bill by 10x in minutes. Anthropic's TPM
and RPM rate limits gate request volume but **not dollars** — at 100
RPM you can still spend $50/min on 5 KB outputs. The dollar cap is
the only guardrail that actually enforces budget.

What's tracked
--------------

Every ``AsyncAnthropic.messages.create`` call made during the live
session is intercepted via an ``__init__`` wrapper installed in the
session-scoped autouse fixture below. Each call's ``response.usage``
is fed through ``app.llm._shared.compute_cost_usd`` (which talks to
``litellm.cost_per_token``) so the test cap matches the per-call cost
the product itself reports.

Coverage:
  * The ``anthropic_client`` fixture in ``conftest.py`` -> wrapped on construction.
  * ``judge_client`` in ``test_aar_quality_judge.py`` -> wrapped on construction.
  * ``LLMClient`` in ``app/llm/client.py`` (used by ``AARGenerator``,
    ``run_setup_turn``, etc.) constructs ``AsyncAnthropic`` lazily;
    that instance is also wrapped because the ``__init__`` patch is
    process-wide for the test session's lifetime.

Configuration
-------------

``LIVE_TEST_COST_CAP_USD`` env var. Default: ``2.00`` — the standing
suite is ~$1.40, leaving ~$0.60 of headroom (~40%) for a couple of
new tests, latency-induced cache misses, or one extra retry on a
flake. A tighter default ($1.50) would false-trip on routine variance
and push contributors toward ``LIVE_TEST_COST_CAP_USD=0``, which is
exactly the failure mode the cap exists to prevent.

Set to ``0`` to disable the cap (useful for one-off "I'm intentionally
measuring a 50x stress run" cases). Negative or non-numeric values
fall back to the default.

When the cap fires
------------------

The currently-running test finishes (so the in-flight HTTP request
isn't orphaned mid-flight), and the very next ``pytest_runtest_teardown``
sets ``session.shouldstop`` so pytest halts cleanly before the next
test. The terminal summary prints the cumulative cost regardless of
whether the cap fired so a contributor can see "I just spent X" on
every run.

Parallelism caveat
------------------

The tracker is a per-process module singleton. Running the live
suite under ``pytest-xdist -n N`` would give each worker its own
counter and the *effective* cap becomes ``N * LIVE_TEST_COST_CAP_USD``.
The standing CI workflow does NOT pass ``-n``; if a future change
introduces parallelism for speed, this needs to move to a file-backed
shared lock (or the workflow should pin ``-n 1``). Same caveat for
``pytest-rerunfailures``: a rerun's spend is already paid before
the cap fires.
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable
from typing import Any

from app.llm._shared import compute_cost_usd
from app.logging_setup import get_logger

# Trailing ``-YYYYMMDD`` date suffix on LiteLLM-returned model ids
# (e.g. ``claude-haiku-4-5-20251001`` → ``claude-haiku-4-5``). Anthropic-direct
# returns the bare name; LiteLLM normalizes to the dated id. ``litellm.cost_per_token``
# tolerates either form, but ``_normalize_model_name`` strips on lookup so
# the cap reads against the same key shape regardless of backend.
_LITELLM_DATE_SUFFIX = re.compile(r"-\d{8}$")

_logger = get_logger("tests.live.cost_cap")

DEFAULT_CAP_USD = 2.00
ENV_VAR_NAME = "LIVE_TEST_COST_CAP_USD"


def _read_cap_usd() -> float:
    """Resolve the cap from ``LIVE_TEST_COST_CAP_USD``.

    Bad values (non-numeric, negative) fall back to the default rather
    than disabling the cap silently — a typo'd env var should never
    remove the guardrail.
    """

    raw = os.environ.get(ENV_VAR_NAME)
    if raw is None or raw.strip() == "":
        return DEFAULT_CAP_USD
    try:
        value = float(raw.strip())
    except ValueError:
        _logger.warning(
            "live_test_cost_cap_bad_value",
            env_value=raw,
            falling_back_to=DEFAULT_CAP_USD,
        )
        return DEFAULT_CAP_USD
    if value < 0:
        _logger.warning(
            "live_test_cost_cap_negative",
            env_value=raw,
            falling_back_to=DEFAULT_CAP_USD,
        )
        return DEFAULT_CAP_USD
    if value == 0.0:
        _logger.warning(
            "live_test_cost_cap_disabled",
            env_value=raw,
            note="set LIVE_TEST_COST_CAP_USD=0 to disable; this run has no $ ceiling",
        )
    return value


class _CostTracker:
    """Cumulative spend tracker for the live session.

    Not thread-safe — pytest-asyncio runs the live suite single-event-loop
    so the increments are sequential. If a future test fans out via
    ``asyncio.gather`` the worst case is a small undercount near the
    cap edge, not a missed abort (the cap check runs after each
    increment).
    """

    def __init__(self, cap_usd: float) -> None:
        self.cap_usd = cap_usd
        self.cumulative_usd = 0.0
        self.calls = 0
        self.abort_message: str | None = None

    @property
    def cap_enabled(self) -> bool:
        return self.cap_usd > 0

    def record(self, *, model: str, usage: Any) -> None:
        if usage is None:
            return
        cost = compute_cost_usd(
            model or "claude-sonnet-4-6",
            {
                "input": int(getattr(usage, "input_tokens", 0) or 0),
                "output": int(getattr(usage, "output_tokens", 0) or 0),
                "cache_read": int(
                    getattr(usage, "cache_read_input_tokens", 0) or 0
                ),
                "cache_creation": int(
                    getattr(usage, "cache_creation_input_tokens", 0) or 0
                ),
            },
        )
        self.cumulative_usd += cost
        self.calls += 1
        if (
            self.cap_enabled
            and self.cumulative_usd > self.cap_usd
            and self.abort_message is None
        ):
            # ``:.4f`` on the cap so sub-dollar caps (e.g. ``0.001``
            # for a smoke test) print as ``$0.0010`` rather than
            # ``$0.00``, which would read as "the cap was 0".
            self.abort_message = (
                f"live-test cost cap exceeded: ${self.cumulative_usd:.4f} > "
                f"${self.cap_usd:.4f} after {self.calls} live API calls "
                f"(all {self.calls} are billed; subsequent tests are skipped). "
                f"Raise {ENV_VAR_NAME} (e.g. {ENV_VAR_NAME}=4.00) or narrow "
                f"the suite (pytest -k <filter>). The current test will finish."
            )
            _logger.warning(
                "live_test_cost_cap_exceeded",
                cumulative_usd=round(self.cumulative_usd, 4),
                cap_usd=self.cap_usd,
                calls=self.calls,
            )


_TRACKER: _CostTracker | None = None


def get_tracker() -> _CostTracker:
    """Module-level singleton. Lazy so tests can mutate the env var
    before first access.
    """

    global _TRACKER
    if _TRACKER is None:
        _TRACKER = _CostTracker(cap_usd=_read_cap_usd())
    return _TRACKER


def reset_tracker_for_tests() -> None:
    """Test-only hook — clears the singleton so a unit test can drive
    the tracker through fresh state. Production tests never call this.
    """

    global _TRACKER
    _TRACKER = None


def _wrap_messages_create(client: Any) -> None:
    """Install ``messages.create`` AND ``messages.stream`` wrappers
    that record usage. Production has TWO Anthropic call paths:

      * ``messages.create``  — non-streaming. Used by ``acomplete``
        in ``app/llm/client.py`` (AAR generation, setup driver,
        guardrail) and by every ``call_play`` in the live suite.
      * ``messages.stream``  — streaming. Used by ``astream`` in
        ``app/llm/client.py`` (the play-turn relay). Today's live
        tests don't exercise this path, but a future test that
        drives a real play turn through ``run_play_turn`` would
        bypass the cap unless ``stream`` is wrapped too.

    Idempotent — repeated calls on the same instance no-op via the
    sentinel attribute. Tolerates missing attrs (some test stubs
    omit ``messages``; very old SDK versions might omit ``stream``).
    """

    if getattr(client, "_cost_cap_wrapped", False):
        return
    messages = getattr(client, "messages", None)
    if messages is None:
        return
    if hasattr(messages, "create"):
        original_create = messages.create

        async def tracked_create(*args: Any, **kwargs: Any) -> Any:
            resp = await original_create(*args, **kwargs)
            model = kwargs.get("model") or getattr(resp, "model", "") or ""
            get_tracker().record(model=model, usage=getattr(resp, "usage", None))
            return resp

        messages.create = tracked_create
    if hasattr(messages, "stream"):
        original_stream = messages.stream

        def tracked_stream(*args: Any, **kwargs: Any) -> Any:
            # ``messages.stream`` returns an async context manager
            # whose ``__aenter__`` yields the live stream object.
            # ``stream.get_final_message()`` returns the assembled
            # ``Message`` once the stream completes, with the final
            # ``usage`` block populated. We tap into ``get_final_message``
            # so the final usage lands in the tracker exactly once per
            # stream.
            #
            # We MUST use a wrapper class for the context-manager
            # boundary, NOT instance-attribute patching of ``__aenter__``.
            # Python's ``async with`` looks up dunders on the *type*,
            # not the instance — ``manager.__aenter__ = ...`` would be
            # silently ignored. The CRITICAL bug caught by the QA
            # review on PR closing #74. Method-level patching of
            # ``stream.get_final_message`` IS effective because it's
            # called as a normal bound method (`stream.get_final_message()`),
            # not via a dunder lookup.
            return _TrackedStreamManager(
                original_stream(*args, **kwargs), kwargs
            )

        messages.stream = tracked_stream
    client._cost_cap_wrapped = True


def _normalize_model_name(model: str) -> str:
    """Map a LiteLLM-returned model id back to the bare name LiteLLM's
    pricing JSON keys on.

    Anthropic-direct: ``claude-haiku-4-5-20251001`` → ``claude-haiku-4-5``.
    LiteLLM-via-Bedrock: ``bedrock/anthropic.claude-3-5-sonnet-20240620-v1:0``
    has trailing ``-v1:0`` after the date so the date-strip pattern
    intentionally doesn't match — that's fine; ``compute_cost_usd``
    returns 0.0 with a WARNING for unknown ids and the cap still gets
    a usable cost figure (under-counts only the unknown-model lines).
    Provider-prefix stripping is best-effort: only the first ``/`` is
    removed (``openrouter/anthropic/claude-…`` becomes
    ``anthropic/claude-…``, which still won't match — see the
    ``response_cost`` fallback in ``_LiteLLMCostHandler._record`` which
    consumes LiteLLM's own per-call ``response_cost`` for non-Anthropic
    providers).
    """

    if not model:
        return ""
    if "/" in model:
        model = model.split("/", 1)[1]
    return _LITELLM_DATE_SUFFIX.sub("", model)


def _build_litellm_cost_handler() -> Any:
    """Build a ``CustomLogger`` subclass instance LiteLLM's dispatcher
    will actually invoke. Done as a function so the import of
    ``CustomLogger`` is deferred — ``cost_cap.py`` is imported by tests
    that don't need LiteLLM (most of the unit suite).

    Why a subclass: LiteLLM's success/failure dispatchers gate on
    ``isinstance(callback, CustomLogger)`` before calling ``log_*_event``.
    A duck-typed bare object is silently skipped. Caught by QA review
    on issue #193 — the cap was inert against ``LLM_BACKEND=litellm``
    until the subclass landed.
    """

    from litellm.integrations.custom_logger import CustomLogger

    class _LiteLLMCostHandler(CustomLogger):
        """Records LiteLLM call cost into the shared ``_CostTracker``.

        Idempotency: LiteLLM's async dispatcher fires both
        ``log_success_event`` (sync, run in a thread) and
        ``async_log_success_event`` for the same call. We dedupe on
        ``litellm_call_id`` (a per-call uuid LiteLLM injects into
        ``kwargs``) to avoid double-counting.

        Failure handling: ``log_failure_event`` is a no-op. The success
        path is the source of truth for billed usage; recording on
        failure double-counts on a 429 → retry → 200 sequence
        because LiteLLM fires both events.

        Cost source: prefer LiteLLM's own ``response_cost`` (the
        per-call cost LiteLLM injects into ``kwargs`` for free). Fall
        back to ``compute_cost_usd`` (which also goes through LiteLLM's
        pricing JSON) only for Anthropic-shaped
        names where we have first-party pricing.
        """

        def __init__(self) -> None:
            super().__init__()
            self._seen_call_ids: set[str] = set()

        def log_success_event(
            self,
            kwargs: dict[str, Any],
            response_obj: Any,
            start_time: Any,
            end_time: Any,
        ) -> None:
            self._record_once(kwargs, response_obj)

        async def async_log_success_event(
            self,
            kwargs: dict[str, Any],
            response_obj: Any,
            start_time: Any,
            end_time: Any,
        ) -> None:
            self._record_once(kwargs, response_obj)

        # log_failure_event / async_log_failure_event intentionally
        # default to the base class's no-op. Recording on failure
        # double-counts retried calls.

        def _record_once(self, kwargs: dict[str, Any], response: Any) -> None:
            if response is None:
                return
            call_id = (
                kwargs.get("litellm_call_id") if isinstance(kwargs, dict) else None
            ) or id(response)
            key = str(call_id)
            if key in self._seen_call_ids:
                return
            self._seen_call_ids.add(key)
            self._record(kwargs, response)

        @staticmethod
        def _record(kwargs: dict[str, Any], response: Any) -> None:
            usage = getattr(response, "usage", None)
            if usage is None:
                return
            model_raw = (
                kwargs.get("model") if isinstance(kwargs, dict) else None
            ) or getattr(response, "model", "") or ""

            # Prefer LiteLLM's own per-call ``response_cost`` when
            # present — already-computed and per-provider authoritative.
            # Fall back to ``compute_cost_usd`` (also via LiteLLM's
            # pricing JSON) only when LiteLLM didn't supply one
            # (older versions, providers without per-call cost).
            response_cost = (
                kwargs.get("response_cost") if isinstance(kwargs, dict) else None
            )
            tracker = get_tracker()
            if isinstance(response_cost, (int, float)) and response_cost > 0:
                tracker.cumulative_usd += float(response_cost)
                tracker.calls += 1
                if (
                    tracker.cap_enabled
                    and tracker.cumulative_usd > tracker.cap_usd
                    and tracker.abort_message is None
                ):
                    tracker.abort_message = (
                        f"live-test cost cap exceeded: ${tracker.cumulative_usd:.4f} "
                        f"> ${tracker.cap_usd:.4f} after {tracker.calls} live API "
                        f"calls (LiteLLM-routed). Raise {ENV_VAR_NAME} or narrow "
                        "the suite (pytest -k <filter>)."
                    )
                    _logger.warning(
                        "live_test_cost_cap_exceeded",
                        cumulative_usd=round(tracker.cumulative_usd, 4),
                        cap_usd=tracker.cap_usd,
                        calls=tracker.calls,
                        source="litellm_response_cost",
                    )
                return

            # Fallback: estimate via local table on Anthropic-shaped names.
            tracker.record(model=_normalize_model_name(model_raw), usage=usage)

    return _LiteLLMCostHandler()


def install_litellm_cost_tracking() -> Callable[[], None]:
    """Register a ``litellm.callbacks`` handler that records cost into the
    shared ``_CostTracker``. Returns a teardown callable.

    No-ops gracefully if ``litellm`` isn't importable (live-test
    auto-skip will catch that anyway).

    Mutates ``litellm.callbacks`` in place so any cached reference held
    by ``litellm`` internals (the ``_async_*`` lists are populated lazily
    from this list on first use) sees the install/teardown atomically.
    """

    try:
        import litellm
    except ImportError:
        return lambda: None

    handler = _build_litellm_cost_handler()
    # In-place mutation — see docstring.
    if not hasattr(litellm, "callbacks") or litellm.callbacks is None:
        litellm.callbacks = []
    litellm.callbacks.insert(0, handler)

    def teardown() -> None:
        try:
            litellm.callbacks.remove(handler)
        except ValueError:
            # Already removed or list was rebound by another caller.
            pass
        # Belt-and-braces: also remove from any async-side list that
        # may have been hoisted from ``callbacks`` on first use.
        for name in ("_async_input_callback", "_async_success_callback",
                     "_async_failure_callback"):
            lst = getattr(litellm, name, None)
            if isinstance(lst, list):
                try:
                    lst.remove(handler)
                except ValueError:
                    pass

    return teardown


class _TrackedStreamManager:
    """Wraps the SDK's stream context manager so the final ``usage``
    block lands in the cost tracker exactly once per stream.

    The class-level ``__aenter__`` / ``__aexit__`` is load-bearing —
    Python looks up dunders on the type, not the instance. See the
    inline comment in ``_wrap_messages_create``.
    """

    def __init__(self, inner: Any, kwargs: dict[str, Any]) -> None:
        self._inner = inner
        self._kwargs = kwargs

    async def __aenter__(self) -> Any:
        stream = await self._inner.__aenter__()
        original_get_final = getattr(stream, "get_final_message", None)
        if original_get_final is None:
            # Older SDK shape: nothing to wrap. Cap won't see this
            # stream, but neither would the previous broken impl.
            return stream
        kwargs = self._kwargs

        async def tracked_get_final() -> Any:
            final = await original_get_final()
            model = (
                kwargs.get("model") or getattr(final, "model", "") or ""
            )
            get_tracker().record(model=model, usage=getattr(final, "usage", None))
            return final

        # Instance-level method patch IS effective — ``stream.get_final_message()``
        # is a normal bound-method call, NOT a dunder lookup.
        stream.get_final_message = tracked_get_final
        return stream

    async def __aexit__(self, *exc: Any) -> Any:
        return await self._inner.__aexit__(*exc)
