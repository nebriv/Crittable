import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        ink: {
          "050": "#F2F4F9",
          "100": "#DCE2EE",
          "200": "#B6BFD0",
          "300": "#8390A8",
          "400": "#5B667D",
          "500": "#3A4458",
          "600": "#2A3344",
          "700": "#1F2636",
          "750": "#181E2C",
          "800": "#131824",
          "850": "#0E121A",
          "900": "#0A0D13",
          "950": "#06080C",
        },
        paper: {
          "050": "#F6F4ED",
          "100": "#EDEAE0",
          "200": "#DAD5C5",
          "300": "#B5AE99",
        },
        signal: {
          DEFAULT: "oklch(0.72 0.16 245)",
          bright: "oklch(0.82 0.17 245)",
          dim: "oklch(0.55 0.13 245)",
          deep: "oklch(0.38 0.10 245)",
          "100": "oklch(0.94 0.05 245)",
          tint: "color-mix(in oklch, oklch(0.72 0.16 245) 14%, transparent)",
        },
        crit: {
          DEFAULT: "oklch(0.68 0.21 25)",
          bg: "color-mix(in oklch, oklch(0.68 0.21 25) 18%, transparent)",
        },
        warn: {
          DEFAULT: "oklch(0.82 0.16 75)",
          bg: "color-mix(in oklch, oklch(0.82 0.16 75) 16%, transparent)",
        },
        info: {
          DEFAULT: "oklch(0.78 0.13 232)",
          bg: "color-mix(in oklch, oklch(0.78 0.13 232) 16%, transparent)",
        },
      },
      fontFamily: {
        // Variable-font names come from the @fontsource-variable
        // packages bundled in src/index.css (no Google Fonts CDN).
        // System fallbacks render until the woff2 lands.
        mono: [
          "JetBrains Mono Variable",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
        sans: [
          "Inter Variable",
          "-apple-system",
          "system-ui",
          "sans-serif",
        ],
      },
      fontSize: {
        "t-12": "12px",
        "t-13": "13px",
        "t-14": "14px",
        "t-16": "16px",
        "t-18": "18px",
        "t-22": "22px",
        "t-28": "28px",
        "t-36": "36px",
        "t-48": "48px",
        "t-64": "64px",
      },
      borderRadius: {
        "r-0": "0px",
        "r-1": "2px",
        "r-2": "4px",
        "r-3": "6px",
        "r-4": "8px",
        "r-pill": "999px",
      },
      keyframes: {
        // The "new messages below ↓" chip in Play.tsx / Facilitator.tsx —
        // outward signal-blue ring that fades. Pairs an outer ripple with
        // a drop shadow so the chip retains depth across the cycle.
        // ``motion-reduce`` utilities baked into the chip element handle
        // the static fallback. RGB literal mirrors the brand mark's signal
        // hex (#5EA6EA, the X marker / primary route in the encounter).
        "chip-pulse": {
          "0%, 100%": {
            boxShadow:
              "0 0 0 0 rgb(94 166 234 / 0.55), 0 10px 15px -3px rgb(0 0 0 / 0.25)",
          },
          "50%": {
            boxShadow:
              "0 0 0 10px rgb(94 166 234 / 0), 0 10px 15px -3px rgb(0 0 0 / 0.25)",
          },
        },
        // The "awaiting your response" chip above the composer in
        // Play.tsx — yellow ring that pulses outward to flag your-turn
        // in peripheral vision while the user reads the room. Mirrors
        // the structure of `chip-pulse` (outer ripple) but keyed off
        // the warn token so it harmonizes with the chip border. The
        // motion-reduce override is wired into the index.css media
        // query so screen-reader and reduced-motion users get a
        // static chip with the same border weight.
        "warn-chip-pulse": {
          "0%, 100%": {
            boxShadow:
              "0 0 0 0 color-mix(in oklch, oklch(0.82 0.16 75) 45%, transparent)",
          },
          "50%": {
            boxShadow:
              "0 0 0 8px color-mix(in oklch, oklch(0.82 0.16 75) 0%, transparent)",
          },
        },
        // Brand keyframes — kept on the Tailwind side so utility classes
        // can compose them. The CSS-side definitions in tokens.css are
        // the source of truth; these mirrors let `animate-tt-*` work.
        "tt-blink": {
          "0%, 49%": { opacity: "1" },
          "50%, 100%": { opacity: "0" },
        },
        "tt-pulse": {
          "0%, 100%": {
            boxShadow:
              "0 0 0 0 color-mix(in oklch, oklch(0.72 0.16 245) 14%, transparent)",
          },
          "50%": { boxShadow: "0 0 0 6px transparent" },
        },
        "tt-sweep": {
          "0%": { transform: "rotate(0deg)" },
          "100%": { transform: "rotate(360deg)" },
        },
        "tt-stream": {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        "chip-pulse": "chip-pulse 2.2s ease-in-out infinite",
        "warn-chip-pulse": "warn-chip-pulse 2.2s ease-in-out infinite",
        "tt-blink": "tt-blink 1s steps(2) infinite",
        "tt-pulse": "tt-pulse 1.6s ease-in-out infinite",
        "tt-sweep": "tt-sweep 8s linear infinite",
        "tt-stream": "tt-stream 6s linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;
