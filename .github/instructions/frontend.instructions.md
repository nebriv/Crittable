---
applyTo: "frontend/**"
---

# Frontend / UI-UX review

Read `design/handoff/BRAND.md` and `design/handoff/HANDOFF.md` before reviewing UI changes. The "Don't" lists in BRAND.md are load-bearing.

## Type & lint
- `tsc -b --noEmit` or `npm run lint` (ESLint flat config) regressions introduced in the diff → **MEDIUM** (both must stay clean)
- New `any` introduced where a real type is reachable → **MEDIUM**

## Design system
- Ad-hoc inline styles instead of design tokens (`var(--ink-*)`, `var(--paper-*)`, `var(--signal-*)`, `var(--crit-*)`, `var(--warn-*)`, `var(--info-*)`) → **HIGH**
- Re-derived chrome instead of brand components from `frontend/src/components/brand/` (`<SiteHeader>`, `<StatusChip>`, `<RailHeader>`, `<Eyebrow>`, `<HudGauges>`, `<TurnStateRail>`, `<DieLoader>`, `<BottomActionBar>`) → **HIGH**
- Fonts loaded from Google Fonts CDN or any other external runtime asset → **BLOCK** (security-team deployments are often air-gapped / strict-CSP). Use the bundled `@fontsource-variable/*` imports.
- Recoloring the brand mark, marketer-fluff voice, stock photography, emoji as decoration → **BLOCK** (BRAND.md "Don't" list)
- Marketer voice in user-facing copy. Operator voice. Prefer "Run the inject. Ship the AAR." over "Empower your team to respond."
- Autoplay of the animated mark on the product side (only marketing). The `<DieLoader>` is the documented exception.
- New component re-implementing a pattern already in `design/handoff/source/app-screens.jsx` instead of lifting it → **HIGH**

## Interaction (BLOCK by default)
Mentally walk every phase view through SETUP → READY → PLAY → ENDED at common viewport sizes (mobile, 1080p, 1440p) and report:
- Content unreachable on a 1080p / 1440p / mobile viewport
- Primary CTA in any phase not reachable
- Primary affordances hidden behind clipped overflow or under fixed elements
- Layout regressions where a previously-reachable control becomes unreachable

## States
- Missing loading, empty, error, disabled, success states for any new async surface → **HIGH**
- Blocking spinners on fast operations; missing skeleton on slow ones
- Form: no inline validation, errors disappear on retype, submit doesn't disable, no optimistic feedback

## Accessibility
- Missing ARIA labels on icon-only buttons, role mismatches → **HIGH**
- Color contrast < 4.5:1 against background → **HIGH**
- Keyboard nav: tab order, focus trap in modals, visible focus ring, Esc to close
- Focus management on route/modal change

## Logging
- New API call bypassing `frontend/src/api/client.ts` (loses the `[api]` log wrapper) → **HIGH**
- Direct `new WebSocket(...)` outside `frontend/src/lib/ws.ts` → **HIGH**
- `setError(...)` without a matching `console.warn` carrying the same context → **MEDIUM**
- `console.*` without a `[module]` prefix (`[ws]`, `[api]`, `[facilitator]`, `[play]`) → **LOW**
- Logging the join token (the URL token on `/play/:id/:token`) anywhere outside the route handler → **BLOCK**

## Communication transport
- New synchronous POST wrapping an LLM call (>2s upstream) without an async-then-poll fallback → **HIGH** (see the "POST 200 → poll 425/200" pattern in `CLAUDE.md`)
- Pushing a heavy payload (>~5 KB) via WebSocket instead of a polled HTTP endpoint → **HIGH**
