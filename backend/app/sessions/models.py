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

from pydantic import BaseModel, ConfigDict, Field, computed_field

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


class WorkstreamState(StrEnum):
    OPEN = "open"
    CLOSED = "closed"


class Workstream(BaseModel):
    """Phase-A chat-declutter primitive (docs/plans/chat-decluttering.md).

    A long-running parallel concern within a single tabletop session.
    AI-declared during setup via ``declare_workstreams``; lives until
    session end (no mid-session lifecycle in Phase A — see plan §10
    Q3). Session-scoped: ``id`` is unique per-session, never global
    (plan §6.5). Color is assigned client-side in declaration order;
    not stored.

    Workstream metadata is **not** load-bearing for play correctness
    (plan §6.1). The play engine, phase policy, and turn validator
    are workstream-blind — a missing or invalid ``workstream_id`` on
    a message renders under the synthetic ``#main`` bucket and the
    turn still progresses.
    """

    model_config = ConfigDict(extra="forbid")

    id: str = Field(
        ...,
        min_length=1,
        max_length=32,
        pattern=r"^[a-z][a-z0-9_]*$",
    )
    label: str = Field(..., min_length=1, max_length=24)
    lead_role_id: str | None = None
    state: WorkstreamState = WorkstreamState.OPEN
    created_at: datetime = Field(default_factory=_now)
    closed_at: datetime | None = None


ParticipantKind = Literal["player", "spectator"]
TurnStatus = Literal["awaiting", "processing", "complete", "errored"]
RosterSize = Literal["small", "medium", "large"]
AARStatus = Literal["pending", "generating", "ready", "failed"]
Difficulty = Literal["easy", "standard", "hard"]


class SessionFeatures(BaseModel):
    """Creator-selected feature toggles that shape AI facilitation.

    Picked on the new-session wizard alongside difficulty and target
    duration, frozen at creation time. Surfaced into the setup AND
    play system prompts so the model tunes pacing, adversary
    aggression, and inject themes without re-asking the creator.

    Default skew is "balanced standard tabletop": three pressure
    sources on, media off because press inquiries land cleanly only
    when the seed prompt explicitly invites them.
    """

    model_config = ConfigDict(extra="forbid")

    active_adversary: bool = True
    """Red side actively counters player moves, probes for re-entry."""

    time_pressure: bool = True
    """Critical injects fire on deadlines; urgency escalates over the session."""

    executive_escalation: bool = True
    """C-suite / board demands updates and forces reprioritization mid-beat."""

    media_pressure: bool = False
    """Press inquiries, social-media leaks, reputational injects."""


class SessionSettings(BaseModel):
    """Creator-selected scenario tuning, frozen at session creation.

    Lives on ``Session.settings``. Read by the prompt builders
    (``_build_session_settings_block``) and surfaced verbatim into
    the setup + play system blocks. The setup AI is instructed NOT
    to re-ask difficulty / duration / features — they're decided in
    the wizard before the first LLM call.
    """

    model_config = ConfigDict(extra="forbid")

    difficulty: Difficulty = "standard"
    duration_minutes: int = Field(default=60, ge=15, le=180)
    features: SessionFeatures = Field(default_factory=SessionFeatures)


