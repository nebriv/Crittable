# Extensions

Skills-style customization. Operators can register custom **tools**, **resources**, and **prompts** that Claude has access to during a session. In MVP these are loaded once at app startup from environment variables. In Phase 3 the same registry is fed by a UI editor, a database loader, and an MCP-bridge loader without any change to the registry contract.

> **Phase 1 status:** registries and loaders are not yet implemented; this page is the contract Phase 2 must satisfy. See [`PLAN.md`](PLAN.md) § Extensions.

## Concepts

### `ExtensionTool`
A custom tool the AI facilitator can call.

```jsonc
{
  "name": "lookup_threat_intel",
  "description": "Look up a simulated threat-intel record for an IOC.",
  "input_schema": {
    "type": "object",
    "properties": { "ioc": { "type": "string" } },
    "required": ["ioc"]
  },
  "handler_kind": "templated_text",
  "handler_config": "Threat intel for {{ args.ioc }}: simulated TLP:AMBER, last seen 2026-04-12 in {{ session.industry }}."
}
```

`handler_kind`:
- `static_text` — `handler_config` is a fixed string returned verbatim.
- `templated_text` — `handler_config` is a Jinja template; rendered with `args` (tool input) and a minimal `session` context (industry, roster size, beat number — no PII, no transcript).

No code execution, no network calls in MVP. Phase 3 adds `webhook` and `python_entrypoint` handlers behind the same interface.

### `ExtensionResource`
Reusable content surfaced via the `lookup_resource(name)` built-in tool — Claude pulls them on demand instead of bloating every system prompt.

```jsonc
{
  "name": "ir_runbook_excerpt",
  "description": "First three steps of our IR runbook.",
  "content": "1. Triage in SOC ticket. 2. Page on-call IR. 3. ..."
}
```

### `ExtensionPrompt`
A reusable prompt fragment.

```jsonc
{
  "name": "fedramp_focus",
  "description": "Bias the facilitator toward FedRAMP compliance considerations.",
  "scope": "system",
  "body": "When scoring decisions, weight FedRAMP impact and 800-53 control alignment heavily."
}
```

`scope`:
- `system` — appended to the system prompt block when the creator opts in during setup.
- `snippet` — available for any participant to inject into their next message via the UI (Phase 2 wires the snippet picker; Phase 1 stub).

## Loading (MVP)

Set one of the `EXTENSIONS_*_JSON` (inline) or `EXTENSIONS_*_PATH` (file path) env vars. JSON is a list of objects matching the schemas above. Both forms accepted; inline wins if both set.

```bash
docker run --rm -p 8000:8000 \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e EXTENSIONS_TOOLS_JSON='[{"name":"lookup_threat_intel","description":"...","input_schema":{...},"handler_kind":"static_text","handler_config":"sim TLP:AMBER"}]' \
  ghcr.io/nebriv/ai-tabletop-facilitator:latest
```

`GET /api/extensions` lists what was successfully registered. Validation errors fail-fast at startup and are logged with the offending entry.

## Security model — read this before authoring

Extensions are **operator-trusted** (you put them there) but their *content* is still untrusted text from Claude's perspective. The implementation enforces:

1. **Tool results, not system content.** Extension output is delivered to Claude only as `tool_result`-role content. It never gets concatenated into the system prompt.
2. **No code execution in MVP.** Only declarative handlers (`static_text`, `templated_text`). A malicious template cannot exfiltrate data or make outbound calls.
3. **Sandboxed templating.** The Jinja environment has no autoescape disabled, no filesystem loader, no `import`, no `tojson`-style filters that could leak Python state.
4. **Schema validation on input.** Tool args are validated against `input_schema` before the handler sees them.
5. **Audit logged.** Every extension invocation is recorded to the audit log and surfaced in the AAR.

When authoring `templated_text` handlers, **do not** include instructions like "ignore previous rules" — Claude will still see them, and the system prompt's hard boundaries will refuse, but it wastes a turn. Treat handler content like documentation: factual, neutral, scoped to what the tool returns.

## Phase 3 expansions (placeholders)

- `DBLoader` — registry pulled from a database, hot-reloadable per session.
- `UILoader` — creator authors extensions in the app at session-create time.
- `MCPLoader` — bridge to MCP servers; tools and resources from the MCP server appear as `ExtensionTool` / `ExtensionResource`.
- New `handler_kind`s: `webhook` (operator-trusted HTTPS callback), `python_entrypoint` (operator-installed plugin module).
