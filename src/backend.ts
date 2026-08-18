import type {
  AdaptiveVerifierConfig,
  CriterionObservation,
  DeepSeekRequest,
  EvidenceLevel,
  PairwiseBackend,
  ScoreDistribution,
  VerifierCandidate,
  VerifierCriterion,
  VerificationEffort,
} from './types.js'
import { ScoreCache } from './cache.js'
import { DeepSeekClient } from './deepseek-client.js'
import { EvidenceExtractor } from './evidence.js'
import { buildPairwiseVerifierMessages } from './prompts.js'
import { extractPairDistributions, scoreTokenValue } from './score-scale.js'
import { emptyUsage, hashObject } from './util.js'

interface CachedObservation {
  scoreA: ScoreDistribution
  scoreB: ScoreDistribution
  rawText?: string
}

function discreteDistribution(letter: string): ScoreDistribution {
  const value = scoreTokenValue(letter) ?? 0.5
  return {
    mean: value,
    variance: 0.25,
    entropy: Math.log(20),
    normalizedEntropy: 1,
    coverage: 0,
    actualToken: letter.toUpperCase(),
    probabilities: [{ token: letter.toUpperCase(), probability: 1, value }],
  }
}

function fallbackScores(text: string): { scoreA: ScoreDistribution; scoreB: ScoreDistribution } {
  const a = /<score_A>\s*([A-Ta-t])/i.exec(text)?.[1]
  const b = /<score_B>\s*([A-Ta-t])/i.exec(text)?.[1]
  if (!a || !b) throw new Error('Verifier returned neither usable logprobs nor score tags')
  return { scoreA: discreteDistribution(a), scoreB: discreteDistribution(b) }
}

export class DeepSeekPairwiseBackend implements PairwiseBackend {
  private readonly cache: ScoreCache<CachedObservation>

  constructor(
    private readonly client: DeepSeekClient,
    private readonly extractor: EvidenceExtractor,
    private readonly config: AdaptiveVerifierConfig,
  ) {
    this.cache = new ScoreCache(config.cache)
  }

  async compare(
    task: string,
    originalA: VerifierCandidate,
    originalB: VerifierCandidate,
    criterion: VerifierCriterion,
    options: {
      evidenceLevel: EvidenceLevel
      effort: VerificationEffort
      temperature: number
      reverse: boolean
      repeat: number
      signal?: AbortSignal
    },
  ): Promise<CriterionObservation> {
    const slotA = options.reverse ? originalB : originalA
    const slotB = options.reverse ? originalA : originalB
    const messages = buildPairwiseVerifierMessages({
      task,
      candidateA: slotA,
      candidateB: slotB,
      criterion,
      evidenceLevel: options.evidenceLevel,
      extractor: this.extractor,
    })
    const key = hashObject({
      version: 1,
      model: this.config.deepseek.model,
      messages,
      criterion: criterion.id,
      level: options.evidenceLevel,
      effort: options.effort,
      temperature: options.temperature,
      reverse: options.reverse,
      repeat: options.repeat,
      topLogprobs: this.config.verification.topLogprobs,
    })

    let liveUsage = emptyUsage()
    const { value, hit } = await this.cache.getOrCompute(key, async () => {
      const request: DeepSeekRequest = {
        model: this.config.deepseek.model,
        messages,
        temperature: options.temperature,
        max_tokens: options.effort === 'off' ? 64 : 16_384,
        stream: false,
        logprobs: true,
        top_logprobs: this.config.verification.topLogprobs,
      }
      const call = await this.client.call(request, { effort: options.effort, signal: options.signal })
      liveUsage = call.usage
      const choice = call.response.choices[0]
      const rawText = choice?.message?.content ?? ''
      const tokens = choice?.logprobs?.content ?? []
      const parsed = tokens.length > 0 ? extractPairDistributions(tokens) : fallbackScores(rawText)
      const mapped = options.reverse
        ? { scoreA: parsed.scoreB, scoreB: parsed.scoreA }
        : { scoreA: parsed.scoreA, scoreB: parsed.scoreB }
      return { ...mapped, rawText: rawText || ('text' in parsed ? parsed.text : undefined) }
    })

    return {
      criterionId: criterion.id,
      direction: options.reverse ? 'reverse' : 'forward',
      repeat: options.repeat,
      scoreA: value.scoreA,
      scoreB: value.scoreB,
      rawText: value.rawText,
      usage: hit ? emptyUsage() : liveUsage,
      cacheHit: hit,
    }
  }
}
