import { createHash, randomUUID } from 'node:crypto'
import type { TokenUsage } from './types.js'

export const EMPTY_USAGE: TokenUsage = Object.freeze({
  calls: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
})

export function emptyUsage(): TokenUsage {
  return { ...EMPTY_USAGE }
}

export function addUsage(...values: Array<Partial<TokenUsage> | undefined>): TokenUsage {
  const result = emptyUsage()
  for (const value of values) {
    if (!value) continue
    result.calls += value.calls ?? 0
    result.inputTokens += value.inputTokens ?? 0
    result.cacheReadTokens += value.cacheReadTokens ?? 0
    result.cacheWriteTokens += value.cacheWriteTokens ?? 0
    result.outputTokens += value.outputTokens ?? 0
    result.reasoningTokens += value.reasoningTokens ?? 0
  }
  return result
}

export function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value))
}

export function sigmoid(value: number): number {
  if (value >= 0) {
    const z = Math.exp(-value)
    return 1 / (1 + z)
  }
  const z = Math.exp(value)
  return z / (1 + z)
}

export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  const normalize = (node: unknown): unknown => {
    if (node === null || typeof node !== 'object') return node
    if (seen.has(node)) throw new TypeError('stableStringify does not accept cycles')
    seen.add(node)
    if (Array.isArray(node)) return node.map(normalize)
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(node as Record<string, unknown>).sort()) {
      const item = (node as Record<string, unknown>)[key]
      if (item !== undefined) out[key] = normalize(item)
    }
    return out
  }
  return JSON.stringify(normalize(value))
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function hashObject(value: unknown): string {
  return sha256(stableStringify(value))
}

export function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  if (maxChars < 64) return value.slice(0, maxChars)
  const marker = `\n... [${value.length - maxChars} chars omitted] ...\n`
  const remaining = maxChars - marker.length
  const head = Math.ceil(remaining * 0.42)
  const tail = Math.max(0, remaining - head)
  return value.slice(0, head) + marker + value.slice(-tail)
}

export function tail(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(-maxChars)
}

export function estimateTokens(value: string): number {
  // Conservative enough for budget admission across mixed code and prose.
  return Math.ceil(value.length / 3.2)
}

export function makeId(prefix = 'av'): string {
  return `${prefix}-${randomUUID()}`
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  }).finally(() => undefined)
}

export function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const usable = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (usable.length === 0) return undefined
  if (usable.length === 1) return usable[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(usable)
  const controller = new AbortController()
  for (const signal of usable) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

export class Semaphore {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Semaphore limit must be positive')
  }

  async use<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await operation()
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise(resolve => this.waiting.push(() => {
      this.active += 1
      resolve()
    }))
  }

  private release(): void {
    this.active -= 1
    this.waiting.shift()?.()
  }
}

export function compilePatterns(patterns: string[]): RegExp[] {
  return patterns.map(pattern => new RegExp(pattern, 'i'))
}

export function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(value))
}

export function textFromUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map(textFromUnknown).filter(Boolean).join('\n')
  if (typeof value !== 'object') return String(value)
  const record = value as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  if (record.content !== undefined) return textFromUnknown(record.content)
  if (record.message !== undefined) return textFromUnknown(record.message)
  if (record.value !== undefined) return textFromUnknown(record.value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function normaliseWhitespace(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim()
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

export function weightedMean(values: Array<{ value: number; weight: number }>): number {
  const total = values.reduce((sum, item) => sum + item.weight, 0)
  if (total <= 0) return 0.5
  return values.reduce((sum, item) => sum + item.value * item.weight, 0) / total
}
