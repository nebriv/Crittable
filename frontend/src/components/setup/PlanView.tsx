import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ScenarioPlan } from "../../api/client";

/**
 * Readable structured plan view with optional spoiler-hide.
 *
 * Default: title, executive_summary, key_objectives, guardrails,
 * success_criteria, and out_of_scope are visible. ``narrative_arc`` and
 * ``injects`` are spoiler-hidden behind a Reveal toggle whose state is
 * persisted in localStorage so it carries across reloads. Per-session
 * scoping (via ``sessionId``) makes each new exercise reset to the safe
 * (hidden) default while still respecting the user's choice within the
 * current session — without it, a creator screen-sharing with their
 * team after a previous solo test would silently spoil the next plan.
 */
export function PlanView({
  plan,
  sessionId,
}: {
  plan: ScenarioPlan;
  sessionId?: string;
}) {
  const storageKey = sessionId
    ? `atf-plan-reveal:${sessionId}`
    : "atf-plan-reveal";
  const [reveal, setReveal] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });
  function toggleReveal() {
    setReveal((cur) => {
      const next = !cur;
      try {
        window.localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        /* localStorage may be disabled; preference is best-effort. */
      }
      return next;
    });
  }
  return (
    <article className="flex flex-col gap-4 text-sm text-ink-100">
      <header>
        <h3 className="text-lg font-semibold text-signal-100">{plan.title}</h3>
      </header>

      {plan.executive_summary ? (
        <section className="flex flex-col gap-1">
          <h4 className="text-xs uppercase tracking-widest text-ink-400">
            Executive summary
          </h4>
          <ReactMarkdown
            skipHtml
            remarkPlugins={[remarkGfm]}
            components={{
              p: ({ children }) => (
                <p className="whitespace-pre-wrap leading-relaxed">{children}</p>
              ),
              strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
              em: ({ children }) => <em className="italic">{children}</em>,
            }}
          >
            {plan.executive_summary}
          </ReactMarkdown>
        </section>
      ) : null}

      {plan.key_objectives.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h4 className="text-xs uppercase tracking-widest text-ink-400">Key objectives</h4>
          <ul className="ml-4 list-disc space-y-0.5">
            {plan.key_objectives.map((o, i) => (
              <li key={i}>{o}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {plan.guardrails.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h4 className="text-xs uppercase tracking-widest text-ink-400">Guardrails</h4>
          <ul className="ml-4 list-disc space-y-0.5">
            {plan.guardrails.map((o, i) => (
              <li key={i}>{o}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {plan.success_criteria.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h4 className="text-xs uppercase tracking-widest text-ink-400">
            Success criteria
          </h4>
          <ul className="ml-4 list-disc space-y-0.5">
            {plan.success_criteria.map((o, i) => (
              <li key={i}>{o}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {plan.out_of_scope.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h4 className="text-xs uppercase tracking-widest text-ink-400">Out of scope</h4>
          <ul className="ml-4 list-disc space-y-0.5">
            {plan.out_of_scope.map((o, i) => (
              <li key={i}>{o}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {plan.narrative_arc.length > 0 || plan.injects.length > 0 ? (
        <section className="flex flex-col gap-2 rounded border border-warn bg-warn-bg p-2">
          <header className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-xs uppercase tracking-widest text-warn">
              Narrative arc &amp; injects
            </h4>
            <button
              type="button"
              onClick={toggleReveal}
              className="rounded border border-warn px-2 py-0.5 text-xs font-semibold text-warn hover:bg-warn-bg"
              aria-pressed={reveal}
              title={
                reveal
                  ? "Switch to participant mode — hide upcoming injects so you can play fresh."
                  : "Switch to facilitator mode — show upcoming injects so you can pace the meeting."
              }
            >
              {reveal ? "Switch to participant mode" : "Switch to facilitator mode"}
            </button>
          </header>
          {!reveal ? (
            <p className="text-xs text-warn">
              <span className="font-semibold">Participant mode.</span>{" "}
              Hidden so you can play through fresh. {plan.narrative_arc.length}{" "}
              beat{plan.narrative_arc.length === 1 ? "" : "s"}, {plan.injects.length}{" "}
              inject{plan.injects.length === 1 ? "" : "s"} planned. Switch to
              facilitator mode if you need to pace the meeting block.
            </p>
          ) : (
            <>
              {plan.narrative_arc.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <p className="text-[11px] uppercase tracking-widest text-warn">
                    Narrative arc
                  </p>
                  <ol className="ml-4 list-decimal space-y-1">
                    {plan.narrative_arc.map((b) => (
                      <li key={b.beat}>
                        <span className="font-semibold">{b.label}</span>
                        {b.expected_actors.length > 0 ? (
                          <span className="ml-1 text-ink-400">
                            — {b.expected_actors.join(", ")}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}
              {plan.injects.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <p className="text-[11px] uppercase tracking-widest text-warn">
                    Injects
                  </p>
                  <ul className="ml-4 list-disc space-y-1">
                    {plan.injects.map((inj, i) => (
                      <li key={i}>
                        <span className="text-ink-400">[{inj.trigger}]</span>{" "}
                        <span className="text-ink-400">({inj.type})</span>{" "}
                        {inj.summary}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : null}
    </article>
  );
}
