# Architecture

## Separation of concerns

The plugin keeps three independent concepts:

1. **Generator route** — the Harness-selected provider/model for the agent step.
2. **Verifier route** — inherited through Harness or fixed independently.
3. **Verifier backend** — generic Harness judging or an explicit provider-specific logprob implementation.

This prevents model names, endpoints, or credentials from one provider being interpreted as another provider's HTTP configuration.

## Transparent action selection

The `llm/stream` listener only intercepts Harness agent-loop requests. Internal sampling/judge calls run under an `AsyncLocalStorage` bypass guard to prevent recursive verification.

Candidate generation re-enters `ctx.llm` with the same provider/model as the current agent request. Rejected candidate tool calls never reach the Agent Loop.

## Harness verifier backend

`HarnessPairwiseBackend` builds pairwise A–T prompts and sends them through `ctx.llm`. Provider transport and credentials remain entirely inside the selected Harness adapter.

The generic Harness stream does not expose token logprobs, so this backend returns categorical A–T observations. The ranker treats categorical observations as lower-reliability than true logprob distributions and can spend additional criteria/repeats when needed.

## DeepSeek logprob backend

The existing direct DeepSeek backend is retained as explicit `verifier.backend: deepseek-logprob` functionality. It is never selected by inspecting the generator route. Its endpoint/model/credential settings are independent configuration and are primarily intended for standalone or controlled deployments that explicitly want continuous score-token logprobs.

## Continuous scoring

Provider-specific logprob backends compute expected A–T score, variance, entropy, and probability coverage. Generic Harness backend cannot reconstruct probabilities that the provider-neutral stream never exposes.

## Full trajectory mode

`ctx.adaptiveVerifier.select()` ranks completed trajectories but does not clone execution environments. Use isolated worktrees/containers and re-test the selected artifact before promotion.
