# LLM providers

Crittable routes every LLM call through **LiteLLM**, supporting ~100
providers natively (Azure OpenAI, AWS Bedrock, Vertex AI, OpenRouter,
OpenAI-direct, Together, Groq, vLLM/Ollama, …). The implementation
lives at
[`backend/app/llm/clients/litellm_client.py`](../backend/app/llm/clients/litellm_client.py)
and satisfies the `ChatClient` ABC at
[`backend/app/llm/protocol.py`](../backend/app/llm/protocol.py); code
outside `app/llm/` doesn't know or care which provider is configured.

## Quick selection guide

| You want… | Use |
|---|---|
| Anthropic (the simple, default case) | `LLM_API_KEY=sk-ant-...` (default model is Claude) |
| Anthropic via your own gateway/proxy | `LLM_API_KEY=sk-ant-...` + `LLM_API_BASE=https://your-gateway/...` |
| Azure OpenAI / AWS Bedrock / Vertex / OpenRouter / OpenAI direct | per-tier model id (see "Configuring per-tier models" below) |
| Local LLM (Ollama, vLLM) | `LLM_MODEL_*=ollama/...` + `LLM_API_BASE=http://ollama:11434` |

Per-tier model + sampling overrides are documented in
[`configuration.md`](configuration.md). Every LLM call resolves
`max_tokens` / `temperature` / `top_p` from the tier defaults at request
time, so a single env var change takes effect on the next turn — no
restart for sampling tweaks.

---

## Configuring per-tier models

LiteLLM model ids look like `<provider>/<bare-name>`. For Anthropic, the
``anthropic/`` prefix is auto-applied to bare ``claude-...`` names; for
other providers, set the fully-qualified id explicitly:

```bash
LLM_API_KEY=sk-ant-...               # used for any anthropic/ tier

# Per-tier overrides (optional). Bare claude- names auto-prefix with
# anthropic/; other providers use the full id.
LLM_MODEL_PLAY=claude-sonnet-4-6                    # → anthropic/claude-sonnet-4-6
LLM_MODEL_AAR=bedrock/anthropic.claude-opus-4-7-20251101-v1:0
LLM_MODEL_GUARDRAIL=openai/gpt-4o-mini
LLM_MODEL_SETUP=vertex_ai/claude-sonnet-4-6
```

The first-class providers we recognize are: `anthropic`, `bedrock`,
`vertex_ai`, `azure`, `openai`, `openrouter`, `openai_like`, `ollama`,
`vllm`. Adding a new prefix requires editing
[`_KNOWN_PROVIDER_PREFIXES`](../backend/app/llm/clients/litellm_client.py)
and documenting the deployment recipe here. Bare model ids that don't
match `claude-...` are rejected at startup with a clear error directing
the operator to set the fully-qualified form.

`LLM_API_BASE` is forwarded to LiteLLM as `api_base` — use any
OpenAI-compatible / Anthropic-compatible / provider-native endpoint.
`None` (default) lets the provider default win.

`LLM_TIMEOUT_S` is the per-request timeout in seconds (default `600`).
Per-tier overrides live in `LLM_TIMEOUT_<TIER>` and are applied via
LiteLLM's per-call `timeout=` kwarg.

## API keys for non-Anthropic providers

Each provider reads its own env var. The engine forwards `LLM_API_KEY`
to LiteLLM **only** when the wire model targets the `anthropic/`
family; for every other provider the engine omits the `api_key` kwarg
and lets LiteLLM auto-discover the provider-native credential at call
time. This keeps an Anthropic key from ever being shipped to OpenAI's
auth endpoint on the first `LLM_MODEL=openai/...` deploy.

The startup gate in `app/main.py` mirrors this: it requires
`LLM_API_KEY` only when at least one tier targets `anthropic/...`. A
deployment that routes only to non-Anthropic providers boots without
`LLM_API_KEY` set at all.

