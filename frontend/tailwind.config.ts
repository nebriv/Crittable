import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      keyframes: {
        // Soft outward sky ring that fades — used by the
        // "New messages below ↓" chip in Play.tsx / Facilitator.tsx
        // to draw the eye without thrashing. The starting / ending
        // frame includes the static drop shadow so a motion-reduced
        // user (``motion-reduce:animate-none``) still gets a chip
        // with depth — the animation only touches the outer ripple
        // ring layer.
        "chip-pulse": {
          "0%, 100%": {
            boxShadow:
              "0 0 0 0 rgb(14 165 233 / 0.55), 0 10px 15px -3px rgb(0 0 0 / 0.25)",
          },
          "50%": {
            boxShadow:
              "0 0 0 10px rgb(14 165 233 / 0), 0 10px 15px -3px rgb(0 0 0 / 0.25)",
          },
        },
      },
      animation: {
        "chip-pulse": "chip-pulse 2.2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
