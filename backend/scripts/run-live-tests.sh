#!/usr/bin/env bash
# Run backend/tests/live/ against the live LLM provider (Anthropic
# by default, or whichever provider you've set via LLM_MODEL_<TIER>).
#
# Bridges a harness-namespaced key into the pytest subprocess only.
# Setting ``LLM_API_KEY`` directly at the Claude Code session level is
# now safe (the rename in #193 moved off the SDK-auto-discovery
# namespace), but the bridge stays as a convention so contributors
# don't have to think about which env vars are safe vs. shadowing.
# See CLAUDE.md -> "Live-test API key handling".
#
# Usage:
#   backend/scripts/run-live-tests.sh                              # full suite
#   backend/scripts/run-live-tests.sh -k test_aar                  # filter
#   backend/scripts/run-live-tests.sh tests/live/test_aar_generation.py -v
#
# Key resolution order:
#   1. $LIVE_TEST_LLM_API_KEY  (harness convention; preferred)
#   2. $LLM_API_KEY            (local-dev fallback)

set -euo pipefail

key="${LIVE_TEST_LLM_API_KEY:-${LLM_API_KEY:-}}"
if [[ -z "${key}" ]]; then
  echo "error: neither LIVE_TEST_LLM_API_KEY nor LLM_API_KEY is set." >&2
  echo "       In the Claude Code harness, prefer LIVE_TEST_LLM_API_KEY" >&2
  echo "       to keep the harness/runtime split obvious." >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backend_dir="$(dirname "${script_dir}")"
cd "${backend_dir}"

if [[ $# -eq 0 ]]; then
  set -- tests/live/ -v
fi

# Scope the assignment to this single child process. With the post-#193
# rename, ``LLM_API_KEY`` doesn't collide with any provider SDK's
# auto-discovery namespace, so this is purely a convention.
LLM_API_KEY="${key}" exec pytest "$@"
