"""Ad-hoc diagnostic: show the FULL Anthropic response on the bug scenario.

Dumps stop_reason, all content blocks (text + tool_use), tool_use ordering,
input_tokens, output_tokens. Useful for investigating why the model picks
`inject_event` over `broadcast`.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), os.pardir))

from anthropic import AsyncAnthropic

from app.config import get_settings
from app.extensions.models import ExtensionBundle
from app.extensions.registry import freeze_bundle
from app.llm.prompts import build_play_system_blocks
from app.llm.tools import PLAY_TOOLS

# Reuse the same scenario as the live recovery script.
from scripts.live_recovery_check import _build_play_messages, _build_session


async def main() -> int:
    api_key = os.environ["ANTHROPIC_API_KEY"]
    settings = get_settings()
    client = AsyncAnthropic(api_key=api_key, base_url=settings.anthropic_base_url)
    session = _build_session()
    system_blocks = build_play_system_blocks(session, registry=freeze_bundle(ExtensionBundle()))
    messages = _build_play_messages(session)

    # Variant 1: full palette (the production path).
    print("=" * 70)
    print("VARIANT 1: full palette, no tool_choice (production path)")
    print("=" * 70)
    resp = await client.messages.create(
        model=settings.model_for("play"),
        max_tokens=2048,  # extra headroom in case model was running out
        system=system_blocks,
        messages=messages,
        tools=PLAY_TOOLS,
    )
    print(f"stop_reason: {resp.stop_reason}")
    print(f"usage: input={resp.usage.input_tokens} output={resp.usage.output_tokens}")
    print(f"content blocks: {len(resp.content)}")
    for i, block in enumerate(resp.content):
        btype = getattr(block, "type", "unknown")
        if btype == "text":
            text = block.text
            print(f"  [{i}] text ({len(text)} chars): {text[:200]!r}{'...' if len(text) > 200 else ''}")
        elif btype == "tool_use":
            print(f"  [{i}] tool_use: name={block.name} input={json.dumps(block.input, indent=2)[:300]}")
        else:
            print(f"  [{i}] {btype}: {block!r}")

    # Variant 2: rationale removed. If the model still avoids broadcast, the
    # bug is deeper than just rationale-priority bias.
    print()
    print("=" * 70)
    print("VARIANT 2: rationale removed from palette")
    print("=" * 70)
    tools_no_rationale = [t for t in PLAY_TOOLS if t["name"] != "record_decision_rationale"]
    resp2 = await client.messages.create(
        model=settings.model_for("play"),
        max_tokens=2048,
        system=system_blocks,
        messages=messages,
        tools=tools_no_rationale,
    )
    print(f"stop_reason: {resp2.stop_reason}")
    print(f"usage: input={resp2.usage.input_tokens} output={resp2.usage.output_tokens}")
    print(f"content blocks: {len(resp2.content)}")
    for i, block in enumerate(resp2.content):
        btype = getattr(block, "type", "unknown")
        if btype == "text":
            text = block.text
            print(f"  [{i}] text ({len(text)} chars): {text[:200]!r}{'...' if len(text) > 200 else ''}")
        elif btype == "tool_use":
            print(f"  [{i}] tool_use: name={block.name} input={json.dumps(block.input, indent=2)[:300]}")

    # Variant 3: rationale + mark_timeline_point + inject_event removed.
    # Forces the hand: only broadcast/address_role/set_active_roles can speak.
    print()
    print("=" * 70)
    print("VARIANT 3: rationale + inject_event + mark_timeline_point removed")
    print("=" * 70)
    forbidden = {"record_decision_rationale", "inject_event", "mark_timeline_point"}
    tools_strict = [t for t in PLAY_TOOLS if t["name"] not in forbidden]
    resp3 = await client.messages.create(
        model=settings.model_for("play"),
        max_tokens=2048,
        system=system_blocks,
        messages=messages,
        tools=tools_strict,
    )
    print(f"stop_reason: {resp3.stop_reason}")
    print(f"usage: input={resp3.usage.input_tokens} output={resp3.usage.output_tokens}")
    print(f"content blocks: {len(resp3.content)}")
    for i, block in enumerate(resp3.content):
        btype = getattr(block, "type", "unknown")
        if btype == "text":
            text = block.text
            print(f"  [{i}] text ({len(text)} chars): {text[:200]!r}")
        elif btype == "tool_use":
            print(f"  [{i}] tool_use: name={block.name} input={json.dumps(block.input, indent=2)[:300]}")

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
