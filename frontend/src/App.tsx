import { useEffect, useState } from "react";
import { Facilitator } from "./pages/Facilitator";
import { Home } from "./pages/Home";
import { Play } from "./pages/Play";

type Route =
  | { kind: "home" }
  | { kind: "facilitator" }
  | { kind: "play"; sessionId: string; token: string };

function parseRoute(): Route {
  const path = window.location.pathname;
  const playMatch = path.match(/^\/play\/([^/]+)\/([^/]+)$/);
  if (playMatch) {
    return { kind: "play", sessionId: playMatch[1], token: decodeURIComponent(playMatch[2]) };
  }
  // `/new` is the creator's "Roll new session" form (the existing
  // Facilitator landing). Everything else (including bare `/`) renders
  // the marketing Home page.
  if (path === "/new" || path.startsWith("/new/")) {
    return { kind: "facilitator" };
  }
  return { kind: "home" };
}

export default function App() {
  const [route, setRoute] = useState<Route>(parseRoute);

  useEffect(() => {
    const handler = () => setRoute(parseRoute());
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  return (
    <div className="min-h-screen bg-ink-900 text-ink-100 font-sans">
      {route.kind === "home" ? (
        <Home />
      ) : route.kind === "facilitator" ? (
        <Facilitator />
      ) : (
        <Play sessionId={route.sessionId} token={route.token} />
      )}
    </div>
  );
}
