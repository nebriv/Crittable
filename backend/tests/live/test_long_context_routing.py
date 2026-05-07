"""§E demonstration test — does the model still route correctly
deep into a session?

Why this exists
---------------

Most live-tier regressions we've caught surface at turn 1-3 because
our short-context fixtures look just like the prompt's worked
examples. The "real" long-context failure mode — the per-turn
reminder getting buried in a 50K+ token transcript — needs much
heavier inputs to reproduce reliably (Sonnet 4.6's effective
attention window is wide; meaningful recency bias kicks in well
above 30K input tokens).

This test is the **first step** toward §E coverage: a 24-turn
transcript (~8 KB raw, ~2.5K transcript tokens, ~10K total input
including system blocks + tool descriptions) that puts the model
roughly **2x as deep** as the existing turn-1 case. It is NOT a
genuine long-context stress test on its own — at this depth Sonnet
still has the routing rules trivially in attention. What it DOES
catch is "the routing rules survive a session-shaped transcript at
all" — i.e. did a recent prompt edit accidentally break routing on
anything past the first three turns. A purpose-built ~50K-token
test (e.g. a 100-turn transcript or a single mega-message stuffing
context) is the natural follow-up; tracked separately.

Issue #74 calls for "at least one example new live test from a
category in §A-F" landing alongside the gated CI workflow. PR #166
covered §A (setup), §B (AAR), §C (guardrail), §D (critical-inject),
and §F (large roster). §E (long-context) was the remaining gap;
this is the foothold.

Cost
----

~$0.03 per run on `claude-sonnet-4-6` (~10K input × $3/Mtok plus
~500 output × $15/Mtok = $0.038). About 3x the short-context cases.
Skipped unless ``LLM_API_KEY`` is set. The cost-cap fixture in
``conftest.py`` records the spend like any other live call.
"""

from __future__ import annotations

from typing import Any

import pytest

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

from .conftest import call_play, tool_names, tool_uses

pytestmark = [pytest.mark.asyncio, pytest.mark.live]


# Bookkeeping-only tools — present in PLAY_TOOLS but produce no
# player-visible chat bubble on their own. The Trap 2/3 failure mode
# in docs/tool-design.md is the model picking ONLY these and stopping,
# leaving the player with no AI message. The forbidden-set check
# below uses this constant rather than the legacy "dead tool" names
# (which can't be picked anyway, since the API rejects unknown tool
# names).
_BOOKKEEPING_ONLY_TOOLS = frozenset(
    {
        "track_role_followup",
        "resolve_role_followup",
        "request_artifact",
        "lookup_resource",
        "use_extension_tool",
    }
)


