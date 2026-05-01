# ruff: noqa: F811
# ``F811`` fires on the ``client`` parameter in every test below
# because we re-import the pytest fixture from ``test_e2e_session``
# instead of duplicating the 9-line setup. The import + parameter
# pattern is the standard pytest cross-file fixture sharing pattern;
# F811 is a false positive here. The ergonomic alternative
# (move ``client`` + ``_install_minimal_mock`` to conftest.py) is a
# separate cleanup that touches every existing e2e test.

"""HTTP-path tests for the structured AAR export endpoint
(``GET /api/sessions/{session_id}/export.json``). Mirror shape on the
existing ``test_export_returns_425_while_aar_pending`` and
``test_aar_failed_path_returns_500`` cases for ``export.md`` so the
two endpoints share a regression net.

Coverage matrix (Copilot review feedback on PR #110):
   - 425 pending          (``aar_status="pending"``, generation hasn't started)
   - 425 generating       (``aar_status="generating"``, mid-flight)
   - 200 ready            (well-formed structured body + meta envelope)
   - 500 failed           (monkey-patched AARGenerator raises)
   - 410 evicted          (GC reaper has tombstoned the session id)
   - 403 wrong token      (auth path)
   - rationale visibility (every viewer sees ``rationale`` — matches
     the markdown export, not the over-aggressive strip we initially
     had on this endpoint)
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

# Reuse the harness fixtures + helpers from the main e2e suite — same
# TestClient setup, same minimal LLM mock, same _create_and_seat
# helper. Re-importing keeps the new tests behaviourally identical
# to the existing export.md tests they parallel.
from .test_e2e_session import _create_and_seat, client  # noqa: F401


def _force_session_to_ended(
    client: TestClient,
    session_id: str,
    *,
    aar_status: str,
    aar_report: dict[str, Any] | None = None,
) -> None:
    """Drop the session straight into ENDED without driving a play
    loop. The export endpoints gate on ``state == ENDED``; the
    individual status branches are what each test cares about."""

    import asyncio

    async def _set() -> None:
        from app.sessions.models import SessionState

        session = await client.app.state.manager.get_session(session_id)
        session.state = SessionState.ENDED
        session.aar_status = aar_status  # type: ignore[assignment]
        if aar_report is not None:
            session.aar_report = aar_report
        await client.app.state.manager._repo.save(session)

    asyncio.run(_set())


def test_export_json_returns_425_while_aar_pending(client: TestClient) -> None:
    """Same polling contract as ``export.md``: 425 + Retry-After
    while the AAR is still in flight, with a tiny JSON body so a
    polling client sees ``content-type: application/json`` end to
    end (no surprise text body before the success path)."""

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    client.post(f"/api/sessions/{sid}/setup/skip?token={cr}")
    _force_session_to_ended(client, sid, aar_status="pending")

    r = client.get(f"/api/sessions/{sid}/export.json?token={cr}")
    assert r.status_code == 425, r.text
    assert r.headers.get("Retry-After") == "3"
    assert r.headers.get("X-AAR-Status") == "pending"
    assert r.headers["content-type"].startswith("application/json")
    body = r.json()
    assert body["status"] == "pending"


def test_export_json_returns_425_while_aar_generating(client: TestClient) -> None:
    """``generating`` is the same bucket as ``pending`` from a
    polling-client's POV — both return 425 + Retry-After."""

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    client.post(f"/api/sessions/{sid}/setup/skip?token={cr}")
    _force_session_to_ended(client, sid, aar_status="generating")

    r = client.get(f"/api/sessions/{sid}/export.json?token={cr}")
    assert r.status_code == 425, r.text
    assert r.headers.get("X-AAR-Status") == "generating"


def test_export_json_returns_500_when_aar_failed(client: TestClient) -> None:
    """If the generator raised, ``aar_report`` is None and
    ``aar_status='failed'`` — endpoint surfaces 500 with the failure
    surfaced in the X-AAR-Status header so the React popup can render
    the right error state without parsing the body."""

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    client.post(f"/api/sessions/{sid}/setup/skip?token={cr}")
    _force_session_to_ended(client, sid, aar_status="failed", aar_report=None)

    r = client.get(f"/api/sessions/{sid}/export.json?token={cr}")
    assert r.status_code == 500, r.text
    assert r.headers.get("X-AAR-Status") == "failed"


