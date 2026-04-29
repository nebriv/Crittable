/// <reference types="vite/client" />

// Vite ``define`` injections for build identification — surfaced in the
// StatusBar so users filing bug reports can tell us which build they're
// running. Falls back to "dev" when no git context is available.
declare const __ATF_GIT_SHA__: string;
declare const __ATF_BUILD_TS__: string;
// Frontend poll cadences (ms). Sourced from ``VITE_ACTIVITY_POLL_MS`` /
// ``VITE_AAR_POLL_MS`` env vars at build time; defaults are 3000 / 2500.
declare const __ATF_ACTIVITY_POLL_MS__: number;
declare const __ATF_AAR_POLL_MS__: number;
