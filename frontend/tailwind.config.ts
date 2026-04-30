import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      keyframes: {
        // Soft outward sky ring that fades — used by the
        // "New messages below ↓" chip in Play.tsx / Facilitator.tsx
        // to draw the eye without thrashing. While the animation is
        // running, every keyframe combines the outer ripple with a
        // drop shadow so the chip keeps depth across the cycle.
        // Under ``motion-reduce:animate-none``, this keyframe doesn't
        // apply at all, so reduced-motion depth comes from the
        // ``motion-reduce:shadow-lg motion-reduce:ring-2
        // motion-reduce:ring-sky-500/30`` utility classes baked into
        // the chip element itself, not from this keyframe.
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
