#!/usr/bin/env bash
# Run backend/tests/live/ against the real Anthropic API.
#
# Bridges a harness-namespaced key into the pytest subprocess only, so
# this works inside the Claude Code agent harness without shadowing the
# host process's ANTHROPIC_API_KEY (which would break Claude Code's own
# SDK auth). See CLAUDE.md -> "Never shadow ANTHROPIC_* in the agent
# harness" for the full rationale.
#
# Usage:
#   backend/scripts/run-live-tests.sh                              # full suite
#   backend/scripts/run-live-tests.sh -k test_aar                  # filter
#   backend/scripts/run-live-tests.sh tests/live/test_aar_generation.py -v
#
# Key resolution order:
#   1. $LIVE_TEST_ANTHROPIC_API_KEY  (harness-safe namespace; preferred)
#   2. $ANTHROPIC_API_KEY            (local-dev fallback)

set -euo pipefail

key="${LIVE_TEST_ANTHROPIC_API_KEY:-${ANTHROPIC_API_KEY:-}}"
if [[ -z "${key}" ]]; then
  echo "error: neither LIVE_TEST_ANTHROPIC_API_KEY nor ANTHROPIC_API_KEY is set." >&2
  echo "       In the Claude Code harness, set LIVE_TEST_ANTHROPIC_API_KEY (NOT" >&2
  echo "       ANTHROPIC_API_KEY -- that name shadows the harness's own SDK auth)." >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backend_dir="$(dirname "${script_dir}")"
cd "${backend_dir}"

if [[ $# -eq 0 ]]; then
  set -- tests/live/ -v
fi

# Scope the assignment to this single child process; the parent shell
# (and the harness process tree above it) never sees ANTHROPIC_API_KEY.
ANTHROPIC_API_KEY="${key}" exec pytest "$@"
