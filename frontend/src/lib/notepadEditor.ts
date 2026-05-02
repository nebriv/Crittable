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
 * If the doc has a top-level ``## Timeline`` heading, return the
 * position right before the next h2 (the end of the Timeline section)
 * — or ``doc.content.size`` if Timeline is the last section. If there
 * is no Timeline heading, also return ``doc.content.size``.
 *
 * Walks only top-level children — pinning into a heading nested inside
 * a list item or blockquote is not a real case for our templates.
 */
export function findPinInsertPos(editor: Editor): number {
  const doc = editor.state.doc;
  let timelineFound = false;
  let nextSectionPos: number | null = null;
  doc.descendants((node, pos, parent) => {
    if (parent !== doc) return false;
    if (node.type.name === "heading" && node.attrs?.level === 2) {
      const text = node.textContent.trim().toLowerCase();
      if (text === "timeline" && !timelineFound) {
        timelineFound = true;
      } else if (timelineFound && nextSectionPos === null) {
        nextSectionPos = pos;
        return false;
      }
    }
    return false;
  });
  if (!timelineFound) return doc.content.size;
  return nextSectionPos ?? doc.content.size;
}

/**
 * Append a pinned snippet at the Timeline-section boundary. Only the
 * originating client should call this — Yjs collab propagates to peers
 * automatically.
 *
 * Multi-line snippets emit one paragraph per line: ProseMirror text
 * nodes silently swallow ``\n`` (rendered as a space), so a chat
 * selection that spans paragraphs would otherwise become a single
 * run-on line. The first line carries the ``T+MM:SS — `` stamp;
 * continuation lines are indented (visually grouped, no second stamp).
 * Empty lines are dropped.
 */
export function appendPinToEditor(
  editor: Editor,
  text: string,
  sessionStartedAt: string,
): void {
  const stamp = relativeStamp(sessionStartedAt);
  const lines = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (lines.length === 0) return;
  const paragraphs = lines.map((line, idx) => ({
    type: "paragraph",
    content: [
      {
        type: "text",
        text: idx === 0 ? `${stamp} — ${line}` : `    ${line}`,
      },
    ],
  }));
  const insertPos = findPinInsertPos(editor);
  editor.chain().insertContentAt(insertPos, paragraphs).run();
}
