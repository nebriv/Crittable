/**
 * Tests for the template markdown → HTML converter (issue #98).
 *
 * The converter is intentionally narrow — it only handles the subset
 * the bundled starter templates use (## headings, ``- bullets``,
 * ``- [ ]`` task items, paragraphs, ``_italic_``, inline code).
 * Anything richer should reach for a real markdown lib.
 */
import { describe, expect, it } from "vitest";

import { templateMarkdownToHtml } from "../lib/notepad";

describe("templateMarkdownToHtml", () => {
  it("converts H2 headings", () => {
    expect(templateMarkdownToHtml("## Timeline")).toBe("<h2>Timeline</h2>");
  });

  it("converts bullet lists", () => {
    const out = templateMarkdownToHtml("- one\n- two");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li><p>one</p></li>");
    expect(out).toContain("<li><p>two</p></li>");
    expect(out).toContain("</ul>");
  });

  it("converts task list items with checked + unchecked states", () => {
    const out = templateMarkdownToHtml("- [ ] first\n- [x] done");
    expect(out).toContain('<ul data-type="taskList">');
    expect(out).toContain('<li data-type="taskItem" data-checked="false"><p>first</p></li>');
    expect(out).toContain('<li data-type="taskItem" data-checked="true"><p>done</p></li>');
  });

  it("does not mix a bullet list and a task list into one <ul>", () => {
    const out = templateMarkdownToHtml("- bullet\n- [ ] task");
    // Two separate lists with the second one carrying data-type.
    expect(out).toContain("<ul><li><p>bullet</p></li></ul>");
    expect(out).toContain('<ul data-type="taskList"><li data-type="taskItem"');
  });

  it("escapes raw HTML in plain prose", () => {
    const out = templateMarkdownToHtml("plain <script>alert(1)</script> text");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("handles inline code, bold, italic", () => {
    const out = templateMarkdownToHtml(
      "say `hello` then **bold** and _italic_",
    );
    expect(out).toContain("<code>hello</code>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>italic</em>");
  });

  it("emits a paragraph break on a blank line between blocks", () => {
    const out = templateMarkdownToHtml("first\n\nsecond");
    expect(out).toContain("<p>first</p>");
    expect(out).toContain("<p>second</p>");
  });

  it("round-trips a starter-template-shaped input without crashing", () => {
    const md =
      "## Timeline\n\nT+0 — kickoff\n\n## Action Items\n\n- [ ] Notify regulator within 72h — @legal\n- [x] Roll signing keys — @ir\n\n## Decisions\n\n- Ransom posture: _under review_\n";
    const out = templateMarkdownToHtml(md);
    expect(out).toContain("<h2>Timeline</h2>");
    expect(out).toContain("<h2>Action Items</h2>");
    expect(out).toContain('data-type="taskItem"');
    expect(out).toContain("<em>under review</em>");
  });
});
