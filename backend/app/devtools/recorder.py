"""SessionRecorder — extract a Scenario from a running/finished session.

The recorder walks ``session.setup_notes`` (creator-side replies only)
and ``session.messages`` (the full transcript), grouping events by
``turn_id`` so each scripted ``PlayTurn`` carries:

* the participant ``submissions`` (player messages, in order); and
* the ``ai_messages`` that followed those submissions — every
  ``ai_text``, ``ai_tool_call``, ``ai_tool_result``, ``critical_inject``
  and ``system`` message attributed to the turn.

Capturing AI messages is what makes replay a fidelity test rather than
an "approximately like that" test. Frontend features that key off
``Message.kind`` + ``Message.tool_name`` + ``Message.body`` (highlight
colours, broadcast vs. share_data icons, critical-inject banners,
transcript filtering) rely on the AI side of the transcript matching;
without it, a recorded session replays to a visibly different UI even
though the player input was identical.

When the scenario is replayed in ``deterministic`` mode the runner
injects these recorded AI messages directly into ``session.messages``,
bypassing the LLM. ``engine`` mode ignores them and re-drives the
real model.

Identity rule (CLAUDE.md "Identity is OURS"): the recorder never
serialises raw ``role_id`` strings — only the role's label, which the
runner resolves to a fresh id at replay time.
"""

from __future__ import annotations

from collections import defaultdict
from typing import TYPE_CHECKING, Any

from ..sessions.models import Message, MessageKind, Session
from .scenario import (
    PlayStep,
    PlayTurn,
    RecordedCost,
    RecordedDecisionEntry,
    RecordedMessage,
    RecordedMessageKind,
    RoleSpec,
    Scenario,
    ScenarioMeta,
    SetupReply,
)

if TYPE_CHECKING:
    pass


_KIND_TO_RECORDED: dict[MessageKind, RecordedMessageKind] = {
    MessageKind.AI_TEXT: "ai_text",
    MessageKind.AI_TOOL_CALL: "ai_tool_call",
    MessageKind.AI_TOOL_RESULT: "ai_tool_result",
    MessageKind.PLAYER: "player",
    MessageKind.SYSTEM: "system",
    MessageKind.CRITICAL_INJECT: "critical_inject",
}


