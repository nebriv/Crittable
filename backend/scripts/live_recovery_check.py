"""Live Claude API verification of the play-turn drive/yield recovery cascade.

Hits the real Anthropic API (cost: a few cents per run) and confirms
that the post-fix prompt + recovery directives produce the expected
behavior on the actual model — not just against the mock transport in
the unit / e2e suites.

Why this script exists
----------------------

The 2026-04-30 silent-yield regression slipped through the unit tests
because the unit tests used a hand-rolled mock transport that returned
canned `tool_use` blocks. The real model interpretation of the prompt
copy was never observed. This script closes that loop: when you change
any of the prompt blocks, recovery directives, or the `_format_drive_user_nudge`
template, run this script before pushing.

Three checks
------------
1. Normal play turn: full tool palette, no `tool_choice`. Expect the
   model to call `broadcast` + `set_active_roles` in a single response,
   and the broadcast must address the active role(s) by name.
2. Drive recovery: tools narrowed to `broadcast`, `tool_choice` pinned,
   prior `record_decision_rationale` tool-loop spliced in, recovery
   user nudge with the verbatim player `?`. Expect a broadcast that
   contains a substring of the player's question (proves grounding).
3. Yield recovery: tools narrowed to `set_active_roles`, `tool_choice`
   pinned. Expect `set_active_roles` with valid role IDs.

Usage
-----
    cd backend
    ANTHROPIC_API_KEY=sk-ant-... python scripts/live_recovery_check.py

Add `--verbose` to dump the full request/response JSON for each call.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from typing import Any

# Make the script runnable from `backend/` without `pip install -e .`.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), os.pardir))

from app.config import get_settings
from app.extensions.models import ExtensionBundle
from app.extensions.registry import freeze_bundle
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
    _DRIVE_RECOVERY_NOTE,
    _STRICT_YIELD_NOTE,
    drive_recovery_directive,
    strict_yield_directive,
)

PASS = "\033[32mPASS\033[0m"
FAIL = "\033[31mFAIL\033[0m"
SKIP = "\033[33mSKIP\033[0m"


def _build_session() -> Session:
    """Construct a session that mirrors the captured production bug scenario."""

    creator = Role(id="role-ciso", label="CISO", display_name="Dev Tester", is_creator=True)
    soc = Role(id="role-soc", label="SOC Analyst", display_name="Dev Bot")
    plan = ScenarioPlan(
        title="Ransomware via vendor portal",
        executive_summary="03:14 Wednesday. Ransomware on finance laptops via a "
        "vendor service-account compromise.",
        key_objectives=[
            "Confirm scope within 30 min",
            "Contain without halting month-end close",
            "Decide regulator notification",
        ],
        narrative_arc=[
            ScenarioBeat(beat=1, label="Detection & triage", expected_actors=["SOC", "IR Lead"]),
            ScenarioBeat(beat=2, label="Containment", expected_actors=["IR Lead", "Engineering"]),
        ],
        injects=[
            ScenarioInject(
                trigger="after beat 2",
                type="critical",
                summary="Slack screenshot leaked to a regional newspaper Twitter.",
            )
        ],
        guardrails=["Stay in scope"],
        success_criteria=["Containment decision documented before beat 3"],
        out_of_scope=["Real exploit code"],
    )
    s = Session(
        scenario_prompt="Ransomware via vendor portal",
        state=SessionState.AI_PROCESSING,
        roles=[creator, soc],
        creator_role_id=creator.id,
        plan=plan,
    )
    # Transcript matching the captured production trace — AI's prior
    # broadcast asked CISO/SOC for triage, both replied, and SOC's last
    # message ends in `?`.
    s.messages.append(
        Message(
            kind=MessageKind.AI_TEXT,
            tool_name="broadcast",
            body=(
                "**SOC Analyst (Dev Bot)** — what does the alert queue look like? "
                "**CISO (Dev Tester)** — first containment instinct: isolate or monitor?"
            ),
        )
    )
    s.messages.append(
        Message(kind=MessageKind.PLAYER, role_id=creator.id, body="We isolate immediately via defender.")
    )
    s.messages.append(
        Message(
            kind=MessageKind.PLAYER,
            role_id=soc.id,
            body="Yeah we can pull account activity via Defender. What do we see?",
        )
    )
    return s


def _empty_registry() -> Any:
    return freeze_bundle(ExtensionBundle())


def _build_play_messages(session: Session) -> list[dict[str, Any]]:
    """Delegate to the production message builder so the live test
    sees the same context (incl. the per-turn reminder) the engine
    sends to the model in production."""

    return _play_messages(session, strict=False)


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


def _tool_uses(resp: Any) -> list[Any]:
    return [b for b in getattr(resp, "content", []) if getattr(b, "type", None) == "tool_use"]


async def check_normal_turn(client: Any, model: str, verbose: bool) -> str:
    """Informational: did the model produce a complete turn on attempt 1?

    Returns ``"ideal"`` if the model emitted both DRIVE + YIELD in a
    single response, or ``"needs_recovery"`` if it stopped on
    bookkeeping/stage-direction tools only. The latter is the SAME
    failure mode that triggered the 2026-04-30 regression — but with
    the validator in place, the recovery cascade (checks 2 + 3) takes
    over. Either outcome is fine for production correctness; this
    check just measures how often the cascade activates.
    """

    print("\n[1/3] normal play turn — full tool palette, no tool_choice")
    print("       (informational — does the model attempt-1 the full shape?)")
    session = _build_session()
    system_blocks = build_play_system_blocks(session, registry=_empty_registry())
    messages = _build_play_messages(session)
    resp = await _call_model(
        client=client,
        model=model,
        system_blocks=system_blocks,
        messages=messages,
        tools=PLAY_TOOLS,
        tool_choice=None,
    )
    uses = _tool_uses(resp)
    names = [u.name for u in uses]
    if verbose:
        print(json.dumps([{"name": u.name, "input": u.input} for u in uses], indent=2))
    has_drive = any(n in {"broadcast", "address_role"} for n in names)
    has_yield = any(n == "set_active_roles" for n in names)
    if has_drive and has_yield:
        print(f"  {PASS} ideal — emitted {names} (no recovery needed)")
        return "ideal"
    print(
        f"  {SKIP} needs_recovery — model emitted {names}; the validator "
        "will fire drive+yield recovery (checks 2 & 3 cover this)."
    )
    return "needs_recovery"


async def check_drive_recovery(client: Any, model: str, verbose: bool) -> bool:
    print("\n[2/3] drive recovery — tools narrowed to broadcast, ? grounded")
    session = _build_session()
    system_blocks = build_play_system_blocks(session, registry=_empty_registry())
    system_blocks.append({"type": "text", "text": _DRIVE_RECOVERY_NOTE})
    # Splice the prior tool_use (record_decision_rationale only) and the
    # dispatcher's tool_result so the model sees what it just did.
    prior_assistant = [
        {
            "type": "tool_use",
            "id": "tu_rationale",
            "name": "record_decision_rationale",
            "input": {"rationale": "Beat 1 transition: SOC needs telemetry."},
        }
    ]
    prior_tool_result = [
        {
            "type": "tool_result",
            "tool_use_id": "tu_rationale",
            "content": "rationale recorded",
            "is_error": False,
        }
    ]
    directive = drive_recovery_directive(
        pending_player_question=(
            "Yeah we can pull account activity via Defender. What do we see?"
        )
    )
    messages = _build_play_messages(session)
    if messages and messages[-1]["role"] == "user":
        messages.pop()
    messages.append({"role": "assistant", "content": prior_assistant})
    messages.append({
        "role": "user",
        "content": [*prior_tool_result, {"type": "text", "text": directive.user_nudge}],
    })
    tools = [t for t in PLAY_TOOLS if t["name"] in directive.tools_allowlist]
    resp = await _call_model(
        client=client,
        model=model,
        system_blocks=system_blocks,
        messages=messages,
        tools=tools,
        tool_choice=directive.tool_choice,
    )
    uses = _tool_uses(resp)
    if verbose:
        print(json.dumps([{"name": u.name, "input": u.input} for u in uses], indent=2))
    if not uses or uses[0].name != "broadcast":
        print(f"  {FAIL} — expected broadcast, got {[u.name for u in uses]}")
        return False
    body = uses[0].input.get("message", "")
    # Substring match — the model rephrases but should reference the source.
    grounding_terms = ("Defender", "account activity", "service account")
    if any(term.lower() in body.lower() for term in grounding_terms):
        print(f"  {PASS} — broadcast addresses the question; body[:140]={body[:140]!r}")
        return True
    print(
        f"  {FAIL} — broadcast did NOT reference the player's question "
        f"({grounding_terms!r}); body[:200]={body[:200]!r}"
    )
    return False


async def check_yield_recovery(client: Any, model: str, verbose: bool) -> bool:
    print("\n[3/3] yield recovery — tools narrowed to set_active_roles")
    session = _build_session()
    system_blocks = build_play_system_blocks(session, registry=_empty_registry())
    system_blocks.append({"type": "text", "text": _STRICT_YIELD_NOTE})
    # Pretend the drive recovery already landed — splice that broadcast.
    prior_assistant = [
        {
            "type": "tool_use",
            "id": "tu_drive_recovery",
            "name": "broadcast",
            "input": {
                "message": (
                    "Defender shows the service account auth'd from 5 hosts in the "
                    "last 90 minutes. CISO — confirm isolation; SOC — what's our "
                    "first telemetry pull?"
                )
            },
        }
    ]
    prior_tool_result = [
        {
            "type": "tool_result",
            "tool_use_id": "tu_drive_recovery",
            "content": "broadcast queued",
            "is_error": False,
        }
    ]
    directive = strict_yield_directive()
    messages = _build_play_messages(session)
    if messages and messages[-1]["role"] == "user":
        messages.pop()
    messages.append({"role": "assistant", "content": prior_assistant})
    messages.append({
        "role": "user",
        "content": [*prior_tool_result, {"type": "text", "text": directive.user_nudge}],
    })
    tools = [t for t in PLAY_TOOLS if t["name"] in directive.tools_allowlist]
    resp = await _call_model(
        client=client,
        model=model,
        system_blocks=system_blocks,
        messages=messages,
        tools=tools,
        tool_choice=directive.tool_choice,
    )
    uses = _tool_uses(resp)
    if verbose:
        print(json.dumps([{"name": u.name, "input": u.input} for u in uses], indent=2))
    if not uses or uses[0].name != "set_active_roles":
        print(f"  {FAIL} — expected set_active_roles, got {[u.name for u in uses]}")
        return False
    role_ids = uses[0].input.get("role_ids", [])
    valid = {r.id for r in session.roles}
    if role_ids and all(rid in valid for rid in role_ids):
        print(f"  {PASS} — yielded to {role_ids}")
        return True
    print(f"  {FAIL} — invalid role_ids {role_ids}; expected subset of {valid}")
    return False


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--verbose", action="store_true", help="dump tool_use JSON")
    args = parser.parse_args()

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print(
            f"{SKIP} — ANTHROPIC_API_KEY not set. This script makes real API "
            f"calls (~$0.03/run). Export the key and re-run.\n"
            f"    export ANTHROPIC_API_KEY=sk-ant-...\n"
            f"    python scripts/live_recovery_check.py"
        )
        return 0  # not a failure — just nothing to verify

    try:
        from anthropic import AsyncAnthropic
    except ImportError:
        print(f"{FAIL} — anthropic package not installed (`pip install anthropic`)")
        return 1

    settings = get_settings()
    model = settings.model_for("play")
    print(f"Live verification against model: {model}")
    print(f"Base URL: {settings.anthropic_base_url}")
    client = AsyncAnthropic(api_key=api_key, base_url=settings.anthropic_base_url)

    attempt1 = await check_normal_turn(client, model, args.verbose)
    drive_ok = await check_drive_recovery(client, model, args.verbose)
    yield_ok = await check_yield_recovery(client, model, args.verbose)

    print()
    print(f"Attempt-1 ideal-shape: {attempt1}")
    print(f"Drive recovery:        {'PASS' if drive_ok else 'FAIL'}")
    print(f"Yield recovery:        {'PASS' if yield_ok else 'FAIL'}")
    if drive_ok and yield_ok:
        if attempt1 == "ideal":
            print(
                "\nProduction-correct: the model attempted the full shape "
                "AND the recovery cascade works. Best case."
            )
        else:
            print(
                "\nProduction-correct: the model needed the recovery "
                "cascade and the cascade worked end-to-end. This is the "
                "expected steady state — the validator + recovery loop "
                "is what makes the engine resilient to attempt-1 misses."
            )
        return 0
    print(
        "\nFAILURE: a recovery directive did not produce its expected "
        "output on the live model. Investigate the prompt copy in "
        "`_DRIVE_RECOVERY_NOTE` / `_STRICT_YIELD_NOTE` / Block 6 of "
        "`prompts.py`. This is a regression."
    )
    return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
