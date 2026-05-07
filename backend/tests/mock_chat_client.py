"""Backend-agnostic ``ChatClient`` mock for tests (Phase 4 of #193).

Sibling to ``mock_anthropic.MockAnthropic``: that one mocks the
Anthropic SDK *transport* and is wired via ``LLMClient.set_transport``;
this one mocks the ``ChatClient`` *interface* and is wired by replacing
``app.state.llm`` outright. The latter works regardless of which
backend's class would otherwise be in use, so tests written against
``MockChatClient`` survive the eventual ``LLM_BACKEND=litellm`` flip
without rewrite.

Today's existing tests use ``MockAnthropic`` and that's fine — they
pass with the default ``LLM_BACKEND=anthropic`` and exercise the
production path through ``LLMClient``. New tests should reach for
``MockChatClient`` instead. Phase 8 migrates the existing 19 callers
in one sweep when ``LLMClient`` (Anthropic-direct) is removed
alongside the ``anthropic`` dep.

# Scripts API

The script shape mirrors ``MockAnthropic.scripts`` for ergonomic
parity: a per-tier dict of ``LLMResult`` lists. Each call pops the
next response. When the script for a tier is exhausted, a benign
default response (one ``end_turn`` text block) is returned.

  scripts = {
      "play": [
          llm_result(text_block("hello"), stop_reason="end_turn"),
          llm_result(tool_block("broadcast", {"message": "hi"}), stop_reason="tool_use"),
      ],
      "setup": [
          llm_result(tool_block("ask_setup_question", {"question": "?"})),
      ],
  }
  app.state.llm = MockChatClient(scripts=scripts)
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from app.config import ModelTier
from app.llm.protocol import ChatClient, LLMResult


def text_block(text: str) -> dict[str, Any]:
    """Anthropic-shaped text content block for ``LLMResult.content``."""

    return {"type": "text", "text": text}


def tool_block(
    name: str,
    input: dict[str, Any],
    block_id: str | None = None,
) -> dict[str, Any]:
    """Anthropic-shaped tool_use content block for ``LLMResult.content``."""

    return {
        "type": "tool_use",
        "id": block_id or f"tu_{name}",
        "name": name,
        "input": input,
    }


def llm_result(
    *blocks: dict[str, Any],
    model: str = "mock-llm",
    stop_reason: str = "end_turn",
    usage: dict[str, int] | None = None,
    estimated_usd: float = 0.0,
) -> LLMResult:
    """Build an ``LLMResult`` from content blocks.

    Default ``usage`` mirrors the ``_UsageBlock`` defaults in
    ``MockAnthropic`` so cost-related assertions stay consistent
    across the two mocks.
    """

    return LLMResult(
        model=model,
        content=list(blocks),
        stop_reason=stop_reason,
        usage=usage or {"input": 100, "output": 80, "cache_read": 60, "cache_creation": 40},
        estimated_usd=estimated_usd,
    )


def _benign_default() -> LLMResult:
    """Generic ``end_turn`` response used when a script is exhausted."""

    return llm_result(text_block("ok"), stop_reason="end_turn")


def install_mock_chat_client(
    test_client: Any,
    scripts: dict[str, list[LLMResult]] | None = None,
    *,
    default_response: LLMResult | None = None,
) -> MockChatClient:
    """Replace every LLM-client reference in the app with a fresh ``MockChatClient``.

    ``SessionManager``, ``InputGuardrail``, and ``AARGenerator`` each
    capture a reference to the client at construction time. Writing to
    ``app.state.llm`` only updates the canonical handle; the captured
    references would still point at the original ``LiteLLMChatClient``
    (or whichever backend the lifespan built). This helper updates
    them all atomically.

    Returns the constructed mock so tests can inspect ``calls`` after
    the fact:

        mock = install_mock_chat_client(client, scripts={"play": [...]})
        ...
        assert mock.calls[0]["tier"] == "play"

    The ``set_transport`` pattern from the legacy ``MockAnthropic``
    worked without this helper because it modified the *internals* of
    a single ``LLMClient`` instance that every reference holder
    shared. ``MockChatClient`` is a sibling class — replacing it
    requires touching every holder.
    """

    mock = MockChatClient(scripts=scripts, default_response=default_response)
    state = test_client.app.state
    state.llm = mock
    manager = getattr(state, "manager", None)
    if manager is not None:
        manager._llm = mock
        guardrail = getattr(manager, "_guardrail", None)
        if guardrail is not None:
            guardrail._llm = mock
    return mock


def setup_then_play_script(
    *,
    role_ids: list[str],
    extension_tool: str | None,
    fire_critical: bool = True,
) -> dict[str, list[LLMResult]]:
    """Canonical 3-tier scripted exercise: setup → play → AAR.

    Builds the same shape as the legacy ``mock_anthropic.setup_then_play_script``
    so test bodies stay identical across the migration. Per-tier
    ``stop_reason`` values match what the production code expects:
    setup tier always emits a tool call (``stop_reason="tool_use"``);
    play turns alternate text/tool patterns; AAR fires the
    ``finalize_report`` tool exactly once.

    Used by integration tests that drive a full session end-to-end —
    see ``test_session_manager``, ``test_turn_driver``,
    ``test_chat_declutter_polish``, ``test_kick_regression``,
    ``tests/scenarios/conftest.py``, etc.
    """

    setup_responses = [
        llm_result(
            text_block("Welcome — let's set this up."),
            tool_block("ask_setup_question", {"topic": "industry", "question": "What industry?"}),
            stop_reason="tool_use",
        ),
        llm_result(
            tool_block(
                "propose_scenario_plan",
                {
                    "title": "Ransomware via vendor portal",
                    "executive_summary": "Vendor portal compromise leading to ransomware.",
                    "key_objectives": ["containment", "comms"],
                    "narrative_arc": [
                        {"beat": 1, "label": "Detection", "expected_actors": [role_ids[0]]},
                        {"beat": 2, "label": "Containment", "expected_actors": role_ids[:2]},
                    ],
                    "injects": [
                        {"trigger": "after beat 2", "type": "critical", "summary": "Twitter leak"}
                    ],
                    "guardrails": ["stay in scope"],
                    "success_criteria": ["containment in 30 min"],
                    "out_of_scope": ["recipe generation"],
                },
            ),
            stop_reason="tool_use",
        ),
        llm_result(
            tool_block(
                "finalize_setup",
                {
                    "title": "Ransomware via vendor portal",
                    "executive_summary": "Vendor portal compromise leading to ransomware.",
                    "key_objectives": ["containment", "comms"],
                    "narrative_arc": [
                        {"beat": 1, "label": "Detection", "expected_actors": [role_ids[0]]},
                    ],
                    "injects": [
                        {
                            "trigger": "after beat 1",
                            "type": "critical",
                            "summary": "Twitter leak",
                        }
                    ],
                    "guardrails": [],
                    "success_criteria": [],
                    "out_of_scope": [],
                },
            ),
            stop_reason="tool_use",
        ),
    ]

    play: list[LLMResult] = []
    play.append(
        llm_result(
            text_block("Initial detection — alarms on the vendor portal."),
            tool_block("broadcast", {"message": "Detection at 03:14"}),
            tool_block("set_active_roles", {"role_ids": [role_ids[0]]}),
            stop_reason="tool_use",
        )
    )
    for i in range(8):
        active = [role_ids[(i + 1) % len(role_ids)]]
        if i == 2:
            play.append(
                llm_result(
                    tool_block(
                        "use_extension_tool",
                        {
                            "name": extension_tool or "lookup_threat_intel",
                            "args": {"ioc": "1.2.3.4"},
                        },
                    ),
                    tool_block("set_active_roles", {"role_ids": active}),
                    stop_reason="tool_use",
                )
            )
            continue
        if i == 3 and fire_critical:
            play.append(
                llm_result(
                    tool_block(
                        "inject_critical_event",
                        {
                            "severity": "HIGH",
                            "headline": "Twitter leak of customer PII",
                            "body": "External breach of customer data confirmed.",
                        },
                    ),
                    tool_block("set_active_roles", {"role_ids": active}),
                    stop_reason="tool_use",
                )
            )
            continue
        play.append(
            llm_result(
                text_block(f"Turn {i + 2}: continue exercise."),
                tool_block("set_active_roles", {"role_ids": active}),
                stop_reason="tool_use",
            )
        )
    play.append(
        llm_result(
            tool_block("end_session", {"reason": "exercise complete"}),
            stop_reason="tool_use",
        )
    )

    aar = [
        llm_result(
            tool_block(
                "finalize_report",
                {
                    "executive_summary": "Team responded effectively.",
                    "narrative": "Detection → containment → comms.",
                    "what_went_well": ["fast triage"],
                    "gaps": ["legal looped in late"],
                    "recommendations": ["pre-stage legal contact"],
                    "per_role_scores": [
                        {
                            "role_id": rid,
                            "decision_quality": 4,
                            "communication": 4,
                            "speed": 3,
                            "rationale": "balanced",
                        }
                        for rid in role_ids
                    ],
                    "overall_score": 4,
                    "overall_rationale": "Solid exercise with minor gaps.",
                },
                block_id="tu_aar",
            ),
            stop_reason="tool_use",
        )
    ]

    return {"setup": setup_responses, "play": play, "aar": aar}


class MockChatClient(ChatClient):
    """Test-only ``ChatClient`` returning scripted ``LLMResult``s.

    Inherits ``_in_flight`` / ``_connections`` / ``_begin_call`` /
    ``_end_call`` / ``set_connections`` / ``in_flight_for`` / etc.
    from the base class — the lifecycle wiring is identical to a real
    backend, so tests that observe ``ai_thinking`` events via the
    connection manager work unchanged.
    """

    def __init__(
        self,
        scripts: dict[str, list[LLMResult]] | None = None,
        *,
        default_response: LLMResult | None = None,
    ) -> None:
        super().__init__()
        self._scripts = {tier: list(rs) for tier, rs in (scripts or {}).items()}
        self._default = default_response or _benign_default()
        self._calls: list[dict[str, Any]] = []

    @property
    def calls(self) -> list[dict[str, Any]]:
        """Per-call kwargs log so tests can assert on what the model
        was asked to do (which tier, which tools, which messages).
        Read-only — tests should treat it as a snapshot.
        """

        return list(self._calls)

    def model_for(self, tier: ModelTier) -> str:
        return f"mock-{tier}"

    async def aclose(self) -> None:
        pass

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
        call = self._begin_call(
            session_id=session_id, tier=tier, model=self.model_for(tier), stream=False
        )
        try:
            self._calls.append(
                {
                    "tier": tier,
                    "model": self.model_for(tier),
                    "system": system_blocks,
                    "messages": messages,
                    "tools": tools,
                    "tool_choice": tool_choice,
                    "max_tokens": max_tokens,
                    "extension_tool_names": extension_tool_names,
                }
            )
            scripts = self._scripts.get(tier, [])
            return scripts.pop(0) if scripts else self._default
        finally:
            self._end_call(session_id, call)

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
        # We don't run the call through ``acomplete`` because that
        # would emit a non-streaming ``ai_thinking`` event. Replicate
        # the bookkeeping here with stream=True.
        call = self._begin_call(
            session_id=session_id, tier=tier, model=self.model_for(tier), stream=True
        )
        try:
            self._calls.append(
                {
                    "tier": tier,
                    "model": self.model_for(tier),
                    "system": system_blocks,
                    "messages": messages,
                    "tools": tools,
                    "tool_choice": tool_choice,
                    "max_tokens": max_tokens,
                    "extension_tool_names": extension_tool_names,
                    "stream": True,
                }
            )
            scripts = self._scripts.get(tier, [])
            result = scripts.pop(0) if scripts else self._default

            text_chunks: list[str] = []
            for block in result.content:
                if block.get("type") == "text":
                    text = block.get("text", "")
                    if text:
                        text_chunks.append(text)
                        yield {"type": "text_delta", "text": text}
            yield {
                "type": "complete",
                "result": result,
                "text": "".join(text_chunks),
            }
        finally:
            self._end_call(session_id, call)
