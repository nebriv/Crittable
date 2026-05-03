"""ScenarioRunner — drives a Scenario through the live SessionManager.

Why direct manager access instead of HTTP/WS calls? The manager is the
single source of truth for state transitions; calling it directly means
the runner has the same semantics as the real handlers and we don't have
to bring up a TestClient or open WS connections to drive the engine. The
only thing we lose is exercising the WS framing code, which is already
covered by ``backend/tests/test_e2e_session.py``.

Result: the runner is callable from
  * pytest (drop-in into ``test_e2e_session.py``-style harnesses);
  * a CLI (``python -m app.devtools.cli play <name>``);
  * a creator-only API endpoint (the dev-mode panel in God Mode).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from ..logging_setup import get_logger
from ..sessions.models import SessionState
from ..sessions.turn_driver import TurnDriver
from .scenario import Scenario

if TYPE_CHECKING:
    from ..sessions.manager import SessionManager

_logger = get_logger("devtools.runner")


@dataclass
class RunnerProgress:
    """Cumulative progress of a running scenario.

    Surfaced through ``ScenarioRunner.progress`` so the dev-mode UI can
    poll without subscribing to internal events. ``error`` is set when
    the runner gives up (timeout, illegal state, or a hard exception);
    callers should treat ``finished and not error`` as success.
    """

    session_id: str | None = None
    state: str = "init"
    current_phase: str = "init"
    setup_replies_sent: int = 0
    play_turns_completed: int = 0
    total_play_turns: int = 0
    error: str | None = None
    finished: bool = False
    last_event: str = ""
    log: list[str] = field(default_factory=list)


class ScenarioRunner:
    """Drive a Scenario through a SessionManager.

    Construct with a ``SessionManager`` and a ``Scenario``. Call
    ``run()`` to play the whole thing, or use the per-phase helpers
    (``setup_phase``, ``play_phase``, ``end_phase``) for step-mode
    debugging from a notebook / CLI.

    The runner maintains a ``progress`` object that any external
    observer can poll. The progress shape is intentionally a plain
    dataclass (not a Pydantic model) so concurrent writes from the
    runner coroutine don't trip validation.
    """

    def __init__(self, manager: SessionManager, scenario: Scenario) -> None:
        self._manager = manager
        self._scenario = scenario
        self._role_ids: dict[str, str] = {}
        self._role_tokens: dict[str, str] = {}
        # Wall-clock timestamp of the last played event, used to
        # compute inter-event delays from recorded ``ts`` deltas. Set
        # to ``None`` until the first event with a timestamp fires.
        self._last_event_ts: str | None = None
        self.progress = RunnerProgress(
            total_play_turns=len(scenario.play_turns),
        )

    # ----------------------------------------------------- public API
    async def prepare(self) -> RunnerProgress:
        """Fast path: create the session + roster, finalise the plan
        (skip-setup or scripted setup), so callers have valid join
        tokens to hand back. Stops BEFORE ``start_phase`` — useful
        for the live-playback flow where the API handler wants to
        return tokens immediately and let the long-running play /
        end / AAR phases run in the background.
        """

        try:
            await self.create_session()
            if self._scenario.skip_setup or not self._scenario.setup_replies:
                await self._skip_setup()
            else:
                await self.setup_phase()
        except Exception as exc:
            _logger.exception(
                "scenario_runner_prepare_failed",
                scenario_name=self._scenario.meta.name,
                session_id=self.progress.session_id,
            )
            self.progress.error = f"{type(exc).__name__}: {exc}"
            self.progress.finished = True
        return self.progress

    async def continue_run(self) -> RunnerProgress:
        """Slow path: start_phase + play_phase + end_phase. Designed
        to be spawned as a background task after ``prepare()`` returns.

        Errors are logged + recorded in ``progress.error``; the
        background task itself does not raise so the supervisor task
        stays clean.
        """

        try:
            await self.start_phase()
            await self.play_phase()
            await self.end_phase()
        except Exception as exc:
            _logger.exception(
                "scenario_runner_continue_failed",
                scenario_name=self._scenario.meta.name,
                session_id=self.progress.session_id,
            )
            self.progress.error = f"{type(exc).__name__}: {exc}"
        finally:
            self.progress.finished = True
        return self.progress

    async def run(self) -> RunnerProgress:
        """Synchronous end-to-end run, retained for pytest + CLI
        callers that don't need the live-playback split.

        The HTTP ``/api/dev/scenarios/{id}/play`` endpoint uses
        ``prepare()`` + a backgrounded ``continue_run()`` instead so
        the response returns within ~100 ms with valid join tokens.
        """

        try:
            await self.create_session()
            if self._scenario.skip_setup or not self._scenario.setup_replies:
                # Skip-setup path: drop the default plan and jump to READY
                # so ``start_session`` doesn't trip on the missing plan
                # check. Mirrors the API's ``setup/skip`` endpoint.
                await self._skip_setup()
            else:
                await self.setup_phase()
            await self.start_phase()
            await self.play_phase()
            await self.end_phase()
        except Exception as exc:
            _logger.exception(
                "scenario_runner_failed",
                scenario_name=self._scenario.meta.name,
                session_id=self.progress.session_id,
            )
            self.progress.error = f"{type(exc).__name__}: {exc}"
        finally:
            self.progress.finished = True
        return self.progress

    async def create_session(self) -> str:
        """Create the session + roster. Returns the session id."""

        s = self._scenario
        session, creator_token = await self._manager.create_session(
            scenario_prompt=s.scenario_prompt,
            creator_label=s.creator_label,
            creator_display_name=s.creator_display_name,
        )
        # ``creator_role_id`` is typed ``str | None`` because session
        # creation could in theory predate role assignment, but a freshly
        # ``create_session``-d session always has it set. Narrow loudly
        # so the type checker knows and a future regression here trips
        # immediately rather than silently storing ``None``.
        creator_role_id = session.creator_role_id
        if creator_role_id is None:
            raise RuntimeError(
                "create_session returned a session without a creator_role_id"
            )
        self._role_ids["creator"] = creator_role_id
        self._role_ids[s.creator_label] = creator_role_id
        self._role_tokens[creator_role_id] = creator_token
        for role_spec in s.roster:
            role, role_token = await self._manager.add_role(
                session_id=session.id,
                label=role_spec.label,
                display_name=role_spec.display_name,
                kind=role_spec.kind,
            )
            self._role_ids[role_spec.label] = role.id
            self._role_tokens[role.id] = role_token
        self.progress.session_id = session.id
        self.progress.state = session.state
        self.progress.current_phase = "created"
        self._log(f"session created — id={session.id} roster={len(s.roster) + 1}")
        return session.id

    async def setup_phase(self) -> None:
        """Drive the AI setup dialogue with the scripted creator replies."""

        self.progress.current_phase = "setup"
        sid = self._must_session_id()
        for idx, reply in enumerate(self._scenario.setup_replies):
            session = await self._manager.get_session(sid)
            if reply.after_state and session.state.value != reply.after_state:
                raise RuntimeError(
                    f"setup_phase: expected state {reply.after_state}, "
                    f"found {session.state.value} before reply #{idx}"
                )
            if session.state == SessionState.READY:
                self._log(f"setup short-circuited at READY after {idx} replies")
                break
            await self._manager.append_setup_message(
                session_id=sid, speaker="creator", content=reply.content
            )
            session = await self._manager.get_session(sid)
            if session.state == SessionState.SETUP:
                await TurnDriver(manager=self._manager).run_setup_turn(session=session)
            self.progress.setup_replies_sent = idx + 1
            self._log(f"setup reply {idx + 1}/{len(self._scenario.setup_replies)}")
        # If the AI never finalised, drop a default plan so play can start.
        session = await self._manager.get_session(sid)
        if session.state != SessionState.READY:
            self._log("setup did not reach READY; finalising with default plan")
            await self._skip_setup()

    async def _skip_setup(self) -> None:
        """Drop the default dev plan and transition the session to READY.

        Local import on ``_default_dev_plan`` keeps the module-level
        import graph clean — ``api.routes`` imports devtools and we'd
        cycle if we re-imported it at module load time.
        """

        from ..api.routes import _default_dev_plan

        sid = self._must_session_id()
        session = await self._manager.get_session(sid)
        if session.state == SessionState.READY:
            return
        await self._manager.finalize_setup(
            session_id=sid,
            plan=_default_dev_plan(self._scenario.scenario_prompt),
        )
        self._log("setup skipped; default plan dropped")

    async def start_phase(self) -> None:
        """Mirror the ``POST /sessions/{id}/start`` handler.

        Engine mode: open turn 0, run the briefing AI turn so the
        session lands in AWAITING_PLAYERS.

        Deterministic mode: open turn 0 only — we do NOT call
        ``run_play_turn`` here. The briefing's AI fallout was captured
        by the recorder as ``play_turns[0].ai_messages`` (and
        play_turns[0].submissions is empty for that turn). The
        play_phase loop does the inject + opens the next turn, so we
        avoid calling the LLM at all.
        """

        from ..sessions.models import Turn  # local import — model graph

        self.progress.current_phase = "starting"
        sid = self._must_session_id()
        session = await self._manager.start_session(session_id=sid)
        if session.current_turn is None:
            session.turns.append(
                Turn(index=0, active_role_ids=[], status="processing")
            )
        deterministic = self._scenario.replay_mode == "deterministic"
        turn = session.current_turn
        if turn is not None and not deterministic:
            await TurnDriver(manager=self._manager).run_play_turn(
                session=session, turn=turn
            )
        # Synthesize presence so the watching dev tab sees every
        # replayed role as online + focused. The connection_manager
        # only tracks REAL WS connections — during replay only the
        # creator's tab is connected, so without this broadcast the
        # roster shows "1 online / N joined" with every other role
        # offline. Frame shape matches what the WS handler emits on
        # connect, so the existing client-side handler picks it up
        # without changes.
        await self._synthesize_presence(initial=True)
        self._log(f"play started (mode={self._scenario.replay_mode})")

    async def _synthesize_presence(self, *, initial: bool = False) -> None:
        """Broadcast a ``presence_snapshot`` listing every non-creator
        replayed role as online + focused.

        Real participants would have their own WS tabs open; during
        replay there's no second connection so the connection_manager
        reports them as offline. Synthesizing presence keeps the
        roster panel honest — the dev sees a live-feeling session
        with everyone "here", not a graveyard of offline rows.

        Idempotent: safe to call multiple times. We don't fan out
        per-turn (the connection_manager doesn't track replayed roles
        anywhere; another snapshot would just resend the same set);
        instead we hit ``presence_snapshot`` once at start_phase and
        let the per-message broadcasts (typing / message_complete)
        carry the per-turn signal.
        """

        sid = self._must_session_id()
        # Every role we know about — creator's role_id is stored
        # under both "creator" and the creator's label, so de-dupe.
        all_role_ids = sorted({rid for rid in self._role_ids.values()})
        await self._manager.connections().broadcast(
            sid,
            {
                "type": "presence_snapshot",
                "role_ids": all_role_ids,
                "focused_role_ids": all_role_ids,
                "connection_count": len(all_role_ids),
            },
            record=False,
        )
        if initial:
            self._log(f"synthesized presence — {len(all_role_ids)} roles online")

    async def play_phase(self) -> None:
        """Replay each scripted play turn.

        Per turn:
          1. Send each submission via ``submit_response`` (real player path).
          2. When the turn is ready to advance, either:
             * inject the recorded ``ai_messages`` directly (deterministic
               replay — UI sees byte-identical transcript), or
             * call ``run_play_turn`` (engine mode — live LLM or installed
               mock generates fresh AI fallout).
        """

        self.progress.current_phase = "play"
        sid = self._must_session_id()
        deterministic = self._scenario.replay_mode == "deterministic"
        play_turns = self._scenario.play_turns
        for turn_idx, turn in enumerate(play_turns):
            session = await self._manager.get_session(sid)
            if session.state == SessionState.ENDED:
                self._log("session ended early; stopping play_phase")
                return
            if deterministic:
                await self._drive_turn_deterministic(
                    turn=turn,
                    next_turn=(
                        play_turns[turn_idx + 1]
                        if turn_idx + 1 < len(play_turns)
                        else None
                    ),
                )
            else:
                await self._drive_turn_engine(turn=turn)
            self.progress.play_turns_completed = turn_idx + 1
            self._log(
                f"play turn {turn_idx + 1}/{len(play_turns)} done"
            )
            await asyncio.sleep(0)  # yield so other tasks (WS pump) drain
        # End-of-play side-channels: notepad snapshot + decision log
        # + cost. These are all session-level state that doesn't fit
        # the per-turn message stream — apply once at the end so the
        # creator's view sees the populated right-rail panel + cost
        # meter + AI rationale appendix without us having to replay
        # every Yjs op or per-turn rationale entry.
        await self._apply_session_side_channels()

    async def _drive_turn_engine(self, *, turn: Any) -> None:
        """Engine-mode driver: submit each submission via the shared
        pipeline, then let ``run_play_turn`` produce the AI side.

        Pipeline-routing is the same as the deterministic driver —
        validation / truncation / guardrail run on every replayed
        submission, in BOTH modes, so a regression in any of those
        gates trips the replay regardless of which mode was used."""

        from ..sessions.submission_pipeline import (
            EmptySubmissionError,
            prepare_and_submit_player_response,
        )

        sid = self._must_session_id()
        for step in turn.submissions:
            role_id = self._resolve_role(step.role_label)
            session = await self._manager.get_session(sid)
            if session.state == SessionState.ENDED:
                return
            await self._simulate_typing(role_id=role_id, content=step.content)
            try:
                outcome = await prepare_and_submit_player_response(
                    manager=self._manager,
                    session_id=sid,
                    role_id=role_id,
                    content=step.content,
                )
            except EmptySubmissionError:
                self._log(
                    f"replay step skipped (empty content) — role={step.role_label}"
                )
                continue
            if outcome.truncated:
                self._log(
                    f"replay submission truncated — role={step.role_label} "
                    f"original_len={outcome.original_len}"
                )
            if outcome.blocked:
                self._log(
                    f"replay submission blocked by guardrail — "
                    f"role={step.role_label} verdict={outcome.blocked_verdict}"
                )
                continue
            if not outcome.advanced:
                continue
            session = await self._manager.get_session(sid)
            if session.current_turn is not None:
                await TurnDriver(manager=self._manager).run_play_turn(
                    session=session, turn=session.current_turn
                )

    # Caps on inter-event sleep durations. Recorded sessions can have
    # multi-minute idle gaps (real dev typing pauses, lunch breaks
    # mid-exercise, etc.) — replaying those verbatim would feel
    # broken. Floor stops a 100ms-spaced LLM token storm from
    # rendering as instant; ceiling stops a 5-minute thinking pause
    # from making the dev think the replay is hung. Tuned for "feels
    # like watching someone else play" on real recordings.
    _PACE_FLOOR_S = 0.15
    _PACE_CEILING_S = 5.0
    # Hand-authored scenarios (no ``ts`` on events) fall back to a
    # fixed cadence — same shape as before timestamps shipped, just
    # used as the default rather than the only path.
    _PACE_FALLBACK_S = 0.5

    async def _pace_from_ts(
        self, current_ts: str | None, prev_ts: str | None
    ) -> None:
        """Sleep for the inter-event delta when both timestamps are
        present, falling back to ``_PACE_FALLBACK_S`` when either is
        missing (hand-authored scenarios) or negative (clock skew).

        Sleeps are clamped between ``_PACE_FLOOR_S`` and
        ``_PACE_CEILING_S`` so neither sub-100ms storms nor
        multi-minute idle gaps make the replay unwatchable.
        """

        from datetime import datetime

        if not current_ts or not prev_ts:
            await asyncio.sleep(self._PACE_FALLBACK_S)
            return
        try:
            now = datetime.fromisoformat(current_ts)
            then = datetime.fromisoformat(prev_ts)
        except ValueError:
            await asyncio.sleep(self._PACE_FALLBACK_S)
            return
        delta = (now - then).total_seconds()
        clamped = max(self._PACE_FLOOR_S, min(self._PACE_CEILING_S, delta))
        await asyncio.sleep(clamped)

    # Synthetic-typing parameters. Real users send ``typing_start`` →
    # heartbeat for ~1s/keystroke → ``typing_stop`` (see Composer.tsx).
    # We don't have keystroke timing in the recording, so we
    # synthesise a length-proportional pause: a player would typically
    # take ~30ms per character (~2000 chars/min), clamped so a
    # one-word response still flashes the indicator and a 4000-char
    # post-mortem doesn't stall the replay for two minutes.
    _TYPING_MS_PER_CHAR = 30
    _TYPING_FLOOR_S = 0.6
    _TYPING_CEILING_S = 4.0

    async def _simulate_typing(self, *, role_id: str, content: str) -> None:
        """Broadcast a ``typing_start`` / sleep / ``typing_stop`` pair
        before the actual submission lands, so a connected dev tab sees
        the same "Player X is typing…" indicator a real participant
        would have triggered. Without this, replayed submissions
        appear instantly with no typing chrome — the watching tab
        feels like a teleport, not live play.

        We deliberately don't broadcast the typing event with
        ``record=True``: the WS handler's typing path uses
        ``record=False`` to keep the replay buffer free of high-
        volume ephemeral signals, and we mirror that here.
        """

        connections = self._manager.connections()
        sid = self._must_session_id()
        await connections.broadcast(
            sid,
            {"type": "typing", "role_id": role_id, "typing": True},
            record=False,
        )
        delay_s = max(
            self._TYPING_FLOOR_S,
            min(
                self._TYPING_CEILING_S,
                (len(content) * self._TYPING_MS_PER_CHAR) / 1000.0,
            ),
        )
        await asyncio.sleep(delay_s)
        await connections.broadcast(
            sid,
            {"type": "typing", "role_id": role_id, "typing": False},
            record=False,
        )

    async def _drive_turn_deterministic(
        self, *, turn: Any, next_turn: Any | None
    ) -> None:
        """Deterministic-mode driver.

        Order matters and mirrors the engine's own contract:
          1. Send any scripted player submissions for this turn (paced
             from recorded ``ts`` deltas, clamped).
          2. Inject the recorded AI fallout (text, tool calls, broadcasts,
             critical injects, system messages) so the UI sees the
             same transcript it did during recording (also paced).
          3. If a ``next_turn`` exists, open it with the role-set that
             turn expects. The session stays in AI_PROCESSING after
             step 2 (because we never called ``run_play_turn``); this
             open_turn flips it back to AWAITING_PLAYERS.

        When ``submissions`` is empty this still runs in order — used
        for the recorded briefing turn (no player input, just AI
        messages, then the next turn opens).
        """

        from ..sessions.submission_pipeline import (
            EmptySubmissionError,
            prepare_and_submit_player_response,
        )

        sid = self._must_session_id()
        for step in turn.submissions:
            await self._pace_from_ts(step.ts, self._last_event_ts)
            self._last_event_ts = step.ts or self._last_event_ts
            role_id = self._resolve_role(step.role_label)
            session = await self._manager.get_session(sid)
            if session.state == SessionState.ENDED:
                return
            await self._simulate_typing(role_id=role_id, content=step.content)
            # Route through the same validation / truncation /
            # guardrail pipeline the WS handler uses, so a regression
            # in any of those gates trips the replay before
            # production. Empty submissions in a recording mean the
            # original session had a guardrail-blocked or empty
            # message — log + skip rather than crash the replay.
            try:
                outcome = await prepare_and_submit_player_response(
                    manager=self._manager,
                    session_id=sid,
                    role_id=role_id,
                    content=step.content,
                )
            except EmptySubmissionError:
                self._log(
                    f"replay step skipped (empty content) — role={step.role_label}"
                )
                continue
            if outcome.truncated:
                self._log(
                    f"replay submission truncated — role={step.role_label} "
                    f"original_len={outcome.original_len}"
                )
            if outcome.blocked:
                # Recorded-input guardrail block is unusual but
                # possible if the guardrail was re-tuned between
                # recording and replay. Don't suppress — surface so
                # a regression in the guardrail trips loudly.
                self._log(
                    f"replay submission blocked by guardrail — "
                    f"role={step.role_label} verdict={outcome.blocked_verdict}"
                )
        await self._inject_ai_messages(turn.ai_messages)
        if next_turn is None:
            return
        next_active = self._next_active_role_ids(next_turn)
        try:
            await self._manager.open_turn(
                session_id=sid, active_role_ids=next_active
            )
        except Exception as exc:
            self._log(f"open_turn failed in deterministic replay: {exc}")
            raise

    def _next_active_role_ids(self, turn: Any) -> list[str]:
        """Resolve a scripted PlayTurn's submission role labels to the
        ids the runner should mark active when opening the turn.

        De-duplicates while preserving order so a turn that lists
        ``[creator, SOC, creator]`` opens with ``[creator, SOC]``.
        """

        seen: dict[str, bool] = {}
        for step in turn.submissions:
            role_id = self._role_ids.get(step.role_label)
            if role_id and role_id not in seen:
                seen[role_id] = True
        return list(seen.keys())

    async def _inject_ai_messages(
        self, ai_messages: list[Any]
    ) -> None:
        """Append recorded AI / system / inject messages via the
        manager's ``append_recorded_message`` boundary.

        That method enforces:
          * kind allowlist (``player`` is rejected — replay sends
            those through ``submit_response`` so the input-side
            guardrail still classifies them);
          * ``max_participant_submission_chars`` body cap;
          * the same lock + repo + broadcast + audit emit the engine
            would do for a normal AI message.

        We do NOT call ``run_play_turn`` — that would re-drive the
        LLM. The recorded body is authoritative; that's the contract
        that buys deterministic UI fidelity.
        """

        from ..sessions.models import MessageKind

        if not ai_messages:
            return
        sid = self._must_session_id()
        for record in ai_messages:
            await self._pace_from_ts(record.ts, self._last_event_ts)
            self._last_event_ts = record.ts or self._last_event_ts
            kind = MessageKind(record.kind)
            role_id: str | None = None
            if record.role_label:
                role_id = self._role_ids.get(record.role_label)
            await self._manager.append_recorded_message(
                session_id=sid,
                kind=kind,
                body=record.body,
                tool_name=record.tool_name,
                tool_args=record.tool_args,
                role_id=role_id,
                is_interjection=record.is_interjection,
                visibility=record.visibility,
            )
            # Critical-inject messages get a separate ``critical_event``
            # WS broadcast in the live engine (see
            # ``llm/dispatch.py::_dispatch_one``); the message itself
            # lands in the transcript, AND a separate banner-firing
            # frame goes out so connected tabs render the red alert.
            # Replay must mirror both — without this, the recorded
            # CRITICAL_INJECT message renders in the transcript but
            # the banner never fires.
            if kind == MessageKind.CRITICAL_INJECT:
                args = record.tool_args or {}
                await self._manager.connections().broadcast(
                    sid,
                    {
                        "type": "critical_event",
                        "severity": args.get("severity", "HIGH"),
                        "headline": args.get("headline", ""),
                        "body": args.get("body", ""),
                    },
                )
        self._log(f"injected {len(ai_messages)} ai_messages (deterministic)")

    async def _apply_session_side_channels(self) -> None:
        """Apply scenario-level side-channel state to the spawned
        session: notepad markdown snapshot, decision-log entries,
        cost banner.

        These don't fit the per-turn message stream — they're
        session-scoped and the original session emitted WS frames
        for them at various points (notepad on every Yjs op, decision
        log per ``record_decision_rationale`` tool call, cost on
        every LLM call). Replaying every individual op would mean
        capturing the full event stream, which the recorder doesn't
        do today. The pragmatic alternative: apply the FINAL state
        once at end-of-play. The creator's view sees the populated
        notepad / decision log / cost; the per-edit cadence of the
        original session is lost (tracked as follow-up).
        """

        from datetime import UTC, datetime

        from ..sessions.models import DecisionLogEntry as _DecisionLogEntry

        sid = self._must_session_id()
        sc = self._scenario
        # Acquire the session lock once and mutate fields in one pass.
        async with await self._manager._lock_for(sid):
            session = await self._manager._repo.get(sid)
            if sc.notepad_snapshot:
                session.notepad.markdown_snapshot = sc.notepad_snapshot
                session.notepad.snapshot_updated_at = datetime.now(UTC)
            # Pinned-message-id round-trip: dedupe + skip unknown
            # ids the spawned session never saw. The dedupe matters
            # because hand-authored scenarios could repeat ids and
            # the live session's idempotency check uses set-membership.
            if sc.notepad_pinned_message_ids:
                already = set(session.notepad.pinned_message_ids)
                for mid in sc.notepad_pinned_message_ids:
                    if mid not in already:
                        session.notepad.pinned_message_ids.append(mid)
                        already.add(mid)
            # Contributor role labels resolve to fresh role_ids on
            # the spawned session. Unresolved labels (roster
            # mismatch) are skipped — same identity-resolution
            # discipline the AI-message inject path uses.
            if sc.notepad_contributor_role_labels:
                for label in sc.notepad_contributor_role_labels:
                    rid = self._role_ids.get(label)
                    if rid and rid not in session.notepad.contributor_role_ids:
                        session.notepad.contributor_role_ids.append(rid)
            if sc.decision_log:
                for entry in sc.decision_log:
                    session.decision_log.append(
                        _DecisionLogEntry(
                            turn_index=entry.turn_index,
                            rationale=entry.rationale,
                        )
                    )
            if sc.cost is not None:
                session.cost.input_tokens = sc.cost.input_tokens
                session.cost.output_tokens = sc.cost.output_tokens
                session.cost.cache_read_tokens = sc.cost.cache_read_tokens
                session.cost.cache_creation_tokens = sc.cost.cache_creation_tokens
                session.cost.estimated_usd = sc.cost.estimated_usd
            await self._manager._repo.save(session)
        # Broadcast a state_changed so connected creator tabs poll
        # the snapshot and pick up the populated side channels. The
        # cost banner is creator-only and read off the snapshot, so
        # this single nudge is enough to refresh all three.
        await self._manager.connections().broadcast(
            sid,
            {"type": "snapshot_invalidated", "reason": "scenario_replay_finalised"},
        )
        applied = []
        if sc.notepad_snapshot:
            applied.append(f"notepad ({len(sc.notepad_snapshot)} chars)")
        if sc.decision_log:
            applied.append(f"{len(sc.decision_log)} decision-log entries")
        if sc.cost is not None and sc.cost.estimated_usd > 0:
            applied.append(f"cost (${sc.cost.estimated_usd:.4f})")
        if applied:
            self._log("applied side-channels: " + ", ".join(applied))

    async def end_phase(self) -> None:
        self.progress.current_phase = "ending"
        sid = self._must_session_id()
        session = await self._manager.get_session(sid)
        if session.state == SessionState.ENDED:
            self._log("session already ENDED — skipping explicit end")
            return
        creator_id = self._role_ids["creator"]
        await self._manager.end_session(
            session_id=sid,
            by_role_id=creator_id,
            reason=self._scenario.end_reason or "scenario complete",
        )
        await self._manager.trigger_aar_generation(sid)
        self._log("session ended; AAR generation triggered")
        self.progress.current_phase = "done"

    # ------------------------------------------------------ internals
    def _resolve_role(self, label: str) -> str:
        try:
            return self._role_ids[label]
        except KeyError as exc:
            raise RuntimeError(
                f"scenario references role label {label!r} not in roster"
            ) from exc

    def _must_session_id(self) -> str:
        if self.progress.session_id is None:
            raise RuntimeError("scenario runner has not created a session yet")
        return self.progress.session_id

    def _log(self, line: str) -> None:
        _logger.info("scenario_runner_step", line=line)
        self.progress.last_event = line
        self.progress.log.append(line)

    @property
    def role_tokens(self) -> dict[str, str]:
        """Mapping of role_id → join token, for handing back to the UI
        so the dev can open per-role tabs after a scenario seeds a session.
        """

        return dict(self._role_tokens)

    @property
    def role_label_to_id(self) -> dict[str, str]:
        """Mapping of role_label → role_id (creator stored under both
        ``"creator"`` and the creator's label).
        """

        return dict(self._role_ids)
