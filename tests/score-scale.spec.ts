import { describe, expect, it } from 'vitest'
import { extractPairDistributions, scoreTokenValue } from '../src/score-scale.js'
import type { DeepSeekTokenLogprob } from '../src/types.js'

function token(token: string, alternatives?: Array<[string, number]>): DeepSeekTokenLogprob {
  return {
    token,
    logprob: alternatives?.find(([candidate]) => candidate.trim() === token.trim())?.[1] ?? -0.1,
    top_logprobs: alternatives?.map(([value, logprob]) => ({ token: value, logprob })),
  }
}

describe('A-T score extraction', () => {
  it('maps A to 1 and T to 0', () => {
    expect(scoreTokenValue('A')).toBe(1)
    expect(scoreTokenValue('T')).toBe(0)
    expect(scoreTokenValue(' K ')).toBeCloseTo(9 / 19)
  })

  it('extracts expectations at tagged score positions', () => {
    const tokens: DeepSeekTokenLogprob[] = [
      token('<score_A>'),
      token(' A', [[' A', Math.log(0.7)], [' B', Math.log(0.2)], [' T', Math.log(0.1)]]),
      token('</score_A>\n<score_B>'),
      token(' T', [[' T', Math.log(0.8)], [' S', Math.log(0.15)], [' A', Math.log(0.05)]]),
      token('</score_B>'),
    ]
    const result = extractPairDistributions(tokens)
    expect(result.scoreA.mean).toBeGreaterThan(0.85)
    expect(result.scoreB.mean).toBeLessThan(0.15)
    expect(result.scoreA.coverage).toBeCloseTo(1)
    expect(result.text).toContain('<score_A> A')
  })
})
