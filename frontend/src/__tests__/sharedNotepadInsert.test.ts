/**
 * Unit tests for the Timeline-section-end finder + pin-append helpers
 * in ``SharedNotepad.tsx``. These run against a headless TipTap editor
 * (no React, no Collaboration plugin) — enough to exercise the doc
 * walk and the ``insertContentAt`` call path without booting the full
 * notepad.
 */
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";

import {
  appendPinToEditor,
  findPinInsertPos,
} from "../lib/notepadEditor";

function makeEditor(html: string): Editor {
  return new Editor({
    extensions: [StarterKit.configure({ undoRedo: false })],
    content: html,
  });
}

describe("findPinInsertPos", () => {
  it("returns end-of-doc when there is no Timeline heading", () => {
    const editor = makeEditor("<p>just a paragraph</p>");
    expect(findPinInsertPos(editor)).toBe(editor.state.doc.content.size);
  });

  it("returns the start of the next h2 when Timeline is followed by another section", () => {
    const editor = makeEditor(
      "<h2>Timeline</h2><p>existing</p><h2>Action Items</h2><p>todo</p>",
    );
    const pos = findPinInsertPos(editor);
    // Insert position should be the start of the "Action Items" heading,
    // i.e. strictly less than doc.content.size and strictly greater than
    // the position of the first paragraph after Timeline.
    expect(pos).toBeLessThan(editor.state.doc.content.size);
    expect(pos).toBeGreaterThan(0);
    // Round-trip: inserting a paragraph there should land BEFORE the
    // "Action Items" heading.
    editor.commands.insertContentAt(pos, [
      { type: "paragraph", content: [{ type: "text", text: "INSERTED" }] },
    ]);
    const text = editor.getText();
    expect(text.indexOf("INSERTED")).toBeLessThan(text.indexOf("Action Items"));
    expect(text.indexOf("INSERTED")).toBeGreaterThan(text.indexOf("Timeline"));
  });

  it("returns end-of-doc when Timeline is the last section", () => {
    const editor = makeEditor(
      "<h2>Action Items</h2><p>todo</p><h2>Timeline</h2><p>existing</p>",
    );
    expect(findPinInsertPos(editor)).toBe(editor.state.doc.content.size);
  });

  it("matches Timeline case-insensitively (TIMELINE / timeline / Timeline)", () => {
    const upper = makeEditor("<h2>TIMELINE</h2><p>x</p><h2>Next</h2>");
    expect(findPinInsertPos(upper)).toBeLessThan(
      upper.state.doc.content.size,
    );
    const lower = makeEditor("<h2>timeline</h2><p>x</p><h2>Next</h2>");
    expect(findPinInsertPos(lower)).toBeLessThan(
      lower.state.doc.content.size,
    );
  });

  it("ignores h1 / h3 timeline headings — only h2 counts", () => {
    const h1 = makeEditor("<h1>Timeline</h1><p>x</p><h2>Next</h2>");
    // h1 doesn't match — falls through to end-of-doc.
    expect(findPinInsertPos(h1)).toBe(h1.state.doc.content.size);
    const h3 = makeEditor("<h3>Timeline</h3><p>x</p><h2>Next</h2>");
    expect(findPinInsertPos(h3)).toBe(h3.state.doc.content.size);
  });
});

describe("appendPinToEditor", () => {
  it("inserts a paragraph with a T+MM:SS prefix at the Timeline-section end", () => {
    const editor = makeEditor(
      "<h2>Timeline</h2><p>existing</p><h2>Action Items</h2>",
    );
    // Use a fixed sessionStartedAt 90s in the past so the stamp is "T+01:30".
    const sessionStartedAt = new Date(Date.now() - 90_000).toISOString();
    appendPinToEditor(editor, "important snippet", sessionStartedAt);
    const text = editor.getText();
    expect(text).toMatch(/T\+01:30 — important snippet/);
    // And the new paragraph lives in the Timeline section, not after
    // "Action Items".
    expect(text.indexOf("important snippet")).toBeGreaterThan(
      text.indexOf("Timeline"),
    );
    expect(text.indexOf("important snippet")).toBeLessThan(
      text.indexOf("Action Items"),
    );
  });

  it("appends at end-of-doc when there is no Timeline heading", () => {
    const editor = makeEditor("<p>scratch note</p>");
    appendPinToEditor(editor, "PIN", new Date().toISOString());
    const text = editor.getText();
    // PIN should live AFTER the existing scratch note.
    expect(text.indexOf("PIN")).toBeGreaterThan(text.indexOf("scratch note"));
  });

  it("clamps a future sessionStartedAt so the stamp never goes negative", () => {
    const editor = makeEditor("<p>x</p>");
    // Session "starts" 10 minutes in the future — clamp should yield T+00:00.
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    appendPinToEditor(editor, "negative-clamp pin", future);
    expect(editor.getText()).toMatch(/T\+00:00 — negative-clamp pin/);
  });

  it("emits one paragraph per non-empty line; continuation lines use ↳ (NOT 4 spaces)", () => {
    // 4-space indent would round-trip through ``editorToMarkdown`` as a
    // CommonMark indented code block, which would change AAR rendering.
    // Per Copilot review on PR #125 — keep the lead-in as ``↳ `` so the
    // serialised markdown stays as plain paragraphs.
    const editor = makeEditor("<p>x</p>");
    const sessionStartedAt = new Date(Date.now() - 60_000).toISOString();
    appendPinToEditor(
      editor,
      "first line\n\nsecond line\n  third line  ",
      sessionStartedAt,
    );
    const text = editor.getText();
    expect(text).toMatch(/T\+01:00 — first line/);
    expect(text).toMatch(/↳ second line/);
    expect(text).toMatch(/↳ third line/);
    // No 4-space prefix — that would parse as an indented code block.
    expect(text).not.toMatch(/^ {4}second line/m);
  });
});
