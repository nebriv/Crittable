/// <reference types="vitest" />
import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Best-effort short git SHA for build identification — surfaced in the UI
 * so users filing bug reports can tell us which build they're on. Falls
 * back to "dev" when git isn't present or the working tree isn't a repo
 * (e.g. inside the production Docker image where ``.git`` is excluded).
 */
function _gitSha(): string {
  // Allow override via env so docker builds can inject a tagged SHA.
  if (process.env.VITE_GIT_SHA) return process.env.VITE_GIT_SHA;
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "dev";
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __ATF_GIT_SHA__: JSON.stringify(_gitSha()),
    __ATF_BUILD_TS__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8000",
      "/ws": { target: "ws://localhost:8000", ws: true },
      "/healthz": "http://localhost:8000",
      "/readyz": "http://localhost:8000",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
});
