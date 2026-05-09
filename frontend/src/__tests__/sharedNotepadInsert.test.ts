/**
 * Unit tests for the Timeline-section-end finder + pin-append helpers
 * in ``SharedNotepad.tsx``. These run against a headless TipTap editor
 * (no React, no Collaboration plugin) — enough to exercise the doc
 * walk and the ``insertContentAt`` call path without booting the full
 * notepad.
 */
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";

import {
  appendPinToEditor,
  findPinInsertPos,
} from "../lib/notepadEditor";

// Track every editor created by ``makeEditor`` so the ``afterEach``
// hook can destroy them all. ProseMirror's ``DOMObserver`` schedules a
// ``setTimeout`` (~20 ms) to batch DOM mutations on every doc change;
// without ``editor.destroy()`` the timer survives vitest's per-test
// teardown of the jsdom environment, then fires while a later test is
// running and crashes with ``ReferenceError: document is not defined``
// (the global was already cleaned up). The error doesn't fail any
// individual test but it pollutes the console output and would mask a
// real unhandled error if one ever showed up.
const livingEditors: Editor[] = [];

function makeEditor(html: string): Editor {
  const editor = new Editor({
    extensions: [StarterKit.configure({ undoRedo: false })],
    content: html,
  });
  livingEditors.push(editor);
  return editor;
}

afterEach(() => {
  while (livingEditors.length > 0) {
    const editor = livingEditors.pop();
    editor?.destroy();
  }
});

