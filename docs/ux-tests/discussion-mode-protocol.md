# UX test protocol — Wave 1 discussion mode (issue #134)

**Goal:** validate that the per-turn `intent` model (Submit & Ready vs Submit, Still Discussing) feels natural to a first-time player. Wave 2 (`@`-routing) blocks on this signal — if testers don't discover the discussion path, that's a redesign trigger, not just a label tweak.

## Logistics

- **Sample size:** 3–5 testers, none of whom built or scoped the feature.
- **Format:** 30-minute hosted session per tester, you observing via creator dashboard. Do NOT brief them on the feature beforehand. They start with the same context any first-time creator would (the README, the join link, the brand voice).
- **Scenario:** use the `discussion_then_ready.json` preset from `backend/scenarios/` or any 3-role scenario where parallel concerns are plausible (Containment + Disclosure + Comms-style branching).
- **Roles:** tester takes a non-creator role; you take the creator role (CISO).
- **Recording:** session recording optional but strongly recommended. The post-test debrief catches things the live observation misses.

## Script

> Read these out loud at the start. Don't elaborate beyond the script unless the tester asks a clarifying question.

1. *"You're a [role] in a tabletop exercise. Your team has just been alerted to [scenario hook]. The AI is going to drive the exercise — your job is to play the part of [role] and respond as you naturally would on the team."*
2. *"There are two other people in this exercise besides me. Talk to them, plan together, decide together — that's the point of the drill."*
3. *"Take 20 minutes. I'll just be observing — try not to ask me clarifying questions about the app itself. If you get stuck, just narrate what you're trying to do."*

Then start the timer and shut up.

## What to capture

Mark each on a 1–5 scale (1 = friction, 5 = effortless) plus a free-text note. Don't show the tester these.

| # | Question | What you're looking for |
|---|---|---|
| 1 | Did they discover "Submit, still discussing" without prompting? | Tester clicks the secondary button at least once during the exercise. If they only ever click the primary "Submit & Ready," that's a discoverability fail. |
| 2 | Did they understand the difference between the two buttons? | Watch for hesitation on the second turn or third turn. If they re-read the buttons or hover-tooltip them after the first use, they're still mapping the model. |
| 3 | Did they ever feel the AI cut them off mid-discussion? | Watch for live "wait, I wasn't done" reactions or post-test debrief notes. The whole point of Wave 1 is to make this not happen. |
| 4 | Did they walk back ready at any point? | Watch for the "Walk back ready" button click. Bonus signal: did they know the button existed? |
| 5 | After the exercise, did they describe the model correctly? | Ask: *"How did you decide when the AI moved on?"* Listen for "when we all clicked ready" or equivalent. If they say "I don't know" or "after we all sent a message," the mental model didn't land. |
| 6 | Was the HUD readiness count helpful? | Ask: *"Did you notice the '2 of 3 ready' indicator?"* If they say "what indicator?" the placement or styling is too quiet. |

## Debrief questions

After the timer ends:

1. *"Walk me through one decision you made in there. What were you thinking when you hit Submit?"* — opens the floor for them to surface friction without leading.
2. *"If you were inviting a teammate to use this, what would you tell them about how to send messages?"* — proxy for "did the model land?"
3. *"Anything that surprised you, in either direction?"* — catches signal you didn't expect to look for.
4. *"On a 1–5, how was the pacing? Too fast / too slow / just right?"* — quantitative summary.

## Pass criteria for Wave 2

Wave 2 (`@`-routing) starts only when at least 4 of 5 testers (or 3 of 3 if N=3) hit:

- **Q1 = Yes** (discovered the discuss button unprompted), AND
- **Q3 = No** (never felt cut off), AND
- **Q5** mental model is at least roughly correct (they don't have to use the word "quorum" — "when everyone is ready" is enough).

If two or more testers fail Q1 OR Q5, redesign the Composer's button layout / labels before adding `@`-mention surface area on top of it.

## Where the data lives

- Live observation notes → `docs/ux-tests/<date>-<tester-id>.md` (one file per tester, sanitised — first names only or a tag like "Tester A").
- Audio/video recording → not stored in-repo; archive in your usual project folder.
- Aggregate summary + the pass-criteria call → comment on issue #134 with the verdict and links.

## Out of scope for this protocol

- `@facilitator` routing, `@<role>` mentions, mention autocomplete — Wave 2.
- Pause-AI toggle (issue #69) — Wave 3.
- Workstream / chat-declutter affordances (PR #119) — separate rollout.

If a tester asks about any of those, just say "not built yet" and move on.

## Tester recruitment notes

- Avoid security-team folks who already know the product is for them — their bias is too aligned. Best signal comes from someone in an adjacent IT-ops or PM role who'd plausibly play "Comms" or "Legal" without being primed by the operator vocabulary.
- 30 minutes is the right cap — past that the tester goes from "first-time user" to "becoming an expert," which is the wrong cohort for this signal.
