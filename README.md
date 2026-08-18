# dsh-adaptive-verifier

Adaptive logprob-based verification for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). The package adds a `deepseek-verified` model route that selects among candidate assistant responses before any tool side effect runs, plus a `ctx.adaptiveVerifier` service for ranking completed, isolated agent trajectories.

> Status: initial `0.1.0` implementation. Core logic, CLI tools, mock tests, packaging, and Harness integration are implemented. No new Terminal-Bench accuracy or cost result is claimed by this repository. Pin both Harness and plugin commits because Harness is still a developer preview.

[中文文档](README.zh.md)

## Highlights

- Continuous A–T rewards from score-token top-logprobs.
- Deterministic evidence extraction before LLM verification.
- Partial-evidence elimination and full-evidence finalist ranking.
- Conditional slot reversal and repeated evaluation only for ambiguous pairs.
- Explicit limits on calls, uncached input, output, per-call context, and wall-clock time.
- Hash-only persistent score cache; trajectories are not written to the cache.
- Installable DeepSeek Harness bundle.
- Offline benchmark CLI that withholds labels from the selector.

## Install

```bash
git clone https://github.com/keepkeen/dsh-adaptive-verifier.git
cd dsh-adaptive-verifier
npm install
npm run check

dsh plugin --profile verifier-lab add .
dsh --profile verifier-lab --dump-config
```

Set the live API credential:

```bash
export DEEPSEEK_API_KEY='...'
```

Select the route in the relevant Harness agent row:

```yaml
provider: deepseek-verified
model: deepseek-v4-flash
```

See [`examples/profile.cordis.patch.yml`](examples/profile.cordis.patch.yml) and the [Chinese README](README.zh.md) for the full configuration and behavior.

## Service API

```ts
const result = await ctx.adaptiveVerifier.select(task, [
  { id: 'run-a', content: trajectoryA },
  { id: 'run-b', content: trajectoryB },
])

console.log(result.selectedId)
console.log(result.budget)
```

Completed trajectories must come from isolated workspaces. Harness session forking copies conversation history, not filesystem or process state. See [isolation semantics](docs/isolation.md).

## CLI

```bash
npm run build
node dist/src/cli.js --input examples/candidates.json --evidence-only
node dist/src/cli.js --input examples/candidates.json
node dist/src/benchmark.js --input examples/benchmark.json
```

Installed binaries are `dsh-adaptive-verify` and `dsh-adaptive-benchmark`.

## Validation

```bash
npm run check
```

Default tests use mocks and never call a paid API. A live run is opt-in through the CLI and `DEEPSEEK_API_KEY`.

## Limitations

- The verified route buffers candidate generations before replaying the winner, increasing time to first token.
- Rule-based evidence extraction is intentionally high precision but incomplete.
- Same-model generation and verification share blind spots.
- Top-logprob coverage may be incomplete; low coverage lowers confidence.
- Workspace isolation and winner promotion are caller responsibilities for full trajectory Best-of-N.
- No benchmark result should be inferred until the supplied replay protocol is run on a fixed candidate pool.

## License

MIT