class Role(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(default_factory=_short_id)
    label: str
    display_name: str | None = None
    kind: ParticipantKind = "player"
    is_creator: bool = False
    joined_at: datetime = Field(default_factory=_now)
    # Bumped on "kick / revoke link" — old tokens become invalid because
    # ``authn.verify`` checks the embedded ``v`` against the role's current
    # version. Default 0; only changes on explicit revocation.
    token_version: int = 0


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
    # Issue #78: True when this PLAYER message was posted by a role that
    # was NOT in the current turn's active set (or had already submitted)
    # — i.e. an out-of-turn interjection. The play-turn prompt renders
    # interjections with an explicit ``[OUT-OF-TURN] …`` marker so the AI
    # doesn't mistake the interjector for an active responder. The
    # transcript UI uses the same flag to render a "sidebar" badge so
    # human players don't confuse an interjection with a turn answer.
    is_interjection: bool = False
    # When this PLAYER message was posted while the session was in
    # ``AI_PROCESSING`` (the AI is generating its turn). Set on the
    # message by ``submit_response`` so the audit log + AAR replay can
    # distinguish "responded on turn" from "side-noted while AI was
    # thinking". Always ``False`` for AI / system messages.
    during_ai_processing: bool = False
    # Phase A chat-declutter (docs/plans/chat-decluttering.md §4.1):
    # ``workstream_id`` categorizes this message into one of the
    # session's declared workstreams (or ``None`` for the synthetic
    # ``#main`` bucket). Validated at dispatch time against the
    # session's declared set; invalid values fall back to ``None``
    # rather than failing the tool call (plan §7.3). Purely metadata
    # — never load-bearing for play correctness (plan §6.1).
    workstream_id: str | None = None
    # ``mentions`` is the structural source for the @-highlight
    # affordance (plan §5.1). Server-populated for AI messages from
    # the ``role_id`` arg of ``address_role`` (and any future
    # directly-addressed tools); user-typed @-mentions land here in
    # Phase C. The frontend renders the highlight from this list,
    # **never** from regex-scanning ``body``, so the highlight is
    # decoupled from the model's prose habits.
    mentions: list[str] = Field(default_factory=list)
    # Wave 3 (issue #69): True when this player message tagged
    # ``@facilitator`` AND ``Session.ai_paused`` was set at submit
    # time. The transcript renders a "AI silenced — won't reply"
    # indicator under the bubble so the player understands why no
    # AI reply followed. Persisted on the message (rather than
    # computed client-side from a moving pause flag) so the
    # indicator survives snapshot reloads even after the creator
    # resumes the AI later in the session.
    ai_paused_at_submit: bool = False
    # Issue #162: per-message "hidden from AI" mute. When True, the
    # message stays in the human-visible transcript (with a "hidden
    # from AI" badge) but is filtered out of every LLM-tier user
    # block (play / interject / AAR). Toggled via the right-click
    # contextmenu by the creator or the message-of-record's role.
    # The AI sees the new state on the next user-block build, not
    # retroactively (a previous turn's transcript stays as it was).
    hidden_from_ai: bool = False

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
    # Optional-mentions model (issue #168). The AI yields to one or more
    # *groups* of roles; each group is closed when ANY ONE of its
    # members signals ``intent="ready"`` and the turn advances when
    # *every* group is closed. A single-role group is the "must
    # respond" case (same shape as the pre-#168 single-id yield); a
    # multi-role group is the "either of you can answer" case (the
    # screenshot from issue #168: "Paul and Lawrence — one of you owns
    # this ticket"). The flat union is exposed as ``active_role_ids``
    # for legacy reads (visibility checks, "is this role on the active
    # set?" predicates, frontend chrome). Mutations always go through
    # ``active_role_groups`` so the gate stays in sync.
    active_role_groups: list[list[str]] = Field(default_factory=list)
    submitted_role_ids: list[str] = Field(default_factory=list)
    # Ready-quorum gate. A role lands here when it explicitly fired the
    # ``set_ready`` WS event (handled by ``manager.set_role_ready``);
    # walking back fires the same event with ``ready=False`` and removes
    # the role. Submissions never touch this set — typing or sending
    # messages does NOT mark a role ready.
    #
    # Issue #168 role-groups model: the play engine advances
    # ``AWAITING_PLAYERS → AI_PROCESSING`` when
    # ``groups_quorum_met(turn)`` returns True — i.e. every group in
    # ``active_role_groups`` has at least one role in
    # ``ready_role_ids`` (any-of-N per group). A single-role group
    # reduces to the strict "that role must ready" case; a multi-role
    # group is the "either of you can answer" case. Force-advance
    # bypasses entirely. Briefing turns never gate on it. Resets every
    # turn (each new active role starts not-ready).
    ready_role_ids: list[str] = Field(default_factory=list)
    # Per-turn flip cap counter — ``manager.set_role_ready`` increments
    # this for ``role_id`` on every accepted toggle (mark or walk-back).
    # Once any role's count hits ``READY_FLIP_CAP_PER_TURN`` (5), further
    # toggles for that role on this turn are rejected with
    # ``reason="flip_cap_exceeded"``. Mirrors the per-turn submission cap
    # — protects the audit log + WS broadcast surface from a buggy or
    # malicious client flapping ready→not-ready 100x/sec.
    ready_flip_count_by_role: dict[str, int] = Field(default_factory=dict)
    # Debounce ledger: per-role timestamp of the most recent accepted
    # ``ready_changed`` emit. ``manager.set_role_ready`` drops a toggle
    # silently (no audit, no broadcast, no flip-cap increment) when the
    # role's most recent emit was within ``READY_DEBOUNCE_MS`` (250ms).
    # Smooths double-clicks without burning the flip cap.
    last_ready_change_ts_by_role: dict[str, datetime] = Field(default_factory=dict)
    status: TurnStatus = "awaiting"
    started_at: datetime = Field(default_factory=_now)
    ended_at: datetime | None = None
    error_reason: str | None = None
    retried_with_strict: bool = False
    # Issue #111: per-turn AI sub-step progress (0.0–1.0). Written by
    # ``turn_driver.run_play_turn`` at known sub-step boundaries
    # (planning → tool dispatch → emit / yield) so the frontend's
    # TURN STATE rail can render a determinate bar instead of the
    # indeterminate sweep. ``None`` while the turn has not yet
    # produced a meaningful sub-step (e.g. waiting on the LLM call to
    # start) — the rail falls back to the sweep in that case.
    # Only populated while ``session.state`` is AI_PROCESSING /
    # BRIEFING; AWAITING_PLAYERS computes its own progress from
    # ``submitted_role_ids / active_role_ids`` at snapshot time.
    ai_progress_pct: float | None = None

    # mypy doesn't recognize ``@computed_field`` stacked on top of
    # ``@property`` (https://github.com/pydantic/pydantic/issues/9417)
    # — Pydantic v2's recommended pattern for a serialized derived
    # field, but typed as if the decorator order were illegal. The
    # ignore is the documented workaround until pydantic-stubs lands
    # the fix; revisit when bumping pydantic past 2.7.
    @computed_field  # type: ignore[prop-decorator]
    @property
    def active_role_ids(self) -> list[str]:
        """Flat union of every role mentioned across ``active_role_groups``.

        Preserves first-seen order so the legacy ordering (which the
        frontend's "your turn" predicate and a few audit lines rely on)
        survives the move to groups. De-duplicates because a role
        legitimately appears in only one group, but defensive code may
        construct duplicates during narrowing edge cases.
        """

        seen: set[str] = set()
        flat: list[str] = []
        for group in self.active_role_groups:
            for rid in group:
                if rid not in seen:
                    seen.add(rid)
                    flat.append(rid)
        return flat


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
    # Required arrays — every plan must define a structural backbone
    # (objectives, narrative_arc, injects) so the play tier has
    # something to drive against. Empty plans were the root cause of
    # the "AI freeforms because the plan is hollow" failure mode
    # observed in the 2026-04-29 session. Defense in depth: this
    # Pydantic invariant + the Anthropic tool ``input_schema``
    # ``minItems=1`` on the ``propose_scenario_plan`` /
    # ``finalize_setup`` tools + the dispatcher's
    # ``_validate_plan_completeness`` safety net + the REST plan-edit
    # endpoint inheriting these invariants. No caller can plant an
    # empty plan into a session.
    key_objectives: list[str] = Field(..., min_length=1)
    narrative_arc: list[ScenarioBeat] = Field(..., min_length=1)
    injects: list[ScenarioInject] = Field(..., min_length=1)
    guardrails: list[str] = Field(default_factory=list)
    success_criteria: list[str] = Field(default_factory=list)
    out_of_scope: list[str] = Field(default_factory=list)
    # Phase A chat-declutter (docs/plans/chat-decluttering.md §4.1):
    # AI-declared workstreams for this session. Empty list = no
    # categorization (single ``#main`` bucket); populated when the
    # AI calls ``declare_workstreams`` during setup with the
    # ``workstreams_enabled`` feature flag on. Stripped from the
    # AAR pipeline's serialization per plan §6.9 — workstreams are
    # a live-exercise affordance, not a post-mortem artifact.
    workstreams: list[Workstream] = Field(default_factory=list)


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
    """One utterance in the setup dialogue."""

    model_config = ConfigDict(extra="forbid")

    ts: datetime = Field(default_factory=_now)
    speaker: Literal["ai", "creator"]
    content: str
    topic: str | None = None
    options: list[str] | None = None


class RoleFollowup(BaseModel):
    """A per-role open item the AI is tracking across turns.

    Maintained by the AI via the ``track_role_followup`` /
    ``resolve_role_followup`` tools. Surfaced back into the play system
    prompt every turn so the AI doesn't forget unanswered asks.
    """

    model_config = ConfigDict(extra="forbid")

    id: str = Field(default_factory=_short_id)
    role_id: str
    prompt: str
    status: Literal["open", "done", "dropped"] = "open"
    created_at: datetime = Field(default_factory=_now)
    resolved_at: datetime | None = None


class DecisionLogEntry(BaseModel):
    """One AI-emitted rationale line attached to a play turn.

    Captured via the ``record_decision_rationale`` tool. Surfaced to the
    creator (live, via WebSocket) and embedded in the AAR appendix so
    the operator can replay why the AI picked the actions it did. See
    issue #55. Player roles never see this content — the rationale is
    creator/debug-only by design.
    """

    model_config = ConfigDict(extra="forbid")

    id: str = Field(default_factory=_short_id)
    ts: datetime = Field(default_factory=_now)
    turn_index: int | None = None
    turn_id: str | None = None
    rationale: str


class NotepadState(BaseModel):
    """Snapshot-side state for the shared markdown notepad (issue #98).

    The Yjs binary state itself lives on :class:`SessionManager` as a
    per-session ``pycrdt.Doc`` (not pydantic-serializable). This model
    holds only the values the snapshot/AAR pipeline reads: the most
    recent markdown extraction (pushed by clients), lock status, and
    accounting fields.
    """

    model_config = ConfigDict(extra="forbid")

    created_at: datetime = Field(default_factory=_now)
    locked: bool = False
    locked_at: datetime | None = None
    # Latest markdown view of the notepad. Pushed by clients via the
    # /notepad/snapshot endpoint (debounced) and forced on session end.
    # Source of truth for AAR ingestion.
    markdown_snapshot: str = ""
    snapshot_updated_at: datetime | None = None
    # Which starter template was applied (generic_ir / ransomware / data_breach / "custom" / None).
    template_id: str | None = None
    edit_count: int = 0
    # Idempotency keys for pin actions. Each entry is
    # ``f"{action}:{source_message_id}"`` where ``action`` is ``"pin"``
    # (Add to notes) or ``"aar_mark"`` (Mark for AAR review). Two
    # different actions on the same message are kept distinct so a user
    # can both pin a message to notes AND mark it for AAR review without
    # one shadowing the other. A different selection from the same
    # message + action creates a new pin (different request) — that's
    # expected; this list only deduplicates accidental double-clicks of
    # the same affordance.
    pinned_message_keys: list[str] = Field(default_factory=list)
    # Roles that have emitted at least one update or pin. Used by the
    # export.md header to render "Contributors: ..." without scanning
    # the audit log.
    contributor_role_ids: list[str] = Field(default_factory=list)


class Session(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(default_factory=_short_id)
    tenant_id: str | None = None  # tenancy stub
    state: SessionState = SessionState.CREATED
    created_at: datetime = Field(default_factory=_now)
    ended_at: datetime | None = None

    scenario_prompt: str
    settings: SessionSettings = Field(default_factory=SessionSettings)
    plan: ScenarioPlan | None = None
    active_extension_prompts: list[str] = Field(default_factory=list)

    roles: list[Role] = Field(default_factory=list)
    creator_role_id: str | None = None

    setup_notes: list[SetupNote] = Field(default_factory=list)
    role_followups: list[RoleFollowup] = Field(default_factory=list)
    # AI-emitted reasoning lines, one per ``record_decision_rationale``
    # call. Creator-only on the snapshot; embedded in the AAR appendix.
    # Bounded by the per-turn dispatcher (no cap on total length here —
    # the play-tier prompt asks for one short line per turn, so an
    # exercise that runs 30 turns produces ~30 short entries).
    decision_log: list[DecisionLogEntry] = Field(default_factory=list)

    turns: list[Turn] = Field(default_factory=list)
    messages: list[Message] = Field(default_factory=list)

    cost: TokenUsage = Field(default_factory=TokenUsage)
    critical_injects_window: list[int] = Field(default_factory=list)
    """Indices of recent turns that fired ``inject_critical_event``; trimmed to a 5-turn window."""
    critical_inject_rate_limit_until: int | None = None
    """If set, the turn index at which ``inject_critical_event`` becomes
    callable again. Tracks the rate-limit window across turns so the
    play system prompt can surface a "you're rate-limited until turn N"
    nudge to the model — without it, the AI was observed retrying the
    same critical-event call on three consecutive turns after the
    first attempt was rejected. Cleared when the rolling window
    drops below the cap."""

    notepad: NotepadState = Field(default_factory=NotepadState)

    # Wave 2 (composer mentions + facilitator routing): when True, the
    # WS routing branch in ``ws/routes.py`` skips ``run_interject`` for
    # ``@facilitator`` mentions — the message still lands in the
    # transcript with the highlight, but the AI does not respond.
    # The toggle UI / endpoint that flips this flag is Wave 3 (issue
    # #69) and intentionally not part of this PR; the model field is
    # included now so the routing branch can structurally consume it
    # and tests can flip it manually.
    ai_paused: bool = False

    aar_markdown: str | None = None
    aar_status: AARStatus = "pending"
    aar_error: str | None = None
    # Structured form of the AAR (the ``finalize_report`` tool input that
    # the AAR generator already produces). Persisted alongside the
    # rendered markdown so the frontend can render a structured layout
    # (per-role score cards, narrative + bullet blocks) without parsing
    # markdown back into fields. Same lifecycle as ``aar_markdown``: set
    # together when generation succeeds, cleared / re-set on retry.
    aar_report: dict[str, Any] | None = None

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
