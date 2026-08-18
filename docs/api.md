# API and configuration

## Cordis service

The bundle registers `ctx.adaptiveVerifier`.

### `extractEvidence(content, task?)`

Returns an `EvidencePacket` without calling an LLM.

### `extractSessionEvidence(events, task?)`

Renders a detached Session-event sequence and extracts evidence.

### `compare(task, candidateA, candidateB, options?)`

Returns continuous rewards, a Bradley–Terry preference, uncertainty, per-criterion observations, usage, and stop reason.

### `select(task, candidates, options?)`

Returns:

- `selectedId`
- ordered `ranking`
- every `pairDecision`
- actual current-run `usage`
- budget snapshot
- stopping reason
- deduplication and exact-winner metadata

## Candidate contract

```ts
interface VerifierCandidate {
  id: string
  content: string
  evidence?: EvidencePacket
  exactOutcome?: 'pass' | 'fail' | 'unknown'
  artifactHash?: string
  metadata?: Record<string, unknown>
}
```

`exactOutcome` means a trusted checker result available at decision time. It must not be populated from a hidden evaluation label.

## Important configuration groups

### `deepseek`

| Field | Default | Meaning |
|---|---:|---|
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | Environment variable containing the key |
| `baseURL` | public DeepSeek API | API or compatible gateway |
| `model` | `deepseek-v4-flash` | Verifier model |
| `timeoutMs` | 120000 | Per-attempt timeout |
| `maxRetries` | 3 | Retry count |
| `concurrency` | 16 | Direct API concurrency cap |

### `verification`

| Field | Default | Meaning |
|---|---:|---|
| `topLogprobs` | 20 | Requested top alternatives |
| `cheapEffort` | `off` | Partial-evidence reasoning effort |
| `fullEffort` | `high` | Finalist reasoning effort |
| `initialRepeats` | 1 | Initial evaluations per criterion |
| `maxRepeats` | 4 | Maximum adaptive repeat index |
| `reverseOnAmbiguity` | true | Reverse A/B only when needed |
| `decisiveGap` | 0.12 | Early-stop gap threshold |
| `decisiveConfidence` | 0.72 | Early-stop confidence threshold |
| `slotBias` | 0 | Calibration offset |
| `bradleyTerryTemperature` | 0.18 | Preference temperature |

### `ranking`

| Field | Default | Meaning |
|---|---:|---|
| `finalists` | 3 | Full-evidence pool size |
| `partialCascade` | true | Use partial evidence for broad elimination |
| `rescueUncertainLosers` | true | Preserve a limited ambiguous loser |
| `maxRescuedCandidates` | 1 | Rescue cap |

### `budget`

All fields are hard operation-level limits except that actual tokenization can cross a limit on the final admitted call.

### `adapter`

Controls `deepseek-verified`. `initialCandidates` are generated in parallel; more are generated one at a time only if selection remains ambiguous.

### `hooks`

`evidenceGate` accepts `off`, `advisory`, or `enforce`. Advisory is the safe default for an uncalibrated deployment.