def _deep_session() -> Session:
    """24-turn ransomware exercise, primed for a turn-25 data ask.

    The transcript is synthetic-but-realistic: alternating broadcast
    -> player-reply -> broadcast -> player-reply, with each body
    ~150-300 chars in operator register (Defender / EDR / NIST 6.1
    vocabulary). 12 paired turns + the turn-25 ask = 25 messages.

    NOT genuinely long-context; see module docstring for why. The
    intent is "deeper than turn-1, exercises the prompt at session
    shape."
    """

    creator = Role(
        id="role-ciso",
        label="CISO",
        display_name="Alex Reyes",
        is_creator=True,
    )
    soc = Role(id="role-soc", label="SOC Analyst", display_name="Bo Tan")
    plan = ScenarioPlan(
        title="Ransomware via vendor portal",
        executive_summary=(
            "03:14 Wednesday. Ransomware encrypted three finance laptops "
            "after a vendor-portal credential reuse. Containment in flight."
        ),
        key_objectives=[
            "Confirm scope before containment widens",
            "Decide regulator-notification clock",
            "Stage Comms holding statement for Legal review",
        ],
        narrative_arc=[
            ScenarioBeat(
                beat=1, label="Detection & triage", expected_actors=["SOC"]
            ),
            ScenarioBeat(
                beat=2,
                label="Containment",
                expected_actors=["CISO", "SOC"],
            ),
            ScenarioBeat(
                beat=3,
                label="Comms & decision",
                expected_actors=["CISO"],
            ),
        ],
        injects=[
            ScenarioInject(
                trigger="after beat 2",
                type="critical",
                summary="Reporter calls about leaked Slack screenshot.",
            )
        ],
        guardrails=["stay in scope", "no real exploit code"],
        success_criteria=[
            "containment before beat 3",
            "regulator clock decided",
        ],
        out_of_scope=["live exploitation", "specific CVE PoCs"],
    )
    session = Session(
        scenario_prompt="Ransomware via vendor portal",
        state=SessionState.AI_PROCESSING,
        roles=[creator, soc],
        creator_role_id=creator.id,
        plan=plan,
    )

    transcripts: list[tuple[str, str, str]] = [
        (
            "broadcast",
            "ai",
            "**Beat 1 — Detection.** Defender just lit up on three finance "
            "laptops (FIN-04, FIN-07, FIN-08). Lateral SMB attempts visible "
            "to FIN-12. **CISO** — first call: isolate the trio now or "
            "monitor 15 min for full scope mapping?",
        ),
        (
            "player",
            "ciso",
            "Isolate now. Don't wait. Pull IR Lead in. Start the regulator "
            "clock — we have 72 hours to assess GDPR notification scope. "
            "SOC, what's the lateral pattern look like beyond FIN-12?",
        ),
        (
            "broadcast",
            "ai",
            "Acknowledged — isolation in progress for FIN-04/07/08. **SOC** "
            "— what does the lateral SMB attempt pattern look like? Pull "
            "the EDR timeline for the three hosts.",
        ),
        (
            "player",
            "soc",
            "Defender shows 12 lateral SMB attempts from FIN-04 toward FIN-12 "
            "between 03:08-03:13, all blocked by host firewall. No successful "
            "auth seen. Pulling the auth log for the vendor-portal account now.",
        ),
        (
            "broadcast",
            "ai",
            "Good — vendor-portal credential reuse is the leading hypothesis. "
            "**CISO** — do we kill the portal session globally or just the "
            "compromised account? Global kill blast-radiuses 14 active "
            "vendors; account-only leaves the lateral path open if there "
            "are siblings.",
        ),
        (
            "player",
            "ciso",
            "Account-only first. We can escalate to global if SOC finds a "
            "second compromised account in the next 10 min. Comms — start "
            "drafting the holding statement; assume regulator notification "
            "in scope until we can rule it out.",
        ),
        (
            "broadcast",
            "ai",
            "Account-only kill in flight. **SOC** — sweep the auth log for "
            "any sibling accounts that touched the vendor portal in the "
            "last 24 hours.",
        ),
        (
            "player",
            "soc",
            "Sweep returned two siblings: vendor-billing and vendor-ops. "
            "Both show successful auths from the same source IP as the "
            "compromised account. Recommend killing both proactively.",
        ),
        (
            "broadcast",
            "ai",
            "**CISO** — siblings confirm credential-stuffing or shared "
            "password. Kill both and rotate all vendor-portal credentials? "
            "Or quarantine and observe for 5 min to capture attacker "
            "behavior for the IR report?",
        ),
        (
            "player",
            "ciso",
            "Kill both. Rotate everything. We're past the observe-for-"
            "intel window — containment is the priority. Legal, where are "
            "we on the regulator clock decision? I need a yes/no by 04:00.",
        ),
        (
            "broadcast",
            "ai",
            "Kills in flight, rotation queued. **SOC** — confirm the kill "
            "took effect and no new auths from the source IPs. Comms, give "
            "us a 1-line draft of the holding statement so Legal can mark "
            "it up.",
        ),
        (
            "player",
            "soc",
            "Kill confirmed for both siblings; auth queue is dry. Source IPs "
            "blocked at the perimeter. No new lateral attempts in the last "
            "3 minutes. Defender-isolated hosts FIN-04/07/08 stable; "
            "encryption progress halted.",
        ),
        (
            "broadcast",
            "ai",
            "Containment looks holding. **CISO** — we're at the beat-2 → "
            "beat-3 transition. Three things to decide before we move to "
            "Comms: regulator clock yes/no, internal comms cadence, and "
            "whether we engage external IR for the post-incident review.",
        ),
        (
            "player",
            "ciso",
            "Regulator: yes — assume in scope, file at hour 24 if we can "
            "rule out, file by hour 72 if not. Internal: hourly to exec, "
            "EOD to all-hands. External IR: yes, engage for post-incident "
            "review, not active response.",
        ),
        (
            "broadcast",
            "ai",
            "Regulator path locked at 24h-or-72h. **SOC** — pull the "
            "kill-chain timeline so far: portal credential exposure → "
            "lateral SMB attempts → encryption start. Need it in the IR "
            "report and the regulator filing.",
        ),
        (
            "player",
            "soc",
            "Timeline: 02:51 vendor-portal auth from anomalous IP, 02:54 "
            "lateral SMB FIN-04→FIN-07, 03:02 first encryption activity "
            "FIN-04, 03:08 FIN-07 and FIN-08 encryption, 03:13 lateral "
            "attempt to FIN-12 blocked, 03:14 Defender alert chain.",
        ),
        (
            "broadcast",
            "ai",
            "Clean kill chain. **CISO** — Comms draft is ready: 'On "
            "DATE_TIME we identified suspicious activity affecting a "
            "limited set of finance workstations. Containment was "
            "completed within minutes. We are working with our incident "
            "response team to confirm scope and notify regulators as "
            "required.' Approve, edit, or reject?",
        ),
        (
            "player",
            "ciso",
            "Approve with one edit: change 'limited set of finance "
            "workstations' to 'three finance workstations'. Specificity "
            "is better than vague — Legal will agree.",
        ),
        (
            "broadcast",
            "ai",
            "Edit applied. Comms holding statement ready for Legal. "
            "**SOC** — final containment check before we close beat 2: "
            "are FIN-04/07/08 fully quarantined, and is there any sign "
            "of persistence the kill might have missed?",
        ),
        (
            "player",
            "soc",
            "Quarantine confirmed via Defender. No persistence indicators "
            "yet — checking for scheduled tasks, registry run keys, and "
            "WMI subscriptions on the three hosts. ETA 5 min.",
        ),
        (
            "broadcast",
            "ai",
            "Good. **CISO** — while SOC sweeps for persistence, we should "
            "decide on the IR-report scope. Three options: post-incident "
            "review only, full forensic engagement, or threat-actor "
            "attribution add-on. Each adds 24-48h to the close-out window.",
        ),
        (
            "player",
            "ciso",
            "Full forensic engagement. We need to know if this is "
            "credential-stuffing (one-off) or targeted (sibling threat). "
            "Skip the attribution add-on — not worth the time for a "
            "non-targeted criminal actor.",
        ),
        (
            "broadcast",
            "ai",
            "Forensic engagement scope locked. **SOC** — persistence sweep "
            "results? And give me the full Defender event chain on FIN-04 "
            "for the IR-report attachment: process tree, file writes, "
            "registry mods, network egress.",
        ),
    ]

    for kind, speaker, body in transcripts:
        if kind == "broadcast":
            session.messages.append(
                Message(
                    kind=MessageKind.AI_TEXT,
                    tool_name="broadcast",
                    body=body,
                )
            )
        elif speaker == "ciso":
            session.messages.append(
                Message(
                    kind=MessageKind.PLAYER,
                    role_id=creator.id,
                    body=body,
                )
            )
        else:
            session.messages.append(
                Message(
                    kind=MessageKind.PLAYER,
                    role_id=soc.id,
                    body=body,
                )
            )

    # Turn 25 — the data question we're actually testing routing on.
    # Same shape as ``session_with_player_data_question`` in conftest:
    # a direct 'show me the data' ask that should route to share_data
    # (or broadcast / address_role with markdown) and NOT to a
    # bookkeeping-only stuck-turn.
    session.messages.append(
        Message(
            kind=MessageKind.PLAYER,
            role_id=soc.id,
            body=(
                "Persistence sweep clean — no scheduled tasks, no run "
                "keys, no WMI subs. Now pulling the Defender event log "
                "for FIN-04 for the IR-report attachment. What does the "
                "timeline look like — process tree, file writes, "
                "registry mods, and network egress?"
            ),
        )
    )

    return session


