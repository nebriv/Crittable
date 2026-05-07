# LLM providers

Crittable supports two LLM-routing backends, selected at startup via
the `LLM_BACKEND` env var:

| Backend | Selector | Provider reach |
|---|---|---|
| **Anthropic-direct** *(default)* | `LLM_BACKEND=anthropic` | Anthropic API + any Anthropic-compatible endpoint via `LLM_API_BASE` |
| **LiteLLM-routed** *(multi-provider)* | `LLM_BACKEND=litellm` | ~100 providers natively (Azure OpenAI, AWS Bedrock, Vertex AI, OpenRouter, OpenAI-direct, Together, Groq, vLLM/Ollama via LiteLLM, …) |

Both speak the same internal contract (`ChatClient` ABC at
[`backend/app/llm/protocol.py`](../backend/app/llm/protocol.py)) so
downstream code — turn driver, dispatch, AAR generator, guardrail —
doesn't know which backend is in use. Provider-specific clients adapt
at the wire boundary.

## Quick selection guide

| You want… | Use |
|---|---|
| Anthropic-direct (the simple, default case) | `LLM_BACKEND=anthropic` (or unset) + `LLM_API_KEY` |
| Anthropic via your own gateway/proxy | `LLM_BACKEND=anthropic` + `LLM_API_KEY` + `LLM_API_BASE=https://your-gateway/...` |
| Azure OpenAI / AWS Bedrock / Vertex / OpenRouter / OpenAI direct | `LLM_BACKEND=litellm` + per-tier model id (see "LiteLLM backend" below) |
| Local LLM (Ollama, vLLM) | `LLM_BACKEND=litellm` + `LLM_MODEL_*=ollama/...` |

Per-tier model + sampling overrides are documented in
[`configuration.md`](configuration.md). Every LLM call resolves
`max_tokens` / `temperature` / `top_p` from the tier defaults at request
time, so a single env var change takes effect on the next turn — no
restart for sampling tweaks.

---

## Anthropic-direct backend (default)

The engine talks to Anthropic via `anthropic.AsyncAnthropic`. Two env
knobs let you point it elsewhere without leaving the Anthropic-direct
path:

| Var | Effect |
|---|---|
| `LLM_API_BASE` | Forwarded to `AsyncAnthropic(base_url=…)`. Use with any Anthropic-compatible endpoint. `None` (default) hits `https://api.anthropic.com`. |
| `LLM_TIMEOUT_S` | Per-request timeout in seconds. Default `600` (matches the SDK default for long AAR generations). |

### Tested-good Anthropic-compatible endpoints

These all speak the Anthropic Messages API; just point `LLM_API_BASE`
at them, keep the rest of the config the same, and supply the appropriate
key in `LLM_API_KEY`.

#### Anthropic-compat proxy (LiteLLM as a sidecar)

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

```bash
LLM_API_BASE=http://litellm:4000
LLM_API_KEY=sk-litellm-master-key
LLM_MODEL_PLAY=claude-sonnet-4-6
LLM_MODEL_AAR=claude-opus-4-7
```

LiteLLM normalizes tool-use blocks across providers so Anthropic-style
tool calls keep working when the underlying model is, say, OpenAI. The
guardrail tier is the easiest to test against an alternate provider —
short prompt, deterministic output.

### OpenRouter (Anthropic-compat)

OpenRouter exposes an Anthropic-shaped endpoint at
`https://openrouter.ai/api/v1`:

```bash
LLM_API_BASE=https://openrouter.ai/api/v1
LLM_API_KEY=sk-or-v1-…
LLM_MODEL_PLAY=anthropic/claude-sonnet-4-6
```

#### Self-hosted Anthropic-shaped gateway

If you run an internal Anthropic-shaped gateway (auth proxy, request
shaper, regional egress, etc.), point `LLM_API_BASE` at it. Same
headers + JSON shape as the public SDK; most popular gateways
(`anthropic-proxy`, `anthropic-shaped-router`, `litellm` in proxy mode)
are drop-in.

---

## LiteLLM-routed backend

Set `LLM_BACKEND=litellm` and the engine routes every LLM call through
`litellm.acompletion`, supporting ~100 providers natively without a
sidecar. This is the path for enterprise deployments that need:

- **Approved-vendor fit** — Azure OpenAI via Microsoft EA, Bedrock via AWS
  contract, Vertex via GCP contract.
- **Data residency** — Bedrock EU regions, Vertex EU regions,
  Azure-specific regions.
- **Existing-contract reuse** — operators bring their own provider key
  through their own gateway.
- **Air-gapped deployments** — point at an internal `vLLM` or LiteLLM
  gateway via OpenAI-compatible endpoint.

### Configuring per-tier models

LiteLLM model ids look like `<provider>/<bare-name>`. For Anthropic, the
``anthropic/`` prefix is auto-applied to bare ``claude-...`` names; for
other providers, set the fully-qualified id explicitly:

