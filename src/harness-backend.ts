import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {
  AdaptiveVerifierConfig,
  CriterionObservation,
  EvidenceLevel,
  PairwiseBackend,
  ScoreDistribution,
  TokenUsage,
  VerifierCandidate,
  VerifierCriterion,
  VerificationEffort,
} from './types.js'
import { ScoreCache } from './cache.js'
import { EvidenceExtractor } from './evidence.js'
import { buildPairwiseVerifierMessages } from './prompts.js'
import { scoreTokenValue } from './score-scale.js'
import { emptyUsage, hashObject } from './util.js'
import { harnessVerifierRoute, internalHarnessCall } from './harness-runtime.js'

interface CachedObservation {
  scoreA: ScoreDistribution
  scoreB: ScoreDistribution
  rawText: string
}

function categoricalDistribution(letter: string): ScoreDistribution {
  const token = letter.trim().toUpperCase()
  const value = scoreTokenValue(token)
  if (value === undefined) throw new Error(`Invalid verifier score token ${JSON.stringify(letter)}`)
  return {
    mean: value,
    variance: 0.25,
    entropy: Math.log(20) * 0.65,
    normalizedEntropy: 0.65,
    coverage: 1,
    actualToken: token,
    source: 'categorical',
    probabilities: [{ token, probability: 1, value }],
  }
}

function parseScores(text: string): { scoreA: ScoreDistribution; scoreB: ScoreDistribution } {
  const a = /<score_A>\s*([A-Ta-t])\s*<\/score_A>/i.exec(text)?.[1]
  const b = /<score_B>\s*([A-Ta-t])\s*<\/score_B>/i.exec(text)?.[1]
  if (!a || !b) throw new Error('Harness verifier did not return valid <score_A>/<score_B> A-T tags')
  return { scoreA: categoricalDistribution(a), scoreB: categoricalDistribution(b) }
}

function usageFromChunk(chunk: StreamChunk): TokenUsage | undefined {
  if (chunk.type !== 'usage') return undefined
  const usage = chunk.usage
  return {
    calls: 1,
    inputTokens: usage.inputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens ?? 0,
  }
}

async function collectText(stream: AsyncIterable<StreamChunk>): Promise<{ text: string; usage: TokenUsage }> {
  let text = ''
  let fallbackText = ''
  let usage = emptyUsage()
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'block-end' && chunk.block.type === 'text') fallbackText += chunk.block.text
    const nextUsage = usageFromChunk(chunk)
    if (nextUsage) usage = nextUsage
    if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
      throw new Error(chunk.reason.failure.message)
    }
  }
  return { text: text || fallbackText, usage }
}

/**
 * Provider-agnostic pairwise judge. All provider/model/credential behavior stays
 * inside Harness. Since the generic Harness stream does not expose logprobs,
 * this backend returns categorical A-T observations and relies on adaptive
 * criteria/repeats for uncertainty reduction.
 */
export class HarnessPairwiseBackend implements PairwiseBackend {
  private readonly cache: ScoreCache<CachedObservation>

  constructor(
    private readonly ctx: Context,
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
    const inherited = harnessVerifierRoute.getStore()
    const provider = this.config.verifier.provider ?? inherited?.provider
    const model = this.config.verifier.model ?? inherited?.model
    if (!provider || !model) {
      throw new Error(
        'Harness verifier route is unresolved. Configure verifier.provider/model, or call from an agent request where the route can be inherited.',
      )
    }

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
    const system = String(messages[0]?.content ?? '')
    const user = String(messages[1]?.content ?? '')
    const key = hashObject({
      version: 2,
      backend: 'harness',
      provider,
      model,
      system,
      user,
      criterion: criterion.id,
      level: options.evidenceLevel,
      temperature: options.temperature,
      reverse: options.reverse,
      repeat: options.repeat,
    })

    let liveUsage = emptyUsage()
    const { value, hit } = await this.cache.getOrCompute(key, async () => {
      const request: GenerateOptions = {
        provider,
        model,
        system,
        messages: [createUserMessage({
          content: [{ type: 'text', text: user }],
          source: { kind: 'plugin', plugin: 'dsh-adaptive-verifier' },
        })],
        temperature: options.temperature,
        maxTokens: 4096,
        signal: options.signal,
      }
      const collected = await internalHarnessCall.run(true, () => collectText(this.ctx.llm.stream(request)))
      liveUsage = collected.usage
      const parsed = parseScores(collected.text)
      const mapped = options.reverse
        ? { scoreA: parsed.scoreB, scoreB: parsed.scoreA }
        : parsed
      return { ...mapped, rawText: collected.text }
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
