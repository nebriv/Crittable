"""Scenario data model — declarative description of a full session lifecycle."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from ..sessions.models import SessionSettings

# All ``MessageKind`` values that the recorder may serialise verbatim.
# Mirrors ``app.sessions.models.MessageKind`` but kept as a Literal so a
# scenario JSON file is decoupled from the engine's own enum imports.
RecordedMessageKind = Literal[
    "ai_text",
    "ai_tool_call",
    "ai_tool_result",
    "player",
    "system",
    "critical_inject",
]


class RoleSpec(BaseModel):
    """One role in the scenario roster.

    The creator role is implicit — it gets created from
    ``Scenario.creator_label`` / ``creator_display_name``. ``RoleSpec``
    entries are non-creator roles added via ``POST /sessions/{id}/roles``
    during setup.
    """

    model_config = ConfigDict(extra="forbid")
    label: str = Field(min_length=1, max_length=64)
    display_name: str | None = Field(default=None, max_length=64)
    kind: Literal["player", "spectator"] = "player"


class SetupReply(BaseModel):
    """One creator-side reply during the AI setup dialogue.

    Each entry is a single ``POST /sessions/{id}/setup/reply`` call. The
    runner sends them in order, waiting for the AI's response after each
    before sending the next so the dialogue stays coherent.

    ``after_state`` is an optional sanity check — when set, the runner
    asserts the session is in that state before sending the reply. Used
    to fail fast when a scenario goes off the rails (e.g. the AI ended
    setup early because the mock script was misordered).
    """

    model_config = ConfigDict(extra="forbid")
    content: str = Field(min_length=1, max_length=4000)
    after_state: str | None = None


class PlayStep(BaseModel):
    """One participant submission within a play turn.

    ``role_label`` references a roster entry by its label (or
    ``"creator"`` for the implicit creator role). The runner resolves
    this to a ``role_id`` at runtime so scenarios stay portable across
    sessions.

    ``content`` is what the player would type into the composer; the
    runner posts it via WebSocket ``submit_response`` (matches the
    real player path, including guardrail + dedupe).

    ``ts`` is the wall-clock time of the original event when the
    scenario was recorded (ISO 8601 string). The deterministic
    runner uses the inter-event delta to pace replay so a connected
    dev tab sees messages appear at the same cadence the real
    session did. ``None`` for hand-authored scenarios — the runner
    falls back to a fixed-pace default in that case.
    """

    model_config = ConfigDict(extra="forbid")
    role_label: str = Field(min_length=1)
    content: str = Field(min_length=1, max_length=4000)
    ts: str | None = None
    # Wave 1 (issue #134): per-submission intent for the ready-quorum
    # gate. Defaults to ``"ready"`` so legacy hand-authored scenarios
    # (and recordings captured before the field was added) replay with
    # the historical "submit-and-advance" semantics. Hand-authored
    # scenarios that exercise discussion flows should set
    # ``intent="discuss"`` on the early submissions and
    # ``intent="ready"`` on the closing one. The runner threads this
    # field through ``prepare_and_submit_player_response`` in both
    # engine and deterministic modes.
    intent: Literal["ready", "discuss"] = "ready"


class RecordedMessage(BaseModel):
    """An AI / system / inject message captured for deterministic replay.

    The recorder dumps every non-player ``Message`` here so a replay
    against ``replay_mode="deterministic"`` can reproduce the EXACT
    transcript that drove the original UI — message highlights,
    role-coded colours, filtering, the broadcast/share_data tool icons,
    everything that depends on ``Message.kind`` + ``Message.tool_name``
    + ``Message.body``.

    Identity rule (CLAUDE.md "Identity is OURS"): we never serialise the
    raw ``role_id`` because replay creates fresh ids. ``role_label``
    resolves at replay time; ``None`` means "AI or system" (no role
    attribution). This is the same convention used by ``PlayStep``.

    Length caps are defensive: a malicious or corrupted scenario file
    dropped into the dev-scenarios path could otherwise inject a
    multi-MB body or tool_args blob into ``session.messages`` via the
    deterministic runner. The manager-side
    ``append_recorded_message`` boundary will further truncate
    ``body`` if a recording-time cap miss made it through.
    """

    model_config = ConfigDict(extra="forbid")
    kind: RecordedMessageKind
    body: str = Field(default="", max_length=64_000)
    # Tool name is opaque on the wire (no allowlist here) but the
    # runner cross-references against the tier's known tool names at
    # replay time and logs a warning if a recording references a tool
    # the engine no longer ships. That's looser than an allowlist on
    # purpose: a deterministic replay's whole point is to reproduce
    # historical UI even after the tool palette changes.
    tool_name: str | None = Field(default=None, max_length=64)
    tool_args: dict[str, Any] | None = None
    role_label: str | None = Field(default=None, max_length=64)
    is_interjection: bool = False
    # Visibility is recorded but may be widened to "all" on replay if
    # the original visibility list referenced role_ids we no longer
    # have. The recorder uses ``"all"`` by default — supporting
    # role-scoped visibility round-trips is tracked as follow-up.
    visibility: list[str] | Literal["all"] = "all"
    # Wall-clock timestamp of the original event (ISO 8601). Drives
    # the deterministic runner's playback pacing so the replay
    # matches the real session's cadence — see ``PlayStep.ts``.
    ts: str | None = None
    # Chat-declutter polish: round-trip the workstream tag + the
    # structural mention list so the replay reproduces the colored
    # track-bar stripes + ``@-highlight`` chrome the original session
    # rendered. ``None`` / empty list means the recorded message was
    # unscoped / unaddressed — which is the historical default for
    # scenarios captured before workstreams existed. Hand-authored
    # scenarios SHOULD populate these to exercise the polish PR's UI.
    # Validated against ``Workstream.id``'s regex so a malformed value
    # in a scenario file fails at load time, not at replay time.
    workstream_id: str | None = Field(
        default=None, max_length=32, pattern=r"^[a-z][a-z0-9_]*$"
    )
    # Each entry is a real ``role_label`` (resolved to ``role_id`` at
    # replay time) or the literal ``"facilitator"`` token for AI
    # mentions. The runner translates labels → role_ids the same way
    # ``role_label`` itself is resolved on submissions.
    mentions: list[str] = Field(default_factory=list)


class PlayTurn(BaseModel):
    """One play turn's worth of participant submissions + AI fallout.

    ``submissions`` are sent in order via ``submit_response``. Once the
    turn is ready to advance, the runner either:

      * calls ``run_play_turn`` (engine mode) so the live LLM (or its
        installed mock) generates the next batch of AI messages, OR
      * injects ``ai_messages`` directly into ``session.messages``
        (deterministic mode) so the replay produces a byte-identical
        transcript without any LLM call.

    The runner picks the mode based on ``Scenario.replay_mode`` —
    ``"deterministic"`` requires every turn to populate
    ``ai_messages`` (the recorder does this automatically); other
    modes ignore ``ai_messages`` and hit the LLM.
    """

    model_config = ConfigDict(extra="forbid")
    submissions: list[PlayStep] = Field(default_factory=list)
    # AI / system / inject messages that followed this turn's
    # submissions, captured by the recorder. Empty list when the
    # scenario was hand-authored without a deterministic capture.
    ai_messages: list[RecordedMessage] = Field(default_factory=list)
    # Optional: how long to wait for the AI turn to settle before the
    # runner moves on. Defaults to the runner's own timeout.
    ai_timeout_s: float | None = Field(default=None, gt=0.0, le=600.0)


class ScenarioMeta(BaseModel):
    """Human-readable metadata.

    ``name`` and ``description`` surface in the dev-mode UI's scenario
    picker. ``tags`` lets the picker group scenarios (e.g. ``["smoke",
    "2role"]`` vs ``["regression", "5role"]``).
    """

    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=128)
    description: str = Field(default="", max_length=2000)
    tags: list[str] = Field(default_factory=list)


class RecordedDecisionEntry(BaseModel):
    """One ``record_decision_rationale`` entry captured for replay.

    ``turn_index`` is preserved verbatim (it's a 0-based int our own
    state machine controls — no risk of identity drift across
    replays). ``ts`` is the wall-clock for ordering only; replay
    applies all entries in one batch at end-of-play, not paced.
    """

    model_config = ConfigDict(extra="forbid")
    turn_index: int | None = None
    rationale: str = Field(min_length=1, max_length=4_000)
    ts: str | None = None


class RecordedCost(BaseModel):
    """Session-level token usage snapshot for the cost banner.

    Mirrors ``app.sessions.models.TokenUsage`` but kept as a separate
    type so the scenario JSON file is decoupled from the engine's
    pydantic model.
    """

    model_config = ConfigDict(extra="forbid")
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    estimated_usd: float = 0.0


class Scenario(BaseModel):
    """A full session lifecycle, reproducibly.

    ``mock_llm_script`` is an optional canned-response payload that the
    runner installs onto ``app.state.llm`` before driving the scenario.
    When omitted the scenario runs against whatever LLM transport is
    currently configured (real Anthropic in dev, the test fixture's
    mock in pytest).

    The script shape matches the existing ``tests/mock_anthropic.py``
    contract: ``{"setup": [...], "play": [...], "aar": [...]}`` where
    each entry is a list of ``Response`` blocks. We keep the
    serialised form opaque (``dict[str, Any]``) so scenario recording
    can stash anything ``MockAnthropic`` would accept.
    """

    model_config = ConfigDict(extra="forbid")
    meta: ScenarioMeta
    scenario_prompt: str = Field(min_length=1, max_length=8000)
    creator_label: str = Field(min_length=1, max_length=64)
    creator_display_name: str = Field(min_length=1, max_length=64)
    # Creator-selected scenario tuning (frozen on the live ``Session``
    # at creation). Captured here so a recorded scenario replays with
    # the same difficulty / target duration / feature toggles the
    # original session ran under — without this, every replay would
    # silently reset to the backend defaults regardless of the
    # recording's actual settings.
    settings: SessionSettings = Field(default_factory=SessionSettings)
    skip_setup: bool = False
    roster: list[RoleSpec] = Field(default_factory=list)
    setup_replies: list[SetupReply] = Field(default_factory=list)
    play_turns: list[PlayTurn] = Field(default_factory=list)
    end_reason: str | None = None
    mock_llm_script: dict[str, Any] | None = None
    # Final shared-notepad markdown captured at end-of-recording.
    # Replay applies it once at the end of ``play_phase`` so the dev
    # sees the populated notepad on the spawned session, even though
    # we don't (yet) replay each Yjs CRDT op individually. ``None``
    # for hand-authored scenarios — the notepad stays empty.
    notepad_snapshot: str | None = Field(default=None, max_length=128_000)
    # Idempotency keys for pin actions in the original session. Each
    # entry is ``f"{action}:{source_message_id}"`` (action ∈ {``pin``,
    # ``aar_mark``}). The pinned text itself is already inside
    # ``notepad_snapshot``; this list round-trips the idempotency state
    # so a dev clicking "Add to notes" or "Mark for AAR" on a replayed
    # session doesn't double-pin a message + action that was already
    # pinned in the recording.
    notepad_pinned_message_keys: list[str] = Field(default_factory=list)
    # Contributor role labels (resolved at replay time to fresh
    # role_ids so the snapshot shows the same "Contributors: …"
    # header the original session did).
    notepad_contributor_role_labels: list[str] = Field(default_factory=list)
    # Creator-only AI rationale entries (one per
    # ``record_decision_rationale`` tool call). Recorded sessions
    # captured them as ``session.decision_log`` rows; replay applies
    # them at end-of-play so the creator's "Why did the AI do X?"
    # panel is populated on the spawned session.
    decision_log: list[RecordedDecisionEntry] = Field(default_factory=list)
    # Final session cost (token usage + estimated USD). Empty in
    # deterministic replay (no LLM calls fire), but populated when
    # the recorder dumps it from the original session — surfaced on
    # the creator's cost banner so the spawned session matches the
    # original's spend rather than reading $0.00.
    cost: RecordedCost | None = None
    # ``deterministic`` — replay AI messages from ``play_turns[*].ai_messages``
    # verbatim, never call the LLM during play. Required for UI-fidelity
    # tests (highlighting, colours, filtering all depend on message kind
    # / tool_name / body, which only the recorder can guarantee).
    #
    # ``engine`` — call the live LLM for every play turn (or the
    # ``MockAnthropic`` transport an external test installed on the
    # manager). AI messages drift across runs; use this for prompt
    # experimentation and live-LLM regression tests.
    #
    # The default is ``deterministic`` only when the scenario actually
    # has ``ai_messages`` populated; otherwise the runner falls back to
    # ``engine``. This means a hand-authored scenario without recorded
    # AI fallout still drives the LLM, while a recorded scenario
    # replays bit-perfectly.
    replay_mode: Literal["deterministic", "engine"] = "engine"

    def to_json(self) -> str:
        return self.model_dump_json(indent=2, exclude_none=False)


def load_scenario_file(path: Path) -> Scenario:
    """Read and validate a single scenario file.

    Raises ``pydantic.ValidationError`` on schema mismatch — surface that
    error to the caller so the dev sees the bad field; do not silently
    fall back to a default scenario.
    """

    raw = json.loads(path.read_text(encoding="utf-8"))
    return Scenario.model_validate(raw)


def load_scenario_dir(directory: Path) -> dict[str, Scenario]:
    """Load every ``*.json`` scenario in a directory, keyed by filename stem.

    Filenames are the scenario IDs the API exposes (the ``name`` in
    ``meta`` is the display label only). A directory with bad files
    raises on the first invalid one; we'd rather fail loudly at startup
    than ship a half-empty scenario picker.
    """

    out: dict[str, Scenario] = {}
    for path in sorted(directory.glob("*.json")):
        out[path.stem] = load_scenario_file(path)
    return out
