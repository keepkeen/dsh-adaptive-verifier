import type {
  TokenUsage,
  VerificationBudgetConfig,
  VerificationBudgetSnapshot,
} from './types.js'
import { addUsage, emptyUsage } from './util.js'

export class BudgetExceededError extends Error {
  constructor(public readonly reason: string) {
    super(`Verification budget exhausted: ${reason}`)
    this.name = 'BudgetExceededError'
  }
}

export class VerificationBudget {
  private readonly startedAt = Date.now()
  private usage: TokenUsage = emptyUsage()
  private reason?: string

  constructor(public readonly limits: VerificationBudgetConfig) {}

  canCall(estimatedInputTokens = 0): boolean {
    if (this.reason) return false
    const elapsed = Date.now() - this.startedAt
    if (elapsed >= this.limits.maxWallClockMs) return this.exhaust('wall-clock limit')
    if (this.usage.calls >= this.limits.maxCalls) return this.exhaust('call limit')
    if (estimatedInputTokens > this.limits.maxEstimatedInputTokensPerCall) {
      return this.exhaust('per-call estimated input limit')
    }
    if (this.usage.inputTokens + estimatedInputTokens > this.limits.maxUncachedInputTokens) {
      return this.exhaust('uncached input token limit')
    }
    if (this.usage.outputTokens >= this.limits.maxOutputTokens) return this.exhaust('output token limit')
    return true
  }

  assertCanCall(estimatedInputTokens = 0): void {
    if (!this.canCall(estimatedInputTokens)) throw new BudgetExceededError(this.reason ?? 'unknown')
  }

  record(usage: Partial<TokenUsage>): void {
    this.usage = addUsage(this.usage, usage)
    if (this.usage.calls > this.limits.maxCalls) this.reason ??= 'call limit'
    if (this.usage.inputTokens > this.limits.maxUncachedInputTokens) this.reason ??= 'uncached input token limit'
    if (this.usage.outputTokens > this.limits.maxOutputTokens) this.reason ??= 'output token limit'
    if (Date.now() - this.startedAt > this.limits.maxWallClockMs) this.reason ??= 'wall-clock limit'
  }

  remainingCalls(): number {
    return Math.max(0, this.limits.maxCalls - this.usage.calls)
  }

  snapshot(): VerificationBudgetSnapshot {
    return {
      ...this.usage,
      elapsedMs: Date.now() - this.startedAt,
      exhausted: this.reason !== undefined,
      exhaustionReason: this.reason,
    }
  }

  private exhaust(reason: string): false {
    this.reason ??= reason
    return false
  }
}
