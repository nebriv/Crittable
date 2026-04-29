/// <reference types="vite/client" />

// Vite ``define`` injections for build identification — surfaced in the
// StatusBar so users filing bug reports can tell us which build they're
// running. Falls back to "dev" when no git context is available.
declare const __ATF_GIT_SHA__: string;
declare const __ATF_BUILD_TS__: string;