def _fixture_aar_report(role_id: str) -> dict[str, Any]:
    """Minimal well-formed structured AAR — what
    ``_extract_report`` would store after a successful generation.
    ``role_id`` matches the seated player so the per-role lookup
    succeeds. Numeric fields use the rubric's actual 0–5 range."""

    return {
        "executive_summary": "Crisp containment, slow comms.",
        "narrative": "T0: detection. T1: isolate. T2: legal looped in.",
        "what_went_well": [
            "Isolated the affected hosts inside 5 min.",
            "IR Lead established clean comms cadence.",
        ],
        "gaps": [
            "Legal escalation lagged by 2 turns.",
        ],
        "recommendations": [
            "Pre-stage Legal-on-call rotation in the runbook.",
        ],
        "per_role_scores": [
            {
                "role_id": role_id,
                "label": "CISO",
                "display_name": "Alex",
                "decision_quality": 4,
                "communication": 3,
                "speed": 4,
                "rationale": "Decisive isolation call at T1.",
            }
        ],
        "overall_score": 4,
        "overall_rationale": "Containment held; comms could tighten.",
    }


def test_export_json_returns_200_with_well_formed_body(client: TestClient) -> None:
    """Happy-path contract: every documented field is present,
    typed correctly, and the meta envelope carries everything the
    frontend needs to render without a separate /snapshot call."""

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    creator_role_id = seats["creator_role_id"]
    client.post(f"/api/sessions/{sid}/setup/skip?token={cr}")
    _force_session_to_ended(
        client,
        sid,
        aar_status="ready",
        aar_report=_fixture_aar_report(creator_role_id),
    )

    r = client.get(f"/api/sessions/{sid}/export.json?token={cr}")
    assert r.status_code == 200, r.text
    assert r.headers.get("X-AAR-Status") == "ready"
    body = r.json()

    # Top-level structured fields
    assert isinstance(body["executive_summary"], str)
    assert isinstance(body["narrative"], str)
    assert body["what_went_well"] == [
        "Isolated the affected hosts inside 5 min.",
        "IR Lead established clean comms cadence.",
    ]
    assert body["gaps"] == ["Legal escalation lagged by 2 turns."]
    assert body["recommendations"] == [
        "Pre-stage Legal-on-call rotation in the runbook.",
    ]
    assert body["overall_score"] == 4

    # Per-role: backend stamps decisions count + every score has the
    # canonical label/display_name (no UUID prefixes leak to the
    # frontend even if AI emits a phantom id).
    scores = body["per_role_scores"]
    assert len(scores) == 1
    assert scores[0]["role_id"] == creator_role_id
    assert scores[0]["label"] == "CISO"
    assert scores[0]["display_name"] == "Alex"
    assert scores[0]["decisions"] == 0  # no player messages were posted

    # Meta envelope
    meta = body["meta"]
    assert meta["session_id"] == sid
    assert meta["is_creator"] is True
    assert meta["turn_count"] >= 0
    assert isinstance(meta["roles"], list) and len(meta["roles"]) == 2


