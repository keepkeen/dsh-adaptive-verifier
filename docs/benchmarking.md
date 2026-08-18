# Benchmarking and ablations

## Objective

Measure the accuracy–cost–latency frontier, not only the maximum selected accuracy.

Use a fixed candidate pool so generator quality and selector quality can be separated. Candidate labels are evaluation-only and must never enter `VerifierCandidate.exactOutcome` unless they represent a checker genuinely available at deployment time.

## Input format

```json
{
  "tasks": [
    {
      "id": "task-id",
      "task": "task description",
      "candidates": [
        { "id": "run-1", "label": "pass", "content": "trajectory" },
        { "id": "run-2", "label": "fail", "content": "trajectory" }
      ]
    }
  ]
}
```

The benchmark CLI strips `label` before invoking the selector.

## Run

```bash
npm run build
export DSH_VERIFIER_DEEPSEEK_API_KEY='...'
dsh-adaptive-benchmark --input benchmark.json --output result.json
```

Use fresh cache directories when measuring provider usage from scratch. Use warm-cache runs separately to measure incremental replay behavior.

## Required metrics

- Pass@1: mean success fraction in each candidate pool.
- Selected accuracy.
- Oracle Pass@N.
- Recovered oracle headroom:

```text
(selected - pass1) / (oracle - pass1)
```

- API call count.
- Uncached input tokens.
- Cache-read input tokens.
- Output and reasoning tokens.
- p50/p95 wall-clock latency.
- Partial-cascade elimination count.
- Full-evidence escalation rate.
- Slot-reversal rate.
- Mean repeat count.
- Correct-candidate premature elimination rate.
- Budget-exhausted rate.

## Recommended ablation ladder

1. Full evidence, fixed criteria, fixed repeats, full round-robin.
2. Probabilistic pivot or finalist ranking.
3. Content/artifact deduplication.
4. Deterministic evidence features.
5. Partial-evidence cascade.
6. Conditional slot reversal.
7. Adaptive repeats.
8. Adaptive candidate generation.
9. Weak/strong model routing.
10. Learned slot bias, temperature, and criterion weights on a held-out calibration split.

Every row should use the same candidate pool and report the complete Token/latency breakdown.

## Calibration split

Fit only the following on a separate split:

- `slotBias`
- `bradleyTerryTemperature`
- criterion weights
- decisive gap/confidence thresholds
- partial-evidence rescue threshold

Do not select these values on the final benchmark set.

## Online Harness evaluation

A production-like study must not pre-classify all-pass, swing, or all-fail tasks using labels. Run the plugin blindly on every task and count all generation, checking, cancellation waste, and verification traffic.

For trajectory-level evaluation, candidate environments must be isolated and winner artifacts must be re-tested in a clean promotion environment.
