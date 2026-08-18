import { describe, expect, it } from 'vitest'
import { VerificationBudget } from '../src/budget.js'

describe('verification budget', () => {
  it('stops at the call limit', () => {
    const budget = new VerificationBudget({
      maxCalls: 1,
      maxUncachedInputTokens: 100,
      maxOutputTokens: 100,
      maxWallClockMs: 10_000,
      maxEstimatedInputTokensPerCall: 100,
    })
    expect(budget.canCall(20)).toBe(true)
    budget.record({ calls: 1, inputTokens: 20, outputTokens: 5 })
    expect(budget.canCall()).toBe(false)
    expect(budget.snapshot().exhaustionReason).toMatch(/call/i)
  })
})
