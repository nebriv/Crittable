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
        self.progress = RunnerProgress(
            total_play_turns=len(scenario.play_turns),
        )

    # ----------------------------------------------------- public API
    async def run(self) -> RunnerProgress:
        """Play the scenario end-to-end. Best-effort: on a hard error
        the runner stops, sets ``progress.error``, and returns the
        partial progress object. The session is left in whatever state
        the engine reached so the dev can inspect it via God Mode."""

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
        self._log(f"play started (mode={self._scenario.replay_mode})")

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

    async def _drive_turn_engine(self, *, turn: Any) -> None:
        """Engine-mode driver: submit each submission and let
        ``run_play_turn`` produce the AI side."""

        sid = self._must_session_id()
        for step in turn.submissions:
            role_id = self._resolve_role(step.role_label)
            session = await self._manager.get_session(sid)
            if session.state == SessionState.ENDED:
                return
            advanced = await self._manager.submit_response(
                session_id=sid, role_id=role_id, content=step.content
            )
            if not advanced:
                continue
            session = await self._manager.get_session(sid)
            if session.current_turn is not None:
                await TurnDriver(manager=self._manager).run_play_turn(
                    session=session, turn=session.current_turn
                )

    async def _drive_turn_deterministic(
        self, *, turn: Any, next_turn: Any | None
    ) -> None:
        """Deterministic-mode driver.

        Order matters and mirrors the engine's own contract:
          1. Send any scripted player submissions for this turn.
          2. Inject the recorded AI fallout (text, tool calls, broadcasts,
             critical injects, system messages) so the UI sees the
             same transcript it did during recording.
          3. If a ``next_turn`` exists, open it with the role-set that
             turn expects. The session stays in AI_PROCESSING after
             step 2 (because we never called ``run_play_turn``); this
             open_turn flips it back to AWAITING_PLAYERS.

        When ``submissions`` is empty this still runs in order — used
        for the recorded briefing turn (no player input, just AI
        messages, then the next turn opens).
        """

        sid = self._must_session_id()
        for step in turn.submissions:
            role_id = self._resolve_role(step.role_label)
            session = await self._manager.get_session(sid)
            if session.state == SessionState.ENDED:
                return
            await self._manager.submit_response(
                session_id=sid, role_id=role_id, content=step.content
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
        self._log(f"injected {len(ai_messages)} ai_messages (deterministic)")

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
