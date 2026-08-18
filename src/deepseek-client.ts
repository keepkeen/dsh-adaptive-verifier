import type {
  DeepSeekCallResult,
  DeepSeekClientConfig,
  DeepSeekRequest,
  DeepSeekResponse,
  GenerateCandidateResult,
  HarnessGenerateOptions,
  TokenUsage,
  VerificationEffort,
} from './types.js'
import { generationRequest } from './harness-wire.js'
import { anySignal, emptyUsage, makeId, Semaphore, sleep } from './util.js'

export class DeepSeekApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly responseBody?: string,
  ) {
    super(message)
    this.name = 'DeepSeekApiError'
  }
}

function usageFromResponse(response: DeepSeekResponse): TokenUsage {
  const usage = response.usage
  if (!usage) return emptyUsage()
  const cached = usage.prompt_cache_hit_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? 0
  const totalInput = usage.prompt_tokens ?? ((usage.prompt_cache_miss_tokens ?? 0) + cached)
  return {
    calls: 1,
    inputTokens: Math.max(0, totalInput - cached),
    cacheReadTokens: Math.max(0, cached),
    cacheWriteTokens: 0,
    outputTokens: Math.max(0, usage.completion_tokens ?? 0),
    reasoningTokens: Math.max(0, usage.completion_tokens_details?.reasoning_tokens ?? 0),
  }
}

function effortFields(effort: VerificationEffort): Partial<DeepSeekRequest> {
  if (effort === 'off') return { thinking: { type: 'disabled' } }
  return {
    thinking: { type: 'enabled' },
    reasoning_effort: effort,
  }
}

function retryable(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500
}

function retryAfter(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  const date = Date.parse(raw)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

export class DeepSeekClient {
  private readonly semaphore: Semaphore

  constructor(public readonly config: DeepSeekClientConfig) {
    this.semaphore = new Semaphore(config.concurrency)
  }

  async call(
    request: DeepSeekRequest,
    options: { effort?: VerificationEffort; signal?: AbortSignal } = {},
  ): Promise<DeepSeekCallResult> {
    return this.semaphore.use(async () => {
      const started = Date.now()
      const body: DeepSeekRequest = {
        ...request,
        ...(options.effort ? effortFields(options.effort) : {}),
      }
      let lastError: unknown
      for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
        const timeout = AbortSignal.timeout(this.config.timeoutMs)
        const signal = anySignal([options.signal, timeout])
        try {
          const response = await fetch(`${this.config.baseURL.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${this.apiKey()}`,
              'content-type': 'application/json',
              'user-agent': this.config.userAgent,
            },
            body: JSON.stringify(body),
            signal,
          })
          const text = await response.text()
          if (!response.ok) {
            const error = new DeepSeekApiError(
              `DeepSeek API returned HTTP ${response.status}`,
              response.status,
              text.slice(0, 4_000),
            )
            if (attempt < this.config.maxRetries && retryable(response.status)) {
              const delay = retryAfter(response) ?? this.backoff(attempt)
              await sleep(delay, options.signal)
              lastError = error
              continue
            }
            throw error
          }
          let parsed: DeepSeekResponse
          try {
            parsed = JSON.parse(text) as DeepSeekResponse
          } catch (error) {
            throw new DeepSeekApiError(`DeepSeek API returned malformed JSON: ${String(error)}`, response.status, text.slice(0, 4_000))
          }
          if (!Array.isArray(parsed.choices)) throw new DeepSeekApiError('DeepSeek response has no choices')
          return { response: parsed, usage: usageFromResponse(parsed), latencyMs: Date.now() - started }
        } catch (error) {
          lastError = error
          if (options.signal?.aborted) throw options.signal.reason ?? error
          if (attempt >= this.config.maxRetries || error instanceof DeepSeekApiError) throw error
          await sleep(this.backoff(attempt), options.signal)
        }
      }
      throw lastError ?? new Error('DeepSeek request failed')
    })
  }

  async generate(
    options: HarnessGenerateOptions,
    settings: { model?: string; temperature: number; maxTokens?: number; signal?: AbortSignal },
  ): Promise<GenerateCandidateResult> {
    const request = generationRequest(
      options,
      settings.model ?? options.model ?? this.config.model,
      settings.temperature,
      settings.maxTokens,
    )
    const result = await this.call(request, {
      effort: (options.reasoningEffort as VerificationEffort | undefined) ?? 'high',
      signal: settings.signal,
    })
    const choice = result.response.choices[0]
    if (!choice?.message) throw new DeepSeekApiError('DeepSeek generation returned no message')
    return {
      id: result.response.id ?? makeId('candidate'),
      content: choice.message.content ?? '',
      reasoning: choice.message.reasoning_content ?? undefined,
      toolCalls: (choice.message.tool_calls ?? []).map(call => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
      finishReason: choice.finish_reason ?? 'stop',
      usage: result.usage,
      raw: result.response,
    }
  }

  private apiKey(): string {
    const value = process.env[this.config.apiKeyEnv]?.trim()
    if (!value) throw new DeepSeekApiError(`Missing DeepSeek API key in ${this.config.apiKeyEnv}`)
    if (/[^\x20-\x7E]/.test(value)) throw new DeepSeekApiError(`Invalid characters in ${this.config.apiKeyEnv}`)
    return value
  }

  private backoff(attempt: number): number {
    const base = Math.min(
      this.config.retryMaxDelayMs,
      this.config.retryInitialDelayMs * (2 ** attempt),
    )
    return Math.max(0, base * (0.8 + Math.random() * 0.4))
  }
}
