import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { EvidenceExtractor } from '../src/evidence.js'
import { AdaptiveRanker } from '../src/ranker.js'
import type {
  CriterionObservation,
  PairwiseBackend,
  ScoreDistribution,
  VerifierCandidate,
} from '../src/types.js'
import { emptyUsage } from '../src/util.js'

function distribution(mean: number): ScoreDistribution {
  return {
    mean,
    variance: 0.002,
    entropy: 0.1,
    normalizedEntropy: 0.03,
    coverage: 0.98,
    probabilities: [{ token: mean > 0.5 ? 'B' : 'S', probability: 1, value: mean }],
  }
}

class MockBackend implements PairwiseBackend {
  readonly quality = new Map([['a', 0.2], ['b', 0.6], ['c', 0.95], ['d', 0.4]])
  calls = 0

  async compare(
    _task: string,
    candidateA: VerifierCandidate,
    candidateB: VerifierCandidate,
    criterion: { id: string },
    options: { reverse: boolean; repeat: number },
  ): Promise<CriterionObservation> {
    this.calls += 1
    const a = this.quality.get(candidateA.id) ?? 0.5
    const b = this.quality.get(candidateB.id) ?? 0.5
    return {
      criterionId: criterion.id,
      direction: options.reverse ? 'reverse' : 'forward',
      repeat: options.repeat,
      scoreA: distribution(a),
      scoreB: distribution(b),
      usage: { ...emptyUsage(), calls: 1, inputTokens: 50, outputTokens: 2 },
      cacheHit: false,
    }
  }
}

describe('adaptive ranker', () => {
  it('selects the strongest candidate with bounded calls', async () => {
    const config = resolveConfig({
      cache: { enabled: false, directory: '.', memoryEntries: 10 },
      ranking: {
        finalists: 2,
        enableDeterministicPruning: true,
        exactPassWins: true,
        eliminateExactFailures: true,
        deduplicate: true,
        partialCascade: true,
        rescueUncertainLosers: true,
        maxRescuedCandidates: 0,
      },
      verification: {
        ...resolveConfig().verification,
        criteria: [{ id: 'overall', name: 'Overall', description: 'Overall correctness.' }],
        initialRepeats: 1,
        maxRepeats: 2,
        reverseOnAmbiguity: true,
        decisiveGap: 0.1,
        decisiveConfidence: 0.6,
      },
      budget: {
        maxCalls: 8,
        maxUncachedInputTokens: 10_000,
        maxOutputTokens: 1_000,
        maxWallClockMs: 10_000,
        maxEstimatedInputTokensPerCall: 10_000,
      },
    })
    const backend = new MockBackend()
    const ranker = new AdaptiveRanker(backend, new EvidenceExtractor(config.evidence), config)
    const candidates = ['a', 'b', 'c', 'd'].map(id => ({ id, content: `candidate ${id}` }))
    const result = await ranker.select('choose the best', candidates)
    expect(result.selectedId).toBe('c')
    expect(result.budget.calls).toBeLessThanOrEqual(8)
    expect(backend.calls).toBeLessThanOrEqual(8)
  })

  it('returns an exact passing candidate without an LLM call', async () => {
    const config = resolveConfig({ cache: { enabled: false, directory: '.', memoryEntries: 10 } })
    const backend = new MockBackend()
    const ranker = new AdaptiveRanker(backend, new EvidenceExtractor(config.evidence), config)
    const result = await ranker.select('task', [
      { id: 'a', content: 'failed', exactOutcome: 'fail' },
      { id: 'b', content: 'verified', exactOutcome: 'pass' },
    ])
    expect(result.selectedId).toBe('b')
    expect(backend.calls).toBe(0)
    expect(result.exactWinner).toBe(true)
  })
})
