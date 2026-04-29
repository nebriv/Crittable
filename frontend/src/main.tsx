import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// One-time boot banner so a fresh tab logs the build hash + reminds operators
// to bump DevTools to "Verbose" if they're triaging — Chrome hides
// ``console.debug`` by default which makes the rest of our trace lines
// invisible.
//
// Token scrubbing: tokens appear in TWO places in our URLs —
//   * query-string  (?token=…)
//   * path segment  (/play/:sessionId/:token, used for join links)
// The regexes below cover both forms before logging.
function _scrubLocation(href: string): string {
  return href
    .replace(/([?&]token=)[^&#]+/gi, "$1***")
    .replace(/(\/play\/[^/?#]+\/)[^/?#]+/gi, "$1***");
}
console.info(
  "%c[atf] boot",
  "color:#7dd3fc;font-weight:600",
  {
    href: _scrubLocation(window.location.href),
    userAgent: navigator.userAgent,
    note: "Set DevTools console level to 'Verbose' to see [ws]/[api]/[facilitator] debug traces.",
  },
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
