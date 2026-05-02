/**
 * Direct unit tests for ``sanitizePinText``. The
 * ``highlightActions.test.ts`` integration case covers the typical
 * case via the action wrapper; these target the regex-set edge
 * cases that CodeQL's "incomplete multi-character sanitisation"
 * rule was concerned about.
 *
 * Mirror of ``backend/tests/test_notepad.py::
 * test_sanitize_pin_text_*`` — keep the two suites in sync.
 */
import { describe, expect, it } from "vitest";

import { sanitizePinText } from "../lib/notepad";

describe("sanitizePinText", () => {
  it("strips ``# heading``, ``[link](url)``, ``<script>...</script>`` markers", () => {
    const raw =
      "  ## hello [click](https://evil.com) ![img](x.png) <script>alert(1)</script> world ";
    const out = sanitizePinText(raw);
    expect(out).not.toContain("evil.com");
    expect(out.toLowerCase()).not.toContain("<script");
    expect(out).toContain("alert(1)"); // text kept; tags stripped
    expect(out.startsWith("#")).toBe(false);
    expect(out.startsWith(" ")).toBe(false);
  });

  it("strips nested HTML tags to fixed-point (CodeQL regression)", () => {
    // A single-pass ``replace(/<[^>]+>/g, "")`` would collapse
    // ``<scr<script>ipt>`` to ``<script>`` after the first match
    // and leave it in place. Fixed-point loop must keep stripping
    // until stable.
    const raw = "<scr<script>ipt>alert(1)</scr</script>ipt>";
    const out = sanitizePinText(raw);
    expect(out.toLowerCase()).not.toContain("<script");
    expect(out.toLowerCase()).not.toContain("</script");
    expect(out).toContain("alert(1)");
  });

  it("strips nested markdown links to fixed-point", () => {
    const raw = "[![img](x.png)](http://evil.example)";
    const out = sanitizePinText(raw);
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("](");
    expect(out).not.toContain("![");
    expect(out).toContain("img");
  });

  it("returns empty string when input is only markup", () => {
    expect(sanitizePinText("<b><i></i></b>")).toBe("");
    expect(sanitizePinText("```code```")).toBe("");
    expect(sanitizePinText("[](http://x)")).toBe("");
  });

  it("preserves plain visible text", () => {
    expect(sanitizePinText("plain text — no markup")).toBe(
      "plain text — no markup",
    );
  });
});
