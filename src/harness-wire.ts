import type {
  DeepSeekRequest,
  GenerateCandidateResult,
  HarnessContentBlock,
  HarnessGenerateOptions,
  HarnessMessage,
  HarnessStreamChunk,
  TokenUsage,
} from './types.js'
import { emptyUsage, makeId, textFromUnknown } from './util.js'

function blockText(block: HarnessContentBlock): string {
  if (block.type === 'text' || block.type === 'reasoning') return block.text ?? ''
  if (block.type === 'tool-result') return (block.content ?? []).map(blockText).join('\n')
  return textFromUnknown(block)
}

function messageText(message: HarnessMessage): string {
  return message.content.filter(block => block.type !== 'reasoning' && block.type !== 'tool-call')
    .map(blockText).filter(Boolean).join('\n')
}

export function harnessMessagesToDeepSeek(options: HarnessGenerateOptions): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = []
  if (options.system) messages.push({ role: 'system', content: options.system })

  for (const message of options.messages) {
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    if (toolResults.length > 0) {
      for (const result of toolResults) {
        messages.push({
          role: 'tool',
          tool_call_id: String(result.toolCallId ?? ''),
          content: (result.content ?? []).map(blockText).join('\n') || '(no output)',
        })
      }
      continue
    }

    if (message.role === 'assistant') {
      const text = message.content.filter(block => block.type === 'text').map(blockText).join('\n')
      const reasoning = message.content.filter(block => block.type === 'reasoning').map(blockText).join('\n')
      const toolCalls = message.content.filter(block => block.type === 'tool-call').map(block => ({
        id: String(block.id ?? makeId('call')),
        type: 'function',
        function: {
          name: String(block.name ?? 'unknown_tool'),
          arguments: String(block.arguments ?? '{}'),
        },
      }))
      messages.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(toolCalls.length > 0 && reasoning ? { reasoning_content: reasoning } : {}),
      })
      continue
    }

    messages.push({ role: message.role, content: messageText(message) || '(empty message)' })
  }
  return messages
}

export function toolsToDeepSeek(
  tools: HarnessGenerateOptions['tools'],
): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }))
}

export function generationRequest(
  options: HarnessGenerateOptions,
  model: string,
  temperature: number,
  maxTokens?: number,
): DeepSeekRequest {
  return {
    model,
    messages: harnessMessagesToDeepSeek(options),
    tools: toolsToDeepSeek(options.tools),
    temperature,
    max_tokens: maxTokens ?? options.maxTokens,
    stop: options.stop,
    stream: false,
  }
}

export function candidateText(candidate: GenerateCandidateResult): string {
  const sections: string[] = []
  if (candidate.reasoning) sections.push(`[Reasoning]\n${candidate.reasoning}`)
  if (candidate.content) sections.push(`[Response]\n${candidate.content}`)
  for (const call of candidate.toolCalls) {
    sections.push(`[Tool call]\n${call.name}(${call.arguments})`)
  }
  return sections.join('\n\n') || '(empty candidate)'
}

export async function* candidateToChunks(
  candidate: GenerateCandidateResult,
  aggregateUsage: TokenUsage = candidate.usage,
): AsyncIterable<HarnessStreamChunk> {
  const blocks: HarnessContentBlock[] = candidate.blocks
    ? [...candidate.blocks]
    : []
  if (!candidate.blocks) {
    if (candidate.reasoning) blocks.push({ type: 'reasoning', text: candidate.reasoning })
    if (candidate.content) blocks.push({ type: 'text', text: candidate.content })
    for (const call of candidate.toolCalls) {
      blocks.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments })
    }
  }

  for (const [index, block] of blocks.entries()) {
    yield { type: 'block-start', index, blockType: block.type }
    if (block.type === 'reasoning' && typeof block.text === 'string') {
      yield { type: 'reasoning-delta', index, text: block.text }
    } else if (block.type === 'text' && typeof block.text === 'string') {
      yield { type: 'text-delta', index, text: block.text }
    } else if (block.type === 'tool-call') {
      yield {
        type: 'tool-call-delta',
        index,
        id: String(block.id ?? makeId('call')),
        name: typeof block.name === 'string' ? block.name : undefined,
        argumentsDelta: String(block.arguments ?? '{}'),
      }
    }
    yield { type: 'block-end', index, block }
  }

  yield {
    type: 'usage',
    usage: {
      inputTokens: aggregateUsage.inputTokens,
      outputTokens: aggregateUsage.outputTokens,
      cacheReadTokens: aggregateUsage.cacheReadTokens || undefined,
      cacheWriteTokens: aggregateUsage.cacheWriteTokens || undefined,
      reasoningTokens: aggregateUsage.reasoningTokens || undefined,
    },
  }
  yield {
    type: 'finish',
    reason: candidate.nativeFinishReason
      ?? (candidate.toolCalls.length > 0 ? { kind: 'tool-calls' } : { kind: 'stop' }),
    ...(candidate.replayState === undefined ? {} : { replayState: candidate.replayState }),
  }
}

export function emptyCandidate(id = makeId('candidate')): GenerateCandidateResult {
  return {
    id,
    content: '',
    toolCalls: [],
    finishReason: 'stop',
    usage: emptyUsage(),
    raw: { choices: [] },
  }
}
