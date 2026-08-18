import type {
  DeepSeekTokenLogprob,
  ScoreDistribution,
  ScoreTokenProbability,
} from './types.js'
import { clamp } from './util.js'

export const SCORE_LETTERS = Object.freeze(
  Array.from({ length: 20 }, (_, index) => String.fromCharCode(65 + index)),
)

export function scoreTokenValue(token: string): number | undefined {
  const normalized = token.trim().toUpperCase()
  if (!/^[A-T]$/.test(normalized)) return undefined
  const index = normalized.charCodeAt(0) - 65
  return (19 - index) / 19
}

function capturedScoreOffset(text: string, tag: 'A' | 'B'): number | undefined {
  const expression = new RegExp(`<score_${tag}>\\s*([A-Ta-t])`, 'i')
  const match = expression.exec(text)
  if (!match || match.index === undefined || !match[1]) return undefined
  const relative = match[0].lastIndexOf(match[1])
  return match.index + relative
}

function tokenAtOffset(tokens: DeepSeekTokenLogprob[], offset: number): DeepSeekTokenLogprob | undefined {
  let cursor = 0
  for (const item of tokens) {
    const end = cursor + item.token.length
    if (offset >= cursor && offset < end) return item
    cursor = end
  }
  return undefined
}

function probability(logprob: number): number {
  if (!Number.isFinite(logprob)) return 0
  return Math.exp(Math.max(-100, Math.min(0, logprob)))
}

export function distributionFromToken(item: DeepSeekTokenLogprob): ScoreDistribution {
  const byLetter = new Map<string, number>()
  const alternatives = item.top_logprobs ?? []
  for (const alternative of alternatives) {
    const letter = alternative.token.trim().toUpperCase()
    const value = scoreTokenValue(letter)
    if (value === undefined) continue
    byLetter.set(letter, Math.max(byLetter.get(letter) ?? 0, probability(alternative.logprob)))
  }
  const actualLetter = item.token.trim().toUpperCase()
  const actualValue = scoreTokenValue(actualLetter)
  if (actualValue !== undefined) {
    byLetter.set(actualLetter, Math.max(byLetter.get(actualLetter) ?? 0, probability(item.logprob)))
  }

  const coverage = [...byLetter.values()].reduce((sum, value) => sum + value, 0)
  if (coverage <= 0) {
    return {
      mean: actualValue ?? 0.5,
      variance: 0.25,
      entropy: Math.log(20),
      normalizedEntropy: 1,
      coverage: 0,
      actualToken: actualValue === undefined ? undefined : actualLetter,
      probabilities: [],
    }
  }

  const probabilities: ScoreTokenProbability[] = [...byLetter.entries()]
    .map(([token, mass]) => ({
      token,
      probability: mass / coverage,
      value: scoreTokenValue(token) ?? 0.5,
    }))
    .sort((a, b) => b.value - a.value)
  const mean = probabilities.reduce((sum, entry) => sum + entry.probability * entry.value, 0)
  const variance = probabilities.reduce(
    (sum, entry) => sum + entry.probability * (entry.value - mean) ** 2,
    0,
  )
  const entropy = -probabilities.reduce(
    (sum, entry) => sum + (entry.probability > 0 ? entry.probability * Math.log(entry.probability) : 0),
    0,
  )
  return {
    mean: clamp(mean),
    variance: Math.max(0, variance),
    entropy,
    normalizedEntropy: clamp(entropy / Math.log(20)),
    coverage: clamp(coverage),
    actualToken: actualValue === undefined ? undefined : actualLetter,
    probabilities,
  }
}

export function extractTaggedDistribution(
  tokens: DeepSeekTokenLogprob[],
  tag: 'A' | 'B',
): ScoreDistribution {
  const text = tokens.map(item => item.token).join('')
  const offset = capturedScoreOffset(text, tag)
  if (offset === undefined) {
    throw new Error(`Verifier response did not contain <score_${tag}>A-T</score_${tag}>`)
  }
  const item = tokenAtOffset(tokens, offset)
  if (!item) throw new Error(`Unable to align score_${tag} with token logprobs`)
  return distributionFromToken(item)
}

export function extractPairDistributions(tokens: DeepSeekTokenLogprob[]): {
  scoreA: ScoreDistribution
  scoreB: ScoreDistribution
  text: string
} {
  return {
    scoreA: extractTaggedDistribution(tokens, 'A'),
    scoreB: extractTaggedDistribution(tokens, 'B'),
    text: tokens.map(item => item.token).join(''),
  }
}

export function distributionReliability(distribution: ScoreDistribution): number {
  const coverage = clamp(distribution.coverage)
  const sharpness = clamp(1 - distribution.normalizedEntropy)
  const variancePenalty = clamp(1 - Math.sqrt(distribution.variance) * 2)
  return clamp(0.5 * coverage + 0.35 * sharpness + 0.15 * variancePenalty)
}