```bash
LLM_BACKEND=litellm
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

### API keys for non-Anthropic providers

Each provider reads its own env var. The engine forwards `LLM_API_KEY`
to LiteLLM **only** when the wire model targets the `anthropic/`
family; for every other provider the engine omits the `api_key` kwarg
and lets LiteLLM auto-discover the provider-native credential at call
time. This keeps an Anthropic key from ever being shipped to OpenAI's
auth endpoint on the first `LLM_BACKEND=litellm LLM_MODEL=openai/...`
deploy.

The startup gate in `app/main.py` mirrors this: it requires
`LLM_API_KEY` when (a) `LLM_BACKEND=anthropic`, or (b)
`LLM_BACKEND=litellm` and any tier targets `anthropic/...`. A LiteLLM
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

### Safety hardening

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

### Validated providers

Every code path is tested live against Anthropic-direct via LiteLLM
(50/50 live tests pass under `LLM_BACKEND=litellm`). For other
providers we've smoke-tested the wire-format translator (tool format,
streaming, cache_control passthrough) but you should expect to validate
your specific deployment yourself — different providers have different
quirks around tool-use semantics and prompt caching.

### Local-only setup (no internet)

Two paths:

**A. LiteLLM-routed direct to Ollama** (preferred):

```bash
LLM_BACKEND=litellm
LLM_MODEL_PLAY=ollama/qwen2.5:32b-instruct-q5_K_M
LLM_MODEL_AAR=ollama/qwen2.5:32b-instruct-q5_K_M
LLM_MODEL_GUARDRAIL=ollama/qwen2.5:7b-instruct-q5_K_M
LLM_API_BASE=http://ollama:11434
# LLM_API_KEY not needed — Ollama is unauthenticated and the engine
# only forwards LLM_API_KEY when the wire model targets anthropic/.
```

**B. Anthropic-direct + LiteLLM proxy sidecar** (legacy):
configure as documented in the Anthropic-direct section above.

Caveats common to both paths:

- Tool-use fidelity drops off on smaller models. `qwen2.5:32b-instruct`
  and `llama3.3:70b-instruct` are reasonable starting points; sub-7B
  models tend to fail `set_active_roles` reliably.
- Prompt caching is a no-op for non-Anthropic backends, so the system
  prompt is re-tokenised every turn — cost rises linearly with turn
  count. Consider lowering `MAX_TURNS_PER_SESSION`.
- The strict-retry path expects `tool_choice` enforcement; not every
  model implementation honours it. If you see force-advance loops on
  a local model, that's almost always why.

---

## Choosing between backends

| Question | Anthropic-direct | LiteLLM-routed |
|---|---|---|
| Talking only to Anthropic? | ✓ simpler | ✓ also works |
| Need Azure / Bedrock / Vertex direct? | ✗ needs a proxy sidecar | ✓ native |
| Operator brings their own provider key? | ✗ Anthropic-shape only | ✓ |
| Air-gapped with internal vLLM? | ✗ | ✓ |
| Smallest dep footprint? | ✓ (anthropic SDK only) | ✗ (litellm + transitive deps) |
| Smallest test surface? | ✓ | ✓ |
| Latency? | ✓ slightly faster | within ~110ms TTFT on streaming (~16% overhead) |

If in doubt, start with **Anthropic-direct** (the default). Flip to
LiteLLM the day a deployment requirement (vendor list, residency,
contract) actually requires it.

## Verifying a swap

After changing backends or models:

1. Hit `/healthz` then create a session and use **Dev mode** to skip
   setup.
2. Watch the docker logs for `llm_backend_selected` (set at startup)
   and `llm_call_start` / `llm_call_complete` (one pair per call).
   Model id, per-tier `max_tokens` / `temperature` / `top_p`, and
   token usage are all logged.
3. Run a 2-role exercise end-to-end. The strict-retry test
   (`backend/tests/test_e2e_session.py::test_strict_retry_*`) is the
   best signal that tool-use enforcement is working through whichever
   backend you've chosen.

## Cost tracking parity

Both backends populate the same four-key `usage` dict
(`input` / `output` / `cache_read` / `cache_creation`) and route through
the same `app.llm.cost.estimate_usd` table. LiteLLM's
``prompt_tokens`` (OpenAI convention) is decomposed into its
non-cached portion + cache reads + cache writes inside
``_usage_to_normalized_dict`` so reporting is identical between
backends. Without this normalization, warm-cache calls would show
~10× higher cost on the LiteLLM path — verified post-Phase-3 and locked
by `tests/test_litellm_translators.py::test_from_response_warm_cache_subtracts_cache_read_from_input`.

## Why this matters

Operators have varying constraints — air-gapped networks, regional
data-residency rules, vendor-diversity mandates, model-family
preferences, existing contractual relationships. The two-backend
architecture covers:

- **The 95% case**: stick with the default, point at Anthropic.
- **The "we have an Anthropic-shaped proxy" case**: `LLM_API_BASE`.
- **The "approved AI vendor isn't Anthropic-direct" case**: flip to
  `LLM_BACKEND=litellm`, set the per-tier provider id.

The seam between the two backends is a thin abstract base class with
identical surface — code outside `app/llm/` doesn't know or care which
backend is loaded.
