"""Token-usage → estimated USD pricing.

Numbers below are public list prices in USD per 1M tokens for the Claude
4-family at time of writing. They live in code so the cost meter has a single
source of truth; any pricing renegotiation lands here.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class _Pricing:
    input_per_mtok: float
    output_per_mtok: float
    cache_read_per_mtok: float
    cache_creation_per_mtok: float


_PRICES: dict[str, _Pricing] = {
    # Sonnet 4.6 — facilitation
    "claude-sonnet-4-6": _Pricing(3.00, 15.00, 0.30, 3.75),
    # Haiku 4.5 — setup, guardrail
    "claude-haiku-4-5": _Pricing(0.80, 4.00, 0.08, 1.00),
    # Opus 4.7 — AAR
    "claude-opus-4-7": _Pricing(15.00, 75.00, 1.50, 18.75),
}


_DEFAULT = _Pricing(3.00, 15.00, 0.30, 3.75)


def estimate_usd(
    *,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int = 0,
    cache_creation_tokens: int = 0,
) -> float:
    """Estimated USD cost for one call. Returns 0 for unknown / synthetic models."""

    pricing = _PRICES.get(model, _DEFAULT)
    return (
        input_tokens * pricing.input_per_mtok
        + output_tokens * pricing.output_per_mtok
        + cache_read_tokens * pricing.cache_read_per_mtok
        + cache_creation_tokens * pricing.cache_creation_per_mtok
    ) / 1_000_000.0
