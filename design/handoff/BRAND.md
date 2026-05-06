# Crittable — Brand System

A tabletop‑exercise platform for security teams. The product is **Crittable** — a compound of *crit* (the natural‑20 critical hit, the engine's `inject_critical_event` tool, and security‑ops shorthand for a critical alert) and *table* (placing the product unambiguously in the *tabletop exercise* category). The brand is built around one strategic image: **the die as an encounter.** A die delivers the inject. An encounter map diagrams the response. The mark holds both ideas at once — a die face whose pips have been re‑arranged into a 5‑on‑1 tabletop battle map: the party, the threat, and the routes between them.

---

## 1 · The mark

**Primary form.** A rounded square (a die seen face‑on) at the proportions of a real d6 — 94 / 100 with a 22 / 100 corner radius. Inside the die, a 5‑on‑1 encounter map: five party member tokens (**O**) on a line, with the third slightly heavier (the lead), one threat token (**X**) behind, and 1–3 movement/action routes traced in stroke with arrowheads.

**Six encounters = six die faces.** `CT/01` through `CT/06` ("CT" = Crittable). Each encounter's route count corresponds to the pip count of that die face. The animated mark **rolls** through the cycle — face/01, encounter/01, face/02, encounter/02 … — alternating between the rest state (a numbered die) and the **active encounter** state.

**Optional flavor layer (NIST 800‑61 IR phase mapping).** The six numbered states map cleanly to incident‑response phases. `CT/0N` remains the canonical identifier; the phase name is an additive label exposed in marketing surfaces and the animation legend if useful.

| ID | Phase |
|---|---|
| `CT/01` | Detect |
| `CT/02` | Triage |
| `CT/03` | Contain |
| `CT/04` | Eradicate |
| `CT/05` | Recover |
| `CT/06` | Review |

`CT/06 Review` rhymes with the third beat of the slogan — a quiet bit of brand coherence.

**Tiny sizes use the face, not the encounter.** At ≤32px the route lines disappear into noise. The favicon and Safari pinned tab fall back to **face/01** (single center pip). The encounter map is only used at ≥48px.

### Files

| Use | File |
|---|---|
| Primary mark, dark UI | `logo/svg/mark-encounter-01-dark.svg` |
| Primary mark, light UI | `logo/svg/mark-encounter-01-light.svg` |
| Animation source strip (12 frames, not directly animated) | `logo/svg/mark-animated-{dark,light}.svg` |
| Animated (README, Slack) | `logo/gif/mark-animated-dark.gif` (256×256, 37 KB) — opaque #0A0D13 plate |
| Animated, transparent BG | `logo/{gif,apng,webp}/mark-animated-{128,256,512}-{dark,light}-transparent.{gif,png,webp}` — `dark` = light-stroked (use on dark BG), `light` = dark-stroked (use on light BG); APNG/WebP have full alpha, GIF has 1-bit |
| All 6 encounter states | `logo/svg/mark-encounter-{01–06}-{dark,light}.svg` |
| All 6 die faces | `logo/svg/mark-face-{1–6}-{dark,light}.svg` |
| Favicon set | `logo/favicon/` |

### Lockups

Lockup = mark + wordmark, set in JetBrains Mono Bold, all‑caps. Tagline `ROLL · RESPOND · REVIEW` sits beneath the wordmark in the same family at smaller weight, letter‑spaced 0.18em.

| Use | File |
|---|---|
| Header lockup, dark | `logo/svg/lockup-crittable-dark.svg` |
| Header lockup, light | `logo/svg/lockup-crittable-light.svg` |
| Lockup, transparent BG | `logo/svg/lockup-crittable-{dark,light}-transparent.svg` |
| Raster lockup | `logo/png/lockup-{400,800,1600}-{dark,light}.png` |

### Don't

- Don't recolor the mark. Two color tokens only: `--ink-100` (line work) and `--signal` (the X and primary route).
- Don't put the mark on saturated colored backgrounds. It's built for `--ink-900` / `--paper-050` only.
- Don't stretch, skew, or re‑round‑the‑corners. The die proportions matter.
- Don't use the encounter map below 48px. Use face/01 instead.
- Don't add a glow, drop‑shadow, or chrome treatment. The mark is *operator‑grade*: flat, schematic, technical.
- Don't translate the encounter into other game‑genre metaphors (chess board, hex wargame, sports play). The tabletop encounter is the metaphor; rim it down to that one image.

---

## 2 · Voice

**Operator, not marketer.** The product talks to incident responders mid‑exercise. They are tired, time‑pressured, and skeptical. Copy should sound like a calm console message, not a marketing landing page.

**Three rules:**

1. **Imperative, not aspirational.** "Roll the next inject." not "Empower your team to respond."
2. **Specific, not abstract.** "T+04:32 · Comms breach detected" not "Real‑time incident tracking."
3. **Mono for chrome, sans for prose.** UI labels, status, timestamps, and IDs use JetBrains Mono. Briefs, AAR narrative, and headings use Inter.

**Vocabulary lifted from real ops:** *inject, T‑plus, hot wash, AAR, blast radius, RTO/RPO, runbook, escalation, tabletop, blue team, red cell, white cell.* Use them as designed; don't soften them.

**Slogan.** `ROLL · RESPOND · REVIEW` — three beats matching the product's three modes. Set in mono, dot‑separated, all‑caps. Under the dice‑game frame the cadence reads naturally: roll initiative, take the round, recap.

---

## 3 · Color

Tokens live in `tokens.css`. Renaming "the green" later doesn't ripple through code because everything is referenced by role (ink/paper/signal/crit/warn/info), not hue.

### Ink (the operator surface)

| Token | Hex | Use |
|---|---|---|
| `--ink-950` | `#06080C` | deepest pit |
| `--ink-900` | `#0A0D13` | page bg |
| `--ink-850` | `#0E121A` | chat surface |
| `--ink-800` | `#131824` | card bg |
| `--ink-750` | `#181E2C` | card hover |
| `--ink-700` | `#1F2636` | input bg |
| `--ink-600` | `#2A3344` | divider |
| `--ink-500` | `#3A4458` | muted border |
| `--ink-400` | `#5B667D` | placeholder |
| `--ink-300` | `#8390A8` | secondary text |
| `--ink-200` | `#B6BFD0` | body text |
| `--ink-100` | `#DCE2EE` | primary text |
| `--ink-050` | `#F2F4F9` | on‑dark heading |

### Paper (light mode, stickers, print)

| Token | Hex |
|---|---|
| `--paper-050` | `#F6F4ED` |
| `--paper-100` | `#EDEAE0` |
| `--paper-200` | `#DAD5C5` |
| `--paper-300` | `#B5AE99` |

### Signal (the brand accent — defenders' blue)

Tabletop exercises are a Blue Team discipline, so the accent reads "defenders." A confident operations blue, not corporate‑SaaS‑cyan. Tuned in `oklch` so the hue stays consistent across tints.

| Token | OKLCH |
|---|---|
| `--signal` | `oklch(0.72 0.16 245)` — primary |
| `--signal-bright` | `oklch(0.82 0.17 245)` — hover, focused |
| `--signal-dim` | `oklch(0.55 0.13 245)` |
| `--signal-deep` | `oklch(0.38 0.10 245)` |
| `--signal-100` | `oklch(0.94 0.05 245)` — on‑light tint |
| `--signal-tint` | `color-mix(in oklch, var(--signal) 14%, transparent)` |

### Status (kept narrow on purpose)

| Token | OKLCH | Use |
|---|---|---|
| `--crit` | `oklch(0.68 0.21 25)` | high severity |
| `--warn` | `oklch(0.82 0.16 75)` | medium / pending |
| `--info` | `oklch(0.78 0.13 232)` | informational |

The product has enough color noise; we resist a 7‑hue rainbow.

---

## 4 · Type

**Two families. No exceptions.**

| Family | Use |
|---|---|
| **JetBrains Mono** (400, 500, 700) | UI chrome, IDs, status, timestamps, the wordmark |
| **Inter** (400, 500, 600, 700) | briefs, AAR narrative, marketing prose |

```css
--font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
--font-sans: 'Inter', -apple-system, system-ui, sans-serif;
```

**Scale.** `12 / 13 / 14 / 16 / 18 / 22 / 28 / 36 / 48 / 64`. Tokens: `--t-12` … `--t-64`.

Mono ligatures and stylistic sets `ss01`, `cv11`, `zero` are ON — they sharpen the operator feel and keep `0` distinct from `O`.

---

## 5 · Geometry

**Radii are square‑ish.** This is a tactical product, not a SaaS card deck. `--r-1: 2px`, `--r-2: 4px`, `--r-3: 6px`, `--r-4: 8px` (top tier — keeps it from feeling brutalist), `--r-pill: 999px` for status chips only.

**Backgrounds.**
- `.dotgrid` — radial dots at `--grid-strong` opacity, 16px pitch. Default operator surface.
- `.linegrid` — orthogonal hairlines at 24px pitch. Use for canvases and the briefing room screen.
- `.scanlines` — repeating 1px hairlines at 3px pitch. Reserved — modal overlays only.

---

## 6 · Animations

Defined in `tokens.css`. The `tt-` prefix on these CSS animation names is a generic abbreviation that predates the product name and stays as‑is.

- `.blink` — caret blink (`tt-blink`, 1s, 2 steps)
- `tt-sweep` — radar sweep, 360° / Ns
- `tt-pulse` — focus pulse on signal tint
- `tt-stream` — left‑to‑right marquee for `T+` clocks

Reduce or disable in `prefers-reduced-motion`.

---

## 7 · Photography & illustration

**There isn't any.** The brand is a CLI, not a stock‑photo library. Visual interest comes from:

1. The mark's roll cycle (the only "hero asset")
2. Diagrammatic content — encounter maps, timelines, dot grids, radar plots
3. Type‑driven layouts with mono numerals

If you absolutely need a photo (case study, About page), use a single duotone — `--ink-900` shadows + `--signal` highlights. Never a colored photo on a marketing surface.
