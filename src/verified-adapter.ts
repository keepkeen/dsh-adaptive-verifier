import {
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AdaptiveVerifierCore } from './core.js'
import type {
  GenerateCandidateResult,
  HarnessContentBlock,
  HarnessGenerateOptions,
  HarnessMessage,
  TokenUsage,
  VerifierCandidate,
} from './types.js'
import { candidateText, candidateToChunks } from './harness-wire.js'
import { addUsage, emptyUsage, hashObject, textFromUnknown, truncateMiddle } from './util.js'

function blockText(block: HarnessContentBlock): string {
  if (typeof block.text === 'string') return block.text
  if (block.type === 'tool-call') return `${block.name ?? 'tool'}(${block.arguments ?? '{}'})`
  if (block.type === 'tool-result') return (block.content ?? []).map(blockText).join('\n')
  return textFromUnknown(block)
}

function stateForVerifier(options: HarnessGenerateOptions): string {
  const messages = options.messages.slice(-10).map((message: HarnessMessage) => {
    return `${message.role.toUpperCase()}:\n${message.content.map(blockText).filter(Boolean).join('\n')}`
  }).join('\n\n')
  return truncateMiddle([
    options.system ? `SYSTEM OBJECTIVE:\n${options.system}` : '',
    `CURRENT CONVERSATION STATE:\n${messages}`,
  ].filter(Boolean).join('\n\n'), 32_000)
}

function topGap(result: Awaited<ReturnType<AdaptiveVerifierCore['select']>>): number {
  const top = result.ranking[0]?.score ?? 0.5
  const second = result.ranking[1]?.score ?? 0.5
  return top - second
}

export class VerifiedDeepSeekAdapter extends LlmAdapter {
  constructor(private readonly core: AdaptiveVerifierCore) {
    super()
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: 'DeepSeek Adaptive Verified' }
  }

  override listModels(provider: string): Promise<readonly LlmResolvedModelInfo[]> {
    return Promise.resolve([{
      provider,
      id: this.core.config.adapter.generatorModel ?? this.core.config.deepseek.model,
      name: 'DeepSeek Adaptive Verified',
      description: 'Parallel candidate generation with adaptive logprob-based verification before tool execution.',
      inputModalities: ['text'],
    }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: 'DeepSeek Adaptive Verified',
      description: 'Inference-time candidate generation and adaptive selection.',
      inputModalities: ['text'],
      context: { contextWindow: 1_000_000 },
      defaultMaxTokens: this.core.config.adapter.generationMaxTokens,
      reasoning: {
        efforts: [
          { id: 'off' as never, name: 'Off' },
          { id: 'low' as never, name: 'Low' },
          { id: 'high' as never, name: 'High' },
          { id: 'max' as never, name: 'Max' },
        ],
        defaultEffort: 'high' as never,
      },
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const harnessOptions = options as unknown as HarnessGenerateOptions
    const config = this.core.config.adapter
    const generated: GenerateCandidateResult[] = []
    let generationUsage: TokenUsage = emptyUsage()
    let selectionUsage: TokenUsage = emptyUsage()
    let lastSelection: Awaited<ReturnType<AdaptiveVerifierCore['select']>> | undefined

    const generateBatch = async (count: number): Promise<void> => {
      const batch = await Promise.all(Array.from({ length: count }, () => this.core.client.generate(
        harnessOptions,
        {
          model: config.generatorModel ?? options.model ?? this.core.config.deepseek.model,
          temperature: config.generationTemperature,
          maxTokens: config.generationMaxTokens ?? options.maxTokens,
          signal: options.signal,
        },
      )))
      for (const candidate of batch) {
        generationUsage = addUsage(generationUsage, candidate.usage)
        const fingerprint = hashObject({
          content: candidate.content,
          toolCalls: candidate.toolCalls,
        })
        if (!generated.some(existing => hashObject({
          content: existing.content,
          toolCalls: existing.toolCalls,
        }) === fingerprint)) generated.push(candidate)
      }
    }

    await generateBatch(config.initialCandidates)
    if (generated.length === 0) throw new Error('All generated candidates were empty or duplicated')
    const task = stateForVerifier(harnessOptions)

    while (true) {
      const verifierCandidates: VerifierCandidate[] = generated.map((candidate, index) => ({
        id: `generation-${index}-${candidate.id}`,
        content: candidateText(candidate),
        artifactHash: hashObject({ content: candidate.content, toolCalls: candidate.toolCalls }),
        metadata: { generatedIndex: index },
      }))
      lastSelection = await this.core.select(task, verifierCandidates, {
        criteria: config.actionCriteria,
        budget: config.selectionBudget,
        signal: options.signal,
      })
      selectionUsage = addUsage(selectionUsage, lastSelection.usage)
      const ambiguous = lastSelection.pairDecisions.some(decision => decision.uncertain)
        || topGap(lastSelection) < 0.08
      if (!ambiguous || generated.length >= config.maxCandidates) break
      const before = generated.length
      await generateBatch(1)
      if (generated.length === before) break
    }

    if (!lastSelection) throw new Error('Adaptive selector did not produce a result')
    const selectedIndex = Number(
      (lastSelection.ranking.find(row => row.id === lastSelection?.selectedId)?.id ?? '')
        .match(/^generation-(\d+)-/)?.[1],
    )
    const selected = generated[Number.isSafeInteger(selectedIndex) ? selectedIndex : 0]
    if (!selected) throw new Error('Selected candidate was not found')
    const usage = addUsage(generationUsage, selectionUsage)
    for await (const chunk of candidateToChunks(selected, usage)) {
      yield chunk as StreamChunk
    }
  }
}