@pytest.fixture
def deep_session() -> Session:
    return _deep_session()


async def test_data_question_routes_correctly_at_session_depth(
    anthropic_client: Any,
    play_model: str,
    deep_session: Session,
    empty_registry: Any,
) -> None:
    """A turn-25 data question must still route to a player-facing
    answering tool — not a bookkeeping-only stuck turn.

    Same routing contract as the turn-1 case in
    ``test_tool_routing.py::test_player_data_question_routes_to_share_data_or_broadcast``;
    a regression where this fails but the turn-1 case passes signals
    that the routing rules degrade as the session deepens — investigate
    Block 6 reinforcement, the per-turn reminder, and the tool
    description weights.
    """

    resp = await call_play(
        anthropic_client,
        model=play_model,
        session=deep_session,
        registry=empty_registry,
    )
    names = tool_names(resp)

    assert names, (
        "model emitted no tool calls at turn 25 — silent yield "
        f"regression at session depth. stop_reason={resp.stop_reason}"
    )

    # Bookkeeping-only stuck-turn check (Trap 2/3 from docs/tool-design.md):
    # the model picks ONLY non-rendering tools (track_role_followup,
    # request_artifact, etc.) and stops, leaving the player with no AI
    # bubble. The original forbidden-set used legacy removed-tool names
    # which the API would reject anyway — the bookkeeping-only failure
    # mode is the real risk class at depth.
    non_bookkeeping = set(names) - _BOOKKEEPING_ONLY_TOOLS - {"set_active_roles"}
    assert non_bookkeeping, (
        f"model called only bookkeeping/yield tools at turn 25: {names}. "
        "This is the silent-yield-at-depth class of bug — players "
        "would see no AI bubble despite the response."
    )

    # ``address_role`` is also acceptable: the player's question came
    # from a single role (SOC), so addressing them back is legitimate.
    # Aligned with ``test_briefing_turn_routes_to_broadcast`` and
    # ``test_player_decision_routes_to_broadcast`` in test_tool_routing.py.
    primary = {"share_data", "broadcast", "address_role"}
    assert any(n in primary for n in names), (
        f"expected share_data / broadcast / address_role at turn 25; "
        f"got {names}. The most-recent player message asks for "
        f"Defender event-log data — same routing contract as turn-1."
    )

    # Content-quality check: the answer must reference at least one
    # specific entity from the player's question. Wide acceptance set
    # so the test doesn't false-fail on a model that uses "EDR" instead
    # of "Defender" or "alert chain" instead of "event log" — both are
    # legitimate paraphrases at depth.
    answer_blocks = [
        u.input
        for u in tool_uses(resp)
        if u.name in {"share_data", "broadcast", "address_role"}
    ]
    answer_text = " ".join(
        str(b.get("data", "") or b.get("message", "") or b.get("label", ""))
        for b in answer_blocks
    ).lower()
    accepted = {
        "defender",
        "edr",
        "fin-04",
        "fin-",
        "event log",
        "event chain",
        "alert",
        "telemetry",
        "process",
        "file",
        "registry",
        "network",
        "egress",
        "timeline",
    }
    matched = [k for k in accepted if k in answer_text]
    assert matched, (
        "turn-25 answer didn't reference any specific entity from the "
        "player's data ask. The model may be giving a generic reply at "
        f"depth. Answer text: {answer_text[:300]!r}"
    )
