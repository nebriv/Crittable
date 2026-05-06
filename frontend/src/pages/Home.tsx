import { useEffect } from "react";

/**
 * `/` — marketing landing. Just enough to set the brand tone, explain
 * what the product is in three beats, and route the user to the
 * "Roll new session" form at `/new`. This page is intentionally
 * stateless: no session handling, no API calls, no dependency on the
 * Facilitator state machine.
 */
export function Home() {
  // Wire history navigation so the CTA hands off without a hard
  // reload — the browser still gets a real URL change so back-button
  // works. Bails out for every case where the browser's default
  // behaviour is the right answer:
  //   - modified clicks (cmd/ctrl/shift/alt) → "open in new tab"
  //   - non-primary buttons (middle-click is always button=1) →
  //     "open in new tab" / "paste in browser bar"
  //   - default-prevented events → another handler already claimed it
  //   - non-Element targets (Text node, document) → can't .closest()
  //   - links with target=_blank, download, or non-http(s) hrefs
  //     (mailto:, tel:, in-page hash anchors) → keep native behaviour
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      if (e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (!(e.target instanceof Element)) return;
      const link = e.target.closest("a[data-spa-nav]");
      if (!(link instanceof HTMLAnchorElement)) return;
      // Native attributes that should keep default behaviour.
      if (link.target && link.target !== "_self") return;
      if (link.hasAttribute("download")) return;
      const href = link.getAttribute("href");
      if (!href) return;
      // Same-document hashes are a browser concern, not ours.
      if (href.startsWith("#")) return;
      // Only intercept same-origin http(s) paths. Reject mailto:,
      // tel:, javascript:, blob:, etc. — anything that's not a
      // path-relative app URL.
      if (
        href.startsWith("http://") ||
        href.startsWith("https://") ||
        href.startsWith("//")
      ) {
        return;
      }
      e.preventDefault();
      window.history.pushState({}, "", href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  return (
    <main
      className="dotgrid"
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--ink-900)",
      }}
    >
      <header
        role="banner"
        className="border-b border-ink-600 bg-ink-850 px-5"
        style={{ minHeight: 48 }}
      >
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-3 py-2">
          <a
            href="/"
            aria-label="Crittable home"
            className="inline-flex items-center"
            data-spa-nav
          >
            <img
              src="/logo/svg/lockup-crittable-dark-transparent.svg"
              alt="Crittable"
              height={28}
              style={{ height: 28 }}
              className="block"
            />
          </a>
          <div style={{ flex: 1 }} />
          <a
            href="/new"
            data-spa-nav
            className="mono rounded-r-1 border border-ink-500 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-ink-200 hover:border-signal hover:text-signal focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal"
          >
            ROLL NEW SESSION →
          </a>
        </div>
      </header>

      <section
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "64px 24px",
          gap: 32,
          textAlign: "center",
        }}
      >
        <picture>
          <source
            media="(prefers-reduced-motion: reduce)"
            srcSet="/logo/svg/mark-encounter-01-dark.svg"
          />
          <img
            src="/logo/gif/mark-animated-512-dark-transparent.gif"
            alt=""
            width={260}
            height={260}
            style={{ display: "block" }}
          />
        </picture>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 14,
            maxWidth: 720,
          }}
        >
          <span
            className="mono"
            style={{
              fontSize: 11,
              color: "var(--signal)",
              letterSpacing: "0.22em",
              fontWeight: 700,
              textTransform: "uppercase",
            }}
          >
            ROLL · RESPOND · REVIEW
          </span>
          <h1
            className="sans"
            style={{
              fontSize: 56,
              fontWeight: 600,
              color: "var(--ink-050)",
              margin: 0,
              letterSpacing: "-0.02em",
              lineHeight: 1.05,
            }}
          >
            Tabletop exercises<br />
            for security teams.
          </h1>
          <p
            className="sans"
            style={{
              fontSize: 16,
              color: "var(--ink-300)",
              margin: 0,
              lineHeight: 1.55,
              maxWidth: 580,
            }}
          >
            The AI runs the room. Your team runs the response. The AAR
            drafts itself while the room is still warm.
          </p>
        </div>

        <a
          href="/new"
          data-spa-nav
          className="mono"
          style={{
            background: "var(--signal)",
            color: "var(--ink-900)",
            padding: "16px 28px",
            borderRadius: 2,
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: "0.20em",
            textTransform: "uppercase",
            textDecoration: "none",
          }}
        >
          ROLL A NEW SESSION →
        </a>
      </section>

      <section
        style={{
          borderTop: "1px solid var(--ink-600)",
          background: "var(--ink-850)",
        }}
      >
        <div
          style={{
            maxWidth: 1080,
            margin: "0 auto",
            padding: "32px 24px",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 32,
          }}
        >
          {[
            {
              eyebrow: "ROLL",
              title: "Set the brief",
              body: "Drop in scenario, team, environment, and constraints. Claude proposes a plan you can approve or skip.",
            },
            {
              eyebrow: "RESPOND",
              title: "Run the room",
              body: "Per-role join links. Turn-based responses. The AI narrates beats, throws injects, yields turns.",
            },
            {
              eyebrow: "REVIEW",
              title: "Ship the AAR",
              body: "Markdown after-action report — full transcript, per-role scores, recommendations. Drafted while the room is still warm.",
            },
          ].map((m) => (
            <article
              key={m.eyebrow}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                borderLeft: "2px solid var(--signal)",
                paddingLeft: 16,
              }}
            >
              <span
                className="mono"
                style={{
                  fontSize: 11,
                  color: "var(--signal)",
                  letterSpacing: "0.22em",
                  fontWeight: 700,
                }}
              >
                {m.eyebrow}
              </span>
              <h2
                className="sans"
                style={{
                  fontSize: 20,
                  fontWeight: 600,
                  color: "var(--ink-050)",
                  margin: 0,
                  letterSpacing: "-0.01em",
                }}
              >
                {m.title}
              </h2>
              <p
                className="sans"
                style={{
                  fontSize: 14,
                  color: "var(--ink-200)",
                  margin: 0,
                  lineHeight: 1.55,
                }}
              >
                {m.body}
              </p>
            </article>
          ))}
        </div>
      </section>

      <footer
        style={{
          background: "var(--ink-950)",
          borderTop: "1px solid var(--ink-600)",
          padding: "16px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 10,
            color: "var(--ink-400)",
            letterSpacing: "0.22em",
            fontWeight: 600,
          }}
        >
          CRITTABLE
        </span>
        <a
          href="/new"
          data-spa-nav
          className="mono"
          style={{
            fontSize: 10,
            color: "var(--ink-300)",
            letterSpacing: "0.18em",
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          ROLL NEW SESSION →
        </a>
      </footer>
    </main>
  );
}
