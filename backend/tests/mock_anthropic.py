"""Deterministic Anthropic transport mock for integration tests.

Mocks the minimal surface :class:`app.llm.client.LLMClient` consumes:
* ``messages.create(**kwargs) -> response`` with ``content`` blocks + ``usage``,
* ``messages.stream(**kwargs)`` async-context-managed iterator.

The mock takes a script of *responses* keyed loosely by model id; each call
pops the next scripted response. If the script is exhausted, a benign final
turn is returned.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any


@dataclass
class _UsageBlock:
    input_tokens: int = 100
    output_tokens: int = 80
    cache_read_input_tokens: int = 60
    cache_creation_input_tokens: int = 40


@dataclass
class _ContentBlock:
    type: str
    text: str = ""
    name: str = ""
    input: dict[str, Any] = field(default_factory=dict)
    id: str = ""


@dataclass
class _Response:
    content: list[_ContentBlock]
    stop_reason: str = "end_turn"
    usage: _UsageBlock = field(default_factory=_UsageBlock)


def text_block(text: str) -> _ContentBlock:
    return _ContentBlock(type="text", text=text)


def tool_block(name: str, input: dict[str, Any], block_id: str | None = None) -> _ContentBlock:
    return _ContentBlock(
        type="tool_use",
        name=name,
        input=input,
        id=block_id or f"tu_{name}",
    )


def response(*blocks: _ContentBlock, stop_reason: str = "tool_use") -> _Response:
    return _Response(content=list(blocks), stop_reason=stop_reason)


class MockMessages:
    def __init__(self, scripts: dict[str, list[_Response]]) -> None:
        # Per-tier scripts. Unknown tier falls back to a generic ``end_turn`` response.
        self._scripts = {k: list(v) for k, v in scripts.items()}
        self._call_log: list[dict[str, Any]] = []

    @property
    def calls(self) -> list[dict[str, Any]]:
        return self._call_log

    async def create(self, **kwargs: Any) -> _Response:
        self._call_log.append(kwargs)
        tier = self._tier_of(kwargs.get("model", ""))
        return self._next(tier)

    def stream(self, **kwargs: Any) -> Any:
        self._call_log.append(kwargs)
        tier = self._tier_of(kwargs.get("model", ""))
        resp = self._next(tier)
        return _StreamCtx(resp)

    # --------------------------------------------------- internals
    def _tier_of(self, model: str) -> str:
        m = model.lower()
        for needle in ("setup", "guardrail", "aar", "play"):
            if needle in m:
                return needle
        if "opus" in m:
            return "aar"
        if "haiku" in m:
            return "setup"
        return "play"

    def _next(self, tier: str) -> _Response:
        bucket = self._scripts.get(tier)
        if not bucket:
            return response(
                tool_block("end_session", {"reason": "scripted-default"}),
                stop_reason="tool_use",
            )
        return bucket.pop(0)


class _StreamCtx:
    """Async context manager mimicking the Anthropic streaming API surface."""

    def __init__(self, resp: _Response) -> None:
        self._resp = resp

    async def __aenter__(self) -> _StreamCtx:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    def __aiter__(self) -> AsyncIterator[Any]:
        return self._iter()

    async def _iter(self) -> AsyncIterator[Any]:
        # Yield text deltas for any text content blocks; emit
        # ``content_block_start`` at the head of each ``tool_use`` block
        # so the Anthropic-direct ``astream`` translates it into the
        # ``tool_use_start`` event the setup-tier driver listens for.
        for block in self._resp.content:
            if block.type == "text" and block.text:
                yield _StreamEvent(
                    type="content_block_delta",
                    delta=_StreamDelta(type="text_delta", text=block.text),
                    content_block=None,
                )
            elif block.type == "tool_use":
                yield _StreamEvent(
                    type="content_block_start",
                    delta=None,
                    content_block=_StreamBlock(type="tool_use", name=block.name),
                )

    async def get_final_message(self) -> _Response:
        return self._resp


@dataclass
class _StreamEvent:
    type: str
    delta: Any
    content_block: Any


@dataclass
class _StreamDelta:
    type: str
    text: str = ""


@dataclass
class _StreamBlock:
    type: str
    name: str | None = None


class MockAnthropic:
    """Drop-in for :class:`anthropic.AsyncAnthropic`."""

    def __init__(self, scripts: dict[str, list[_Response]]) -> None:
        self.messages = MockMessages(scripts)


def setup_then_play_script(
    *,
    role_ids: list[str],
    extension_tool: str | None,
    fire_critical: bool = True,
) -> dict[str, list[_Response]]:
    """Standard scripted exercise: setup → finalize → ≥10 turns → end."""

    setup_responses = [
        response(
            text_block("Welcome — let's set this up."),
            tool_block("ask_setup_question", {"topic": "industry", "question": "What industry?"}),
        ),
        response(
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
        ),
        response(
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
        ),
    ]

    play: list[_Response] = []
    play.append(
        response(
            text_block("Initial detection — alarms on the vendor portal."),
            tool_block("broadcast", {"message": "Detection at 03:14"}),
            tool_block("set_active_roles", {"role_groups": [[r] for r in [role_ids[0]]]}),
        )
    )
    for i in range(8):
        active = [role_ids[(i + 1) % len(role_ids)]]
        if i == 2:
            play.append(
                response(
                    tool_block(
                        "use_extension_tool",
                        {"name": extension_tool or "lookup_threat_intel", "args": {"ioc": "1.2.3.4"}},
                    ),
                    tool_block("set_active_roles", {"role_groups": [[r] for r in active]}),
                )
            )
            continue
        if i == 3 and fire_critical:
            play.append(
                response(
                    tool_block(
                        "inject_critical_event",
                        {
                            "severity": "HIGH",
                            "headline": "Twitter leak of customer PII",
                            "body": "External breach of customer data confirmed.",
                        },
                    ),
                    tool_block("set_active_roles", {"role_groups": [[r] for r in active]}),
                )
            )
            continue
        play.append(
            response(
                text_block(f"Turn {i + 2}: continue exercise."),
                tool_block("set_active_roles", {"role_groups": [[r] for r in active]}),
            )
        )
    play.append(
        response(
            tool_block("end_session", {"reason": "exercise complete"}),
        )
    )

    aar = [
        response(
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
            )
        )
    ]

    return {"setup": setup_responses, "play": play, "aar": aar}