class SessionRecorder:
    """Convert a Session (live or post-mortem) into a replayable Scenario."""

    @staticmethod
    def to_scenario(
        session: Session,
        *,
        name: str,
        description: str = "",
        tags: list[str] | None = None,
        include_mock_script: bool = False,
    ) -> Scenario:
        """Build a Scenario from a Session's recorded state.

        ``include_mock_script`` is currently a stub — extracting a
        replay-ready mock from the audit log requires capturing tool
        inputs verbatim, which the audit log redacts for size. Treat
        this as "later work"; the runner happily plays scenarios
        without a mock script (just hits the real LLM).
        """

        roster: list[RoleSpec] = []
        creator_label = ""
        creator_display = ""
        for role in session.roles:
            if role.is_creator:
                creator_label = role.label
                creator_display = role.display_name or role.label
                continue
            roster.append(
                RoleSpec(
                    label=role.label,
                    display_name=role.display_name,
                    kind=role.kind,
                )
            )

        setup_replies = [
            SetupReply(content=note.content)
            for note in session.setup_notes
            if note.speaker == "creator"
        ]

        # Group every message by turn_id, preserving order. We separate
        # the buckets:
        #
        #   * player_steps[turn_id] — what the runner replays via
        #     ``submit_response`` (these drive state).
        #   * ai_messages[turn_id]  — what the runner injects post-
        #     submission so the UI sees the full original transcript
        #     in deterministic mode.
        #
        # Identity rule: record by ``role_label`` (or ``"creator"`` /
        # ``None``), never by raw role_id. Replay creates fresh ids.
        role_id_to_label: dict[str, str] = {}
        for role in session.roles:
            role_id_to_label[role.id] = (
                "creator" if role.is_creator else role.label
            )

        player_steps: dict[str, list[PlayStep]] = defaultdict(list)
        ai_messages: dict[str, list[RecordedMessage]] = defaultdict(list)
        turn_order: list[str] = []
        for msg in session.messages:
            turn_id = msg.turn_id or ""
            if not turn_id:
                # Setup-phase or pre-turn-0 messages (briefing intro
                # without a turn id). Skip — they're either re-emitted
                # by the engine on replay (briefing) or already covered
                # by ``setup_replies`` (setup notes).
                continue
            if turn_id not in player_steps and turn_id not in ai_messages:
                turn_order.append(turn_id)
            if msg.kind == MessageKind.PLAYER and not msg.is_interjection:
                label = role_id_to_label.get(msg.role_id or "")
                if label is None:
                    # Unknown role (mid-session removal?) — skip; can't
                    # replay against a role that's gone.
                    continue
                player_steps[turn_id].append(
                    PlayStep(
                        role_label=label,
                        content=msg.body or "",
                        ts=msg.ts.isoformat() if msg.ts else None,
                    )
                )
            elif msg.kind == MessageKind.PLAYER and msg.is_interjection:
                # Out-of-turn interjection: a player message posted
                # while the turn wasn't expecting them. Recording
                # these would be reordered to post-submission on
                # replay (timing fidelity is approximate per the
                # prompt-expert review LOW-6) — but we ALSO can't
                # replay them through ``append_recorded_message``,
                # which refuses ``kind="player"`` because that
                # bypass would dodge the input-side guardrail. Skip.
                # Tracked as follow-up: route interjections back
                # through ``submit_response`` on replay.
                continue
            else:
                # AI / system / critical_inject.
                ai_messages[turn_id].append(_to_recorded(msg, role_id_to_label))

        play_turns = [
            PlayTurn(
                submissions=player_steps.get(tid, []),
                ai_messages=ai_messages.get(tid, []),
            )
            for tid in turn_order
        ]

        mock_script: dict[str, Any] | None = None
        if include_mock_script:
            mock_script = _try_build_mock_script(session)

        # Default replay_mode: ``deterministic`` when we captured AI
        # fallout (so the UI replays bit-perfectly), ``engine`` when
        # we didn't (avoids the runner injecting an empty AI side and
        # leaving the transcript stuck in AWAITING_PLAYERS forever).
        has_ai_capture = any(turn.ai_messages for turn in play_turns)
        # Capture the final notepad snapshot. This is the markdown
        # the AAR pipeline reads, and it's what a connected dev tab
        # sees in the right-rail panel after replay completes. Only
        # the FINAL state — not the per-edit Yjs op stream — so the
        # notepad pops in fully populated rather than typing-out
        # live. Tracked as follow-up: capture + replay the op stream
        # for full edit-by-edit fidelity.
        notepad_snapshot = session.notepad.markdown_snapshot or None
        # Pinned-message idempotency state. The pinned text is already
        # baked into ``notepad_snapshot``; capturing the ids list lets
        # the replayed notepad refuse a double-pin on the same source
        # message a dev clicks during their replay walk-through.
        notepad_pinned_message_ids = list(session.notepad.pinned_message_ids)
        # Contributors are recorded by role_id in the live session;
        # round-trip them by label so the spawned session's roster
        # resolves to fresh ids without stale references. Unresolved
        # role_ids (mid-session removal?) are skipped — same drop-
        # loudly pattern the message recorder uses.
        notepad_contributor_role_labels: list[str] = []
        for rid in session.notepad.contributor_role_ids:
            label = role_id_to_label.get(rid)
            if label is not None:
                notepad_contributor_role_labels.append(label)
        # Decision-log entries (creator-only AI rationale). Captured
        # by ``record_decision_rationale`` tool calls during the
        # original run; replay applies them at end-of-play so the
        # spawned session's creator panel renders the same "Why did
        # the AI do X?" appendix the original did.
        decision_log = [
            RecordedDecisionEntry(
                turn_index=entry.turn_index,
                rationale=entry.rationale,
                ts=entry.ts.isoformat() if entry.ts else None,
            )
            for entry in session.decision_log
        ]
        # Final cost snapshot. Empty in deterministic replay (no LLM
        # fires) — capturing it here lets the spawned session's cost
        # banner show what the original run actually spent.
        cost = RecordedCost(
            input_tokens=session.cost.input_tokens,
            output_tokens=session.cost.output_tokens,
            cache_read_tokens=session.cost.cache_read_tokens,
            cache_creation_tokens=session.cost.cache_creation_tokens,
            estimated_usd=session.cost.estimated_usd,
        )
        return Scenario(
            meta=ScenarioMeta(
                name=name,
                description=description or f"Recorded from session {session.id[:8]}",
                tags=tags or ["recorded"],
            ),
            scenario_prompt=session.scenario_prompt,
            creator_label=creator_label or "Creator",
            creator_display_name=creator_display or "Creator",
            skip_setup=not setup_replies,
            roster=roster,
            setup_replies=setup_replies,
            play_turns=play_turns,
            end_reason="recorded",
            mock_llm_script=mock_script,
            replay_mode="deterministic" if has_ai_capture else "engine",
            notepad_snapshot=notepad_snapshot,
            notepad_pinned_message_ids=notepad_pinned_message_ids,
            notepad_contributor_role_labels=notepad_contributor_role_labels,
            decision_log=decision_log,
            cost=cost,
        )


def _to_recorded(
    msg: Message, role_id_to_label: dict[str, str]
) -> RecordedMessage:
    """Convert one in-engine ``Message`` to its serialisable shape.

    Keeps the kind, body, tool_name, tool_args and is_interjection
    flags. Resolves ``role_id`` to a label so the scenario is portable
    across sessions; falls back to ``None`` for AI / system messages
    (which have no role) and for messages whose role_id no longer
    matches an entry in the roster.
    """

    label: str | None = None
    if msg.role_id:
        label = role_id_to_label.get(msg.role_id)
    return RecordedMessage(
        kind=_KIND_TO_RECORDED[msg.kind],
        body=msg.body or "",
        tool_name=msg.tool_name,
        tool_args=msg.tool_args,
        role_label=label,
        is_interjection=msg.is_interjection,
        # Visibility lists reference role_ids the new replay session
        # won't have; widen to "all" so the replay UI doesn't drop
        # messages it can't resolve. Per-role visibility round-trip
        # is tracked as follow-up.
        visibility="all",
        ts=msg.ts.isoformat() if msg.ts else None,
    )


def _try_build_mock_script(session: Session) -> dict[str, Any] | None:
    """Attempt to reconstruct a MockAnthropic script from AI messages.

    Stub for now. The audit log records tool-use kinds and partial
    payloads; reconstructing a faithful mock would need the full
    tool input + tier metadata, which the current audit emission
    redacts for size. Returns ``None`` so the runner falls back to
    the live LLM. Tracked in CLAUDE.md follow-ups.
    """

    return None
