# Handoff Brief — Crittable Site Redesign

**You are redesigning the marketing/product site to use the new Crittable brand.** Everything you need is in this folder. Read this file and `BRAND.md` first; everything else is reference.

---

## What "done" looks like

- [ ] Every page uses tokens from `tokens.css`. No new hex codes invented.
- [ ] Two font families only — JetBrains Mono (chrome/UI) and Inter (prose). No Roboto, Arial, or system fallbacks left in production CSS.
- [ ] The Crittable mark appears in the header, OG image, README, and favicon set. Animated mark is used **only** in the marketing hero — not in product chrome.
- [ ] Favicons wired up via `logo/favicon/HEAD-SNIPPET.html`.
- [ ] Voice rewritten per `BRAND.md §2`. No marketing fluff; operator voice throughout.
- [ ] All page titles, OG tags, and email templates say **Crittable**.

---

## Drop‑in files

| Path | Purpose |
|---|---|
| `tokens.css` | All design tokens. Import once at the top of your global stylesheet. |
| `logo/svg/mark-encounter-01-dark.svg` | Primary static mark, dark UI |
| `logo/svg/mark-encounter-01-light.svg` | Primary static mark, light UI |
| `logo/svg/mark-animated-dark.svg` | Animated mark — use in marketing hero |
| `logo/{gif,apng,webp}/mark-animated-{128,256,512}-{dark,light}-transparent.{gif,png,webp}` | Animated mark, transparent BG. `dark` = light strokes (use on dark BG); `light` = dark strokes (use on light BG). APNG/WebP carry full alpha; GIF is 1-bit. |
| `logo/svg/lockup-crittable-dark.svg` | Header lockup |
| `logo/favicon/HEAD-SNIPPET.html` | Paste into `<head>` verbatim |
| `BRAND.md` | Brand system reference |
| `source/` | **Full React/JSX source for every artboard and screen.** Read these to lift exact component patterns, layouts, and copy. See `source/SOURCE.md` for a map. |
| `Brand Package.standalone.html` | Self-contained visual reference (open in browser). If you can't render it, use `source/Brand Package.html` instead — same content, plain JSX. |

---

## Wiring it up

### 1. Tokens

```html
<link rel="stylesheet" href="/tokens.css">
```

`tokens.css` defines `:root` custom properties **and** baseline `html, body` styles (background, font, color, antialiasing, font‑feature settings). It expects the app to be on `--ink-900`. If you have a light‑mode marketing surface, scope it:

```css
.surface-paper { background: var(--paper-050); color: var(--ink-900); }
```

### 2. Fonts

Self‑host or load from a CDN. Recommended `<head>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
```

For production, switch to self‑hosted woff2 in `/fonts/`.

### 3. Favicons

Copy the entire `logo/favicon/` folder to your public root (e.g. `public/favicon/`), then paste the contents of `logo/favicon/HEAD-SNIPPET.html` into your document `<head>`. Adjust paths if the folder lives elsewhere. The `site.webmanifest` is already filled in with `Crittable`.

### 4. Header

```html
<header class="site-header">
  <a href="/" class="lockup">
    <img src="/logo/svg/lockup-crittable-dark.svg" alt="Crittable" height="36">
  </a>
  <nav>...</nav>
</header>
```

The lockup SVG is sized at viewBox 100h. Set `height: 36px` for a standard nav, `48px` for a marketing site.

### 5. Hero (marketing only)

Use `logo/svg/mark-animated-dark.svg` as a centered hero element. It loops indefinitely (~14s cycle); SMIL animations work in all modern browsers without JS. Wrap it in `prefers-reduced-motion` if you want a static fallback:

```html
<picture>
  <source media="(prefers-reduced-motion: reduce)" srcset="/logo/svg/mark-encounter-01-dark.svg">
  <img src="/logo/svg/mark-animated-dark.svg" alt="" class="hero-mark">
</picture>
```

