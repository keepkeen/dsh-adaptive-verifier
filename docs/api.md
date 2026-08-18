# API and configuration

## Routing

Generator and verifier routes are independent.

### Generator

Transparent action selection samples candidates from the provider/model already present in the Harness `GenerateOptions` for the current agent step.

### Verifier

```yaml
verifier:
  backend: harness
  provider: optional-fixed-provider
  model: optional-fixed-model
```

With `backend: harness`, omitted provider/model inherit the current agent route **through Harness**. The plugin does not access that provider's credentials; `ctx.llm` dispatches to the registered adapter.

`backend: deepseek-logprob` is an explicit provider-specific mode. It uses `deepseek.*` settings and is never inferred from the generator route.

## Service

The bundle registers `ctx.adaptiveVerifier`.

- `extractEvidence(content, task?)`
- `extractSessionEvidence(events, task?)`
- `compare(task, candidateA, candidateB, options?)`
- `select(task, candidates, options?)`

When `ctx.adaptiveVerifier` is called outside an agent request and `backend: harness` has no fixed verifier provider/model, configure both fields because there is no current route to inherit.

## Key configuration groups

### `adapter`

- `enabled`: action-level selection on/off.
- `transparent`: intercept agent-loop model calls without adding another provider to the model picker.
- `targetProviders`: optional filter; empty means all agent-loop providers.
- `initialCandidates` / `maxCandidates`: adaptive candidate pool.

### `verifier`

- `backend: harness` — provider-agnostic default, no key handling in this plugin.
- `backend: deepseek-logprob` — explicit DeepSeek-specific logprob backend.
- `provider` / `model` — fixed verifier route when desired. Omit to inherit the current agent route in Harness mode.

### `deepseek`

Used only by standalone CLI / explicit `deepseek-logprob` mode. It is not a mirror of the current generator provider. The default credential reference is `DSH_VERIFIER_DEEPSEEK_API_KEY`, deliberately separate from generator/provider credentials.
