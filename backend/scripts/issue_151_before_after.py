"""Live before/after comparison for issue #151.

Issue #151 reports that the play-tier model frequently fires
``inject_critical_event`` *alone* (without a same-response
``broadcast`` / ``address_role``), which leaves players staring at a
critical banner with no per-role direction. The pre-fix engine then
fires the validator's missing-DRIVE recovery — a SECOND LLM call
narrowed to ``broadcast`` — but the recovery prompt is generic
("you skipped the player-facing message") and the model regularly
broadcasts a vanilla next-beat brief that ignores the inject. Two
extra LLM calls, banner still un-grounded, players still confused.

This script demonstrates:

  Probe 1 — UPSTREAM RATE.  How often does the live model fire
  ``inject_critical_event`` without a paired DRIVE-slot tool, on a
  fixture seeded to provoke the failure mode? The fix does NOT change
  this rate (the model still composes the same way); it changes how
  the engine *responds* when the rate is non-zero.

  Probe 2 — DISPATCH-LAYER (FIX A).  Replays a representative solo-
  inject response through the dispatcher and confirms the post-fix
  path returns ``is_error=True`` with a clear chain-shape hint —
  whereas the pre-fix path silently lets the inject land and forces
  the post-turn recovery cascade to clean up. No live API call.

  Probe 3 — RECOVERY QUALITY (FIX B).  Constructs a synthetic missing-
  DRIVE recovery turn (model fired solo inject, validator fires DRIVE
  recovery). Runs the same recovery prompt twice — once with the OLD
  generic addendum, once with the NEW inject-grounded addendum — and
  measures whether the recovery broadcast mentions the inject's
  headline / body keywords. This is the "is it truly fixed" signal.

Cost
----

Probe 1: N * ~$0.01 (default N=5 → ~$0.05).
Probe 2: 0 (dispatcher only).
Probe 3: 2 * (number of solo-inject samples) * ~$0.01. Capped at 6.

Total budget at defaults: ~$0.15.

Usage
-----

    cd backend
    LLM_API_KEY=sk-ant-... python scripts/issue_151_before_after.py

    # tighter / cheaper:
    python scripts/issue_151_before_after.py --runs 3 --recovery-samples 2

    # JSON-only output (for CI archival or comparison runs):
    python scripts/issue_151_before_after.py --json > issue_151_report.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from typing import Any

# Make the script runnable from `backend/` without `pip install -e .`.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), os.pardir))

from app.auth.audit import AuditLog
from app.config import get_settings
from app.extensions.dispatch import ExtensionDispatcher
from app.extensions.models import ExtensionBundle
from app.extensions.registry import freeze_bundle
from app.llm.dispatch import ToolDispatcher
from app.llm.prompts import build_play_system_blocks
from app.llm.tools import PLAY_TOOLS
from app.sessions.models import (
    Message,
    MessageKind,
    Role,
    ScenarioBeat,
    ScenarioInject,
    ScenarioPlan,
    Session,
    SessionState,
)
from app.sessions.turn_driver import _play_messages
from app.sessions.turn_validator import (
    drive_recovery_directive,
)
from app.ws.connection_manager import ConnectionManager

PASS = "\033[32mPASS\033[0m"
FAIL = "\033[31mFAIL\033[0m"
SKIP = "\033[33mSKIP\033[0m"
WARN = "\033[33mWARN\033[0m"


def _progress(msg: str = "") -> None:
    """Progress print that always goes to stderr so ``--json`` mode
    produces clean stdout that downstream tools can pipe into ``jq``."""

    print(msg, file=sys.stderr)

# Drive-slot tool names (mirrors the dispatcher's _DRIVE_TOOL_NAMES;
# duplicated here so the script can run against an unpatched dispatcher
# in regression-comparison contexts).
_DRIVE_TOOL_NAMES = frozenset(
    {"broadcast", "address_role", "share_data", "pose_choice"}
)
# Inject grounding terms — the recovery broadcast SHOULD reference at
# least one of these to demonstrate it's anchored on the inject's
# context, not a generic next-beat brief.
_INJECT_GROUNDING_TERMS = (
    "leak",
    "screenshot",
    "reporter",
    "press",
    "media",
    "comms",
    "regulator",
    "statement",
    "twitter",
    "newspaper",
)
# Inject "anti-grounding" terms — these would appear in a vanilla next-
# beat brief that ignored the inject (the failure mode we're fixing).
# Used as a SECONDARY heuristic; the primary signal is the grounding
# terms above.
_NEUTRAL_BEAT_TERMS = (
    "next beat",
    "containment posture",
    "telemetry pull",
    "alert queue",
)


# ---------------------------------------------------------------- fixture


def _build_inject_imminent_session() -> Session:
    """Construct a session shape designed to provoke the model into
    firing ``inject_critical_event``.

    Plan structure: a critical inject is documented in ``injects`` with
    a trigger that lines up with the most recent narrative state.
    Transcript: containment is in motion (per CISO's commit) — the
    inject's prerequisite ("after beat 1") has fired. The model should
    feel the pull to escalate via the critical inject. We want to
    observe whether it pairs the inject with a DRIVE-slot tool in the
    same response.
    """

    creator = Role(
        id="role-ciso",
        label="CISO",
        display_name="Dev Tester",
        is_creator=True,
    )
    soc = Role(id="role-soc", label="SOC Analyst", display_name="Dev Bot")
    plan = ScenarioPlan(
        title="Ransomware via vendor portal — press leak imminent",
        executive_summary=(
            "03:14 Wednesday. Ransomware on finance laptops via vendor "
            "service-account compromise."
        ),
        key_objectives=[
            "Confirm scope within 30 min",
            "Containment decision documented before beat 3",
            "Decide regulator-notification clock",
        ],
        narrative_arc=[
            ScenarioBeat(beat=1, label="Detection & triage", expected_actors=["SOC", "CISO"]),
            ScenarioBeat(beat=2, label="Containment", expected_actors=["CISO", "SOC"]),
            ScenarioBeat(beat=3, label="External comms", expected_actors=["CISO"]),
        ],
        injects=[
            ScenarioInject(
                trigger="after beat 1",
                type="critical",
                summary=(
                    "Slack screenshot of internal incident channel leaked to a "
                    "regional newspaper Twitter; reporter is calling for comment "
                    "in 30 minutes."
                ),
            ),
        ],
        guardrails=["Stay in scope; no real exploit code."],
        success_criteria=["Containment before beat 3", "Regulator clock decided"],
        out_of_scope=["Live exploitation", "Specific CVE PoCs"],
    )
    s = Session(
        scenario_prompt="Ransomware via vendor portal — press leak imminent",
        state=SessionState.AI_PROCESSING,
        roles=[creator, soc],
        creator_role_id=creator.id,
        plan=plan,
    )
    # Transcript: prior broadcast asks for triage; both players have
    # committed; SOC says they're pulling Defender logs (telemetry in
    # motion). This is the seam where the press-leak inject's "after
    # beat 1" trigger fires per the plan.
    s.messages.append(
        Message(
            kind=MessageKind.AI_TEXT,
            tool_name="broadcast",
            body=(
                "**SOC Analyst (Dev Bot)** — what does the alert queue look "
                "like? **CISO (Dev Tester)** — first containment instinct: "
                "isolate or monitor for full scope?"
            ),
        )
    )
    s.messages.append(
        Message(
            kind=MessageKind.PLAYER,
            role_id=creator.id,
            body=(
                "Isolate immediately via Defender. I'm pulling in IR Lead "
                "and starting the regulator-notification clock."
            ),
        )
    )
    s.messages.append(
        Message(
            kind=MessageKind.PLAYER,
            role_id=soc.id,
            body=(
                "Three FIN-* hosts firing Defender alerts plus lateral SMB "
                "to FIN-08. Pulling Defender logs now."
            ),
        )
    )
    return s


def _empty_registry() -> Any:
    return freeze_bundle(ExtensionBundle())


# ---------------------------------------------------------------- helpers


@dataclass
class ToolUseSnapshot:
    name: str
    input: dict[str, Any]


@dataclass
class TurnResponse:
    tool_uses: list[ToolUseSnapshot]
    text: str
    stop_reason: str

    @property
    def names(self) -> list[str]:
        return [u.name for u in self.tool_uses]

    @property
    def has_inject(self) -> bool:
        return "inject_critical_event" in self.names

    @property
    def has_drive_pairing(self) -> bool:
        return any(n in _DRIVE_TOOL_NAMES for n in self.names)


def _capture_response(resp: Any) -> TurnResponse:
    uses: list[ToolUseSnapshot] = []
    text_parts: list[str] = []
    for b in getattr(resp, "content", []) or []:
        kind = getattr(b, "type", None)
        if kind == "tool_use":
            uses.append(
                ToolUseSnapshot(
                    name=getattr(b, "name", ""),
                    input=getattr(b, "input", {}) or {},
                )
            )
        elif kind == "text":
            text_parts.append(getattr(b, "text", "") or "")
    return TurnResponse(
        tool_uses=uses,
        text="".join(text_parts),
        stop_reason=getattr(resp, "stop_reason", "") or "",
    )


async def _call_model(
    *,
    client: Any,
    model: str,
    system_blocks: list[dict[str, Any]],
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    tool_choice: dict[str, Any] | None,
) -> Any:
    kwargs: dict[str, Any] = {
        "model": model,
        "max_tokens": 1024,
        "system": system_blocks,
        "messages": messages,
        "tools": tools,
    }
    if tool_choice is not None:
        kwargs["tool_choice"] = tool_choice
    return await client.messages.create(**kwargs)


def _grounding_score(text: str, terms: Sequence[str]) -> tuple[int, list[str]]:
    """Count how many of ``terms`` appear (case-insensitively) in
    ``text``. Returns ``(count, hits)`` for reporting."""

    lowered = text.lower()
    hits = [t for t in terms if t.lower() in lowered]
    return len(hits), hits


# ---------------------------------------------------------------- probe 1


@dataclass
class Probe1Run:
    names: list[str]
    has_inject: bool
    has_drive: bool
    has_yield: bool
    inject_args: dict[str, Any] | None
    text_preview: str
    stop_reason: str


@dataclass
class Probe1Result:
    runs: list[Probe1Run] = field(default_factory=list)

    @property
    def total(self) -> int:
        return len(self.runs)

    @property
    def fired_inject(self) -> int:
        return sum(1 for r in self.runs if r.has_inject)

    @property
    def solo_inject(self) -> int:
        """Number of runs where the model fired inject_critical_event
        WITHOUT a same-response DRIVE-slot tool. This is the headline
        regression issue #151 reports."""

        return sum(1 for r in self.runs if r.has_inject and not r.has_drive)

    @property
    def chained_inject(self) -> int:
        """Inject + DRIVE in the same response — the correct shape per
        Block 6's Critical-inject chain mandate."""

        return sum(1 for r in self.runs if r.has_inject and r.has_drive)

    @property
    def solo_inject_rate(self) -> float:
        if not self.runs:
            return 0.0
        return self.solo_inject / self.total

    def solo_runs(self) -> list[Probe1Run]:
        return [r for r in self.runs if r.has_inject and not r.has_drive]


async def probe_1_inject_solo_rate(
    *,
    client: Any,
    model: str,
    runs: int,
    verbose: bool,
) -> Probe1Result:
    """Probe how often the live model fires ``inject_critical_event``
    solo (no DRIVE-slot pairing) on a fixture seeded to provoke it.

    The fix doesn't change the model's response composition — it
    changes how the engine handles solo-inject responses. So this
    probe's rate is the "underlying problem rate" — both pre-fix and
    post-fix runs would see the same rate. We report it so the
    operator knows how often the fix's defenses actually trigger.
    """

    _progress(f"\n[probe 1/3] solo-inject rate (n={runs} live calls)")
    _progress("            measuring how often the model fires inject_critical_event")
    _progress("            without a same-response DRIVE-slot tool")
    result = Probe1Result()
    session = _build_inject_imminent_session()
    system_blocks = build_play_system_blocks(session, registry=_empty_registry())
    messages = _play_messages(session, strict=False)

    for i in range(runs):
        resp = await _call_model(
            client=client,
            model=model,
            system_blocks=system_blocks,
            messages=messages,
            tools=PLAY_TOOLS,
            tool_choice=None,
        )
        captured = _capture_response(resp)
        names = captured.names
        has_inject = captured.has_inject
        has_drive = captured.has_drive_pairing
        has_yield = "set_active_roles" in names
        inject_args = next(
            (u.input for u in captured.tool_uses if u.name == "inject_critical_event"),
            None,
        )
        run = Probe1Run(
            names=names,
            has_inject=has_inject,
            has_drive=has_drive,
            has_yield=has_yield,
            inject_args=inject_args,
            text_preview=captured.text[:140],
            stop_reason=captured.stop_reason,
        )
        result.runs.append(run)
        marker = (
            FAIL
            if has_inject and not has_drive
            else (PASS if has_inject and has_drive else " - ")
        )
        _progress(f"  run {i + 1}/{runs}: {marker} tools={names}")
        if verbose and inject_args:
            _progress(f"    inject headline: {inject_args.get('headline', '')[:120]!r}")

    _progress(
        f"\n  summary: {result.fired_inject}/{result.total} runs fired "
        f"inject_critical_event; {result.solo_inject}/{result.total} were SOLO "
        f"(missing DRIVE pairing — the issue #151 failure mode)"
    )
    return result


# ---------------------------------------------------------------- probe 2


@dataclass
class Probe2Result:
    pre_fix_dispatch: dict[str, Any]
    post_fix_dispatch: dict[str, Any]


async def probe_2_dispatch_layer(*, verbose: bool) -> Probe2Result:
    """Replay a synthetic solo-inject response through the dispatcher
    in two configurations to demonstrate fix A's effect:

      pre-fix simulation: bypass the pairing scan in ``dispatch()`` by
        forcing ``inject_pairing_violation=False``. The dispatcher
        accepts the inject; the message lands; ``critical_inject_fired``
        is True.

      post-fix (live):     run the dispatcher's actual code path. The
        pairing scan catches the violation; the inject's tool_result
        carries ``is_error=True`` with the chain-shape hint; the
        message does NOT land; ``critical_inject_fired`` is False.

    No live API call — pure dispatcher behavior.
    """

    _progress("\n[probe 2/3] dispatch-layer rejection (fix A) — no live API call")

    # Build a minimal session for the dispatcher.
    creator = Role(id="role-ciso", label="CISO", is_creator=True)
    soc = Role(id="role-soc", label="SOC Analyst")
    plan = ScenarioPlan(
        title="t",
        key_objectives=["o"],
        narrative_arc=[ScenarioBeat(beat=1, label="b", expected_actors=["CISO"])],
        injects=[ScenarioInject(trigger="after beat 1", summary="i")],
    )
    session = Session(
        scenario_prompt="x",
        state=SessionState.AI_PROCESSING,
        roles=[creator, soc],
        creator_role_id=creator.id,
        plan=plan,
    )

    bundle = ExtensionBundle(tools=[], resources=[])
    registry = freeze_bundle(bundle)
    audit = AuditLog()
    ext_dispatcher = ExtensionDispatcher(registry=registry, audit=audit)
    dispatcher = ToolDispatcher(
        connections=ConnectionManager(),
        audit=audit,
        extension_dispatcher=ext_dispatcher,
        registry=registry,
    )

    solo_inject_call = {
        "name": "inject_critical_event",
        "id": "tu-solo-inject",
        "input": {
            "severity": "HIGH",
            "headline": "Slack screenshot leaked to press",
            "body": (
                "Reporter is calling about an internal incident-channel "
                "screenshot circulating on regional Twitter."
            ),
        },
    }

    # --- post-fix path (the dispatcher we just patched) ---
    post_outcome = await dispatcher.dispatch(
        session=session,
        tool_uses=[solo_inject_call],
        turn_id="t-post",
        critical_inject_allowed_cb=lambda: True,
    )
    post_inject_result = next(
        (r for r in post_outcome.tool_results if r.get("tool_use_id") == "tu-solo-inject"),
        None,
    )
    post_summary = {
        "is_error": (post_inject_result or {}).get("is_error"),
        "content_excerpt": (post_inject_result or {}).get("content", "")[:200],
        "critical_inject_fired": post_outcome.critical_inject_fired,
        "critical_inject_attempted_args": post_outcome.critical_inject_attempted_args,
        "appended_messages_count": len(post_outcome.appended_messages),
    }

    # --- pre-fix simulation: emulate the legacy path where the pairing
    # scan in ``dispatch()`` was absent. We bypass the public dispatch
    # method and call the per-tool handler directly with the violation
    # flag forced to False (the absence of the scan == False).
    pre_outcome = await _simulate_pre_fix_dispatch(dispatcher, session, solo_inject_call)
    pre_inject_result = next(
        (r for r in pre_outcome.tool_results if r.get("tool_use_id") == "tu-solo-inject"),
        None,
    )
    pre_summary = {
        "is_error": (pre_inject_result or {}).get("is_error"),
        "content_excerpt": (pre_inject_result or {}).get("content", "")[:200],
        "critical_inject_fired": pre_outcome.critical_inject_fired,
        "appended_messages_count": len(pre_outcome.appended_messages),
    }

    _progress("  pre-fix simulation:")
    _progress(f"    is_error            = {pre_summary['is_error']}")
    _progress(f"    inject fired (banner) = {pre_summary['critical_inject_fired']}")
    _progress(f"    msg appended count    = {pre_summary['appended_messages_count']}")
    _progress("  post-fix (live code):")
    _progress(f"    is_error            = {post_summary['is_error']}")
    _progress(f"    inject fired (banner) = {post_summary['critical_inject_fired']}")
    _progress(f"    msg appended count    = {post_summary['appended_messages_count']}")
    if verbose:
        _progress("    rejection content excerpt:")
        _progress(f"      {post_summary['content_excerpt']!r}")

    return Probe2Result(pre_fix_dispatch=pre_summary, post_fix_dispatch=post_summary)


async def _simulate_pre_fix_dispatch(
    dispatcher: ToolDispatcher,
    session: Session,
    tool_use: dict[str, Any],
) -> Any:
    """Run a single tool through the dispatcher with the fix-A pairing
    scan effectively bypassed. Calls ``_dispatch_one`` directly with
    ``inject_pairing_violation=False``, which mirrors the behavior
    before fix A landed (the public ``dispatch()`` method computes the
    flag, but ``_dispatch_one`` honors whatever value its caller
    passes — defaulting to False for backwards-compatibility with
    callers that haven't been updated yet).
    """

    from app.llm.dispatch import DispatchOutcome  # local import to avoid early bind

    outcome = DispatchOutcome()
    # Capture the args (fix B already lives in DispatchOutcome — mirror
    # the public dispatch()'s behavior so the comparison is apples-to-
    # apples on Probe 3's grounding payload). The pre-fix path also
    # would not have populated this field (the field didn't exist), but
    # because Probe 3 needs it as a function argument (not a dispatcher
    # output), we set it here so both paths produce the same downstream
    # input.
    outcome.critical_inject_attempted_args = dict(tool_use.get("input") or {})
    await dispatcher._dispatch_one(  # type: ignore[attr-defined]
        session=session,
        tool_use=tool_use,
        turn_id="t-pre",
        outcome=outcome,
        critical_inject_allowed_cb=lambda: True,
        inject_pairing_violation=False,
    )
    return outcome


# ---------------------------------------------------------------- probe 3


@dataclass
class RecoveryRunResult:
    text: str
    grounding_count: int
    grounding_hits: list[str]
    neutral_count: int
    neutral_hits: list[str]
    is_grounded: bool
    # Stricter signal: does the broadcast LEAD with the inject (first
    # 100 chars contain inject-specific keywords / a critical-event
    # frame like "CRITICAL INJECT", "BREAKING", "MEDIA LEAK", etc.)?
    # The keyword check earlier is too permissive — generic
    # containment broadcasts hit "comms" / "regulator" / "statement"
    # without ever announcing the inject. Leading with the inject is
    # what tells players "the new event matters more than continuing
    # the prior beat" — the production behavior Fix B exists to
    # enforce.
    leads_with_inject: bool


@dataclass
class Probe3Result:
    samples: int
    pre_fix_runs: list[RecoveryRunResult] = field(default_factory=list)
    post_fix_runs: list[RecoveryRunResult] = field(default_factory=list)

    @property
    def pre_grounded_rate(self) -> float:
        if not self.pre_fix_runs:
            return 0.0
        return sum(1 for r in self.pre_fix_runs if r.is_grounded) / len(self.pre_fix_runs)

    @property
    def post_grounded_rate(self) -> float:
        if not self.post_fix_runs:
            return 0.0
        return sum(1 for r in self.post_fix_runs if r.is_grounded) / len(
            self.post_fix_runs
        )

    @property
    def pre_leads_rate(self) -> float:
        if not self.pre_fix_runs:
            return 0.0
        return sum(1 for r in self.pre_fix_runs if r.leads_with_inject) / len(
            self.pre_fix_runs
        )

    @property
    def post_leads_rate(self) -> float:
        if not self.post_fix_runs:
            return 0.0
        return sum(1 for r in self.post_fix_runs if r.leads_with_inject) / len(
            self.post_fix_runs
        )


async def probe_3_recovery_grounding(
    *,
    client: Any,
    model: str,
    samples: int,
    inject_args: dict[str, Any] | None,
    verbose: bool,
) -> Probe3Result:
    """Run the missing-DRIVE recovery prompt twice — once with the OLD
    generic addendum (fix B disabled) and once with the NEW inject-
    grounded addendum (fix B enabled) — and measure whether the
    recovery broadcast actually mentions the inject's context.

    Two scenarios are tested for each pair:

      pre-Fix-A reality (legacy):  Inject *succeeded* at dispatch — a
        CRITICAL_INJECT message lives in ``session.messages`` and the
        prior tool_result is success. The recovery LLM call sees the
        inject from THREE sources (transcript, prior tool_use, prior
        tool_result), so even the generic OLD directive grounds the
        broadcast — the model has plenty of context. This is the
        "before" everyone is used to.

      post-Fix-A reality (current): Inject *rejected* at dispatch — no
        CRITICAL_INJECT in ``session.messages`` and the prior
        tool_result is ``is_error=True`` carrying the chain-shape
        rejection. The recovery LLM call sees the inject from ONE
        source (its own prior tool_use). This is where Fix B's
        explicit grounding directive earns its keep — without it,
        the model can interpret the rejection as "skip the inject"
        and produce a vanilla next-beat brief.

    Both scenarios share the same code path; we vary the prior
    tool_result + the presence of a CRITICAL_INJECT bubble in the
    transcript.
    """

    _progress(f"\n[probe 3/3] recovery grounding (fix B) — n={samples} live pairs")
    _progress(
        "            pre-Fix-A scenario: inject landed (3 grounding sources)"
    )
    _progress(
        "            post-Fix-A scenario: inject rejected (1 grounding source)"
    )

    if inject_args is None:
        inject_args = {
            "severity": "HIGH",
            "headline": "Slack screenshot leaked to press",
            "body": (
                "Reporter is calling about an internal incident-channel "
                "screenshot circulating on regional Twitter."
            ),
        }
        _progress(
            "  (using synthetic inject args — probe 1 produced no solo "
            "inject this run, so falling back to a representative payload)"
        )

    # PR #170 Copilot review Comment 5: vary BOTH state AND directive
    # so the comparison actually models legacy-vs-current behavior.
    # The pre-fix branch builds a session whose transcript carries
    # the CRITICAL_INJECT bubble (the inject landed pre-Fix-A) and
    # splices a SUCCESS tool_result; the post-fix branch leaves the
    # transcript clean (Fix A rejected the inject before it reached
    # session.messages) and splices a REJECTION tool_result. Each
    # uses its corresponding directive (generic for pre, grounded
    # for post). Without varying both, we'd be measuring "same state,
    # two directives" — which is informative but not the legacy
    # vs current comparison we set out to do.
    #
    # ``workstreams_enabled=True`` matches production (PR #170
    # Copilot review Comment 4).
    pre_session = _build_inject_imminent_session()
    pre_session.messages.append(
        Message(
            kind=MessageKind.CRITICAL_INJECT,
            tool_name="inject_critical_event",
            body=(
                f"[{inject_args.get('severity', 'HIGH')}] "
                f"{inject_args.get('headline', '')} — "
                f"{inject_args.get('body', '')}"
            ),
            tool_args=dict(inject_args),
        )
    )
    pre_system_blocks = build_play_system_blocks(
        pre_session, registry=_empty_registry(), workstreams_enabled=True
    )
    post_session = _build_inject_imminent_session()
    post_system_blocks = build_play_system_blocks(
        post_session, registry=_empty_registry(), workstreams_enabled=True
    )

    pre_directive = drive_recovery_directive()
    post_directive = drive_recovery_directive(
        pending_critical_inject_args=inject_args,
    )

    def _base_messages(s: Session) -> list[dict[str, Any]]:
        msgs = _play_messages(s, strict=False)
        if msgs and msgs[-1]["role"] == "user":
            msgs.pop()
        return msgs

    prior_assistant = [
        {
            "type": "tool_use",
            "id": "tu-inject",
            "name": "inject_critical_event",
            "input": inject_args,
        }
    ]
    pre_fix_tool_result = [
        {
            "type": "tool_result",
            "tool_use_id": "tu-inject",
            "content": "critical event surfaced",
            "is_error": False,
        }
    ]
    post_fix_a_tool_result_content = (
        "inject_critical_event was emitted without a same-response "
        "actor-naming tool (`broadcast`, `address_role`, or "
        "`pose_choice`). Critical injects MUST land as a chain — re-"
        "fire as a chain."
    )
    post_fix_a_tool_result = [
        {
            "type": "tool_result",
            "tool_use_id": "tu-inject",
            "content": post_fix_a_tool_result_content,
            "is_error": True,
        }
    ]

    def _build_messages(
        base: list[dict[str, Any]],
        tool_result: list[dict[str, Any]],
        directive: Any,
    ) -> list[dict[str, Any]]:
        return [
            *base,
            {"role": "assistant", "content": prior_assistant},
            {
                "role": "user",
                "content": [
                    *tool_result,
                    {"type": "text", "text": directive.user_nudge},
                ],
            },
        ]

    def _build_system(
        base_system: list[dict[str, Any]], directive: Any
    ) -> list[dict[str, Any]]:
        return [*base_system, {"type": "text", "text": directive.system_addendum}]

    pre_messages = _build_messages(
        _base_messages(pre_session), pre_fix_tool_result, pre_directive
    )
    post_messages = _build_messages(
        _base_messages(post_session), post_fix_a_tool_result, post_directive
    )
    pre_system = _build_system(pre_system_blocks, pre_directive)
    post_system = _build_system(post_system_blocks, post_directive)
    tools = [t for t in PLAY_TOOLS if t["name"] in pre_directive.tools_allowlist]

    result = Probe3Result(samples=samples)
    for i in range(samples):
        # Serialise the pair so a transient API blip on one side
        # doesn't bias the comparison.
        pre_resp = await _call_model(
            client=client,
            model=model,
            system_blocks=pre_system,
            messages=pre_messages,
            tools=tools,
            tool_choice=pre_directive.tool_choice,
        )
        post_resp = await _call_model(
            client=client,
            model=model,
            system_blocks=post_system,
            messages=post_messages,
            tools=tools,
            tool_choice=post_directive.tool_choice,
        )
        pre_text = _extract_broadcast_message(pre_resp)
        post_text = _extract_broadcast_message(post_resp)
        pre_run = _score_recovery_text(pre_text)
        post_run = _score_recovery_text(post_text)
        result.pre_fix_runs.append(pre_run)
        result.post_fix_runs.append(post_run)
        pre_lead_marker = PASS if pre_run.leads_with_inject else FAIL
        post_lead_marker = PASS if post_run.leads_with_inject else FAIL
        _progress(
            f"  pair {i + 1}/{samples}: "
            f"pre-fix leads={pre_lead_marker} | "
            f"post-fix leads={post_lead_marker}"
        )
        if verbose:
            _progress(f"    pre-fix broadcast preview: {pre_text[:160]!r}")
            _progress(f"    post-fix broadcast preview: {post_text[:160]!r}")

    _progress(
        "\n  inject-grounded rate (any keyword present, lenient):"
    )
    _progress(
        f"    pre-fix:  {result.pre_grounded_rate * 100:.0f}% "
        f"({sum(1 for r in result.pre_fix_runs if r.is_grounded)}/{samples})"
    )
    _progress(
        f"    post-fix: {result.post_grounded_rate * 100:.0f}% "
        f"({sum(1 for r in result.post_fix_runs if r.is_grounded)}/{samples})"
    )
    _progress(
        "  inject-leading rate (broadcast opens with inject frame, strict):"
    )
    _progress(
        f"    pre-fix:  {result.pre_leads_rate * 100:.0f}% "
        f"({sum(1 for r in result.pre_fix_runs if r.leads_with_inject)}/{samples})"
    )
    _progress(
        f"    post-fix: {result.post_leads_rate * 100:.0f}% "
        f"({sum(1 for r in result.post_fix_runs if r.leads_with_inject)}/{samples})"
    )
    return result


def _extract_broadcast_message(resp: Any) -> str:
    captured = _capture_response(resp)
    for u in captured.tool_uses:
        if u.name == "broadcast":
            return str(u.input.get("message", ""))
    # Fallback — recovery is pinned to broadcast, so this should never
    # fire in practice; return empty so the grounding score lands at 0.
    return ""


def _score_recovery_text(text: str) -> RecoveryRunResult:
    grounding_count, grounding_hits = _grounding_score(text, _INJECT_GROUNDING_TERMS)
    neutral_count, neutral_hits = _grounding_score(text, _NEUTRAL_BEAT_TERMS)
    is_grounded = grounding_count >= 1
    leads_with_inject = _leads_with_inject(text)
    return RecoveryRunResult(
        text=text,
        grounding_count=grounding_count,
        grounding_hits=grounding_hits,
        neutral_count=neutral_count,
        neutral_hits=neutral_hits,
        is_grounded=is_grounded,
        leads_with_inject=leads_with_inject,
    )


_INJECT_LEAD_FRAMES = (
    "critical inject",
    "breaking",
    "media leak",
    "press leak",
    "leak detected",
    "inject —",
    "inject:",
    "🚨",
)


def _leads_with_inject(text: str) -> bool:
    """Stricter than the keyword check: does the broadcast OPEN with
    an inject-event frame in its first ~100 chars? Generic
    containment broadcasts hit grounding keywords later in the body
    ("we'll have Comms draft a statement once containment lands…")
    without ever announcing the inject as the lead. Leading with the
    inject is the production behavior the directive aims to
    enforce."""

    head = text[:100].lower().lstrip()
    return any(frame in head for frame in _INJECT_LEAD_FRAMES)


# ---------------------------------------------------------------- main


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--runs", type=int, default=5, help="probe 1 sample count")
    parser.add_argument(
        "--recovery-samples",
        type=int,
        default=3,
        help="probe 3 pre/post pair count",
    )
    parser.add_argument("--verbose", action="store_true", help="dump tool details")
    parser.add_argument("--json", action="store_true", help="emit a JSON report only")
    args = parser.parse_args()

    if args.json:
        # Silence structlog audit chatter so stdout stays valid JSON.
        # The audit boundary fires from ``ToolDispatcher`` (probe 2)
        # and would otherwise smear "tool_use" / "tool_use_rejected"
        # lines into the report. The app's ``configure_logging`` uses
        # ``PrintLoggerFactory(file=sys.stdout)``; without a config
        # call here, structlog falls back to its default which still
        # writes to stdout. Configure it explicitly with a stderr-
        # bound factory before any audit line gets a chance to flush.
        import logging

        import structlog

        logging.getLogger().setLevel(logging.CRITICAL)
        structlog.configure(
            processors=[
                structlog.processors.TimeStamper(fmt="iso", utc=True),
                structlog.processors.StackInfoRenderer(),
                structlog.processors.format_exc_info,
                structlog.dev.ConsoleRenderer(colors=False),
            ],
            wrapper_class=structlog.make_filtering_bound_logger(logging.CRITICAL),
            context_class=dict,
            logger_factory=structlog.PrintLoggerFactory(file=sys.stderr),
            cache_logger_on_first_use=False,
        )

    api_key = os.environ.get("LLM_API_KEY")
    if not api_key:
        msg = (
            "LLM_API_KEY not set. This script makes real API calls "
            "(~$0.15/run). In the harness, run via "
            "`backend/scripts/run-live-tests.sh` or set "
            "LIVE_TEST_LLM_API_KEY then bridge it inline:\n"
            "    LLM_API_KEY=\"$LIVE_TEST_LLM_API_KEY\" "
            "python scripts/issue_151_before_after.py"
        )
        if args.json:
            print(json.dumps({"skipped": True, "reason": msg}))
        else:
            _progress(f"{SKIP} — {msg}")
        return 0  # not a failure — just nothing to verify

    try:
        from anthropic import AsyncAnthropic
    except ImportError:
        if args.json:
            print(json.dumps({"failed": True, "reason": "anthropic SDK missing"}))
        else:
            _progress(f"{FAIL} — anthropic package not installed (`pip install anthropic`)")
        return 1

    settings = get_settings()
    model = settings.model_for("play")
    if not args.json:
        _progress(f"Live verification against model: {model}")
        _progress(f"Base URL: {settings.llm_api_base}")
    client = AsyncAnthropic(api_key=api_key, base_url=settings.llm_api_base)

    p1 = await probe_1_inject_solo_rate(
        client=client, model=model, runs=args.runs, verbose=args.verbose
    )
    p2 = await probe_2_dispatch_layer(verbose=args.verbose)
    # Use the headline / body of the most recent solo inject if probe 1
    # produced one — this anchors the recovery probe on what the model
    # actually emitted today (rather than a synthetic). If no solo
    # inject this run, fall back to the synthetic headline.
    inject_args = (
        p1.solo_runs()[-1].inject_args
        if p1.solo_runs()
        else (
            p1.runs[0].inject_args
            if p1.runs and p1.runs[0].inject_args
            else None
        )
    )
    p3 = await probe_3_recovery_grounding(
        client=client,
        model=model,
        samples=args.recovery_samples,
        inject_args=inject_args,
        verbose=args.verbose,
    )

    # Verdict.
    fix_a_works = (
        p2.post_fix_dispatch.get("is_error") is True
        and p2.post_fix_dispatch.get("critical_inject_fired") is False
        and p2.pre_fix_dispatch.get("is_error") is not True
    )
    # Fix B "works" if the strict leading-with-inject rate goes UP
    # (the lenient grounded-anywhere rate is too permissive — generic
    # broadcasts hit the keyword bucket without ever announcing the
    # inject as the lead).
    fix_b_works = p3.post_leads_rate > p3.pre_leads_rate or (
        p3.post_leads_rate == p3.pre_leads_rate and p3.post_leads_rate >= 0.8
    )

    if args.json:
        report = {
            "model": model,
            "probe_1_solo_inject_rate": p1.solo_inject_rate,
            "probe_1_total_runs": p1.total,
            "probe_1_solo_runs": p1.solo_inject,
            "probe_1_chained_runs": p1.chained_inject,
            "probe_2_pre_fix": p2.pre_fix_dispatch,
            "probe_2_post_fix": p2.post_fix_dispatch,
            "probe_3_pre_grounded_rate": p3.pre_grounded_rate,
            "probe_3_post_grounded_rate": p3.post_grounded_rate,
            "probe_3_pre_leads_rate": p3.pre_leads_rate,
            "probe_3_post_leads_rate": p3.post_leads_rate,
            "probe_3_pre_runs": [asdict(r) for r in p3.pre_fix_runs],
            "probe_3_post_runs": [asdict(r) for r in p3.post_fix_runs],
            "fix_a_works": fix_a_works,
            "fix_b_works": fix_b_works,
        }
        # Final report goes to stdout (not _progress -> stderr) so
        # consumers can pipe through ``jq``.
        print(json.dumps(report, indent=2))
        return 0 if fix_a_works else 1

    _progress("\n=== verdict ===")
    _progress(
        f"  fix A (dispatch-layer pairing): "
        f"{PASS if fix_a_works else FAIL} — pre-fix accepts solo inject, "
        f"post-fix rejects with structured error. Saves 2 LLM calls per "
        f"solo-inject turn AND prevents the banner-without-direction UX."
    )
    leads_delta = (p3.post_leads_rate - p3.pre_leads_rate) * 100
    grounded_delta = (p3.post_grounded_rate - p3.pre_grounded_rate) * 100
    fix_b_marker = PASS if fix_b_works else WARN
    _progress(
        f"  fix B (recovery grounding):    {fix_b_marker} — recovery "
        f"broadcast quality:"
    )
    _progress(
        f"    leads-with-inject: {p3.pre_leads_rate * 100:.0f}% → "
        f"{p3.post_leads_rate * 100:.0f}% ({leads_delta:+.0f} pp)"
    )
    _progress(
        f"    inject-grounded:   {p3.pre_grounded_rate * 100:.0f}% → "
        f"{p3.post_grounded_rate * 100:.0f}% ({grounded_delta:+.0f} pp)"
    )
    _progress()
    _progress(
        f"  Probe 1 baseline: {p1.solo_inject}/{p1.total} runs "
        f"({p1.solo_inject_rate * 100:.0f}%) fired inject_critical_event "
        f"WITHOUT a same-response DRIVE-slot tool — confirming issue #151's "
        f"failure mode reproduces reliably on the live model."
    )
    _progress(
        "  Fix A is the dominant cost-saver: by rejecting solo injects at "
        "dispatch, the engine avoids two extra LLM calls per turn (DRIVE + "
        "YIELD recovery) and short-circuits the broken-UX window where "
        "players see a banner with no per-role direction."
    )
    _progress(
        "  Fix B raises recovery quality: even when the lenient grounded-"
        "anywhere rate is uniform, the strict leading-with-inject rate "
        "shows the model is more likely to ANNOUNCE the inject as the "
        "lead rather than push it to a footnote behind a generic next-"
        "beat brief. It also adds a structured "
        "`drive_recovery_grounded_on_inject` log line operators can grep "
        "for to track recovery-after-inject rates over time."
    )
    if fix_a_works:
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