For surfaces that need to adapt to the user's OS color scheme (e.g. a GitHub README, a docs page that supports both themes), use the transparent GIF/APNG variants — they carry no plate fill, only the rounded-square stroke + the inner ink:

```html
<picture>
  <source media="(prefers-color-scheme: dark)"  srcset="/logo/gif/mark-animated-256-dark-transparent.gif">
  <source media="(prefers-color-scheme: light)" srcset="/logo/gif/mark-animated-256-light-transparent.gif">
  <img src="/logo/gif/mark-animated-256-dark-transparent.gif" alt="" class="hero-mark">
</picture>
```

Substitute the `apng/` or `webp/` sibling for full alpha (no fringing on light backgrounds).

---

## Component conventions

Look at `source/app-screens.jsx` for the full UI (or `Brand Package.standalone.html` rendered in a browser). Distillation:

**Cards**
```css
.card {
  background: var(--ink-800);
  border: 1px solid var(--ink-600);
  border-radius: var(--r-3);
  padding: 16px;
}
.card:hover { background: var(--ink-750); }
```

**Status pills (only 4 colors!)**
```css
.pill        { font-family: var(--font-mono); font-size: var(--t-12); padding: 2px 8px; border-radius: var(--r-pill); letter-spacing: 0.04em; text-transform: uppercase; }
.pill.crit   { background: var(--crit-bg); color: var(--crit); }
.pill.warn   { background: var(--warn-bg); color: var(--warn); }
.pill.info   { background: var(--info-bg); color: var(--info); }
.pill.signal { background: var(--signal-tint); color: var(--signal-bright); }
```

**Buttons**
```css
.btn { font-family: var(--font-mono); font-size: var(--t-13); letter-spacing: 0.04em; text-transform: uppercase; padding: 10px 16px; border-radius: var(--r-2); border: 1px solid var(--ink-500); background: var(--ink-700); color: var(--ink-100); cursor: pointer; }
.btn:hover { border-color: var(--signal); }
.btn-primary { background: var(--signal); color: var(--ink-950); border-color: var(--signal); }
.btn-primary:hover { background: var(--signal-bright); }
```

**IDs and timestamps** — always mono, always `tabular-nums`:
```html
<span class="mono tabular">T+04:32</span>
<span class="mono">INJ-0042</span>
<span class="mono">CT/03</span>
```

**Section dividers** — dotted hairline, never solid:
```css
.divider { border-top: 1px dashed var(--ink-600); }
```

---

## Voice rewrite checklist

When you encounter copy in the existing site, run it through this filter:

| Marketing voice (kill) | Operator voice (keep) |
|---|---|
| "Empower your team to respond" | "Run the inject. Ship the AAR." |
| "Comprehensive incident management" | "Tabletops, end‑to‑end" |
| "Real‑time collaboration" | "All operators, same wall‑clock" |
| "AI‑powered insights" | "AAR drafted while the room is still warm" |
| "Seamlessly integrate" | "Pipes into Slack, Jira, PagerDuty" |
| "Get started today!" | "Roll a tabletop in 5 minutes" |
| "Industry‑leading" | (delete entirely) |

Headlines: imperative verbs, no exclamation points. Body: short sentences, concrete nouns, no em‑dash filler. Replace every soft adjective ("powerful", "seamless", "intuitive") with a specific behavior.

---

## What NOT to do

- ❌ Don't add gradient backgrounds to anything. The brand is flat.
- ❌ Don't use emoji as decoration. Mono dot‑separators (`·`) and arrows (`→`, `↓`) only.
- ❌ Don't introduce a third typeface. Resist Inter Display, Sora, anything trendy.
- ❌ Don't use stock photography. If a section feels empty, use diagrammatic content (an encounter map, a timeline, a stat). See `BRAND.md §7`.
- ❌ Don't skin third‑party widgets (intercom bubble, calendly embed) in our colors. Either restyle them properly or hide them.
- ❌ Don't use `<i>` icon fonts (FontAwesome, Feather inlined). Use inline SVGs from a single set, sized to match `--t-16`.
- ❌ Don't auto‑play the animated mark on the product side. Only on marketing.
- ❌ Don't lean into the D&D fiction in copy. The dice/encounter metaphor lives in the *mark*; the *voice* stays incident‑response operator. No "roll a saving throw" jokes.

