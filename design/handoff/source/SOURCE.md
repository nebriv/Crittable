# Brand Package — Source

The full React/JSX source for every artboard in the Brand Package, ready to read, copy, or run locally. This is what was bundled into `handoff/Brand Package.standalone.html`.

## Files

| File | Contents |
|---|---|
| `Brand Package.html` | Entry point. Loads tokens + JSX, mounts the canvas. Open in any browser with the four JSX files alongside it. |
| `tokens.css` | All design tokens — colors (ink scale, signal blue, accents), spacing, radii, typography variables. The single source of truth for the visual system. |
| `design-canvas.jsx` | The `<DesignCanvas>` / `<DCSection>` / `<DCArtboard>` shell — pan/zoom layout. Not part of the brand itself; just the presentation harness. |
| `mark.jsx` | The CT/0N mark — `<DiceMark>` (the die-face logo with pip-replacement glyphs), wordmark, lockups, favicons. **The canonical source for every glyph.** |
| `artboards.jsx` | Cover, naming note, playbook library, mark construction/variants, color/type/voice systems, stickers, social. The brand-system pages. |
| `app-screens.jsx` | All seven hi-fi product screens: Tactical HUD, Creator setup, Environment, Lobby, Player join, Briefing, AAR. **This is what to mine for product UI patterns.** |

## How to use this for implementation

1. **For tokens / colors / type** → read `tokens.css`. Every variable used in the components is defined there.
2. **For the logo / mark / favicons** → read `mark.jsx`. `<DiceMark size={N} variant="…" />` is the one component you need; everything else composes it.
3. **For product UI components** → read `app-screens.jsx`. Each screen is a self-contained function component built from inline styled `<div>`s using token CSS variables. Lift the patterns directly — buttons, panel chrome, tag pills, the HUD frame, the briefing card, etc.
4. **For voice/copy patterns** → read the `Voice` component in `artboards.jsx` and the in-screen copy in `app-screens.jsx`.

## Running it

```
# any static server in this folder
python3 -m http.server 8000
# then open http://localhost:8000/Brand%20Package.html
```

No build step. React + Babel are loaded from CDN; JSX is transpiled in the browser.

## Conventions used throughout

- **Inline styles** with token CSS variables (`background: 'var(--ink-900)'`). No CSS-in-JS library, no Tailwind.
- **No external icon library.** All glyphs are inline SVG, drawn to fit the brand's geometric language (1.5–2px strokes, rounded line caps, no fills unless intentional).
- **Fonts:** `Inter` for UI, `JetBrains Mono` for codes / IDs / tactical labels. Loaded from Google Fonts in the entry HTML.
- **Color usage:** dark surface `--ink-900` is the default app background; `--signal` (blue) is the single accent. Warning/success/danger colors exist but are used sparingly.
