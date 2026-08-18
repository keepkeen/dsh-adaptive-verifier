# Contributing

## Setup

```bash
npm install
npm run check
```

Node.js must satisfy the version declared in `package.json`.

## Pull requests

- Keep the Harness integration on documented extension points.
- Add unit tests for scoring, evidence, budget, cache, or ranking changes.
- Do not add a default test that calls a paid API.
- Do not claim benchmark gains without a fixed candidate pool, label-isolation proof, full Token accounting, and a reproducible configuration.
- Document any change that can alter tool execution, workspace state, or external side effects.

## Live tests

Live API tests must be opt-in through an explicit environment variable and should use a tiny bounded budget. Never place API keys or private trajectories in fixtures.

## Compatibility

DeepSeek Harness is a developer preview. Compatibility changes should name the Harness commit or release against which they were validated.
