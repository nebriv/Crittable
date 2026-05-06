"""Regression net for the live-API test fixtures.

This module lives at ``backend/tests/test_live_fixtures.py`` (NOT
under ``tests/live/``).  The directory-level conftest auto-skips
every test under ``tests/live/`` when ``ANTHROPIC_API_KEY`` is
absent, which would also skip a regression test that lived
alongside the suite — defeating the entire point.  This file lives
one level up so it runs in every CI invocation regardless of the
key.  It does NOT hit the live API itself; it source-greps the
live-test files for known footgun patterns.

What it locks:

1. **No direct ``os.environ`` reads of ``ANTHROPIC_API_KEY`` in
   ``tests/live/``.**  The production code resolves the key via
   ``Settings.anthropic_api_key`` (pydantic-settings), which honors
   both shell env vars AND (via the live conftest's
   ``_load_project_root_dotenv``) a project-root ``.env`` file.
   Reading ``os.environ`` directly diverges: a contributor whose key
   lives in ``.env`` sees ``KeyError`` errors when they try to run
   the live suite.

   The bug was reported by a real contributor in the field after the
   Wave 2 PR landed: 24 errors + 7 false-positive guardrail failures
   on a working ``.env`` setup.  This regression test is the durable
   fix.

   The single allowed exception is ``judge.py``'s
   ``_settings_api_key`` helper, which intentionally falls back to
   ``os.environ`` when the app settings layer can't import (preserves
   the leaf-utility property the docstring documents).

2. **No path-substring matching that breaks on Windows.**  The live
   conftest's auto-skip originally used ``"tests/live" in str(item.fspath)``
   to filter items.  That works on Linux (paths use ``/``) but
   silently fails on Windows (paths use ``\\``), letting every live
   test run with the parent-conftest dummy API key (when ``TEST_MODE``
   was still around it became ``"test-mode-no-key"``) and producing
   31 confusing 401s.  The production fix uses
   ``pathlib.Path(...).parts`` to compare path segments — this
   regression test forbids the substring pattern from re-appearing
   on any path that contains the ``"tests/live"`` segment, in any
   OS-style spelling, in any file under ``tests/live/``.
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
_BAD_OS_ENVIRON_PATTERN = re.compile(
    r"""(?<!`)os\.environ(?:\.get)?\s*[\[(]\s*['"]ANTHROPIC_API_KEY['"]"""
)

# Match path-substring checks like ``"tests/live" in str(item.fspath)``
# or ``"tests/live" in path``. The Windows-broken pattern uses a
# forward slash inside the substring; ``pathlib.Path.parts`` is the
# OS-agnostic alternative.  Negative lookbehind on backtick (same
# rationale as above) so docstrings quoting the rule don't trip it.
_BAD_PATH_SUBSTRING_PATTERN = re.compile(
    r"""(?<!`)['"]tests/live['"]\s+in\s+"""
)

# Files allowed to contain a bad pattern. Each entry includes the
# rationale so a future contributor doesn't blanket-allowlist a new
# violator.
_ALLOWED = {
    # ``judge.py`` is documented as a leaf utility usable without the
    # app settings layer. Its ``_settings_api_key`` helper tries
    # Settings first and only falls back to ``os.environ`` when the
    # import fails — that fallback is the documented escape hatch.
    "judge.py",
    # ``conftest.py`` is fixture infrastructure, not a test. It owns
    # the env-state dance that bridges the parent-conftest dummy key
    # to a real ``.env``-loaded key for live runs. The bug this test
    # guards is "a TEST FILE reads ``os.environ`` instead of going
    # through Settings", which is a different code path.
    "conftest.py",
}


def _grep_live_dir(pattern: re.Pattern[str]) -> list[tuple[str, int, str]]:
    """Source-grep every ``*.py`` under ``tests/live/`` for ``pattern``.

    Skips files in ``_ALLOWED``.  Returns a list of ``(relative path,
    line number, stripped line text)`` tuples — empty list means
    clean.  Used by both the os.environ check and the path-substring
    check so the file-walking logic stays in one place.
    """

    live_dir = pathlib.Path(__file__).parent / "live"
    hits: list[tuple[str, int, str]] = []
    for path in live_dir.rglob("*.py"):
        if path.name in _ALLOWED:
            continue
        text = path.read_text(encoding="utf-8")
        for lineno, line in enumerate(text.splitlines(), start=1):
            if pattern.search(line):
                hits.append((str(path.relative_to(live_dir)), lineno, line.strip()))
    return hits


def test_no_direct_os_environ_anthropic_api_key_in_tests_live() -> None:
    """Source-grep ``backend/tests/live/`` for the bad pattern.

    Why this test exists: the production code reads the API key via
    ``Settings.anthropic_api_key`` so a ``.env`` file (loaded by the
    live conftest's ``_load_project_root_dotenv``) is honored.
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

    hits = _grep_live_dir(_BAD_OS_ENVIRON_PATTERN)
    assert not hits, (
        "Direct ``os.environ`` access of ``ANTHROPIC_API_KEY`` found "
        "in tests/live/ — the production code uses pydantic-settings "
        "(``Settings.anthropic_api_key``) which reads BOTH shell env "
        "vars AND a project-root ``.env`` file (the live conftest "
        "loads it explicitly). Reading ``os.environ`` directly "
        "diverges: a contributor with the key in ``.env`` will see "
        "``KeyError`` even though the application boots cleanly.\n\n"
        "Replace with:\n"
        "    settings = get_settings()\n"
        "    settings.require_anthropic_key()  # for the api_key param\n\n"
        "Hits:\n"
        + "\n".join(f"  {path}:{ln} → {body}" for path, ln, body in hits)
    )


def test_no_forward_slash_path_substring_matching_in_tests_live() -> None:
    """Source-grep ``backend/tests/live/`` for ``"tests/live" in …``
    style path-substring checks.

    Why this test exists: the live conftest's auto-skip originally
    used ``"tests/live" in str(item.fspath)`` to filter items.  That
    works on Linux (path separator is ``/``) but silently fails on
    Windows (path separator is ``\\``), letting every live test run
    with the placeholder ``"test-mode-no-key"`` API key and produce
    31 confusing 401s in the field.  Caught only because a Windows
    contributor reported it; CI ran on Linux and never noticed.

    To resolve a fail: use ``pathlib.Path(...).parts`` and compare
    path segments instead of doing substring matching with a hard-
    coded separator.  See ``conftest.py::pytest_collection_modifyitems``
    for the canonical pattern.
    """

    hits = _grep_live_dir(_BAD_PATH_SUBSTRING_PATTERN)
    assert not hits, (
        'Forward-slash path-substring matching (``"tests/live" in …``) '
        "found in tests/live/. This pattern silently fails on Windows "
        "where path separators are ``\\``, letting code that should "
        "have been filtered run instead. The auto-skip in the live "
        "conftest was originally written this way and let live tests "
        "run with the dummy unit-test API key, producing 401s in the "
        "field.\n\n"
        "Replace with:\n"
        "    parts = pathlib.Path(str(item.fspath)).parts\n"
        '    if "tests" in parts and "live" in parts: ...\n\n'
        "Hits:\n"
        + "\n".join(f"  {path}:{ln} → {body}" for path, ln, body in hits)
    )
