"""Regression net for the live-API test fixtures.

This module lives at ``backend/tests/test_live_fixtures.py`` (NOT
under ``tests/live/``).  The directory-level conftest auto-skips
every test under ``tests/live/`` when ``ANTHROPIC_API_KEY`` is
absent, which would also skip a regression test that lived
alongside the suite — defeating the entire point.  This file lives
one level up so it runs in every CI invocation regardless of the
key.  It does NOT hit the live API itself; it source-greps the
live-test files for a bad pattern.

What it locks:

1. **No direct ``os.environ`` reads of ``ANTHROPIC_API_KEY`` in
   ``tests/live/``.**  The production code resolves the key via
   ``Settings.anthropic_api_key`` (pydantic-settings), which honours
   both shell env vars AND a ``.env`` file. Reading ``os.environ``
   directly diverges: a contributor whose key lives in ``.env`` (which
   the production app boots fine on) sees ``KeyError`` errors when
   they try to run the live suite — the fixture bypasses Settings.

   The bug was reported by a real contributor in the field after the
   Wave 2 PR landed: 24 errors + 7 false-positive guardrail failures
   on a working ``.env`` setup.  Fixing the fixtures only would let
   the same pattern silently re-appear in the next live-API test
   added.  This regression test is the durable fix.

   The single allowed exception is ``judge.py``'s
   ``_settings_api_key`` helper, which intentionally falls back to
   ``os.environ`` when the app settings layer can't import (preserves
   the leaf-utility property the docstring documents).  That fallback
   is gated behind a ``try / except`` and is not the primary path.
"""

from __future__ import annotations

import pathlib
import re

# Match either ``os.environ["ANTHROPIC_API_KEY"]`` or
# ``os.environ.get("ANTHROPIC_API_KEY"...)`` in any quoting / spacing.
# Negative lookbehind on backtick excludes occurrences inside RST-
# style docstring code spans (`` `` ``os.environ...`` ``) so a file
# that DOCUMENTS the rule by quoting the bad pattern doesn't trip
# its own check. Real code doesn't precede ``os.environ`` with a
# backtick.
_BAD_PATTERN = re.compile(
    r"""(?<!`)os\.environ(?:\.get)?\s*[\[(]\s*['"]ANTHROPIC_API_KEY['"]"""
)

# Files allowed to contain the bad pattern. Each entry includes the
# rationale so a future contributor doesn't blanket-allowlist a new
# violator.
_ALLOWED = {
    # ``judge.py`` is documented as a leaf utility usable without the
    # app settings layer. Its ``_settings_api_key`` helper tries
    # Settings first and only falls back to ``os.environ`` when the
    # import fails — that fallback is the documented escape hatch.
    "judge.py",
}


def test_no_direct_os_environ_anthropic_api_key_in_tests_live() -> None:
    """Source-grep ``backend/tests/live/`` for the bad pattern.

    Why this test exists: the production code reads the API key via
    ``Settings.anthropic_api_key`` so a ``.env`` file is honoured.
    Test fixtures that read ``os.environ`` directly silently force
    every contributor to export the var into their shell — a
    divergence that produced ``KeyError`` errors on a working setup
    in the field.  This test makes the divergence loud at CI time
    rather than at "I ran ``pytest tests/live/`` and got 24
    confusing errors" time.

    To resolve a fail: swap ``os.environ["ANTHROPIC_API_KEY"]`` for
    ``get_settings().require_anthropic_key()`` (or the equivalent
    Settings-resolved value).  See ``conftest.py``'s ``anthropic_client``
    fixture for the canonical pattern.
    """

    live_dir = pathlib.Path(__file__).parent / "live"
    hits: list[tuple[str, int, str]] = []
    for path in live_dir.rglob("*.py"):
        if path.name in _ALLOWED:
            continue
        text = path.read_text(encoding="utf-8")
        for lineno, line in enumerate(text.splitlines(), start=1):
            if _BAD_PATTERN.search(line):
                hits.append((str(path.relative_to(live_dir)), lineno, line.strip()))

    assert not hits, (
        "Direct ``os.environ`` access of ``ANTHROPIC_API_KEY`` found "
        "in tests/live/ — the production code uses pydantic-settings "
        "(``Settings.anthropic_api_key``) which reads BOTH shell env "
        "vars AND ``.env`` files. Reading ``os.environ`` directly "
        "diverges: a contributor with the key in ``.env`` will see "
        "``KeyError`` even though the application boots cleanly.\n\n"
        "Replace with:\n"
        "    settings = get_settings()\n"
        "    settings.require_anthropic_key()  # for the api_key param\n\n"
        "Hits:\n"
        + "\n".join(f"  {path}:{ln} → {body}" for path, ln, body in hits)
    )
