import { useEffect, useState } from "react";
import { Facilitator } from "./pages/Facilitator";
import { Play } from "./pages/Play";

type Route =
  | { kind: "facilitator" }
  | { kind: "play"; sessionId: string; token: string };

function parseRoute(): Route {
  const path = window.location.pathname;
  const playMatch = path.match(/^\/play\/([^/]+)\/([^/]+)$/);
  if (playMatch) {
    return { kind: "play", sessionId: playMatch[1], token: decodeURIComponent(playMatch[2]) };
  }
  return { kind: "facilitator" };
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
      {route.kind === "facilitator" ? <Facilitator /> : <Play sessionId={route.sessionId} token={route.token} />}
    </div>
  );
}
