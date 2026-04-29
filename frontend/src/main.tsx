import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// One-time boot banner so a fresh tab logs the build hash + reminds operators
// to bump DevTools to "Verbose" if they're triaging — Chrome hides
// ``console.debug`` by default which makes the rest of our trace lines
// invisible.
console.info(
  "%c[atf] boot",
  "color:#7dd3fc;font-weight:600",
  {
    href: window.location.href.replace(/(token=)[^&]+/i, "$1***"),
    userAgent: navigator.userAgent,
    note: "Set DevTools console level to 'Verbose' to see [ws]/[api]/[facilitator] debug traces.",
  },
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
