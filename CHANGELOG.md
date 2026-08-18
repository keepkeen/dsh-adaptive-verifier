# Changelog

## 0.2.0

- Provider-agnostic transparent mode: candidate generation inherits the Harness-selected provider/model.
- Verifier routing is now independent from generator routing.
- Default verifier backend uses Harness `ctx.llm`, so the main plugin never reads or infers provider API keys.
- Verifier provider/model can either inherit the current agent route or be fixed explicitly.
- Direct DeepSeek logprob scoring is now an explicit `deepseek-logprob` backend for standalone/advanced use, never inferred from the generator route.
- Transparent interception is limited to Harness agent-loop requests and skips internal sampling/judge calls.
- Generic Harness verification uses categorical A–T judgments with adaptive repeats; continuous token-logprob scoring remains available only in provider-specific backends.

## 0.1.0

- Initial installable DeepSeek Harness bundle.
- `deepseek-verified` response-level candidate-selection adapter.
- `ctx.adaptiveVerifier` comparison and trajectory-selection service.
- Direct DeepSeek logprob backend with retry, timeout, concurrency, and usage accounting.
- A–T continuous score expectation, entropy, variance, and coverage.
- Deterministic evidence extraction and verification-freshness checks.
- Partial-evidence cascade, finalist round-robin, conditional slot reversal, and adaptive repeats.
- Persistent hash-only score cache.
- Evidence gate and optional turn-stop steering hooks.
- Selection and benchmark CLIs.
