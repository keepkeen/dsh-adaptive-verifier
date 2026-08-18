# dsh-adaptive-verifier

Adaptive verification for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), designed to remain provider-agnostic at the Harness boundary.

[中文文档](README.zh.md)

## 0.2.0 routing model

The plugin deliberately separates **generator routing** from **verifier routing**.

### Generator

The generator always uses the provider/model already selected by the current Harness agent. It can therefore be DeepSeek Official, OpenRouter, an OpenAI-compatible gateway, a local adapter, or another Harness provider.

### Verifier

The verifier has an independent route:

```yaml
verifier:
  backend: harness
  # provider/model omitted => inherit current agent route through Harness
```

or a fixed independent Harness route:

```yaml
verifier:
  backend: harness
  provider: deepseek-official
  model: deepseek-v4-flash
```

In both cases the call goes through `ctx.llm`. **The main plugin never reads, guesses, copies, or parses that provider's API key.** The selected Harness adapter owns credentials and transport.

### Optional logprob backend

The generic Harness stream does not expose token logprobs. Therefore continuous score-token logprob evaluation cannot be universal.

If you explicitly want the original DeepSeek token-logprob scorer, opt into the provider-specific backend:

```yaml
verifier:
  backend: deepseek-logprob
  model: deepseek-v4-flash
```

That mode uses the standalone DeepSeek HTTP configuration (`deepseek.*` / `DEEPSEEK_API_KEY`) and is never inferred from the generator route.

## Install

```bash
git clone https://github.com/keepkeen/dsh-adaptive-verifier.git
cd dsh-adaptive-verifier
npm install --legacy-peer-deps
npm run check

dsh plugin --profile verifier-lab add .
dsh --profile verifier-lab --dump-config
```

The bundle automatically inserts the `adaptive-verifier` row. You do not need to change your Harness-selected provider/model.

## Recommended config

```yaml
- id: adaptive-verifier
  config:
    adapter:
      enabled: true
      transparent: true
      targetProviders: []
      initialCandidates: 2
      maxCandidates: 4
      generationTemperature: 0.6

    verifier:
      backend: harness

    hooks:
      observeSessions: true
      evidenceGate: advisory
      steerBeforeTurnEnd: false
```

See [`examples/profile.cordis.patch.yml`](examples/profile.cordis.patch.yml).

## Runtime

```text
Harness agent provider/model
        │
        ├── candidate A ─┐
        ├── candidate B ─┼─ adaptive selection ─► winner only ─► Agent Loop/tools
        └── candidate N ─┘

Verifier route (independent)
        └── Harness ctx.llm (default, no key handling in this plugin)
            OR explicit provider-specific logprob backend
```

Rejected candidate tool calls never execute.

## Generic vs logprob scoring

`backend: harness` works with any Harness LLM route. It parses A–T categorical judgments and uses adaptive criteria/repeats to reduce uncertainty.

`backend: deepseek-logprob` is provider-specific and can compute continuous expected A–T rewards from top-logprobs. It is optional rather than a hidden dependency.

## Service API

The bundle also exposes `ctx.adaptiveVerifier.select()` and `compare()` for already-completed candidates. For trajectory Best-of-N, isolate filesystems/processes separately; a Session fork is not a workspace fork.

## License

MIT
