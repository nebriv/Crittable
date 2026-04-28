"""Domain models for the session, role, turn, and message graph.

Pydantic v2 throughout. Mutability is allowed — the in-memory repository hands
back live references and the SessionManager mutates them under a per-session
lock. Phase 3 will switch to a persistent repository whose ``save`` rebinds
fresh copies; the manager's call-shape stays the same.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

PLAN_EDITABLE_FIELDS = frozenset(
    {"key_objectives", "guardrails", "injects", "out_of_scope", "success_criteria"}
)


def _now() -> datetime:
    return datetime.now(UTC)


def _short_id() -> str:
    return uuid.uuid4().hex[:12]


class SessionState(StrEnum):
    CREATED = "CREATED"
    SETUP = "SETUP"
    READY = "READY"
    BRIEFING = "BRIEFING"
    AWAITING_PLAYERS = "AWAITING_PLAYERS"
    AI_PROCESSING = "AI_PROCESSING"
    ENDED = "ENDED"


class MessageKind(StrEnum):
    AI_TEXT = "ai_text"
    AI_TOOL_CALL = "ai_tool_call"
    AI_TOOL_RESULT = "ai_tool_result"
    PLAYER = "player"
    SYSTEM = "system"
    CRITICAL_INJECT = "critical_inject"


ParticipantKind = Literal["player", "spectator"]
TurnStatus = Literal["awaiting", "processing", "complete", "errored"]
RosterSize = Literal["small", "medium", "large"]


class Role(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(default_factory=_short_id)
    label: str
    display_name: str | None = None
    kind: ParticipantKind = "player"
    is_creator: bool = False
    joined_at: datetime = Field(default_factory=_now)


class Message(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(default_factory=_short_id)
    ts: datetime = Field(default_factory=_now)
    turn_id: str | None = None
    role_id: str | None = None  # None for AI / system messages
    kind: MessageKind
    body: str = ""
    visibility: list[str] | Literal["all"] = "all"
    tool_name: str | None = None
    tool_args: dict[str, Any] | None = None

    def is_visible_to(self, role_id: str | None, *, is_creator: bool = False) -> bool:
        if self.visibility == "all":
            return True
        if role_id is None:
            # Server-side observer (e.g. AAR pipeline) sees everything.
            return True
        if is_creator:
            return True
        return role_id in self.visibility


class Turn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(default_factory=_short_id)
    index: int
    active_role_ids: list[str] = Field(default_factory=list)
    submitted_role_ids: list[str] = Field(default_factory=list)
    status: TurnStatus = "awaiting"
    started_at: datetime = Field(default_factory=_now)
    ended_at: datetime | None = None
    error_reason: str | None = None
    retried_with_strict: bool = False


class ScenarioInject(BaseModel):
    model_config = ConfigDict(extra="forbid")

    trigger: str
    type: str = "event"
    summary: str


class ScenarioBeat(BaseModel):
    model_config = ConfigDict(extra="forbid")

    beat: int
    label: str
    expected_actors: list[str] = Field(default_factory=list)


class ScenarioPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str
    executive_summary: str = ""
    key_objectives: list[str] = Field(default_factory=list)
    narrative_arc: list[ScenarioBeat] = Field(default_factory=list)
    injects: list[ScenarioInject] = Field(default_factory=list)
    guardrails: list[str] = Field(default_factory=list)
    success_criteria: list[str] = Field(default_factory=list)
    out_of_scope: list[str] = Field(default_factory=list)


class TokenUsage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    estimated_usd: float = 0.0

    def add(self, other: TokenUsage) -> None:
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens
        self.cache_read_tokens += other.cache_read_tokens
        self.cache_creation_tokens += other.cache_creation_tokens
        self.estimated_usd += other.estimated_usd


class SetupNote(BaseModel):
    """One round of the setup dialogue."""

    model_config = ConfigDict(extra="forbid")

    ts: datetime = Field(default_factory=_now)
    speaker: Literal["ai", "creator"]
    content: str
    topic: str | None = None
    options: list[str] | None = None


class Session(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(default_factory=_short_id)
    tenant_id: str | None = None  # tenancy stub
    state: SessionState = SessionState.CREATED
    created_at: datetime = Field(default_factory=_now)
    ended_at: datetime | None = None

    scenario_prompt: str
    plan: ScenarioPlan | None = None
    active_extension_prompts: list[str] = Field(default_factory=list)

    roles: list[Role] = Field(default_factory=list)
    creator_role_id: str | None = None

    setup_notes: list[SetupNote] = Field(default_factory=list)

    turns: list[Turn] = Field(default_factory=list)
    messages: list[Message] = Field(default_factory=list)

    cost: TokenUsage = Field(default_factory=TokenUsage)
    critical_injects_window: list[int] = Field(default_factory=list)
    """Indices of recent turns that fired ``inject_critical_event``; trimmed to a 5-turn window."""

    aar_markdown: str | None = None

    def role_by_id(self, role_id: str) -> Role | None:
        return next((r for r in self.roles if r.id == role_id), None)

    @property
    def current_turn(self) -> Turn | None:
        return self.turns[-1] if self.turns else None

    @property
    def roster_size(self) -> RosterSize:
        n = len(self.roles)
        if n <= 4:
            return "small"
        if n <= 10:
            return "medium"
        return "large"

    def visible_messages(self, role_id: str | None) -> list[Message]:
        is_creator = role_id is not None and role_id == self.creator_role_id
        return [m for m in self.messages if m.is_visible_to(role_id, is_creator=is_creator)]
