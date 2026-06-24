"""Provider-agnostic chat-client contract.

Defines the abstract base class every LLM client implementation extends, plus
the data types that flow across the seam (``LLMResult``, ``InFlightCall``).

The production implementation that lives behind this seam:

  * ``app.llm.clients.litellm_client.LiteLLMChatClient`` — routes via LiteLLM
    (~100 providers: Azure OpenAI, Bedrock, Vertex, OpenRouter, …).

See `docs/llm_providers.md` for the configuration story.

# Design choices

The base class is concrete for everything that's provider-agnostic
(in-flight call tracking, ``ai_thinking`` broadcast, connection wiring) and
abstract for the four methods every implementation must supply
(``acomplete``, ``astream``, ``model_for``, ``aclose``). Concentrating the
lifecycle logic here is the difference between adding a new provider in
~150 LOC of pure translator vs. ~250 LOC including 100 lines of duplicated
in-flight bookkeeping.

Internal vocabulary stays Anthropic-shaped — content blocks
(``{"type": "text"}`` / ``{"type": "tool_use"}``), ``stop_reason`` values
(``"end_turn" | "tool_use" | "max_tokens"``), ``cache_control: ephemeral``,
the four-key ``usage`` dict. Provider-specific clients translate at the
wire boundary; downstream callers (``SessionManager``, ``TurnDriver``,
``AARGenerator``, ``InputGuardrail``) never see provider-shaped data. See
`CLAUDE.md` § "Model-output trust boundary" for why this matters.
"""

from __future__ import annotations

import asyncio
import secrets
import time
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from ..logging_setup import get_logger
from .errors import UpstreamLLMError

if TYPE_CHECKING:
    from ..config import ModelTier
    from ..ws.connection_manager import ConnectionManager

_logger = get_logger("llm.protocol")

# Concurrency-governor tunables (cost/abuse H2). Not env-exposed — these
# are observability/UX thresholds, not capacity knobs (capacity is
# ``LLM_MAX_CONCURRENCY`` / ``LLM_ACQUIRE_TIMEOUT_S``).
_QUEUE_LOG_FLOOR_MS = 5  # below this a call effectively didn't queue
_QUEUE_SATURATION_WARN_MS = 1000  # wait ≥ this → WARNING + creator notice
_DEGRADED_NOTIFY_THROTTLE_S = 5.0  # min seconds between creator backend_status pings


@dataclass
class InFlightCall:
    """One active LLM call. Used by the creator's activity panel.

    ``call_id`` is a short opaque identifier so a real-time WS subscriber
    (the participant + creator UI's "AI thinking" indicator, see
    issue #63) can match an ``ai_thinking active=true`` event with the
    later ``active=false`` event for the same call. Concurrent calls on
    the same session (e.g. guardrail + interject) overlap, so the
    indicator must reference-count rather than naively toggle.
    """

    tier: str
    model: str
    stream: bool
    started_at: float  # time.monotonic() seconds
    call_id: str = field(default_factory=lambda: secrets.token_hex(6))


class LLMResult:
    """Resolved (non-streamed) response with a cost estimate attached.

    ``content`` is a list of dict blocks in Anthropic's content-block
    shape (``{"type": "text", "text": ...}`` or ``{"type": "tool_use",
    "id": ..., "name": ..., "input": ...}``). Every ``ChatClient``
    implementation normalizes provider-shaped responses into this shape.

    ``usage`` keys are the normalized form (``input``, ``output``,
    ``cache_read``, ``cache_creation``) — *not* the raw Anthropic SDK
    field names. ``app.llm._shared.compute_cost_usd`` reads these.
    """

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


