# Copilot code review instructions

Review the diff and report **issues only** — no praise, no summaries. Format:

`[SEVERITY] file:line — issue — fix`

Severities: **BLOCK** (must fix), **HIGH** (this PR), **MEDIUM** (soon), **LOW** (nit). Skip below LOW. Clean category → say "clean".

Be specific. Quote the offending line. Group findings with one root cause. Path-specific rules in `.github/instructions/` also apply.

## 1. Correctness
- Off-by-one, null/undefined, unhandled empty cases, inverted conditions
- Race conditions, missing `await`, shared mutable state
- Swallowed exceptions, bare `except`, retries without backoff
- Resource leaks (unclosed files/sockets, missing `with`/`using`)

## 2. Security
- Injection: SQL, command, shell, XSS, template, **prompt injection** — any user/model output flowing back into a prompt or tool call
- AuthN/AuthZ: missing checks, IDOR (fetching by id without owner check), trust-boundary violations
- Secrets in code, logs, URLs, or env files
- Boundary input validation (HTTP, WS, file upload, deserialization); SSRF; path traversal; open redirect
- Crypto: weak hashes, MD5/SHA1 for security, non-constant-time compare, predictable randomness for security
- CORS, CSRF, missing rate limits on expensive endpoints, unbounded request bodies
- New deps: known CVEs, >12mo unmaintained, copyleft license — **BLOCK** without justification in the PR body

## 3. Code smells
- Duplicated logic (>3 similar blocks), long functions (>~50 lines), nesting >3, god objects
- Magic numbers/strings, dead code, commented-out code, unused imports
- Premature abstraction (interface with one impl), speculative generality
- Dense one-liners, nested ternaries, regex without explanation
- Comments restating *what* instead of *why*; comments referencing the current task/PR (rot fast)
- Inconsistent naming; mixed I/O + logic + formatting in one function
- Backwards-compat shims for code with no callers; `_var` renames for "unused" params; `// removed` placeholders

## 4. Performance
- N+1 queries, missing indexes implied by new query patterns, full-table scans
- Blocking I/O on async paths, sync calls inside loops, missing pagination
- Unbounded loops/recursion, O(n²) over user-controlled n, large in-memory accumulations

## 5. API & contract
- Breaking changes to public APIs/types/DB schema without migration path
- Inconsistent error shapes, missing status codes, internals leaking in error messages
- New endpoints missing auth, validation, or rate limiting

## 6. Tests
- New logic without tests; happy-path-only coverage; missing negative/edge cases
- Tests asserting implementation instead of behavior; flaky time/random/network deps
- Snapshot tests committed without reviewing the snapshot
- Skipped tests (`@pytest.mark.skip`, `it.skip`) without a tracking issue

## 7. Observability
- New external call without start/end log line at the boundary
- Swallowed exception without log
- Log line missing IDs needed to debug it (`request_id`, `session_id`, `role_id`, `turn_id`)
- Logging secrets, tokens, full payloads, or PII
- Frontend `console.*` without a `[module]` prefix

## 8. Docs & migrations
- Public API/behavior change without README/CHANGELOG/comment update
- DB migration without rollback or without considering existing rows
- New env var added without entry in `docs/configuration.md`

## 9. PR body
- Comma-list closing keyword (`Closes #1, #2, #3`) — only `#1` auto-closes. Repeat per issue.
- Closing keyword next to an issue number you don't want to close (negation, rhetorical question) → **BLOCK**. GitHub's parser ignores surrounding context.
