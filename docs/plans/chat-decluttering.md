# Chat-declutter — design plan

**Status:** Draft · 2026-05-02 · feeds Phase 3 (milestone #3)
**Owner:** unassigned
**Cross-refs:** PR #116 (closed, mockups archived on `claude/threaded-replies-investigation-1eekS`) · PR #115 (merged, highlight-to-notepad) · issue #117 (Mark-for-AAR affordance, implemented as a sibling action in the highlight registry — pins under the notepad's `## AAR Review` section, surfaced to the AAR via a dedicated `<player_aar_marked_verbatim>` priority block)

## TL;DR

When more than two parallel concerns run in chat at once (e.g. Containment + Disclosure + Comms during a ransomware tabletop), the linear stream becomes unreadable: the manager can't follow, mentioned roles miss their cue, and the AAR is hard to reconstruct. We propose a small, structurally-driven categorization primitive — a **workstream** — that the AI emits as a typed enum field on its existing routing tools, with players inheriting workstream membership by reply chain and a manual override for everyone. Mention highlighting is driven from structured `mentions[]` metadata (not body regex), so it works whether the highlight source is the AI's `address_role` tool call or a user typing `@CISO` in the composer.

The primitive deliberately avoids:
- a separate classifier-AI pass per message (cost + latency + drift),
- new state machines or new phase policy (would tangle with `phase_policy.py` / `dispatch.py` / `turn_validator.py`),
- collision with the existing `track_role_followup` tool ("track" is taken — we use "workstream"),
- making categorization load-bearing for play correctness (it's metadata; if it's missing or wrong, the chat still works).

Risks are bounded: the AI may fail to declare workstreams, may miscategorize, or may invent new ones — each has a defined fallback (single `#main` workstream, last-used inheritance, hard cap with creator surfacing) and the manual-override affordance is the universal escape hatch.

---

## 1. Background

### 1.1 Problem statement

A creator runs a tabletop with 5–7 roles. Mid-exercise, three or four lines of work fire in parallel: SOC team containing endpoints, Legal racing a notification clock, Comms drafting a holding statement, sometimes a second SOC analyst on a separate lateral-movement problem. The chat fans into a single linear stream. By minute 6, the CISO can't tell which thread is theirs to answer, the IR Lead can't reconstruct a clean timeline, the Comms lead misses a Legal sign-off because it scrolled past during a press inject. The clutter is the bug; the fix is structural.

### 1.2 What we tried — focus-group + iterative mockups

Five chat-clutter directions were prototyped as standalone HTML mockups (see `docs/mockups/chat-declutter/` on the `claude/threaded-replies-investigation-1eekS` branch — PR #116, closed without merge). A six-persona focus group (CISO, IR Lead, Legal, Comms, two SOC analysts) reviewed each direction across two iterations:

- **A — Filter chips + side rails.** Flat chat, top filter pills (All / @Me / Critical / Decisions / Track), right rail with Artifacts / Decisions / Critical tabs.
- **B — Slack-style threads.** Replies tucked behind "N replies" chips, click to expand right pane.
- **C — Multi-track lanes.** Parallel column lanes per track (Containment / Disclosure / Comms / Lateral) plus a Main lane.
- **D — Tag tabs.** Single stream, every message tagged, top tab bar to filter.
- **E — Hybrid.** Synthesis of A + iter-1 cybersecurity-team asks.

**Iter-1 ranking:** CISO + Comms + IR put A or D in their top 2; Legal preferred C (defensible columns); SOC preferred C (parallel-track separation). Threads (B) lost unanimously — "fragments the AAR record," "buries cross-track @-mentions."

**Iter-2 + iter-3 reframing:** the operator clarified the tool is for cybersecurity *rehearsal*, not legal-defense, so Legal's privilege/clock asks were dropped from scope. Iter-3 baked in pinned-artifacts, multi-select track pills, sticky minute anchors, hidden-mentions banner, export buttons. Iter-4 added the full Play.tsx app shell (top status banner, left roster + management, right rail + Notes panel) and reduced visual noise (per-message track-chip dropped — the colored stripe is enough).

**Iter-4 operator feedback** — the trigger for this plan:
- "E looks really busy, lots of colors, lots of chips."
- "I have doubts the AI will maintain our categorizations that well."
- "We need the right management pressure, the notes bar, the left roster, top/bottom bars" (i.e. the real app shell).
- Tabs Artifacts/Action items good; **Critical isn't useful as a tab** (drop it); the timeline strip moves into a rail tab.
- Add user-to-user `@`s, plus AI prompt reinforcement so `@`s appear consistently in body text.

### 1.3 Why this is a Phase-3 candidate, not a quick-fix

The scope spans backend (tool schema, message model, dispatch validation), prompts (system + tool descriptions), and frontend (composer autocomplete, filter UI, rail tabs, notepad placement). **The AAR pipeline is intentionally out of scope** — workstreams are a live-exercise affordance, not a post-mortem artifact (see §6.9). A "tags-only" version (mockup D) could ship in a day, but doesn't address the structural issue: the AI is the only entity that knows *why* it routed a message to a given role, and that routing intent is the right source for categorization. Surfacing that intent cleanly is what makes the downstream UI affordances stable.

---

## 2. Definitions

### 2.1 Workstream — the noun

A **workstream** is a long-running parallel concern within a single tabletop session. It has:

- A stable `id` (slug, session-scoped).
- A short `label` (1–3 words, shown on filter pills and the colored stripe — e.g. "Containment", "Disclosure", "Comms").
- A `lead_role_id` (the role primarily responsible — used for default inheritance).
- A `state` (`open` / `closed`) for lifecycle.
- A `created_at` / `closed_at` (for the live timeline rail and the operator's `timeline.md` export — not the AAR; see §6.9).
- A color (assigned by frontend from a fixed 6-color palette in workstream-declaration order; not stored server-side).

A workstream is declared by the AI (typically once during setup, occasionally mid-session) and lives until session end. The set is bounded — soft cap of 5, hard cap of 8.

### 2.2 Why not "track" — collision with `track_role_followup`

`backend/app/llm/tools.py:307` already defines a tool named `track_role_followup` — a per-role to-do list of unanswered asks. That tool's verb-sense of "track" ("keep tabs on this open question") collides with the noun-sense we'd want for the chat-declutter primitive ("which workstream is this message part of"). Reusing the word would be exactly the kind of spaghetti the operator flagged. We use **workstream** as the canonical noun in code, schemas, and prompts (the AAR doesn't see the word — see §6.9). The UI may surface a different *label* (e.g. just the `label` string with no prefix), but the data model word is `workstream` everywhere.

### 2.3 Anatomy of a workstream — what's in scope, what's out

| In scope | Out of scope |
|---|---|
| Categorize a message into one workstream (or `main`/none) | Multi-workstream membership per message |
| AI emits `workstream_id` via existing routing tools | Player tags messages with arbitrary tags |
| Player replies inherit by reply chain | Workstream-scoped phase policy |
| Manual override (move-to-workstream) | Per-workstream visibility / privacy controls |
| Filter UI: pick one or many workstreams | Workstream-scoped sub-channels |
| Workstream-scoped colored stripe in chat + rail | Workstream-scoped notepad sections |
| Rendered in the live Timeline rail tab + the operator's `timeline.md` export | Rendered in the AAR (intentionally — see §6.9) |
| | Workstream-as-thread (no parent/child semantics) |

A workstream is an **annotation**, not a container. Messages live in the same flat session-scoped log as today; the workstream is metadata on each message that the UI can filter on.

### 2.4 What a workstream is NOT

- **Not a Slack thread.** No parent/child message graph, no "reply in thread," no fragmentation of the linear log. The chat stays linear; the workstream is a filter property.
- **Not a Slack channel.** Single chat surface, single composer, single transcript. Workstreams are filters on that one surface, not separate rooms.
- **Not a track in the `track_role_followup` sense.** That tool's per-role to-do list stays exactly as it is — different concept, different name.
- **Not a phase / beat.** Phases (`SETUP`/`READY`/`AI_PROCESSING`/`ENDED`) are session-wide; beats are scenario-plan structure; workstreams are intra-play parallelism.
- **Not load-bearing for play correctness.** If `workstream_id` is missing or invalid, the message still renders and the turn still progresses. Workstream metadata is purely a UI-layer filter affordance.

---

## 3. Existing-primitives audit

Before extending anything, make sure we don't conflict.

### 3.1 Tools we extend

| Tool | File | Extension | Phase |
|---|---|---|---|
| `address_role` | `backend/app/llm/tools.py:62` | Add optional `workstream_id` field (enum-constrained against current declared set). | A |
| `pose_choice` | `backend/app/llm/tools.py:126` | Same field. Decisions tend to belong to a workstream (e.g. Disclosure's notification clock decision). | B |
| `share_data` | `backend/app/llm/tools.py:173` | Same field. Data shares (IOC dumps, log tables) cluster by workstream. | B |
| `inject_critical_event` | `backend/app/llm/tools.py:212` | Same field. Most injects target one workstream (press inject → Comms; new IOC → Containment). | B |

**Phase A only extends `address_role`** — three tools deferred to Phase B to limit blast radius. Reasoning:

- `address_role` is the strongest categorization signal: the AI is explicitly routing work to a specific person, which is the clearest possible hint about which workstream the beat belongs to.
- Each tool extension is a place for the schema wording to drift across tools and the model to apply the field inconsistently. Four near-identical schema diffs at once is four chances for prompt-tax compounding.
- `share_data` is often genuinely cross-cutting (an IOC dump can be relevant to two workstreams); `inject_critical_event` is creator-driven (the AI is just executing — categorization is debatable). Both deserve a real-session look at how the data flows before we extend them.
- Messages from the three deferred tools render under `#main` in Phase A. UI-wise that's fine — the data share / pose-choice / inject is visible, just not workstream-tagged. The track filter is intentionally less complete in Phase A as the cost of the smaller risk surface.

All extensions are **optional** — the field defaults to `None` and the message renders under the synthetic `#main` workstream if absent. Mandating it would create a new failure mode (tool call rejected → strict-retry loop → wasted tokens) for a metadata field that isn't load-bearing.

### 3.2 Tool we add

`declare_workstreams` — see §4.2. New tool, only callable in `SETUP` and (optionally) early `BRIEFING`.

### 3.3 Tools we leave strictly alone

| Tool | File | Why we don't touch it |
|---|---|---|
| `track_role_followup` | `tools.py:307` | The naming collision we're avoiding. Different semantics, different lifecycle. Workstreams are session-scoped categorization; followups are per-role open-question lists. |
| `resolve_role_followup` | `tools.py:326` | Pair of the above. |
| `broadcast` | `tools.py:86` | Broadcasts go to everyone — by definition not workstream-scoped. They render under `#main` always. |
| `set_active_roles` | `tools.py:241` | Phase / turn primitive. Wholly orthogonal. |
| `request_artifact` | `tools.py:267` | Could theoretically be workstream-scoped, but it's already constrained to a target role and the workstream falls out of that role's last-known workstream. Adding a field isn't worth the prompt-tax. |
| `lookup_resource` / `use_extension_tool` | `tools.py:286,298` | Extension/RAG layer. Adding workstream coupling here would tangle two sub-systems. |
| `end_session` | `tools.py:352` | Session-wide. |
| `ask_setup_question` / `propose_scenario_plan` / `finalize_setup` | `tools.py:368+` | Setup tier. Workstreams are declared *as part of* `propose_scenario_plan` (see §4.2) — but the existing tool stays intact; we add a field. |
| `finalize_report` (AAR_TOOL) | `tools.py:471` | The AAR pipeline is intentionally workstream-blind. See §6.9 — the AAR doesn't see `workstream_id`, the AAR system prompt doesn't mention workstreams, and the AAR markdown output is structurally identical with the feature flag on vs off. |

### 3.4 Models we extend

| Model | File | Extension |
|---|---|---|
| `Message` | `backend/app/sessions/models.py:71` | Add `workstream_id: str \| None = None` and `mentions: list[str] = Field(default_factory=list)`. |
| `ScenarioPlan` | `backend/app/sessions/models.py:133` | Add `workstreams: list[Workstream] = Field(default_factory=list)`. Empty-list default = single `#main` fallback. |
| `Workstream` (new) | `backend/app/sessions/models.py` (new class) | Pydantic model: `id`, `label`, `lead_role_id`, `state`, `created_at`, `closed_at`. |

### 3.5 Phase policy

`backend/app/sessions/phase_policy.py` — **untouched**. Workstream IDs aren't a phase-policy concept; they're metadata on tool inputs, not new tools. The four extended tools (`address_role` etc.) stay in their current tier sets.

### 3.6 Prompt-tool consistency test

`backend/tests/test_prompt_tool_consistency.py` is the regression net for "the prompt mentions a tool that doesn't exist." Adding `declare_workstreams` adds one new tool name to the play/setup palette; the test pulls names from the tool arrays so no test edit is needed for additions (per CLAUDE.md "Addition protocol"). The new field name `workstream_id` may need to be added to `_NON_TOOL_ALLOWLIST` in the test if it appears in any prompt body in backticks.

---

## 4. Architecture

### 4.1 Data-model changes

```python
# backend/app/sessions/models.py — additions

class WorkstreamState(StrEnum):
    OPEN = "open"
    CLOSED = "closed"

class Workstream(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(..., min_length=1, max_length=32, pattern=r"^[a-z][a-z0-9_]*$")
    label: str = Field(..., min_length=1, max_length=24)
    lead_role_id: str | None = None
    state: WorkstreamState = WorkstreamState.OPEN
    created_at: datetime = Field(default_factory=_now)
    closed_at: datetime | None = None

class Message(BaseModel):
    # existing fields …
    workstream_id: str | None = None    # None ⇒ #main / unscoped
    mentions: list[str] = Field(default_factory=list)  # role_ids tagged in this message

class ScenarioPlan(BaseModel):
    # existing fields …
    workstreams: list[Workstream] = Field(default_factory=list)  # may be empty
```

The `id` regex (`^[a-z][a-z0-9_]*$`) constrains workstream IDs to a stable shape so the AI can't introduce typos that break the enum on subsequent tool calls. Examples: `containment`, `disclosure`, `comms`, `lateral_movement`. The label is freeform.

The `mentions` list on `Message` is a structured list of role IDs the message addresses — populated by:
- AI messages: from the `role_id` arg of `address_role` (and any other directly-addressed role tools).
- Player messages: parsed from the composer at submit time (see §4.6).

Backwards compatibility: existing messages have `workstream_id=None` and `mentions=[]`. The frontend renders `None` as the default `#main` chip (slate gray, no special styling).

### 4.2 New tool — `declare_workstreams`

```python
# backend/app/llm/tools.py — addition to SETUP_TOOLS
{
    "name": "declare_workstreams",
    "description": (
        "Declare 0–5 parallel workstreams for this exercise. A workstream is a "
        "long-running concern (e.g. 'Containment', 'Disclosure', 'Comms') that "
        "groups related chat messages so participants can filter their view. "
        "Each workstream has a stable id (lowercase, snake_case), a 1–3 word "
        "label, and an optional lead role. Subsequent ``address_role`` calls "
        "may reference the workstream via a ``workstream_id`` field; messages "
        "without one render under the default '#main' bucket. "
        "\n\n"
        "WHEN TO CALL THIS: only when you expect 3+ participants to work on "
        "2+ distinct concerns concurrently for a sustained portion of the "
        "exercise. Examples that warrant workstreams: ransomware with "
        "parallel containment / disclosure / comms tracks; multi-region "
        "outage with separate site teams; supply-chain breach with "
        "investigation + customer-comms + vendor-management running at "
        "once. "
        "\n\n"
        "WHEN TO SKIP THIS: small or sequential scenarios where every actor "
        "is working the same concern at any given moment. Examples that "
        "don't need workstreams: phishing-triage with sequential "
        "investigate-then-remediate; a 2-person tabletop; an insider-threat "
        "investigation where HR + Legal + IT are collaborating on one "
        "thread. Skipping is harmless — the @Me filter, the Critical filter, "
        "and the hidden-mentions banner all still work without workstreams "
        "(they read from message metadata, not workstream membership). The "
        "user only loses the workstream pills, which would have been empty "
        "or single-valued and therefore useless anyway. "
        "\n\n"
        "Call this once during setup, after ``propose_scenario_plan`` is "
        "finalized and before ``finalize_setup`` closes the setup tier. "
        "Hard cap: 8 total per session. When in doubt, skip — the UI is "
        "well-behaved either way."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "workstreams": {
                "type": "array",
                "minItems": 0,
                "maxItems": 8,
                "items": {
                    "type": "object",
                    "properties": {
                        "id":           {"type": "string", "pattern": "^[a-z][a-z0-9_]*$", "maxLength": 32},
                        "label":        {"type": "string", "maxLength": 24},
                        "lead_role_id": {"type": "string"},
                    },
                    "required": ["id", "label"],
                },
            },
        },
        "required": ["workstreams"],
    },
}
```

Tier: `SETUP` — and an additional, narrower variant in `PLAY` if we want mid-exercise additions (deferred to Phase D — the simpler model is "declare once at setup, freeze for play"). Phase A ships setup-only.

### 4.3 Extending `address_role` (Phase A only)

```diff
 # backend/app/llm/tools.py — address_role
 "input_schema": {
     "type": "object",
     "properties": {
         "role_id":  {"type": "string"},
         "prompt":   {"type": "string"},
+        "workstream_id": {
+            "type": "string",
+            "description": (
+                "Workstream this beat belongs to. Must match an id from "
+                "``declare_workstreams``. Omit (or pass empty string) for "
+                "broadcast / general / cross-cutting beats."
+            ),
+        },
     },
     "required": ["role_id", "prompt"],
 }
```

`pose_choice` / `share_data` / `inject_critical_event` get the same field shape in **Phase B** — see §3.1 for why those are deferred. The field is optional in all four. Strict enum on the *value* is enforced at dispatch time (§4.5), not in the JSON schema, so a bad value yields a structured `tool_result is_error=True` the strict-retry loop can recover from — same path as today's other validation errors.

### 4.4 Inheritance for player replies

A player message inherits its `workstream_id` from the most recent in-conversation reference, in this priority order:

1. The player explicitly tagged a workstream in the composer (`#disclosure` token, see §4.6) — highest precedence.
2. The most recent AI message addressing this player (via `address_role` or `pose_choice`) carries a `workstream_id`. The player's reply inherits it.
3. The player's role is the `lead_role_id` of an open workstream — inherit that.
4. Otherwise, `workstream_id = None` (rendered as `#main`).

Out-of-turn interjections (`is_interjection=True`) inherit via the same rules but the UI prefers rule (3) over (2) because the interjector isn't responding to a specific AI prompt. Rule (4) is the universal fallback so we never hard-fail to assign membership.

### 4.5 Dispatch-time validation

`backend/app/llm/dispatch.py` validates the `workstream_id` value (when present) against the session's declared set. Three outcomes:

- **Valid id (in declared set):** message stored with `workstream_id` set.
- **Empty string or missing:** message stored with `workstream_id=None`.
- **Invalid id (not in declared set):** `tool_result is_error=True` with body `"Unknown workstream_id 'X'. Known: containment, disclosure, comms"`. The strict-retry path in `turn_driver.py` feeds this back to the model, which self-corrects to a known id or drops the field. Same recovery pattern as today's other tool-validation failures (per `docs/turn-lifecycle.md`).

Critically, this is the **same dispatch-validation pattern** already in production for tool args. We are not adding a new error path or a new state machine; we are adding one `if workstream_id and workstream_id not in declared_ids` check.

### 4.6 User-typed `@`-mentions

> **Status (2026-05-03):** Phase C of this plan + Wave 2 of the
> turn-management plan shipped jointly. The composer popover, the
> mark/resolve invariant, the structural ``mentions[]`` payload, and
> the server-side validation are all live in
> ``frontend/src/components/MentionPopover.tsx`` /
> ``frontend/src/components/Composer.tsx`` /
> ``backend/app/sessions/submission_pipeline.py``. The
> ``@facilitator`` synthetic entry + alias resolution + the routing
> branch in ``ws/routes.py`` are documented below for completeness.
>
> **Phase B is intentionally NOT in this PR.** The transcript-side
> ``@``-highlight rendering — drawing an amber chip on a message
> when ``Message.mentions[]`` includes the local participant's
> ``role_id`` — is listed under Phase B (see §8 / §4.7) and remains
> deferred. Frontend ``Transcript.tsx`` is unmodified in this PR.
> The composer's body-scan fallback (added in this PR) ensures
> hand-typed ``@facilitator`` / ``@<role>`` tokens populate
> ``mentions[]`` symmetrically with popover-picked tokens, so
> Phase B can pick up rendering against a stable contract.

Composer-side (frontend, `frontend/src/components/Composer.tsx`):

- On `@` keypress, open a roster popover anchored at the caret. Filter by typeahead. Arrow-key nav, Enter / Tab to insert, Escape / click-outside to dismiss.
- Insert format: `@<role_label>` for distinct labels (matches the role's `insertLabel`). The synthetic ``@facilitator`` entry inserts the canonical ``"facilitator"`` token; aliases ``@ai`` / ``@gm`` resolve to the same insertion client-side.
- Each insertion stores a `(start, end, target)` mark in component state — the visible text and the resolved target (real `role_id` OR the literal ``"facilitator"``) are kept paired. This is critical: regex on the body would re-introduce the brittleness we just escaped on the AI side.
- On submit, build `mentions: [targets]` from the marks (order-preserving + de-duplicated) and ship the message with both the prose body and the structured list.
- Backspace-into-mark removes the WHOLE mark — the reconciler drops any mark whose ``[start, end)`` substring no longer matches the original visible text.

Server-side (`backend/app/sessions/submission_pipeline.py::_validate_mentions`):

- Validate every `mentions[]` entry is either a current role in the session OR the literal ``"facilitator"`` token. Drop unknown / non-string / empty entries with a `mention_dropped` WARNING audit (per CLAUDE.md "Logging rules"). Log payload includes the full submitted list, the dropped entries, and the kept entries so an operator can debug a "the AI didn't pick up my @-mention" report from the audit log alone.
- Cap the list at 16 entries; excess is truncated and the drop is logged.
- No body parsing. The composer is the single source of mention-resolution.
- The cleaned list is what `manager.submit_response` persists on `Message.mentions` and what the WS routing branch reads.

WS routing branch (`backend/app/ws/routes.py`):

- After the pipeline returns, if ``"facilitator" in outcome.mentions`` AND ``not session.ai_paused``, fire ``run_interject`` for the asking role. Plain ``@<role>`` mentions have no AI side effect — the transcript-with-highlight (rendered from `Message.mentions[]` on the frontend) is the entire affordance.
- ``Session.ai_paused`` is a Wave 3 stub field (default False); the toggle UI / endpoint that flips it is intentionally out of this PR's scope. The routing branch consumes the flag so Wave 3 can ship the toggle without re-touching this code.

Workstream-tagging via composer: typing `#<workstream_label>` (with autocomplete from declared set) sets the message's `workstream_id`. If a player types both `@CISO` and `#disclosure` the message gets both pieces of metadata — they're orthogonal. (The `#`-token autocomplete itself is deferred per §10 Q5.)

### 4.7 UI — what changes vs the iter-4 mockup

The iter-4 hybrid mockup (`docs/mockups/chat-declutter/e-hybrid.html`) lays out the target shell. Productionizing it:

| iter-4 mockup feature | Production target | Notes |
|---|---|---|
| Top status banner | Already exists in `Play.tsx` | Mockup mirrors the real banner; nothing new to ship. |
| Roster + Management (left) | Already exists | `RoleRoster.tsx`, force-advance + end buttons in `Play.tsx`. |
| Filter pills (All / @Me / Critical, then track multi-select) | New top-of-transcript filter row in `Transcript.tsx` or new `TranscriptFilters.tsx` component | Local component state for `filter` + `Set<string> trackFilter`. No server round trip. |
| Hidden-mentions banner | Same component as above | Surfaces when `state.filter ≠ "all"` AND there are `mentions.includes(self_role_id)` messages currently filtered out. |
| Synthetic track-opened rows | Computed client-side | Frontend tracks first-seen `workstream_id` while iterating messages; emits a synthetic `<TrackOpenRow>` before that message. No server state. |
| Sticky minute anchors | Computed client-side | Same pattern. |
| Track-bar + colored stripe per message | New CSS rule | Color assigned by frontend from a 6-color palette in declared-workstream order. Server doesn't store color. |
| Right rail: Artifacts / Action items / Timeline tabs | Replaces / extends `Timeline.tsx` and the existing right sidebar | Artifacts := `share_data` + `inject_critical_event` history. Action items := `track_role_followup` open list (already exists, just re-skinned as a tab). Timeline := chronological lifecycle (workstream-opens, injects, end-session). |
| NotesPanel below rail | Already in `RightSidebar.tsx` | After PR #115 merges, this becomes the shared collaborative notepad. |
| Export buttons (timeline.md / full-record.md) | New REST endpoint or client-side blob download | Phase D — defer until the metadata is reliably in place. |

The frontend changes are **additive** to the existing `Play.tsx` shell. The center column gets a new filter row above the chat; the right rail gets a tab system around what's currently `<Timeline>` + `<NotesPanel>`. No layout rewrite required.

### 4.8 WebSocket event payloads

Per CLAUDE.md "Communication patterns: WebSocket vs AJAX/polling" — anything chat-fan-out is WS, anything heavy is HTTP. The new fields ride on existing events:

- `message_complete` payload gains `workstream_id: string | null` and `mentions: string[]`.
- `message_chunk` is unaffected — chunks don't carry metadata.
- `state_changed` is unaffected.
- New event: `workstream_declared` (small JSON, fan-out to all participants — fires on `declare_workstreams` tool dispatch). Payload: the new workstream(s). Frontend updates its local workstream registry.

Replay buffer (`ConnectionManager`) handles the new event type the same way as existing ones — bounded, per-connection, in-order.

---

## 5. AI prompt reinforcement

The operator iter-3/iter-4 feedback included: *"We'll need to have extra reinforcement on the AI @-ing names as well."* Two directives, in order of importance:

### 5.1 Highlight is structural, not body-parsed

The frontend renders the amber `@-mention` highlight from `Message.mentions[]`, **not** from regex-scanning `Message.body`. This decouples correctness from the AI's prose habits — even if the model writes "Legal, please confirm" without an `@`, the highlight still fires because `address_role(role_id="legal", …)` set `mentions=["legal"]` server-side at dispatch time. The `@<Role>` syntax in the body becomes a readability convention, not a correctness contract.

This is the single most important architectural decision in this plan — it's what makes the rest of the prompt-side reinforcement *soft* rather than load-bearing.

### 5.2 No body-text `@`-syntax directive (deliberately omitted)

An earlier draft of this plan added a soft "lead the prompt with `@<role_label>`" instruction to both `address_role`'s tool description and Block 6 of `prompts.py`. **It's intentionally omitted.** Reasoning:

- §5.1 already settled that the `@`-highlight is structural, not body-parsed. The body `@`-token is purely cosmetic — it makes prose read nicer for humans but adds zero correctness to the highlight feature.
- Every prompt directive is a place the model can drift, conflict with another directive, or interpret strictly. Block 6 is already busy (CLAUDE.md flags it as a load-bearing block, and the 2026-04-30 cleanup miss documented in the prompt-tool consistency test was exactly this class of bug).
- Adding a directive whose only effect is "AI prose reads slightly nicer" is pure prompt-tax for negligible benefit. If users complain in production that the prose feels off, we add the directive in a follow-up — but defaulting to YES on a soft style nudge is the wrong default for a brittle LLM pipeline.

The only soft-`@` reinforcement left is in `address_role`'s existing description (the human-readable rationale of what the tool is *for*). Players who type in the composer get autocomplete (§4.6) so their prose includes `@`-tokens naturally; the AI's prose is structurally-driven highlight regardless.

### 5.3 Workstream declaration in setup

Add to Block 4 (or wherever the setup-flow guidance lives in `prompts.py`):

> *"After ``propose_scenario_plan`` is finalized and before ``finalize_setup``, optionally call `declare_workstreams` with 2–5 entries reflecting the parallel concerns the team will manage. Skip the call when the scenario is small or sequential — the @Me, Critical, and hidden-mentions filters all work without workstreams. Examples that warrant workstreams: a ransomware scenario typically has Containment, Disclosure, Comms; a multi-region outage has separate site teams. Examples that don't: phishing-triage with sequential investigate-then-remediate; a 2-person tabletop."*

Block 6 (tool use during play) gets a minimal addition — one optional field on one tool, no other directives:

> *"`address_role` accepts an optional `workstream_id` from the declared set. Use it when the beat clearly belongs to one workstream; omit for cross-cutting beats. Workstream metadata is a UI-filter affordance, not a play-correctness requirement."*

### 5.4 Regression nets

- **Prompt-tool consistency test** (`backend/tests/test_prompt_tool_consistency.py`) — pulls names from `PLAY_TOOLS` / `SETUP_TOOLS`. Adding `declare_workstreams` is detected automatically. Add the field name `workstream_id` to `_NON_TOOL_ALLOWLIST` since it appears in prompt copy in backticks.
- **Live-API tests** (`backend/tests/live/`) — add a single test asserting that on a 5-role ransomware setup, `declare_workstreams` fires in the setup tier and produces ≥2 entries. Don't assert *which* workstreams; let the model choose. (Per CLAUDE.md `tool-design.md`: never test for specific tool-arg content; test for shape.)
- **Prompt Expert sub-agent review** — runs as part of the standard review pipeline on the implementation PR. Specifically asked to check: (a) is the soft-`@` directive phrased as a style note vs a rule? (b) does Block 6 conflict with the structural-source statement? (c) is the workstream declaration block bounded enough to not encourage runaway proliferation?

---

## 6. Spaghetti-avoidance principles

The operator flagged: *"We need to make sure this isn't too spaghetti'd in implementation. The AI/LLM stuff is already quite brittle."* These six principles are commitments, not aspirations:

### 6.1 Workstream metadata is NOT load-bearing for play correctness

A message with `workstream_id=None` renders, broadcasts, and counts toward turn submission identically to one with `workstream_id="containment"`. The play engine, the phase policy, the turn validator, and the strict-retry loop are completely workstream-blind. **Test for this:** all existing turn-engine tests in `backend/tests/test_turn_*.py` continue to pass without modification, even with workstreams declared in the session.

Critically, **the chat-declutter UI itself also degrades gracefully** when workstreams are absent (whether by design — small scenarios — or by data — old sessions before this lands):

| Filter pill | Depends on | Works without workstreams? |
|---|---|---|
| All | nothing | yes |
| @Me | `Message.mentions[]` | yes — populated server-side from `address_role.role_id`, never reads `workstream_id` |
| Critical | `MessageKind.CRITICAL_INJECT` | yes — same enum that drives the red bubble today |
| Hidden-mentions banner | `mentions[]` ∩ `self_role_id` | yes — same data source as @Me |
| Track multi-select pills | `Workstream` registry + `Message.workstream_id` | no, but the pills don't render at all when there are no declared workstreams (and the "AND track" divider conditionally hides) — there's nothing to lose |

So a 2-role tabletop with no `declare_workstreams` call gets a clean **All / @Me / Critical** filter row, the hidden-mentions banner, and every message under `#main`. The user never sees an empty Track pill section. Skipping the AI categorization step doesn't strip away any filter affordance the user actually needs at that scale; it just hides chrome that would have been empty.

### 6.2 `phase_policy.py` stays untouched

No new tier, no new policy entries, no new tool gating. The four extended tools stay in their current `_PLAY_TOOL_NAMES` / `_SETUP_TOOL_NAMES` frozensets. `declare_workstreams` is added once to `_SETUP_TOOL_NAMES`. That's the entire phase-policy diff.

### 6.3 `dispatch.py` adds one validation, not a new validator class

The `workstream_id` validation is a single conditional (§4.5), reusing the existing `tool_result is_error=True` recovery mechanism. No new dispatch class, no new error type, no new audit kind. Audit log for invalid workstream IDs reuses `tool_use_rejected` with a structured `reason` field.

### 6.4 No new state machines

A workstream's `state` field has two values (`open`, `closed`). It transitions on `declare_workstreams` (set to `open`) and at session end (set to `closed`). No mid-play transitions, no creator-controlled lifecycle, no workstream-scoped phase. If we ever need richer lifecycle (closed-while-others-open, archived), that's a separate proposal — Phase A says no.

### 6.5 Workstreams are session-scoped, not global

There is no global "Containment" workstream. Each session declares its own; ids are unique per-session, not across sessions. The repository (`backend/app/sessions/repository.py`) needs no schema migration beyond adding the new fields to the existing per-session blob — no new table, no foreign keys, no cross-session join.

### 6.6 @-highlight from metadata, not body parsing

Already covered in §5.1 but worth repeating as a principle: the frontend never regex-scans `Message.body` for mention tokens. `mentions[]` is the single source of truth. The `@<Role>` text in the body is decorative.

### 6.7 Backwards compatibility — all old data renders correctly

Sessions created before this lands have:
- Empty `ScenarioPlan.workstreams` (default).
- Every `Message.workstream_id == None` (default).
- Every `Message.mentions == []` (default).

The frontend renders these as: no filter pills (or just All/@Me/Critical), every message in the synthetic `#main` workstream, no @-highlights. Completely degraded but functional. No data migration required.

### 6.8 One feature flag at most

`workstreams_enabled` (default `False` initially, flip to `True` whenever Phase A's audit logs look sane on a few real exercises — no formal soak gate, this is a side project). Controls:
- Whether `declare_workstreams` is included in `SETUP_TOOLS` exposed to the model.
- Whether the frontend shows the workstream filter UI.

When `False`, the entire feature is invisible; `Message.workstream_id` and `Message.mentions` still serialize but nothing reads them. This gives us a single emergency kill-switch if the AI behaves badly post-launch.

### 6.9 AAR is workstream-blind

The AAR pipeline (`finalize_report` tool, AAR system prompt, AAR markdown shape) **does not see workstreams**. Concretely:

- The AAR's serialization of `Message` objects strips `workstream_id` before passing to the AAR-tier LLM. The AAR sees the same flat chronological log as today.
- The AAR system prompt makes no mention of workstreams, doesn't ask the model to group by them, and doesn't include a workstream section in the output template.
- The AAR markdown output has no per-workstream appendix, no "workstreams declared" header, no workstream-tagged messages.
- The `Workstream` model itself never enters the AAR pipeline's serialization — it's a session-runtime artifact only.

Reasoning:

- **The AAR is a narrative document.** Its readers (post-incident, days later) want decisions, outcomes, and a timeline — not the live-exercise UI scaffolding. Workstream tags are how the chat got *organized*; they're not what *happened*.
- **The AAR shape should be stable across UI iterations.** If we restructure or rename workstreams in the UI in 6 months, AARs already written shouldn't suddenly look stale or broken.
- **Coupling the AAR to a UI feature is a spaghetti vector.** It creates a path where "fix the categorization UI" requires re-running the AAR pipeline tests; that's exactly the tangle we're avoiding.
- **The operator's `timeline.md` export is the workstream-aware artifact**, not the AAR. The export is a deterministic dump for live-exercise debugging or hand-off; the AAR is the authored narrative. Different artifacts, different shapes.

Test: an AAR generated for a session with declared workstreams and an AAR generated for the same session with the workstream feature flag off must produce structurally identical output (allowing for LLM non-determinism in prose). If they differ in shape, §6.9 has been violated.

---

## 7. Failure modes + recovery

Each numbered failure mode pairs the symptom, the recovery, and the audit-log breadcrumb so the operator can spot it in production.

### 7.1 AI never calls `declare_workstreams` during setup

**Symptom:** session starts with `ScenarioPlan.workstreams = []`. Every message renders under `#main`.
**Recovery:** none needed — single-workstream sessions are valid and visually identical to today's UI minus the (empty) filter pills. No retry, no nudge.
**Audit:** `setup_complete` audit line includes `workstreams_count=0` so we can measure declaration rate across sessions.
**Tuning lever:** if declaration rate is < 50% across 20 multi-track-shaped scenarios, soften §5.3's wording to be more directive (still not mandatory).

### 7.2 AI calls `address_role` with `workstream_id` not in declared set

**Symptom:** dispatch returns `tool_result is_error=True`. Strict-retry loop re-prompts.
**Recovery:** model retries either with a valid id or omitting the field. Same recovery path as today's other validation errors.
**Audit:** `tool_use_rejected` with `reason="unknown_workstream_id"`, `attempted=...`, `known=[...]`.
**Worst case:** strict-retry exhausts (3 attempts). The play engine already has a defined recovery for this — `current_turn.status = "errored"`, banner surfaces, creator can force-advance. Workstreams don't add a new failure mode; they extend an existing one.

### 7.3 AI invents `workstream_id` values close to but distinct from declared (`containment_2`, `containment-secondary`)

**Symptom:** §7.2 fires, model retries, may invent another variant. Pathological loop possible if the model is determined.
**Recovery:** the strict-retry loop caps at 3 attempts. After exhaustion the field is treated as omitted (defensive: the dispatch layer falls back to `workstream_id=None` after retry exhaustion rather than erroring the whole tool call).
**Audit:** same `tool_use_rejected`, plus `audit_kind="workstream_id_retry_exhausted"` if the message ultimately falls back to `None`.

### 7.4 User `@`s a non-existent role (typo'd in autocomplete reject)

**Symptom:** composer-side prevention should make this nearly impossible (autocomplete only offers valid roles, and resolved tokens carry their `role_id`). If a malicious / malformed client submits an unknown id in `mentions[]`:
**Recovery:** server drops unknown ids from `mentions[]`, logs `mention_dropped`, accepts the message with the cleaned list.
**Audit:** `mention_dropped` with `submitted_role_ids=[...]`, `dropped=[...]`, `kept=[...]`.

### 7.5 Workstream proliferation (AI declares 6+ during a single session)

**Symptom:** UI gets crowded; filter pills wrap onto multiple rows; the operator's iter-3 visual-noise complaint returns.
**Recovery:** `declare_workstreams` schema enforces `maxItems: 8` (hard cap). Dispatch-layer warns but accepts at 6+ (`audit_kind="workstream_proliferation"`).
**UI:** filter pills above 6 collapse into a "More tracks ▾" overflow popover so the chrome doesn't wrap.

### 7.6 AI mis-categorizes (operator's iter-3 concern)

**Symptom:** a Disclosure-track message gets tagged `containment` because the AI's routing heuristic was off.
**Recovery:** manual override on each message (right-click → "Move to #disclosure") for the creator and the message's role-of-record. The override updates `Message.workstream_id` server-side, fans out via `message_metadata_changed` WS event, and is replay-buffered.
**Audit:** `workstream_override` with `before`, `after`, `actor`.
**Why this is the right answer, not a better classifier:** mis-categorization is a property of natural language, not of model choice. A separate classifier-AI pass would have its own mis-categorization rate, plus 200–800ms latency, plus extra cost, plus a new failure mode (classifier API down). The manual override is the cheapest fix and works for any cause.

### 7.7 AI doesn't address anyone (broadcast-style turn) but workstream context is clear

**Symptom:** `broadcast` tool used; no `workstream_id` (broadcast is unscoped). UI renders under `#main` even though the human reader can tell it's a Disclosure-relevant beat.
**Recovery:** intentional. Broadcasts are session-wide signal by definition; cluttering them with workstream metadata muddies what a broadcast is. If the model wants to constrain audience, it should use `address_role` instead.
**Audit:** none.

---

## 8. Phasing

Four phases; each is a separate PR and can land independently. Earlier phases have no UI without later phases — they're foundational metadata first, affordances second.

### Phase A — Foundation (backend metadata + minimal AI directive)

**Scope:** the metadata layer for **only `address_role`**. **Zero frontend changes.** The data flows through the backend and lands in the audit logs, but nothing renders differently in the UI. This is deliberate — putting visuals on top of an LLM-driven feature before the underlying data has been observed in real sessions creates user-confusion bugs (a wrong filter pill) that are harder to debug than the equivalent backend-only bugs (a wrong audit log line).

- `Workstream` Pydantic model.
- `Message.workstream_id` and `Message.mentions` fields.
- `ScenarioPlan.workstreams` field.
- `declare_workstreams` tool added to `SETUP_TOOLS`.
- **`address_role` only** extended with optional `workstream_id`. Other tool extensions deferred to Phase B (see §3.1 reasoning).
- Dispatch validation (§4.5) for `address_role.workstream_id` only.
- Prompt edits — Block 4 (declare workflow) + Block 6 (one-line `address_role` field note). No `@`-syntax body-text directive (see §5.2).
- Regression nets per §5.4.
- WS event payload extended (§4.8).
- Feature flag `workstreams_enabled` defaulting `False`.

**Exit criteria:** all existing tests pass; new tests for the data model + dispatch validation pass; live-API smoke run shows the AI declaring workstreams on at least one multi-track scenario fixture and skipping declaration on a small / sequential fixture; `mentions[]` is correctly populated on AI `address_role` calls. **No frontend changes shipped.**

**Estimated PR size:** ~400 LoC backend + ~50 LoC schema/test edits. Zero frontend.

### Phase B — Remaining tool extensions + Filter UI + colored chat stripe

**Scope:** absorb the three deferred tools, then make the metadata visible. Backend-light, frontend-heavy.

- Extend `pose_choice`, `share_data`, `inject_critical_event` with `workstream_id` (the deferred set from §3.1).
- Dispatch validation extends to the three new tool-arg sites (same single-conditional pattern as Phase A).
- `TranscriptFilters` component (filter pills + multi-select track pills + hidden-mentions banner) above the existing `Transcript`.
- Colored stripe + per-message workstream rendering (track-bar, no chip per the iter-4 noise reduction).
- `@`-highlight rendered from `Message.mentions[]` (the structural source).
- Synthetic "track opened" rows (frontend-computed).
- Sticky minute-anchor rows (frontend-computed).

Phase B ships only after Phase A's audit logs show `declare_workstreams` and `address_role.workstream_id` behaving sanely across some live exercises. There's no fixed soak duration — this is a side project, not a production rollout — but the principle holds: don't add UI on top of metadata that hasn't been observed flowing correctly.

**Exit criteria:** mockup E iter-4 reproduces in-app, against real session data, on a 1080p and 1440p viewport, with no regressions in existing E2E tests; manual smoke against a live session shows pills counting correctly when a creator filters.

**Estimated PR size:** ~400 LoC frontend.

### Phase C — User `@`-mentions + composer autocomplete

**Scope:** parity for human-typed mentions.

- Composer popover on `@` keypress (Tailwind + headless-ui-style accessible listbox).
- Mark/resolve pattern in composer state — never regex on body.
- Server-side `mentions[]` validation + drop-unknown logic.
- Same `#`-token autocomplete path for workstream-tagging (lower priority; can defer to Phase D).
- E2E test: creator types `@Diana`, presses Enter, message lands with `mentions=[<diana_role_id>]`, Diana's `(@you)` badge fires, Diana's hidden-mentions banner increments if she's filtered away.

**Exit criteria:** keyboard-only navigation works (popover, arrow keys, Enter, Esc), screen-reader navigation works (aria-listbox), tests pass.

**Estimated PR size:** ~250 LoC frontend + ~50 LoC backend.

### Phase D — Polish + manual override + operator exports

**Scope:** nice-to-haves that finish the live-exercise affordance. **The AAR is intentionally not in scope** (see §6.9).

- Right-rail tabs (Artifacts / Action items / Timeline) replace the current `<Timeline>` flat list.
- Manual workstream override on each message (right-click contextmenu + creator-only "Move to #X" submenu, plus the message-of-record's role can override their own messages).
- `timeline.md` and `full-record.md` export buttons (per the iter-3 mockup) — operator-facing, NOT the AAR. These are deterministic markdown dumps from the message data, useful for live-exercise hand-offs and post-exercise debugging. They include workstream tags; the AAR doesn't.
- Feature flag `workstreams_enabled` flipped to `True` by default.

**Exit criteria:** export round-trips correctly with workstream tags; manual override fans out via WS event and updates the rail tabs; flag flip is reversible; AAR for a multi-track exercise is structurally identical to an AAR for the same session with the flag off (per §6.9 test).

**Estimated PR size:** ~150 LoC backend (export endpoints + override route) + ~250 LoC frontend.

---

## 9. Testing strategy

Three layers, all already established in this codebase:

### 9.1 Unit (backend)

- `Message.workstream_id` validation (regex-conformant ids accepted; bad ones rejected).
- `Workstream.id` regex (snake_case, length cap).
- Inheritance rules (§4.4) — table-driven test against synthetic message sequences.
- Dispatch validation (§4.5) — three branches: valid / empty / invalid.
- `mentions[]` population from `address_role.role_id`.

### 9.2 Unit (frontend)

- Filter logic (multi-select track + AND quality filter).
- `@`-highlight rendering from `mentions[]` (not body).
- Composer mark/resolve invariant — `mentions[]` matches the visible `@`-tokens.
- Hidden-mentions banner appears iff `mentions.includes(self) && current filter excludes message`.

### 9.3 Live-API (`backend/tests/live/`)

Two new tests, both gated on `ANTHROPIC_API_KEY`:

- **Setup workstream declaration** — assert that for a multi-track scenario (we have one in `backend/tests/fixtures/`), `declare_workstreams` fires during setup with 2–5 entries. Don't assert names.
- **Play-time workstream tagging** — assert that ≥ 50% of `address_role` calls in a 10-turn play loop carry `workstream_id`. Don't assert exact values. (50% is a deliberately soft floor to leave headroom for prompt drift.)

Per CLAUDE.md `tool-design.md`: live tests assert *shape*, not content. Don't lock the model into specific phrasing.

### 9.4 Regression nets

- `test_prompt_tool_consistency.py` continues to pass (covered automatically per §3.6).
- `test_phase_policy.py` continues to pass (we don't change phase policy).
- `pytest backend/tests/live/` against `ANTHROPIC_API_KEY` after every prompt edit (CLAUDE.md mandate).

### 9.5 Sub-agent review pipeline

CLAUDE.md mandates six sub-agent reviews on every Phase-2/3 PR. For this work:

- **QA** — verifies tests cover the inheritance branches and the dispatch validation; flags missing live-API coverage.
- **Security Engineer** — `mentions[]` is user-supplied input; verify server-side validation is sound (no injection vector via `role_id` lookup).
- **UI/UX** — filter row reachable on 1080p / 1440p / mobile; `@`-popover keyboard-navigable; hidden-mentions banner doesn't push primary controls below fold.
- **Product / App-Owner** — does this match what was asked vs over-scoping (this plan is the spec — easy review pass).
- **User Agent (creator persona)** — first-time creator: do filter pills appear unprompted? Is the workstream concept self-explanatory from labels alone?
- **Prompt Expert** — directives in §5 — do they conflict? Are they bounded? Do they encourage proliferation? Is the soft-`@` directive phrased as a style note?

---

## 10. Open questions (decide before Phase A merges)

These are intentionally surfaced so we can settle them in review rather than discovering them mid-implementation.

1. **Who can declare workstreams?** Plan says: AI only, in setup, via `declare_workstreams`. Alternative: creator can also declare via a setup-tier UI. Recommendation: AI-only for v1; creator-override via UI is Phase D if the AI proves unreliable.
2. **Mid-session declaration?** Plan says: deferred to Phase D. Single declaration during setup is the v1 simplification. If a wholly new concern emerges mid-exercise, the creator force-routes via the manual override in Phase D — the new concern's messages live in `#main` until then.
3. **Closing workstreams mid-session?** Plan says: no v1 lifecycle transitions. Once open, stays open until session end. Simpler.
4. **Color palette for workstreams?** Plan says: 6-color palette assigned in declaration order. Question: do we want a 7th/8th color reserved for `#main` and overflow? Recommendation: yes — slate gray for `#main`, dim purple for "More tracks" overflow.
5. **`#tag` autocomplete in composer?** Plan §4.6 mentions it. Question: ship in Phase C alongside `@` mentions, or defer to Phase D? Recommendation: defer — `@` is the primary use case for the iter-4 feedback; `#` can wait.
6. ~~**AAR appendix per workstream**~~ — **resolved** (see §6.9). The AAR is workstream-blind. No appendix, no header section, no per-workstream grouping. The AAR shape stays exactly as it is today. The operator's `timeline.md` / `full-record.md` exports are the workstream-aware artifacts, not the AAR.
7. **Workstream label conventions across sessions?** Plan §6.5 says session-scoped, no globals. Question: do we want a curated set of common labels (e.g. "Containment", "Disclosure", "Comms") that a creator could pick from in setup, vs the AI free-forming each session? Recommendation: not v1 — let the AI propose names per scenario; revisit if creator surveys show it's a friction point. Cross-session analytics is not a goal of this work.
8. **`broadcast` and workstream context** — plan §7.7 says broadcasts are unscoped. Question: should `broadcast` get an *optional* `relevant_workstreams: list[str]` field for "this is a general beat but is most actionable for X and Y"? Recommendation: defer — start with the cleaner unscoped semantics. The original framing of this question referenced "if the AAR shape needs it"; now that §6.9 makes the AAR workstream-blind, that justification is gone, so this should not be revisited unless an actual UI use case appears.

---

## 11. References

- **Mockups (closed PR):** `claude/threaded-replies-investigation-1eekS` branch on GitHub. Five HTML mockups in `docs/mockups/chat-declutter/`. Iter-4 hybrid is `e-hybrid.html`. PR #116 closed without merge — exploratory only, but the mockups are the visual spec for Phase B.
- **PR #115 (merged):** shared markdown notepad with `HighlightActionPopover`. Not load-bearing on this plan, but the rail's "Notes & follow-ups" slot is where it lands.
- **Issue #117:** Mark-for-AAR affordance — implemented as a `markForAarReviewAction` in the same `HighlightAction` registry PR #115 introduced. Pins land under a `## AAR Review` notepad section (auto-created on first click); the AAR pipeline extracts those lines into a `<player_aar_marked_verbatim>` priority block and the AAR system prompt weights it as a strong "this moment was pivotal" signal.
- **CLAUDE.md sections referenced:**
  - "Engine-side phase policy" (§ "phase_policy.py is the single source of truth") — read before any LLM-call-site change. Plan §3.5 confirms we don't touch it.
  - "Prompt ↔ tool consistency" (§ `test_prompt_tool_consistency.py`) — Plan §3.6, §5.4 covers the regression net.
  - "Stream Timeout Prevention" — implementation should follow the one-task-at-a-time pattern, especially around prompts.py edits.
  - "Logging rules" — every new audit kind named in §7 conforms to the structlog binding pattern.
  - "Communication patterns: WebSocket vs AJAX/polling" — Plan §4.8 confirms WS for the new event types.
  - "Sub-agent review protocol" — Plan §9.5 lists the six reviewers and the specific prompt for each.
- **`docs/PLAN.md`:** the project-level design doc. This plan is a Phase-3 sub-proposal that doesn't contradict it.
- **`docs/architecture.md`:** the diagrams + flow doc. Workstreams add no new components; the architecture diagram is unchanged.
- **`docs/turn-lifecycle.md`:** load-bearing reference for `turn_validator` / `turn_driver` / `slots` / `dispatch`. Plan §3.5, §4.5, §6.1, §6.3 are all consistent with this doc.
- **`docs/tool-design.md`:** five trap patterns for tool descriptions. The `declare_workstreams` description in §4.2 was drafted against this guide — explicit purpose, examples, when-to-use guidance, when-NOT-to-use guidance, hard cap.
- **`docs/prompts.md`:** prompt-engineering conventions. §5 directives follow the soft-vs-hard-rule pattern documented there.

---

## Appendix A — minimal risk-acceptance checklist

For the eventual Phase-A reviewer:

- [ ] `declare_workstreams` cannot be called outside `SETUP` (phase-policy assertion).
- [ ] An invalid `workstream_id` on `address_role` produces a structured `tool_result is_error=True`, not an unhandled exception.
- [ ] `Message.workstream_id` and `Message.mentions` default-empty for old data.
- [ ] No existing turn-engine test required modification.
- [ ] Feature flag `workstreams_enabled=False` makes the feature invisible end-to-end (no UI changes, no prompt changes seen by the model).
- [ ] No global state added (workstreams session-scoped only).
- [ ] No new audit kind required to debug a stuck session beyond what §7 names.
- [ ] **AAR pipeline is workstream-blind** (§6.9) — `Message.workstream_id` is stripped before serialization to the AAR-tier LLM; AAR system prompt makes no mention of workstreams; AAR markdown output structurally identical with the feature flag on vs off.
- [ ] Live-API smoke test passes with current production prompts.
- [ ] Six sub-agent reviews (CLAUDE.md) all green for BLOCK / CRITICAL / HIGH.

