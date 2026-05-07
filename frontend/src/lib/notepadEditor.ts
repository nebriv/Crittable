/**
 * Editor-side helpers for the shared notepad — extracted from
 * ``SharedNotepad.tsx`` so the component file only exports React
 * components (eslint-plugin-react-refresh requirement) and the helpers
 * are unit-testable without mounting the full editor.
 */
import type { Editor } from "@tiptap/core";

/**
 * "T+MM:SS" relative to ``sessionStartedAt``. Used by both the hotkey-
 * insert path and the highlight-pin path so the two timestamp formats
 * stay identical.
 */
export function relativeStamp(sessionStartedAt: string): string {
  const start = new Date(sessionStartedAt).getTime();
  const elapsedMs = Date.now() - start;
  const minutes = Math.max(0, Math.floor(elapsedMs / 60000));
  const seconds = Math.max(0, Math.floor((elapsedMs % 60000) / 1000));
  return `T+${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Pin section identifier. Add a new value here when adding a new
 * highlight action that pins under a different section heading.
 */
export type PinSection = "timeline" | "aar_review";

/**
 * Visible markdown heading text + matching predicate for each pin
 * section. Storing them in one place keeps the heading copy in sync
 * across the insertion path (``findPinInsertPos``), the auto-create
 * path (``appendPinToEditor``), and the AAR-pipeline expectation that
 * a section exists in the notepad markdown.
 *
 * ``matches`` is the case-insensitive predicate the doc walker uses
 * when locating a top-level h2 — kept explicit so a future rename of
 * the visible heading doesn't silently stop matching old docs.
 */
const PIN_SECTION_HEADINGS: Record<PinSection, { heading: string; matches: (text: string) => boolean }> = {
  timeline: {
    heading: "Timeline",
    matches: (t) => t === "timeline",
  },
  aar_review: {
    heading: "AAR Review",
    matches: (t) => t === "aar review",
  },
};

/**
 * Locate the insertion position for a pin: the end of the named
 * top-level section. If the doc has a top-level h2 matching the
 * section's heading, return the position right before the next h2 —
 * or ``doc.content.size`` if the section is the last one. If the
 * heading isn't present, return ``null`` so the caller can decide
 * whether to auto-create it (AAR Review) or fall back to end-of-doc
 * (Timeline, which most templates already include).
 *
 * Walks only top-level children — pinning into a heading nested
 * inside a list item or blockquote is not a real case for our
 * templates.
 */
export function findPinInsertPos(
  editor: Editor,
  section: PinSection = "timeline",
): number | null {
  const doc = editor.state.doc;
  const matcher = PIN_SECTION_HEADINGS[section].matches;
  let sectionFound = false;
  let nextSectionPos: number | null = null;
  doc.descendants((node, pos, parent) => {
    if (parent !== doc) return false;
    if (node.type.name === "heading" && node.attrs?.level === 2) {
      const text = node.textContent.trim().toLowerCase();
      if (matcher(text) && !sectionFound) {
        sectionFound = true;
      } else if (sectionFound && nextSectionPos === null) {
        nextSectionPos = pos;
        return false;
      }
    }
    return false;
  });
  if (!sectionFound) return null;
  return nextSectionPos ?? doc.content.size;
}

/**
 * Append a pinned snippet under the named section heading. Only the
 * originating client should call this — Yjs collab propagates to peers
 * automatically.
 *
 * If the section heading isn't present, the behavior depends on the
 * section: ``timeline`` falls back to end-of-doc (most templates
 * already include the heading; if a user blew it away that's still
 * "near the bottom" by intent), while ``aar_review`` auto-inserts the
 * heading at end-of-doc before the snippet. Auto-insert keeps the
 * section discoverable for the AAR pipeline (which sees the whole
 * notepad markdown verbatim) without requiring the user to manually
 * scaffold it before the first Mark-for-AAR click.
 *
 * Multi-line snippets emit one paragraph per line: ProseMirror text
 * nodes silently swallow ``\n`` (rendered as a space), so a chat
 * selection that spans paragraphs would otherwise become a single
 * run-on line. The first line carries the ``T+MM:SS — `` stamp;
 * continuation lines get a ``↳ `` lead-in marker. We deliberately
 * avoid a 4-space indent: when ``editorToMarkdown`` serialises the
 * snapshot back out, CommonMark-style renderers parse paragraphs that
 * start with 4+ spaces as indented code blocks, which would change
 * how pins appear in the AAR pipeline. Per Copilot review on PR #125.
 */
export function appendPinToEditor(
  editor: Editor,
  text: string,
  sessionStartedAt: string,
  section: PinSection = "timeline",
): void {
  const stamp = relativeStamp(sessionStartedAt);
  const lines = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (lines.length === 0) return;
  const paragraphs: Array<Record<string, unknown>> = lines.map((line, idx) => ({
    type: "paragraph",
    content: [
      {
        type: "text",
        text: idx === 0 ? `${stamp} — ${line}` : `↳ ${line}`,
      },
    ],
  }));

  let insertPos = findPinInsertPos(editor, section);
  if (insertPos === null) {
    if (section === "aar_review") {
      // Auto-create the heading at end-of-doc so the user gets a
      // visibly-grouped "AAR Review" block from the very first click.
      const headingNode = {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: PIN_SECTION_HEADINGS[section].heading }],
      };
      paragraphs.unshift(headingNode);
      insertPos = editor.state.doc.content.size;
    } else {
      // ``timeline`` heading missing — fall back to end-of-doc and
      // skip auto-creation; existing templates always ship with the
      // heading, so a missing one usually means the user deliberately
      // restructured the doc and we shouldn't fight them.
      insertPos = editor.state.doc.content.size;
    }
  }
  editor.chain().insertContentAt(insertPos, paragraphs).run();
}
