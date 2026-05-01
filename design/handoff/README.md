# Crittable — Brand Handoff Package

This folder is everything you need to redesign the site to use the new Crittable brand.

**Crittable** = *crit* (the natural‑20 critical hit, the engine's `inject_critical_event` tool, security‑ops shorthand for a critical alert) + *table* (tabletop exercise). One word, leading capital only: `Crittable` in prose, `CRITTABLE` in the wordmark, `crittable` in URLs/handles/filenames.

## Read these in order

1. **`Brand Package.standalone.html`** — open this in a browser. It's the full visual reference: every component, the mark exploration, voice cards, app screens, stickers, lockup variants. Self‑contained, works offline.
2. **`BRAND.md`** — the brand system. Mark usage, voice rules, color/type tokens, do/don't.
3. **`HANDOFF.md`** — the developer brief. Drop‑in instructions, voice rewrite checklist, page‑by‑page redesign order.

## Drop‑in files

- **`tokens.css`** — copy into your global stylesheet. Defines all design tokens.
- **`logo/`** — every logo asset. SVG (preferred), PNG (raster fallback), GIF (animated, for README/Slack), and a complete favicon set.

## Quick ref — design tokens

```css
/* Colors */
--ink-900: #0A0D13;        /* page bg */
--ink-100: #DCE2EE;        /* primary text */
--signal:  oklch(0.72 0.16 245);  /* defenders' blue */
--crit, --warn, --info     /* status — narrow palette */

/* Type */
--font-mono: 'JetBrains Mono', ui-monospace, ...;
--font-sans: 'Inter', system-ui, ...;

/* Type scale: 12 / 13 / 14 / 16 / 18 / 22 / 28 / 36 / 48 / 64 */
/* Radii: 0 / 2 / 4 / 6 / 8 / 999 (pill, status only) */
```

Full reference in `tokens.css` and `BRAND.md`.

## The mark, in one sentence

A d6 whose pips have been re‑arranged into a 5‑on‑1 tabletop encounter map — five party tokens, one threat, routes between them. Six numbered states (`CT/01`…`CT/06`) optionally mapping to NIST 800‑61 IR phases (Detect, Triage, Contain, Eradicate, Recover, Review).

## Structure

```
.
├── README.md                         (you are here)
├── BRAND.md                          brand system
├── HANDOFF.md                        developer brief
├── tokens.css                        drop into global CSS
├── Brand Package.standalone.html     full visual reference
└── logo/
    ├── svg/      static + animated marks, lockup-crittable-*
    ├── png/      raster marks (16/32/64/128/256/512/1024) + lockups
    ├── gif/      animated mark for README/Slack (37 KB)
    └── favicon/  complete favicon set + HEAD-SNIPPET.html + manifest
```