def test_export_json_includes_rationale_for_non_creator(
    client: TestClient,
) -> None:
    """Rationale visibility is the same as the markdown export —
    every participant sees per-role rationale. Initial PR #110
    over-redacted this for non-creators which created two
    inconsistent AAR views; Copilot review caught it. This test
    pins the alignment so a future regression flips the wrong way
    again."""

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    creator_role_id = seats["creator_role_id"]
    # Pick the non-creator role's token.
    other_token = next(
        tok
        for rid, tok in seats["role_tokens"].items()
        if rid != creator_role_id
    )
    client.post(f"/api/sessions/{sid}/setup/skip?token={cr}")
    _force_session_to_ended(
        client,
        sid,
        aar_status="ready",
        aar_report=_fixture_aar_report(creator_role_id),
    )

    r = client.get(f"/api/sessions/{sid}/export.json?token={other_token}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["meta"]["is_creator"] is False
    assert (
        body["per_role_scores"][0]["rationale"]
        == "Decisive isolation call at T1."
    ), (
        "rationale must be visible to all participants — same policy "
        "as the markdown export. If we want it creator-only, also "
        "strip it from the markdown render so the two endpoints stay "
        "consistent."
    )
    # Sanity: non-creator viewer also gets the un-redacted bullet
    # blocks. The structured AAR is content-equivalent for both.
    assert body["what_went_well"]
    assert body["gaps"]
    assert body["recommendations"]


def test_export_json_returns_410_after_eviction(client: TestClient) -> None:
    """Once the GC reaper has tombstoned the session id, both
    export endpoints must surface 410 Gone (not 404) so polling
    clients see a definitive "stop retrying" signal."""

    seats = _create_and_seat(client, role_count=2)
    sid = seats["session_id"]
    cr = seats["creator_token"]
    creator_role_id = seats["creator_role_id"]
    client.post(f"/api/sessions/{sid}/setup/skip?token={cr}")
    _force_session_to_ended(
        client,
        sid,
        aar_status="ready",
        aar_report=_fixture_aar_report(creator_role_id),
    )

    # Forge an eviction tombstone via the GC's internal set — the
    # endpoint reads ``app.state.session_gc.is_evicted(session_id)``
    # before any token-binding work so the 410 path doesn't depend
    # on session-row availability. ``_tombstone_set`` is the private
    # field that ``is_evicted`` consults; touching it directly is
    # standard test pattern for this surface (matches the GC's own
    # unit tests in test_session_gc.py).
    gc = client.app.state.session_gc
    gc._tombstone_set.add(sid)  # type: ignore[attr-defined]
    try:
        r = client.get(f"/api/sessions/{sid}/export.json?token={cr}")
        assert r.status_code == 410, r.text
        assert r.headers.get("X-AAR-Status") == "evicted"
    finally:
        gc._tombstone_set.discard(sid)  # type: ignore[attr-defined]


def test_export_json_rejects_token_for_other_session(
    client: TestClient,
) -> None:
    """Auth boundary: a creator token from session-A must not pull
    the AAR JSON for session-B. ``_bind_token`` enforces this; the
    parallel test for export.md is in the existing e2e suite."""

    seats_a = _create_and_seat(client, role_count=2)
    seats_b = _create_and_seat(client, role_count=2)
    sid_b = seats_b["session_id"]
    cr_a = seats_a["creator_token"]

    r = client.get(f"/api/sessions/{sid_b}/export.json?token={cr_a}")
    # 403 (token doesn't bind) or 401 — anything-but-200 confirms the
    # cross-session leak is closed. Pin it loosely so future auth
    # refactors can change the exact status code.
    assert r.status_code >= 400, r.text


# NOTE: schema-shape coercion (string-blob → [string], char-per-bullet
# regression) is a *boundary* concern enforced in
# ``app/llm/export.py::_sanitise_report``. The route handler trusts
# ``session.aar_report`` and does no re-coercion (see CLAUDE.md
# "Model-output trust boundary" — one boundary per call). The unit
# tests for that boundary live below; the route-level tests above
# only assert the wire contract.


@pytest.mark.parametrize(
    "shape_in,expected_out",
    [
        # Schema-clean: array<string> stays as-is.
        (["did A", "did B"], ["did A", "did B"]),
        # 2026-05-01 char-per-bullet bug: AI returned a string blob.
        # _coerce_str_list wraps it into [string] (NOT list("did A")
        # which would split into ['d','i','d',' ','A']).
        ("did A", ["did A"]),
        # Empty / null / blank → empty list, never None on the wire.
        (None, []),
        ([], []),
        ("   ", []),
        # Mixed: drop None / blank entries, str-coerce non-strings.
        (["a", None, "", "b"], ["a", "b"]),
        ([1, "two", 3.5], ["1", "two", "3.5"]),
    ],
)
def test_sanitise_report_coerces_array_string_fields(
    shape_in: Any,
    expected_out: list[str],
) -> None:
    """Boundary unit test: ``_sanitise_report`` is the single trust
    point that runs on every AAR generation. Pin the
    string-blob-vs-array<string> coercion here so a regression that
    bypasses the route (anyone writing directly to aar_report,
    importing the report from a fixture, etc.) can't reintroduce
    the char-per-bullet bug.
    """

    from app.llm.export import _sanitise_report
    from app.sessions.models import Session, SessionState

    session = Session(
        scenario_prompt="(unused)",
        state=SessionState.ENDED,
        roles=[],
        creator_role_id="",
    )
    raw: dict[str, Any] = {
        "executive_summary": "",
        "narrative": "",
        "what_went_well": shape_in,
        "gaps": [],
        "recommendations": [],
        "per_role_scores": [],
        "overall_score": 0,
        "overall_rationale": "",
    }
    cleaned = _sanitise_report(raw, session=session)
    assert cleaned["what_went_well"] == expected_out, (
        f"what_went_well boundary coercion regressed: input "
        f"{shape_in!r} → output {cleaned['what_went_well']!r} "
        f"(expected {expected_out!r}). The char-per-bullet bug "
        "shape would be a list of single-character strings."
    )


def test_sanitise_report_drops_phantom_role_ids() -> None:
    """Boundary unit test for the identity contract: any
    per_role_scores entry whose role_id doesn't match a real
    role.id (or a real role.label, case-insensitive) is dropped.
    The 2026-05-01 bug rendered UUID-prefix "role names" because
    the model invented role_ids and we were rendering the raw
    value. The boundary now drops them.
    """

    from app.llm.export import _sanitise_report
    from app.sessions.models import Role, Session, SessionState

    real = Role(id="role-real", label="CISO", display_name="Alex")
    session = Session(
        scenario_prompt="(unused)",
        state=SessionState.ENDED,
        roles=[real],
        creator_role_id=real.id,
    )
    raw: dict[str, Any] = {
        "executive_summary": "",
        "narrative": "",
        "what_went_well": [],
        "gaps": [],
        "recommendations": [],
        "per_role_scores": [
            {
                "role_id": "role-real",
                "decision_quality": 4,
                "communication": 3,
                "speed": 4,
                "rationale": "ok",
            },
            {
                # Phantom — UUID prefix the AI invented. Must be dropped.
                "role_id": "3D7A-XXXX",
                "decision_quality": 2,
                "communication": 2,
                "speed": 2,
                "rationale": "phantom score, should not survive",
            },
            {
                # Label-as-id (case-insensitive). Resolves to role-real.
                "role_id": "ciso",
                "decision_quality": 5,
                "communication": 5,
                "speed": 5,
                "rationale": "label-as-id should be tolerated",
            },
        ],
        "overall_score": 4,
        "overall_rationale": "ok",
    }
    cleaned = _sanitise_report(raw, session=session)
    scores = cleaned["per_role_scores"]
    # Two entries survive: the real one and the label-resolved one.
    # The phantom UUID-prefix entry is dropped.
    assert len(scores) == 2, scores
    for s in scores:
        assert s["role_id"] == "role-real"  # all resolve to canonical id
        assert s["label"] == "CISO"
        assert s["display_name"] == "Alex"


def test_sanitise_report_clamps_numeric_fields_to_rubric() -> None:
    """Boundary unit test for the numeric range contract. Sub-scores
    clamp to 0..5 (rubric range); ``overall_score`` to 0..5. An out-
    of-band int from the model (or a string in the int slot) lands
    on the safe-default 0.
    """

    from app.llm.export import _sanitise_report
    from app.sessions.models import Role, Session, SessionState

    real = Role(id="role-real", label="CISO", display_name="Alex")
    session = Session(
        scenario_prompt="(unused)",
        state=SessionState.ENDED,
        roles=[real],
        creator_role_id=real.id,
    )
    raw: dict[str, Any] = {
        "executive_summary": "",
        "narrative": "",
        "what_went_well": [],
        "gaps": [],
        "recommendations": [],
        "per_role_scores": [
            {
                "role_id": "role-real",
                "decision_quality": 99,  # out-of-band high → clamps to 5
                "communication": -10,  # out-of-band low → clamps to 0
                "speed": "fast",  # non-int → coerces to 0
                "rationale": "ok",
            }
        ],
        "overall_score": 17,  # clamp to 5
        "overall_rationale": "ok",
    }
    cleaned = _sanitise_report(raw, session=session)
    s = cleaned["per_role_scores"][0]
    assert s["decision_quality"] == 5
    assert s["communication"] == 0
    assert s["speed"] == 0
    assert cleaned["overall_score"] == 5