| Provider | Env var | Notes |
|---|---|---|
| Anthropic | `LLM_API_KEY` | Required when any tier is `anthropic/...`; LiteLLM gets it explicitly |
| OpenAI | `OPENAI_API_KEY` | LiteLLM auto-discovers. Model ids must be **fully qualified** (e.g. `openai/gpt-4.1`, not bare `gpt-4.1`) — bare names fail at first call with a clear error directing you to add the prefix. |
| Azure OpenAI | `AZURE_API_KEY` + `AZURE_API_BASE` + `AZURE_API_VERSION` | LiteLLM auto-discovers. Use `azure/<deployment-name>`. |
| AWS Bedrock | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION_NAME` | Or IAM role / instance profile. Use `bedrock/<model-id>`. |
| Vertex AI | `GOOGLE_APPLICATION_CREDENTIALS` (JSON path) | LiteLLM auto-discovers. Use `vertex_ai/<model>`. |
| OpenRouter | `OPENROUTER_API_KEY` | LiteLLM auto-discovers. Use `openrouter/<vendor>/<model>`. |
| Ollama / vLLM | `LLM_API_BASE` (treated as `api_base`) | Local; no auth. Use `ollama/<model>` or `vllm/<model>`. |

## Safety hardening

The LiteLLM backend zeroes every callback registry the library reads at
completion time and disables phone-home telemetry — see the module
docstring at
[`backend/app/llm/clients/litellm_client.py`](../backend/app/llm/clients/litellm_client.py)
for the full list. This prevents a stray `LANGSMITH_API_KEY` or
`HELICONE_API_KEY` in a contributor's `.env` from silently exporting
prompts + participant chat to a third-party SaaS we don't operate. If
you have a legitimate logging need (your own ops dashboard), wire it
through `structlog` from the `llm.clients.litellm` logger rather than
re-enabling LiteLLM callbacks.

`LITELLM_MODE=PRODUCTION` is set before `import litellm` so the
library's import-time `dotenv.load_dotenv()` is skipped — operators
who want LiteLLM to load a `.env` should do it explicitly via their
process manager / docker-compose config.

## Validated providers

The full live-test suite (50/50 tests) passes against Anthropic via
LiteLLM. For other providers we've smoke-tested the wire-format
translator (tool format, streaming, cache_control passthrough) but
you should expect to validate your specific deployment yourself —
different providers have different quirks around tool-use semantics
and prompt caching.

## Local-only setup (no internet)

```bash
LLM_MODEL_PLAY=ollama/qwen2.5:32b-instruct-q5_K_M
LLM_MODEL_AAR=ollama/qwen2.5:32b-instruct-q5_K_M
LLM_MODEL_GUARDRAIL=ollama/qwen2.5:7b-instruct-q5_K_M
LLM_API_BASE=http://ollama:11434
# LLM_API_KEY not needed — Ollama is unauthenticated and the engine
# only forwards LLM_API_KEY when the wire model targets anthropic/.
```

Caveats:

- Tool-use fidelity drops off on smaller models. `qwen2.5:32b-instruct`
  and `llama3.3:70b-instruct` are reasonable starting points; sub-7B
  models tend to fail `set_active_roles` reliably.
- Prompt caching is a no-op for non-Anthropic backends, so the system
  prompt is re-tokenised every turn — cost rises linearly with turn
  count. Consider lowering `MAX_TURNS_PER_SESSION`.
- The strict-retry path expects `tool_choice` enforcement; not every
  model implementation honours it. If you see force-advance loops on
  a local model, that's almost always why.

## Verifying a swap

After changing models:

1. Hit `/healthz` then create a session and use **Dev mode** to skip
   setup.
2. Watch the docker logs for `llm_call_start` / `llm_call_complete`
   (one pair per call). Model id, per-tier `max_tokens` /
   `temperature` / `top_p`, and token usage are all logged.
3. Run a 2-role exercise end-to-end. The strict-retry test
   (`backend/tests/test_e2e_session.py::test_strict_retry_*`) is the
   best signal that tool-use enforcement is working through whichever
   provider you've chosen.

## Cost tracking

LiteLLM's ``prompt_tokens`` (OpenAI convention) is decomposed into its
non-cached portion + cache reads + cache writes inside
``_usage_to_normalized_dict`` so reporting is consistent with
Anthropic's native four-key shape (`input` / `output` / `cache_read` /
`cache_creation`). All four route through `app.llm._shared.compute_cost_usd`
which reads `litellm.cost_per_token` so pricing stays accurate across
provider rate changes. Without this normalization, warm-cache calls
would show ~10× higher cost — locked by
`tests/test_litellm_translators.py::test_from_response_warm_cache_subtracts_cache_read_from_input`.

## Streaming caveats (read before adding a new `astream` call site)

`ChatClient.astream(...) -> AsyncIterator[dict]` emits these events:

| event | reliability | what it carries |
|---|---|---|
| `text_delta` | ✓ reliable (content fidelity not contracted — see below) | `text` chunk |
| `tool_use_start` | ✓ best-effort, function name only | tool `name` |
| `complete` | ✓ terminal, carries `LLMResult` | final assembled result |

The terminal `complete` event is the durable contract. Mid-stream
events are useful as **early signals** (e.g. fanning out a "setup is
drafting the plan" indicator before the 10–30 s call returns) but are
**not safe sources of content**.

### The `input_json_delta` minefield

When a model streams a `tool_use` block, the JSON arguments arrive as
fragmented deltas. Hand-accumulating these is known to break — lost
characters across chunk boundaries, malformed JSON, encoding edge
cases, partial-codepoint splits — and **the LiteLLM translator
deliberately does not attempt it**. Tool-call deltas are dropped
mid-stream; the partial JSON accumulates inside LiteLLM via
`stream_chunk_builder` which we call at end-of-stream, and the
assembled `ModelResponse` runs through the same `_from_litellm_response`
translator as `acomplete`. Net result: a streamed response and a
non-streamed response produce **identical `LLMResult` shapes
downstream**.

Consequence: **tool args / IDs / inputs are unavailable until the
`complete` event fires**.

### Streaming is a typing pulse, not a content channel

`Play.tsx` and `Facilitator.tsx` explicitly **ignore `text_delta`
content** — they're used purely as a "model is still alive" signal
that flips `setStreamingActive(true)`. The actual text gets rendered
from the snapshot refresh after `message_complete`. This is
load-bearing: it lets the LiteLLM translator skip mid-stream text
fidelity (which would otherwise diverge across providers) and still
land identical UI output. **Do not add a frontend code path that
treats mid-stream `text_delta` content as ground truth.**

### What's safe to use mid-stream

| Use case | OK? | Notes |
|---|---|---|
| "Is the model still alive?" pulse | ✓ | Text or tool deltas, count is the signal. |
| "Has the model committed to tool X?" early signal | ✓ best-effort | LiteLLM degrades to "no early signal" on providers that don't surface the function name in chunk-form (Bedrock variants, some self-hosted). |
| Reading a tool call's `input` (args) | ✗ — wait for `complete` | Even on Anthropic-via-LiteLLM, args are unavailable until terminal. |
| Reading a tool call's `id` | ✗ — wait for `complete` | Same. |
| Streaming chat text to the user | use `complete`'s text | The frontend re-renders from the snapshot after `message_complete`; mid-stream text is discarded. |
| Distinguishing "tool A vs tool B" mid-stream | ✓ best-effort at `tool_use_start` | LiteLLM may simply not fire one. |
| Counting tool calls mid-stream | best-effort | Same caveat as above. |

### `tool_use_start` event details

Mid-stream the client emits `{"type": "tool_use_start", "name": <str>}`
the first time a given tool block is observed in the stream:

- Derived best-effort from the first chunk that surfaces a non-empty
  `function.name` for a given `tool_calls[i]` index.
- Wrapped in `try/except` per chunk so a misshapen delta never breaks
  the stream itself.
- Deduped via `seen_tool_names` in case a provider re-emits the same
  name across chunks.
- **Provider variability**: OpenAI, Anthropic-via-LiteLLM, and most
  OpenAI-compat gateways emit the function name in the first chunk
  for a tool call. Some Bedrock model variants and a few self-hosted
  endpoints assemble the entire tool call only in
  `stream_chunk_builder` at end-of-stream — those produce **no
  `tool_use_start` event mid-stream**, just the terminal `complete`.
  Callers must treat the absence as "no early signal," not "no tool
  call."

### Engine-side rule of thumb for new astream call sites

1. **The `complete` event is the contract.** Anything that affects
   correctness — tool args, IDs, the dispatcher tool_uses list, the
   `LLMResult` shape — must read from `complete`, not from mid-stream
   events.
2. **Mid-stream events are for UX, not state.** OK to fan out a "what
   is the AI doing?" indicator from `tool_use_start`. Not OK to
   advance session state from one.
3. **Plan for the "no event" path.** If your feature *needs*
   `tool_use_start` to fire on every tool call, you've coupled to a
   subset of providers. Have a fallback that reaches the same UX
   outcome when no early signal arrives (typically: a generic "AI is
   thinking" indicator that escalates after some elapsed time).
4. **Don't accumulate `input_json_delta` yourself.** Read
   `_from_litellm_response` first; the translator already has the
   bug-free path. If you genuinely need streamed args, the answer is
   probably "switch this code path to non-streaming `acomplete`," not
   "DIY the delta accumulation."

### Current astream call sites

| Call site | Failure mode if `tool_use_start` doesn't fire |
|---|---|
| `TurnDriver.run_play_turn` | N/A — doesn't read `tool_use_start`. |
| `TurnDriver.run_setup_turn` | Banner falls back to small "AI is typing" dots — same UX as before the early-signal hookup, no functional regression. |

If you add a new astream call site, add a row here.

## Why this matters

Operators have varying constraints — air-gapped networks, regional
data-residency rules, vendor-diversity mandates, model-family
preferences, existing contractual relationships. Routing every call
through LiteLLM covers:

- **The 95% case**: stick with the default, point at Anthropic.
- **The "we have an Anthropic-shaped proxy" case**: `LLM_API_BASE`.
- **The "approved AI vendor isn't Anthropic-direct" case**: set the
  per-tier provider id.
