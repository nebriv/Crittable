# LLM providers

> **Don't manage your own LLM gateway?** You can ignore this page. The
> default — set `ANTHROPIC_API_KEY` and the engine talks to Anthropic
> directly — is the right choice for ~95% of operators.
>
> This page is for: ops teams who want the engine to talk to Bedrock /
> Vertex / OpenRouter / a self-hosted gateway / a local Ollama server.
> All of those are reachable via a single env var (`ANTHROPIC_BASE_URL`)
> + a translating proxy (typically `litellm`).

The engine talks to Anthropic via the official `anthropic.AsyncAnthropic` SDK.
Two env knobs let you point it elsewhere without code changes:

| Var | Effect |
|---|---|
| `ANTHROPIC_BASE_URL` | Forwarded to `AsyncAnthropic(base_url=…)`. Use with any Anthropic-compatible endpoint. `None` (default) hits `https://api.anthropic.com`. |
| `ANTHROPIC_TIMEOUT_S` | Per-request timeout in seconds. Default `600` (matches the SDK default for long AAR generations). |

Per-tier model + sampling overrides are documented in
[`configuration.md`](configuration.md). Every LLM call resolves
`max_tokens` / `temperature` / `top_p` from the tier defaults at request
time, so a single env var change takes effect on the next turn — no
restart for sampling tweaks.

## Tested-good Anthropic-compatible endpoints

These all speak the Anthropic Messages API; just point `ANTHROPIC_BASE_URL`
at them, keep the rest of the config the same, and supply the appropriate
key in `ANTHROPIC_API_KEY`.

### LiteLLM proxy (Bedrock / Vertex / OpenAI / Ollama under one roof)

Run `litellm` as a proxy and configure model aliases in `litellm_config.yaml`:

```yaml
model_list:
  - model_name: claude-sonnet-4-6
    litellm_params:
      model: bedrock/anthropic.claude-sonnet-4-6-20251001-v2:0
      aws_region_name: us-west-2
  - model_name: claude-opus-4-7
    litellm_params:
      model: bedrock/anthropic.claude-opus-4-7-20251101-v1:0
      aws_region_name: us-west-2
```

Then:

```bash
ANTHROPIC_BASE_URL=http://litellm:4000
ANTHROPIC_API_KEY=sk-litellm-master-key
ANTHROPIC_MODEL_PLAY=claude-sonnet-4-6
ANTHROPIC_MODEL_AAR=claude-opus-4-7
```

LiteLLM normalizes tool-use blocks across providers so Anthropic-style
tool calls keep working when the underlying model is, say, OpenAI. The
guardrail tier is the easiest to test against an alternate provider —
short prompt, deterministic output.

### OpenRouter (Anthropic-compat)

OpenRouter exposes an Anthropic-shaped endpoint at
`https://openrouter.ai/api/v1`:

```bash
ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1
ANTHROPIC_API_KEY=sk-or-v1-…
ANTHROPIC_MODEL_PLAY=anthropic/claude-sonnet-4-6
```

### Self-hosted Anthropic-compatible

If you run an internal Anthropic-shaped gateway (auth proxy, request
shaper, etc.), point `ANTHROPIC_BASE_URL` at it. The engine will pass
the same headers + JSON shape as the public SDK. Most popular gateways
(`anthropic-proxy`, `anthropic-shaped-router`, `litellm`) are
drop-in.

## What is **not yet** supported (Phase 3 roadmap)

The engine assumes:
* Anthropic Messages API shape (`system` blocks, `tool_use` content
  blocks, `cache_control` ephemeral breakpoints).
* Per-call `max_tokens`, `temperature`, `top_p` knobs.
* Server-Sent Events streaming with the `content_block_delta` /
  `text_delta` event types from the SDK.

Native non-Anthropic backends (vanilla OpenAI Chat Completions,
local-only Ollama / vLLM with no proxy, Vertex direct) require a thin
adapter that maps:

* `anthropic.system` blocks → OpenAI `role: system` messages
* `anthropic.tools` → OpenAI `tools` (similar shape) or function-call
* `anthropic.tool_use` content blocks → OpenAI `tool_calls`
* Streaming SSE events
* Prompt cache breakpoints (no-op for non-Anthropic)

Phase 3 plans an `LLMProvider` Protocol so the engine can depend on a
common interface and load the concrete adapter from env. Until then,
front the alternate provider with a translating proxy (`litellm` is the
zero-effort path).

## Local-only setup (no internet)

Recommended path: run [Ollama](https://ollama.ai) → front it with
`litellm` → point `ANTHROPIC_BASE_URL` at the proxy. The engine will
think it's talking to Anthropic; `litellm` translates to/from Ollama.

```yaml
# litellm_config.yaml
model_list:
  - model_name: claude-sonnet-4-6
    litellm_params:
      model: ollama_chat/qwen2.5:32b-instruct-q5_K_M
      api_base: http://ollama:11434
  - model_name: claude-haiku-4-5
    litellm_params:
      model: ollama_chat/qwen2.5:7b-instruct-q5_K_M
      api_base: http://ollama:11434
```

Caveats:

* Tool-use fidelity drops off on smaller models. Quality is highly
  model-dependent — `qwen2.5:32b-instruct` and `llama3.3:70b-instruct`
  are reasonable starting points; sub-7B models tend to fail
  `set_active_roles` reliably.
* Prompt caching is a no-op (the cache_control hint is dropped by
  litellm for non-Anthropic backends), so the system prompt is
  re-tokenised every turn — cost rises linearly with turn count.
  Consider lowering `MAX_TURNS_PER_SESSION`.
* The strict-retry path expects `tool_choice` enforcement; not every
  model implementation honors it. If you see force-advance loops on a
  local model, that's almost always why.

## Verifying a swap

After changing `ANTHROPIC_BASE_URL`:

1. Hit `/healthz`, then create a session and use **Dev mode** to skip
   setup.
2. Watch the docker logs for `anthropic_base_url_override` — should
   appear once when the SDK is first lazily constructed.
3. Watch for `llm_call_start` / `llm_call_complete` events — model id
   and per-tier `max_tokens` / `temperature` / `top_p` are logged.
4. Run a 2-role exercise end-to-end. The strict-retry test
   (`backend/tests/test_e2e_session.py::test_strict_retry_*`) is the
   best signal that tool-use enforcement is working through the proxy.

## Why this matters

Operators have varying constraints — air-gapped networks, regional
data-residency rules, vendor-diversity mandates, model-family
preferences. The base-URL override is the smallest possible knob that
covers the 80% case (a translating proxy is one container away). Phase
3 will land first-class non-Anthropic providers when the team commits
to a target.
