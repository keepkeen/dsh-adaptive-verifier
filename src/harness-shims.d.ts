declare module '@deepseek-ai/cordis' {
  export interface Context {
    llm: {
      registerAdapter(providers: string[], adapter: unknown): unknown
      stream(options: import('@deepseek-ai/dsh-llm').GenerateOptions): AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk>
    }
    logger?: {
      info?: (...args: unknown[]) => void
      warn?: (...args: unknown[]) => void
    }
    get(name: string): any
    on(event: string, listener: (...args: any[]) => any): unknown
  }
  export class Service {
    constructor(ctx: Context, name: string)
  }
}

declare module '@deepseek-ai/dsh-llm' {
  export interface GenerateOptions {
    provider: string
    model: string
    messages: unknown[]
    system?: string
    tools?: unknown[]
    temperature?: number
    maxTokens?: number
    stop?: string[]
    reasoningEffort?: string
    signal?: AbortSignal
    sessionId?: string
    purpose?: string
  }
  export interface LlmResolvedModelInfo {
    provider: string
    id: string
    name: string
    description?: string
    inputModalities?: readonly string[]
    context?: { contextWindow: number }
    defaultMaxTokens?: number
    reasoning?: {
      efforts: readonly Array<{ id: unknown; name: string; description?: string }>
      defaultEffort?: unknown
    }
  }
  export type StreamChunk = any
  export class LlmAdapter {
    providerInfo(provider: string): { id: string; name: string }
    listModels(provider: string): Promise<readonly LlmResolvedModelInfo[]>
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  }
  export function createUserMessage(input: unknown): any
  export function isAgentLoopRequest(options: GenerateOptions): boolean
}