---

## Pages to redesign (in order)

1. **Marketing home** — hero with animated mark, 3 product modes (Roll / Respond / Review), one screenshot of the app, footer.
2. **Product page** ("How it works") — a single scrolling page that walks through an exercise from inject delivery to AAR.
3. **Pricing** — 3 tiers, mono price labels, no annual/monthly toggle (we'll add it back later if needed).
4. **About** — 1‑page operator manifesto. No team photos.
5. **Docs / Changelog** — long‑form Inter on `--ink-900`, code blocks in mono on `--ink-800`.
6. **App chrome** — header, sidebar, modal frames. Reference `source/app-screens.jsx` (`AppTacticalHUD`, `AppLobby`, `AppBriefing`, `AppAAR`).

Don't try to redesign auth screens, settings, or admin in this pass. Keep their existing layout, just swap tokens and fonts.

---

## Open questions to surface back

When something is ambiguous, leave a `// TODO(brand)` comment in the code and surface it in a list. Don't invent answers. Examples worth flagging:

- Does the dashboard need both a light‑mode and dark‑mode? Brand assumes dark only for product.
- What is the OG image for shareable exercise links? (The mark + exercise title is a likely answer.)
- Is there a customer logo bar on the marketing home? If yes, do they have permission to use them?
- Should the optional NIST 800‑61 phase labels (`CT/01 Detect`, `CT/02 Triage`, …) appear on the marketing site? See `BRAND.md §1`.

---

## Files in this package

```
handoff/
├── BRAND.md                          ← brand system
├── HANDOFF.md                        ← this file
├── README.md                         ← top-level orientation
├── tokens.css                        ← drop into global CSS
├── Brand Package.standalone.html     ← rendered visual reference
├── source/                           ← React/JSX source for every artboard
│   ├── SOURCE.md                     ← map of what's in each file
│   ├── Brand Package.html            ← entry point (works locally, no bundle)
│   ├── tokens.css
│   ├── mark.jsx                      ← logo / favicon source
│   ├── artboards.jsx                 ← brand-system pages
│   ├── app-screens.jsx               ← all 7 product screens
│   └── design-canvas.jsx             ← presentation harness (ignore)
└── logo/
    ├── svg/
    │   ├── mark-encounter-01..06-{dark,light}.svg    ← static marks (each encounter state)
    │   ├── mark-face-1..6-{dark,light}.svg           ← static die faces (small-size fallback)
    │   ├── mark-animated-{dark,light}.svg            ← animated SMIL
    │   └── lockup-crittable-{dark,light}[-transparent].svg
    ├── png/
    │   ├── mark-{16..1024}-{dark,light}.png          ← raster mark
    │   └── lockup-{400,800,1600}-{dark,light}.png    ← raster lockup
    ├── gif/
    │   ├── mark-animated-{128,256,512}-dark.gif                       ← opaque #0A0D13 plate
    │   └── mark-animated-{128,256,512}-{dark,light}-transparent.gif   ← 1-bit alpha, adaptive via <picture>
    ├── apng/
    │   └── mark-animated-{128,256,512}-{dark,light}-transparent.png   ← full alpha (animated PNG)
    ├── webp/
    │   └── mark-animated-{128,256,512}-{dark,light}-transparent.webp  ← full alpha, smallest
    └── favicon/
        ├── favicon.ico
        ├── favicon.svg
        ├── favicon-mono.svg                          ← Safari pinned tab
        ├── favicon-{16,32,48,96}.png
        ├── apple-touch-icon.png
        ├── android-{192,512}.png
        ├── maskable-512.png
        ├── site.webmanifest                          ← Crittable, pre-filled
        └── HEAD-SNIPPET.html
```
