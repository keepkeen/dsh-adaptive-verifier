export interface GenerateOptions {
  provider: string
  model: string
  messages?: unknown[]
  system?: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  [key: string]: unknown
}

export type StreamChunk = any

export function createUserMessage(input: any): any {
  return { id: 'test-user', role: 'user', ...input }
}

export function isAgentLoopRequest(options: GenerateOptions): boolean {
  return options.__agentLoop === true
}

export class LlmAdapter {}
