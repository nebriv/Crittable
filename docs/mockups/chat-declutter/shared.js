// Helpers shared by all four mockup pages.

window.byRole = (id) => window.ROLES.find((r) => r.id === id) || null;

window.tailwindColor = (name) => {
  // Map our role color names to Tailwind shades for avatar bg.
  const t = {
    emerald: ["bg-emerald-700/40", "border-emerald-600", "text-emerald-200"],
    violet:  ["bg-violet-700/40",  "border-violet-600",  "text-violet-200"],
    sky:     ["bg-sky-700/40",     "border-sky-600",     "text-sky-200"],
    amber:   ["bg-amber-700/40",   "border-amber-600",   "text-amber-200"],
    pink:    ["bg-pink-700/40",    "border-pink-600",    "text-pink-200"],
    cyan:    ["bg-cyan-700/40",    "border-cyan-600",    "text-cyan-200"],
    teal:    ["bg-teal-700/40",    "border-teal-600",    "text-teal-200"],
  };
  return t[name] || ["bg-slate-700/40", "border-slate-600", "text-slate-200"];
};

// Render the body, replacing @Role and @Name tokens with .mention spans.
// If the @-mention matches the current viewer, also add .mention-me for amber highlight.
window.renderBody = (msg, viewerId) => {
  let body = msg.body;
  const viewer = window.byRole(viewerId);
  // Replace @Tom, @Diana, @CISO, @Jordan, @Sarah etc.
  const tokens = window.ROLES.flatMap((r) => {
    const list = [r.label];
    if (r.name) list.push(r.name.split(" ")[0]); // first name
    return list.map((label) => ({ label, role: r }));
  });
  // Sort longest-first so "SOC Analyst" doesn't get partial-matched.
  tokens.sort((a, b) => b.label.length - a.label.length);
  for (const { label, role } of tokens) {
    const re = new RegExp(`@${label}\\b`, "g");
    const isMe =
      viewer && (role.id === viewer.id ||
        (role.label === viewer.label && role.id === viewer.id));
    body = body.replace(re, (match) => {
      const cls = isMe ? "mention mention-me" : "mention";
      return `<span class="${cls}">${match}</span>`;
    });
  }
  // Also catch the explicit msg.mentions[] addressed-to-me (no @ token in body but mentions has the role)
  return body;
};

// Is this message addressed-to-me?
window.isAddressedToMe = (msg, viewerId) => {
  if (!viewerId) return false;
  if (msg.to === viewerId) return true;
  if (Array.isArray(msg.mentions) && msg.mentions.includes(viewerId)) return true;
  return false;
};

// Initials for the avatar circle.
window.initials = (role) => role.short || role.label.slice(0, 3).toUpperCase();

// Format the role label. "AI Facilitator", "CISO · Sarah Chen", etc.
window.actorLabel = (role) =>
  role.id === "ai" || !role.name ? role.label : `${role.label} · ${role.name}`;

// Short version for tight spaces.
window.actorShort = (role) =>
  role.id === "ai" ? "AI" : role.name ? role.name.split(" ")[0] : role.label;

// Track styling helper.
window.trackInfo = (trackId) => window.TRACKS[trackId] || window.TRACKS.main;

// Build the Tailwind color class for a track chip in HTML form.
window.trackColorHex = (trackId) => {
  const map = {
    containment: "#f43f5e",
    disclosure:  "#f59e0b",
    comms:       "#ec4899",
    lateral:     "#14b8a6",
    main:        "#64748b",
  };
  return map[trackId] || "#64748b";
};

// Pinned-card list extracted from messages.
window.pinnedCards = () =>
  window.MESSAGES
    .filter((m) => m.pinned)
    .map((m) => ({
      ...m.pinned,
      msgId: m.id,
      ts: m.ts,
      from: m.from,
      track: m.track,
    }));

// Decisions list extracted from messages flagged is_decision.
window.decisionList = () =>
  window.MESSAGES.filter((m) => m.is_decision).map((m) => ({
    msgId: m.id,
    ts: m.ts,
    from: m.from,
    track: m.track,
    body: m.body,
  }));

// Critical inject list.
window.criticalList = () =>
  window.MESSAGES.filter((m) => m.kind === "critical").map((m) => ({
    msgId: m.id,
    ts: m.ts,
    body: m.body,
  }));

// Build a thread tree using REPLIES parent map.
window.buildThreadTree = () => {
  const childrenOf = {};
  for (const [child, parent] of Object.entries(window.REPLIES || {})) {
    (childrenOf[parent] ||= []).push(child);
  }
  // Roots = messages that are not someone else's reply
  const replyIds = new Set(Object.keys(window.REPLIES || {}));
  const roots = window.MESSAGES.filter((m) => !replyIds.has(m.id));
  return { roots, childrenOf };
};

// Click-to-scroll to a message id.
window.scrollToMsg = (id) => {
  const el = document.getElementById("msg-" + id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("awaiting-me");
  setTimeout(() => el.classList.remove("awaiting-me"), 1500);
};

// Viewer switcher widget — shared across all mockups.
window.renderViewerSwitcher = () => {
  const sel = document.getElementById("viewer-switcher");
  if (!sel) return;
  sel.innerHTML = window.ROLES
    .map((r) => `<option value="${r.id}" ${r.id === window.VIEWER ? "selected" : ""}>${r.label}${r.name ? " · " + r.name : ""}</option>`)
    .join("");
  sel.addEventListener("change", (e) => {
    window.VIEWER = e.target.value;
    if (typeof window.rerender === "function") window.rerender();
  });
};
