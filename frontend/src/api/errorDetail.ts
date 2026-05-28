/**
 * Single source of truth for turning a FastAPI/Starlette error-response
 * ``detail`` into a human-readable string.
 *
 * Why this is its own module: the ``detail`` field arrives in two shapes
 * — a plain string for a hand-thrown ``HTTPException(detail="…")`` and an
 * **array** of ``{loc, msg, type, …}`` objects for a Pydantic 422
 * request-body validation failure. Any code that does
 * ``json.detail as string`` and feeds the result into a thrown ``Error``
 * or the DOM produces the infamous ``"[object Object]"`` for the array
 * shape — an unrecoverable, meaningless blob for the user. That bug
 * shipped at two separate fetch boundaries (the create-session wizard
 * AND the notepad fetch), so the normalisation lives here, is reused at
 * every boundary, and is fenced in by ``errorDetail.test.ts`` (unit
 * cases + a source-grep guard that fails CI if anyone hand-rolls the
 * cast again).
 *
 * Rule for any new fetch boundary: never type or cast a response
 * ``detail`` as ``string``. Parse the body, then call
 * ``formatErrorDetail(json.detail, res.status)``.
 */

/**
 * Turn a Pydantic ``loc`` array into a field name a human recognises.
 * Drops the protocol-noise ``body`` / ``query`` / ``path`` prefix and
 * trailing numeric array indices, then humanises the field's snake_case
 * into sentence case: ``["body","creator_label"]`` → ``"Creator label"``,
 * ``["body","invitee_roles",0,"label"]`` → ``"Label"``. A raw schema id
 * like ``creator_label`` means nothing to an operator staring at a form
 * field labelled "CREATOR ROLE"; "Creator label" at least lands in the
 * right ballpark without coupling this generic helper to any one form.
 */
export function humanizeLoc(loc: unknown): string {
  if (!Array.isArray(loc)) return "";
  const segs = loc.filter(
    (s) => s !== "body" && s !== "query" && s !== "path",
  );
  // The field is the last *string* segment; trailing numeric segments
  // are array indices (noise). Fall back to the dotted path if there's
  // no string segment at all.
  const field = [...segs].reverse().find((s) => typeof s === "string");
  if (typeof field !== "string") return segs.map((s) => String(s)).join(".");
  const spaced = field.replace(/_/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : "";
}

/**
 * Normalise a response ``detail`` (string OR Pydantic-422 array OR
 * anything unexpected) into a readable message. For the array shape each
 * entry becomes ``"<Field>: <msg>"`` with the field humanised (see
 * {@link humanizeLoc}); multiple errors join with ``"; "``. Entry count
 * and per-message length are clamped so a pathological 422 body can't
 * build a multi-KB alert string (defence in depth — the real backend
 * can't currently produce one). Falls back to the HTTP ``status`` when
 * the shape can't yield anything useful. Guaranteed to return a
 * non-empty string and to NEVER return ``"[object Object]"``.
 */
export function formatErrorDetail(detail: unknown, status: number): string {
  if (typeof detail === "string" && detail.trim().length > 0) return detail;
  if (Array.isArray(detail)) {
    const parts = detail
      .slice(0, 10)
      .map((entry): string => {
        if (entry && typeof entry === "object") {
          const e = entry as { loc?: unknown; msg?: unknown };
          const field = humanizeLoc(e.loc);
          const rawMsg = typeof e.msg === "string" ? e.msg : "";
          const msg = rawMsg.length > 200 ? `${rawMsg.slice(0, 200)}…` : rawMsg;
          return field && msg ? `${field}: ${msg}` : msg || field;
        }
        return typeof entry === "string" ? entry : "";
      })
      .filter((s) => s.length > 0);
    if (parts.length > 0) return parts.join("; ");
  }
  return `${status}`;
}
