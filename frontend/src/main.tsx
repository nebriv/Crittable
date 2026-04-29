import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Single boot log line for engineering triage. Intentionally low-key —
// the User Agent flagged that any "open DevTools" hint in user-facing
// output is invisible noise to non-engineers, so we surface only the
// build / page identity here. Engineers triaging will already have
// console open; the WS / API debug lines need the console at Verbose
// to be visible, but that's documented in CLAUDE.md, not in the UI.
//
// Token scrubbing: tokens appear in TWO places in our URLs —
//   * query-string  (?token=…)
//   * path segment  (/play/:sessionId/:token, used for join links)
// Both forms are stripped before logging.
function _scrubLocation(href: string): string {
  return href
    .replace(/([?&]token=)[^&#]+/gi, "$1***")
    .replace(/(\/play\/[^/?#]+\/)[^/?#]+/gi, "$1***");
}
console.debug(
  "[atf] boot",
  {
    href: _scrubLocation(window.location.href),
    userAgent: navigator.userAgent,
  },
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