describe("findPinInsertPos — timeline section", () => {
  it("returns null when there is no Timeline heading (caller falls back to end-of-doc)", () => {
    const editor = makeEditor("<p>just a paragraph</p>");
    expect(findPinInsertPos(editor)).toBeNull();
  });

  it("returns the start of the next h2 when Timeline is followed by another section", () => {
    const editor = makeEditor(
      "<h2>Timeline</h2><p>existing</p><h2>Action Items</h2><p>todo</p>",
    );
    const pos = findPinInsertPos(editor);
    expect(pos).not.toBeNull();
    // Insert position should be the start of the "Action Items" heading,
    // i.e. strictly less than doc.content.size and strictly greater than
    // the position of the first paragraph after Timeline.
    expect(pos!).toBeLessThan(editor.state.doc.content.size);
    expect(pos!).toBeGreaterThan(0);
    // Round-trip: inserting a paragraph there should land BEFORE the
    // "Action Items" heading.
    editor.commands.insertContentAt(pos!, [
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
    const upperPos = findPinInsertPos(upper);
    expect(upperPos).not.toBeNull();
    expect(upperPos!).toBeLessThan(upper.state.doc.content.size);
    const lower = makeEditor("<h2>timeline</h2><p>x</p><h2>Next</h2>");
    const lowerPos = findPinInsertPos(lower);
    expect(lowerPos).not.toBeNull();
    expect(lowerPos!).toBeLessThan(lower.state.doc.content.size);
  });

  it("ignores h1 / h3 timeline headings — only h2 counts", () => {
    const h1 = makeEditor("<h1>Timeline</h1><p>x</p><h2>Next</h2>");
    // h1 doesn't match — null tells the caller to fall back to end-of-doc.
    expect(findPinInsertPos(h1)).toBeNull();
    const h3 = makeEditor("<h3>Timeline</h3><p>x</p><h2>Next</h2>");
    expect(findPinInsertPos(h3)).toBeNull();
  });
});

describe("findPinInsertPos — aar_review section (issue #117)", () => {
  it("returns null when there is no AAR Review heading (caller auto-creates)", () => {
    const editor = makeEditor("<h2>Timeline</h2><p>x</p>");
    expect(findPinInsertPos(editor, "aar_review")).toBeNull();
  });

  it("returns the start of the next h2 when AAR Review is followed by another section", () => {
    const editor = makeEditor(
      "<h2>AAR Review</h2><p>existing</p><h2>Decisions</h2><p>x</p>",
    );
    const pos = findPinInsertPos(editor, "aar_review");
    expect(pos).not.toBeNull();
    expect(pos!).toBeLessThan(editor.state.doc.content.size);
    editor.commands.insertContentAt(pos!, [
      { type: "paragraph", content: [{ type: "text", text: "AAR INSERT" }] },
    ]);
    const text = editor.getText();
    expect(text.indexOf("AAR INSERT")).toBeLessThan(text.indexOf("Decisions"));
    expect(text.indexOf("AAR INSERT")).toBeGreaterThan(text.indexOf("AAR Review"));
  });

  it("returns end-of-doc when AAR Review is the last section", () => {
    const editor = makeEditor(
      "<h2>Timeline</h2><p>x</p><h2>AAR Review</h2><p>existing</p>",
    );
    expect(findPinInsertPos(editor, "aar_review")).toBe(
      editor.state.doc.content.size,
    );
  });

  it("does NOT confuse the Timeline heading for an AAR Review heading", () => {
    const editor = makeEditor("<h2>Timeline</h2><p>x</p>");
    expect(findPinInsertPos(editor, "aar_review")).toBeNull();
    expect(findPinInsertPos(editor, "timeline")).toBe(
      editor.state.doc.content.size,
    );
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

describe("appendPinToEditor — aar_review section (issue #117)", () => {
  it("auto-creates the ## AAR Review heading on first pin when missing", () => {
    const editor = makeEditor("<h2>Timeline</h2><p>existing</p>");
    const sessionStartedAt = new Date(Date.now() - 30_000).toISOString();
    appendPinToEditor(editor, "important moment", sessionStartedAt, "aar_review");
    const text = editor.getText();
    // The heading is now in the doc, followed by the pin text.
    expect(text).toContain("AAR Review");
    expect(text).toMatch(/T\+00:30 — important moment/);
    // Heading should land AFTER the existing Timeline content (we
    // insert at end-of-doc when auto-creating).
    expect(text.indexOf("AAR Review")).toBeGreaterThan(text.indexOf("existing"));
    expect(text.indexOf("important moment")).toBeGreaterThan(
      text.indexOf("AAR Review"),
    );
  });

  it("appends to an existing ## AAR Review section without duplicating the heading", () => {
    const editor = makeEditor(
      "<h2>Timeline</h2><p>x</p><h2>AAR Review</h2><p>first pin</p>",
    );
    const sessionStartedAt = new Date(Date.now() - 60_000).toISOString();
    appendPinToEditor(editor, "second pin", sessionStartedAt, "aar_review");
    const text = editor.getText();
    // Only one "AAR Review" heading despite two pins landing under it.
    const headingMatches = text.match(/AAR Review/g) ?? [];
    expect(headingMatches).toHaveLength(1);
    expect(text).toMatch(/T\+01:00 — second pin/);
    expect(text.indexOf("first pin")).toBeLessThan(text.indexOf("second pin"));
  });

  it("inserts BEFORE a section that follows AAR Review, not after it", () => {
    const editor = makeEditor(
      "<h2>AAR Review</h2><p>first</p><h2>Open Questions</h2><p>q</p>",
    );
    const sessionStartedAt = new Date(Date.now() - 90_000).toISOString();
    appendPinToEditor(editor, "second", sessionStartedAt, "aar_review");
    const text = editor.getText();
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
    expect(text.indexOf("second")).toBeLessThan(text.indexOf("Open Questions"));
  });

  it("timeline pins do NOT match an AAR Review heading and vice versa", () => {
    // Belt-and-braces: the lookup must keep the two sections distinct
    // even if a doc has both.
    const editor = makeEditor(
      "<h2>Timeline</h2><p>tl</p><h2>AAR Review</h2><p>aar</p>",
    );
    const stamp = new Date(Date.now() - 30_000).toISOString();
    appendPinToEditor(editor, "TL_PIN", stamp, "timeline");
    appendPinToEditor(editor, "AAR_PIN", stamp, "aar_review");
    const text = editor.getText();
    // TL_PIN lands inside the Timeline section (before AAR Review).
    expect(text.indexOf("TL_PIN")).toBeLessThan(text.indexOf("AAR Review"));
    // AAR_PIN lands inside the AAR Review section, after the existing "aar" content.
    expect(text.indexOf("AAR_PIN")).toBeGreaterThan(text.indexOf("aar"));
  });
});
