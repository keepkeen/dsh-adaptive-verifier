# Architecture

## Goals

The plugin improves the quality/cost frontier of inference-time verification without patching the DeepSeek Harness agent loop. It separates three concerns:

1. **Proposal generation** — produce one or more possible assistant responses or completed trajectories.
2. **Evidence construction** — extract deterministic, compact facts from a response or trajectory.
3. **Adaptive selection** — spend verifier compute only where the current ordering is unresolved.

The package intentionally does not combine “copy a conversation” with “copy an execution world.” Full trajectory branching is safe only when each candidate owns an isolated filesystem, process space, ports, and external resources.

## Components

### `AdaptiveVerifierCore`

A Harness-independent facade containing:

- `DeepSeekClient`
- `EvidenceExtractor`
- `SessionEvidenceTracker`
- `DeepSeekPairwiseBackend`
- `AdaptiveRanker`

The CLI and Harness service share this exact core.

### `DeepSeekClient`

Calls `/chat/completions` directly because the current provider-neutral Harness streaming vocabulary does not expose token logprobs. It provides:

- bounded concurrency;
- timeout and caller cancellation;
- retry/backoff for transport, 408, 409, 429, and 5xx failures;
- DeepSeek cache-hit accounting;
- reasoning-effort selection;
- generation and verifier calls.

The client performs one network attempt per internal retry iteration and never logs the API key.

### `EvidenceExtractor`

Produces an `EvidencePacket` from plain text or Session events:

```text
tests + exit codes
mutations + changed files
unresolved errors
verification freshness
artifacts + final output
tool calls + agent claims
```

The extractor is a cheap feature layer. It is deliberately incomplete and cannot certify semantic correctness.

### `DeepSeekPairwiseBackend`

Builds cache-friendly pair prompts. Task and candidate evidence precede the criterion, while the criterion is placed near the prompt tail. The response contract is:

```text
<score_A>X</score_A>
<score_B>Y</score_B>
```

The backend aligns these positions with token logprobs, filters A–T alternatives, normalizes the visible score-token mass, and returns continuous distributions. If logprobs are unexpectedly missing but valid tags are present, it emits a low-confidence discrete fallback rather than presenting it as an equally reliable score.

### `AdaptiveRanker`

The ranker runs:

1. evidence extraction;
2. exact-check pruning, when the caller supplies a trusted exact outcome;
3. content/artifact deduplication;
4. partial-evidence elimination when the pool is large;
5. optional rescue of an uncertain loser;
6. full-evidence round-robin among finalists;
7. soft-win aggregation.

Each pair starts with one forward evaluation. It escalates through criterion completion, slot reversal, and repeated evaluation only while the pair remains uncertain and budget remains.

### `VerifiedDeepSeekAdapter`

Registers the `deepseek-verified` provider. It uses the same Harness request envelope to generate candidate responses through the direct DeepSeek client, then ranks textual responses/tool calls before yielding any chunks to the agent loop.

Only the chosen candidate is converted into Harness chunks. The rejected candidates’ tool calls are never dispatched.

### `AdaptiveVerifierRuntime`

A Cordis `Service` registered as `ctx.adaptiveVerifier`. It exposes evidence extraction, pair comparison, and selection to other plugins and workflow orchestrators.

### Harness hooks

The package attaches only to documented plugin seams:

- `session/event` — evidence observation;
- `session/disposed` — tracker cleanup;
- `tools/pre-execute` — optional advisory/enforced evidence gate;
- `agent/turn-stopping` — optional stale-verification steering;
- `ctx.llm.registerAdapter` — verified model route.

No agent-loop source file is patched.

## Score mathematics

For score letters `A, …, T`, the default map is linear:

```text
A = 1
B = 18/19
...
T = 0
```

For the retrieved score-token alternatives:

```text
R = Σ p(v) φ(v) / Σ p(v)
```

The denominator is reported as `coverage` before normalization. The package also reports variance and normalized entropy.

Criterion observations are averaged within criterion, then criteria are combined by configured weights. Pair preference is:

```text
P(A > B) = sigmoid((R_A - R_B - slotBias) / bradleyTerryTemperature)
```

Default calibration parameters are startup values, not benchmark-fitted constants.

## Budget semantics

A `VerificationBudget` tracks only work actually performed in the current operation. Disk/memory cache hits carry zero current-run usage. Limits are checked before dispatch using an input estimate and updated after the provider returns authoritative usage.

A single call can exceed a remaining token limit because actual provider tokenization is known only afterward. The budget then becomes exhausted and prevents subsequent calls.

## Prefix-cache behavior

To preserve cache reuse:

- model, reasoning effort, temperature, task, candidates, evidence level, and rating scale stay fixed for a pair phase;
- criterion-specific prose appears at the tail;
- the first criterion naturally warms the shared prefix;
- later criterion/repeat calls reuse the same hashed input where the provider cache permits it.

Changing evidence level, direction, model, or upstream content creates a distinct cache entry and may invalidate provider KV-prefix reuse.

## Failure behavior

- Missing credential: calls fail with a named environment-variable error; plugin loading itself succeeds.
- Malformed provider response: the operation fails rather than silently selecting a random candidate.
- Budget exhaustion: ranking returns the best current aggregate.
- Cache corruption: the entry is ignored and recomputed.
- Duplicate generations: duplicates are removed; the adapter stops expanding if a new sample adds no candidate.
- Caller cancellation: the signal propagates to generation and verification calls.
