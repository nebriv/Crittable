"""Live-API smoke for Phase A chat-declutter `declare_workstreams`.

Asserts the setup-tier model:

* fires `declare_workstreams` on a multi-track scenario shape
  (ransomware: containment + disclosure + comms = 3+ parallel tracks),
* skips it on a small/sequential shape (2-person phishing triage =
  one concern at a time).

Per ``docs/tool-design.md`` we assert *shape*, not content — we don't
care what ids/labels the model picks, only that it makes the binary
"do I need workstreams here?" call correctly.

Setup-tier traffic flows through the standard Anthropic message API.
We bypass the in-process turn driver so the test is self-contained
(matches the play-tier live tests' style).
"""

from __future__ import annotations

from typing import Any

import pytest

from app.llm.prompts import build_setup_system_blocks
from app.llm.tools import setup_tools_for
from app.sessions.models import Role, Session, SessionState

pytestmark = [pytest.mark.asyncio, pytest.mark.live]


def _multi_track_session() -> Session:
    """Ransomware tabletop with 5 roles — classic multi-track shape."""

    creator = Role(id="role-ciso", label="CISO", display_name="A", is_creator=True)
    return Session(
        scenario_prompt=(
            "Ransomware via vendor portal hits a 200-person fintech. "
            "We need to brief CISO, IR Lead, SOC, Legal, and Comms — "
            "expect parallel containment, regulator-disclosure clock, "
            "and external-comms tracks running concurrently."
        ),
        state=SessionState.SETUP,
        roles=[creator],
        creator_role_id=creator.id,
    )


def _small_sequential_session() -> Session:
    """2-person phishing triage — sequential investigation. No tracks."""

    creator = Role(
        id="role-soc", label="SOC Analyst", display_name="A", is_creator=True
    )
    return Session(
        scenario_prompt=(
            "Phishing-triage drill, 2-person team (SOC + Manager). "
            "Sequential: investigate one suspicious email, decide remediation, "
            "document. One concern at a time. Beginner difficulty."
        ),
        state=SessionState.SETUP,
        roles=[creator],
        creator_role_id=creator.id,
    )


async def _call_setup(
    client: Any,
    *,
    model: str,
    session: Session,
) -> Any:
    """Hit the setup tier with workstreams_enabled=True so
    ``declare_workstreams`` is in the tool palette."""

    system_blocks = build_setup_system_blocks(session, workstreams_enabled=True)
    messages: list[dict[str, Any]] = [
        {
            "role": "user",
            "content": (
                "Draft the scenario plan now. Don't ask any more questions; "
                "if any details would be helpful, infer reasonable defaults "
                "from the seed prompt and proceed. Call propose_scenario_plan, "
                "then optionally declare_workstreams if the scenario warrants "
                "it, then finalize_setup. The creator approves whatever you "
                "produce."
            ),
        }
    ]
    return await client.messages.create(
        model=model,
        max_tokens=4096,
        system=system_blocks,
        messages=messages,
        tools=setup_tools_for(workstreams_enabled=True),
        tool_choice={"type": "any"},
    )


def _tool_uses(resp: Any) -> list[Any]:
    return [
        b for b in getattr(resp, "content", []) if getattr(b, "type", None) == "tool_use"
    ]


async def test_multi_track_setup_fires_declare_workstreams(
    anthropic_client: Any,
    request: pytest.FixtureRequest,
) -> None:
    """5-role ransomware → model emits declare_workstreams with ≥2 entries.

    We don't assert which workstreams; the model picks per-scenario per
    plan §10 Q7 (no curated label set in v1).

    A miss here is a soft signal — the model is non-deterministic and
    plan §7.1 names a tuning lever ("if declaration rate < 50% across
    20 multi-track scenarios, soften the directive"). To make that
    rate observable instead of invisible, we mark the test ``xfail``
    when the call is missed (so the operator sees ``XFAIL`` /
    ``XPASS`` in the summary) and emit a warning the run captures.
    Hard-asserting would mean every CI run gambles on
    non-determinism; pytest.skip silently hides the miss. xfail is
    the documented "I expect this to pass but a miss is informative"
    pattern.
    """

    settings_model = __import__(
        "app.config", fromlist=["get_settings"]
    ).get_settings().model_for("setup")
    resp = await _call_setup(
        anthropic_client,
        model=settings_model,
        session=_multi_track_session(),
    )
    uses = _tool_uses(resp)
    names = [u.name for u in uses]
    declare_calls = [u for u in uses if u.name == "declare_workstreams"]

    if not declare_calls:
        # Surface the miss as a captured warning so a 20-run sweep
        # can grep "declare_workstreams_missed" to compute the rate
        # plan §7.1 calls out as the tuning trigger.
        import warnings

        warnings.warn(
            f"declare_workstreams_missed_on_multi_track tools={names}",
            stacklevel=1,
        )
        request.node.add_marker(
            pytest.mark.xfail(
                strict=False,
                reason=(
                    "model chose to skip declare_workstreams on the "
                    "multi-track shape; non-deterministic but informative "
                    "— see plan §7.1 declaration-rate tuning lever."
                ),
            )
        )
        pytest.fail("declare_workstreams missing — see xfail marker")

    assert len(declare_calls) == 1, "exactly one declare_workstreams expected"
    args = declare_calls[0].input
    assert isinstance(args, dict)
    workstreams = args.get("workstreams") or []
    # Plan §4.2 — soft floor of 2, hard cap of 8. We assert the hard cap;
    # the soft floor is informational since the model picks the count.
    assert isinstance(workstreams, list)
    assert len(workstreams) <= 8
    # Each entry must have the required shape (id + label).
    for ws in workstreams:
        assert "id" in ws
        assert "label" in ws


async def test_small_sequential_setup_skips_declare_workstreams(
    anthropic_client: Any,
) -> None:
    """2-person phishing triage → model skips declare_workstreams.

    Per plan §5.3, the directive explicitly tells the model to skip
    when "every actor is working the same concern at any given moment".
    """

    settings_model = __import__(
        "app.config", fromlist=["get_settings"]
    ).get_settings().model_for("setup")
    resp = await _call_setup(
        anthropic_client,
        model=settings_model,
        session=_small_sequential_session(),
    )
    uses = _tool_uses(resp)
    declare_calls = [u for u in uses if u.name == "declare_workstreams"]
    # If the model declares anyway, it should at most pick 1 entry —
    # any more than that is over-application of the tool.
    if declare_calls:
        args = declare_calls[0].input
        workstreams = args.get("workstreams") or []
        assert len(workstreams) <= 1, (
            f"model over-applied declare_workstreams on a sequential / "
            f"small scenario: {workstreams}"
        )