class ChatClient(ABC):
    """Provider-agnostic LLM client.

    Concrete: in-flight tracking, ``ai_thinking`` broadcast, connection
    wiring (every backend needs the same behavior here).
    Abstract: the four API methods every backend must supply.
    """

    def __init__(
        self,
        *,
        max_concurrency: int | None = None,
        acquire_timeout_s: float | None = None,
    ) -> None:
        # In-flight tracker: session_id -> list of InFlightCall (in case the
        # session manager dispatches the AAR while a guardrail call is also
        # active; rare but possible).
        self._in_flight: dict[str, list[InFlightCall]] = {}
        # ConnectionManager is wired post-construction (``set_connections``)
        # because the app builds the LLM client before the connection manager
        # in some startup orderings. Until set, ``_begin_call`` / ``_end_call``
        # skip the WS broadcast — non-fatal (calls still track via
        # ``_in_flight`` for the polled ``/activity`` endpoint).
        self._connections: ConnectionManager | None = None
        # Concurrency governor (cost/abuse H2). Two lanes so the cheap,
        # latency-critical guardrail never queues behind a long Opus AAR
        # in the heavy (play/setup/aar) lane. ``None``/0 disables the cap
        # — the default for bare ``ChatClient`` subclasses in tests, which
        # must not serialize on a shared semaphore. ``LiteLLMChatClient``
        # passes the configured size. Constructed without a running loop
        # (asyncio.Semaphore binds lazily on first await in 3.10+).
        self._acquire_timeout_s = acquire_timeout_s
        if max_concurrency and max_concurrency > 0:
            self._heavy_sem: asyncio.Semaphore | None = asyncio.Semaphore(
                max_concurrency
            )
            self._guardrail_sem: asyncio.Semaphore | None = asyncio.Semaphore(
                max_concurrency
            )
        else:
            self._heavy_sem = None
            self._guardrail_sem = None
        # Per-session throttle for the creator ``backend_status`` notice.
        self._last_degraded_notify: dict[str, float] = {}

    # Lifecycle / wiring -----------------------------------------------------

    def set_connections(self, connections: ConnectionManager) -> None:
        """Wire the connection manager so begin/end-of-call boundaries fan
        out as ``ai_thinking`` WS events. See issue #63.
        """

        self._connections = connections

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
        call = InFlightCall(
            tier=tier, model=model, stream=stream, started_at=time.monotonic()
        )
        self._in_flight.setdefault(session_id, []).append(call)
        self._broadcast_thinking(session_id, call, active=True)
        return call

    def _end_call(self, session_id: str | None, call: InFlightCall | None) -> None:
        if session_id and call is not None:
            bucket = self._in_flight.get(session_id)
            if bucket and call in bucket:
                bucket.remove(call)
            if bucket is not None and not bucket:
                self._in_flight.pop(session_id, None)
            self._broadcast_thinking(session_id, call, active=False)

    def _broadcast_thinking(
        self, session_id: str, call: InFlightCall, *, active: bool
    ) -> None:
        """Fire-and-forget ``ai_thinking`` event so every connected client
        sees the indicator the moment a call starts / stops, regardless of
        which tier or driver path triggered it.

        ``record=False`` because the event is stale on reconnect — the
        replay buffer would otherwise show "AI was thinking" forever for a
        call that finished an hour ago. Failures are swallowed but logged:
        a misbehaving WS handler must NOT break the LLM call.
        """

        if self._connections is None:
            return
        event: dict[str, Any] = {
            "type": "ai_thinking",
            "active": active,
            "tier": call.tier,
            "call_id": call.call_id,
        }
        if active:
            event["started_at_ms"] = int(call.started_at * 1000)
        try:
            asyncio.get_running_loop().create_task(
                self._connections.broadcast(session_id, event, record=False)
            )
        except Exception as exc:
            _logger.warning(
                "ai_thinking_broadcast_failed",
                session_id=session_id,
                call_id=call.call_id,
                tier=call.tier,
                active=active,
                error=str(exc),
            )

    # Concurrency governor ---------------------------------------------------

    async def _acquire_slot(
        self, *, tier: ModelTier, session_id: str | None
    ) -> asyncio.Semaphore | None:
        """Acquire a global concurrency slot for one upstream call
        (cost/abuse H2); returns the semaphore to ``release()`` when done,
        or ``None`` when capping is disabled.

        Heavy tiers (play / setup / aar) share one lane; the guardrail
        gets its own lane of the same size so cheap, latency-critical
        input screening never queues behind a long Opus AAR. A call that
        finds its lane full WAITS — the ``ai_thinking`` indicator, begun
        by the caller *before* this acquire, keeps the player informed, so
        a brief queue looks like "AI thinking," not a stall. If no slot
        frees within ``acquire_timeout_s`` it raises a retryable
        ``UpstreamLLMError(overloaded)`` so the turn ends gracefully via
        the existing creator banner rather than hanging the per-session
        lock. No-op (returns ``None``) when the cap is disabled
        (``LLM_MAX_CONCURRENCY=0`` or a bare test subclass).
        """

        sem = self._guardrail_sem if tier == "guardrail" else self._heavy_sem
        if sem is None:
            return None
        t0 = time.monotonic()
        try:
            if self._acquire_timeout_s is not None:
                await asyncio.wait_for(sem.acquire(), timeout=self._acquire_timeout_s)
            else:
                await sem.acquire()
        except TimeoutError as exc:
            waited_ms = int((time.monotonic() - t0) * 1000)
            _logger.warning(
                "llm_acquire_timeout",
                tier=tier,
                session_id=session_id,
                waited_ms=waited_ms,
                timeout_s=self._acquire_timeout_s,
            )
            raise UpstreamLLMError(
                category="overloaded",
                status_code=None,
                request_id=None,
                retry_hint_seconds=None,
                message=(
                    f"local LLM concurrency cap: no slot within "
                    f"{self._acquire_timeout_s}s (tier={tier})"
                ),
            ) from exc
        waited_ms = int((time.monotonic() - t0) * 1000)
        if waited_ms > _QUEUE_LOG_FLOOR_MS:
            _logger.debug(
                "llm_call_queued",
                tier=tier,
                session_id=session_id,
                waited_ms=waited_ms,
            )
            if waited_ms >= _QUEUE_SATURATION_WARN_MS:
                _logger.warning(
                    "llm_concurrency_saturated",
                    tier=tier,
                    session_id=session_id,
                    waited_ms=waited_ms,
                )
                self._notify_backend_degraded(session_id)
        return sem

    @asynccontextmanager
    async def _concurrency_slot(
        self, *, tier: ModelTier, session_id: str | None
    ) -> AsyncIterator[None]:
        """Context-manager form of ``_acquire_slot`` for the non-streamed
        path (``acomplete``). The streaming path manages the slot
        explicitly because it can't wrap its yield-bearing loop in a
        single ``async with`` without re-indenting the whole body.
        """

        sem = await self._acquire_slot(tier=tier, session_id=session_id)
        try:
            yield
        finally:
            if sem is not None:
                sem.release()

    def _notify_backend_degraded(self, session_id: str | None) -> None:
        """Fire-and-forget, creator-only, throttled ``backend_status``
        degraded notice (cost/abuse H2).

        Low-information by design — no counts, no tiers, no internals:
        just "heavy load, responses may be delayed" so the creator
        understands the lag without leaking capacity details. Players keep
        seeing the normal "AI is thinking" indicator. Throttled per
        session so a sustained burst doesn't spam the creator's socket;
        swallows + logs any failure so a flaky WS layer never breaks the
        LLM call.
        """

        if not session_id or self._connections is None:
            return
        now = time.monotonic()
        last = self._last_degraded_notify.get(session_id, 0.0)
        if now - last < _DEGRADED_NOTIFY_THROTTLE_S:
            return
        self._last_degraded_notify[session_id] = now
        event: dict[str, Any] = {
            "type": "backend_status",
            "status": "degraded",
            "message": "Heavy load — responses may be delayed.",
        }
        try:
            asyncio.get_running_loop().create_task(
                self._connections.broadcast_to_creator(session_id, event)
            )
        except Exception as exc:
            _logger.warning(
                "backend_status_notify_failed",
                session_id=session_id,
                error=str(exc),
            )

    # Abstract API surface ---------------------------------------------------

    @abstractmethod
    async def aclose(self) -> None:
        """Release any underlying SDK resources. Idempotent."""

    @abstractmethod
    def model_for(self, tier: ModelTier) -> str:
        """Resolve the model id for the given tier."""

    @abstractmethod
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
        """One-shot non-streamed completion.

        ``tool_choice`` accepts the Anthropic-shaped dict
        (``{"type": "any"}``, ``{"type": "tool", "name": ...}``, etc.);
        provider-specific clients translate at the wire boundary.
        ``max_tokens`` defaults to ``settings.max_tokens_for(tier)``.
        """

    @abstractmethod
    def astream(
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
        """Yield streamed events. Terminal event has ``type == "complete"``
        and carries the final ``LLMResult`` under the ``result`` key.
        """


__all__ = ["ChatClient", "InFlightCall", "LLMResult"]
