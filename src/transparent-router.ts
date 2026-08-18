import type { Context } from '@deepseek-ai/cordis'
import { isAgentLoopRequest, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AdaptiveVerifierCore } from './core.js'
import type {
  GenerateCandidateResult,
  HarnessContentBlock,
  HarnessGenerateOptions,
  TokenUsage,
  VerifierCandidate,
} from './types.js'
import { candidateText, candidateToChunks } from './harness-wire.js'
import { addUsage, emptyUsage, hashObject, makeId, textFromUnknown, truncateMiddle } from './util.js'
import { internalHarnessCall, withHarnessVerifierRoute } from './harness-runtime.js'

function blockText(block: HarnessContentBlock): string {
  if (typeof block.text === 'string') return block.text
  if (block.type === 'tool-call') return `${block.name ?? 'tool'}(${block.arguments ?? '{}'})`
  if (block.type === 'tool-result') return (block.content ?? []).map(blockText).join('\n')
  return textFromUnknown(block)
}

function stateForVerifier(options: HarnessGenerateOptions): string {
  const messages = options.messages.slice(-10).map(message => {
    return `${message.role.toUpperCase()}:\n${message.content.map(blockText).filter(Boolean).join('\n')}`
  }).join('\n\n')
  return truncateMiddle([
    options.system ? `SYSTEM OBJECTIVE:\n${options.system}` : '',
    `CURRENT CONVERSATION STATE:\n${messages}`,
  ].filter(Boolean).join('\n\n'), 32_000)
}

function usageFromHarness(value: Record<string, unknown> | undefined): TokenUsage {
  if (!value) return emptyUsage()
  const number = (key: string): number => {
    const raw = value[key]
    return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, raw) : 0
  }
  return {
    calls: 1,
    inputTokens: number('inputTokens'),
    cacheReadTokens: number('cacheReadTokens'),
    cacheWriteTokens: number('cacheWriteTokens'),
    outputTokens: number('outputTokens'),
    reasoningTokens: number('reasoningTokens'),
  }
}

async function collectCandidate(
  stream: AsyncIterable<StreamChunk>,
  id = makeId('candidate'),
): Promise<GenerateCandidateResult> {
  const blocks: HarnessContentBlock[] = []
  let usage = emptyUsage()
  let nativeFinishReason: Record<string, unknown> | undefined
  let replayState: unknown

  for await (const rawChunk of stream) {
    const chunk = rawChunk as unknown as Record<string, unknown>
    if (chunk.type === 'block-end' && chunk.block && typeof chunk.block === 'object') {
      blocks.push(structuredClone(chunk.block) as HarnessContentBlock)
      continue
    }
    if (chunk.type === 'usage') {
      usage = usageFromHarness(chunk.usage as Record<string, unknown> | undefined)
      continue
    }
    if (chunk.type === 'finish') {
      const reason = (chunk.reason && typeof chunk.reason === 'object')
        ? chunk.reason as Record<string, unknown>
        : { kind: 'stop' }
      const kind = typeof reason.kind === 'string' ? reason.kind : 'stop'
      if (kind === 'error' || kind === 'aborted') {
        const failure = reason.failure as { message?: unknown } | undefined
        throw new Error(typeof failure?.message === 'string'
          ? failure.message
          : `Upstream Harness model call ended with ${kind}`)
      }
      nativeFinishReason = structuredClone(reason)
      replayState = chunk.replayState
    }
  }

  const content = blocks
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('')
  const reasoning = blocks
    .filter(block => block.type === 'reasoning')
    .map(block => block.text ?? '')
    .join('')
  const toolCalls = blocks
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: String(block.id ?? makeId('call')),
      name: String(block.name ?? 'unknown_tool'),
      arguments: String(block.arguments ?? '{}'),
    }))

  return {
    id,
    content,
    ...(reasoning ? { reasoning } : {}),
    toolCalls,
    finishReason: typeof nativeFinishReason?.kind === 'string'
      ? nativeFinishReason.kind
      : toolCalls.length > 0 ? 'tool-calls' : 'stop',
    usage,
    raw: { source: 'harness-stream' },
    blocks,
    ...(replayState === undefined ? {} : { replayState }),
    ...(nativeFinishReason === undefined ? {} : { nativeFinishReason }),
  }
}

function topGap(result: Awaited<ReturnType<AdaptiveVerifierCore['select']>>): number {
  const top = result.ranking[0]?.score ?? 0.5
  const second = result.ranking[1]?.score ?? 0.5
  return top - second
}

/**
 * Transparently enhance selected Harness provider routes without changing the
 * provider/model recorded by the Agent. Internal sampling re-enters ctx.llm
 * under an AsyncLocalStorage bypass so this middleware never verifies itself.
 */
export function installTransparentVerification(ctx: Context, core: AdaptiveVerifierCore): () => void {
  return ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    const config = core.config.adapter
    if (
      internalHarnessCall.getStore() === true
      || !config.enabled
      || !config.transparent
      || !isAgentLoopRequest(options)
      || (config.targetProviders.length > 0 && !config.targetProviders.includes(options.provider))
    ) return next()

    return (async function* verified(): AsyncIterable<StreamChunk> {
      const harnessOptions = options as unknown as HarnessGenerateOptions
      const generated: GenerateCandidateResult[] = []
      let generationUsage = emptyUsage()
      let selectionUsage = emptyUsage()
      let firstUnderlyingCallAvailable = true
      let lastSelection: Awaited<ReturnType<AdaptiveVerifierCore['select']>> | undefined

      const addCandidate = (candidate: GenerateCandidateResult): void => {
        generationUsage = addUsage(generationUsage, candidate.usage)
        const fingerprint = hashObject({
          blocks: candidate.blocks,
          content: candidate.content,
          reasoning: candidate.reasoning,
          toolCalls: candidate.toolCalls,
        })
        if (!generated.some(existing => hashObject({
          blocks: existing.blocks,
          content: existing.content,
          reasoning: existing.reasoning,
          toolCalls: existing.toolCalls,
        }) === fingerprint)) generated.push(candidate)
      }

      const secondaryOptions = (): GenerateOptions => ({
        ...options,
        temperature: options.temperature ?? config.generationTemperature,
        maxTokens: config.generationMaxTokens ?? options.maxTokens,
      })

      const generateSecondary = (): Promise<GenerateCandidateResult> => internalHarnessCall.run(
        true,
        () => collectCandidate(ctx.llm.stream(secondaryOptions())),
      )

      const generateBatch = async (count: number): Promise<void> => {
        if (count <= 0) return
        const jobs: Array<Promise<GenerateCandidateResult>> = []
        let primaryIndex = -1
        if (firstUnderlyingCallAvailable) {
          firstUnderlyingCallAvailable = false
          primaryIndex = jobs.length
          jobs.push(collectCandidate(next()))
        }
        while (jobs.length < count) jobs.push(generateSecondary())

        const settled = await Promise.allSettled(jobs)
        const primaryResult = primaryIndex >= 0 ? settled[primaryIndex] : undefined
        if (primaryResult?.status === 'rejected') throw primaryResult.reason
        for (const result of settled) {
          if (result.status === 'fulfilled') addCandidate(result.value)
        }
      }

      await generateBatch(config.initialCandidates)
      if (generated.length === 0) throw new Error('All inherited Harness generations failed or duplicated')
      const task = stateForVerifier(harnessOptions)

      while (true) {
        const verifierCandidates: VerifierCandidate[] = generated.map((candidate, index) => ({
          id: `generation-${index}-${candidate.id}`,
          content: candidateText(candidate),
          artifactHash: hashObject({ blocks: candidate.blocks, toolCalls: candidate.toolCalls }),
          metadata: {
            generatedIndex: index,
            inheritedProvider: options.provider,
            inheritedModel: options.model,
          },
        }))

        const verifierRoute = {
          provider: core.config.verifier.provider ?? options.provider,
          model: core.config.verifier.model ?? options.model,
        }
        lastSelection = await withHarnessVerifierRoute(verifierRoute, () => core.select(task, verifierCandidates, {
          criteria: config.actionCriteria,
          budget: config.selectionBudget,
          signal: options.signal,
        }))
        selectionUsage = addUsage(selectionUsage, lastSelection.usage)
        const ambiguous = lastSelection.pairDecisions.some(decision => decision.uncertain)
          || topGap(lastSelection) < 0.08
        if (!ambiguous || generated.length >= config.maxCandidates) break
        const before = generated.length
        await generateBatch(1)
        if (generated.length === before) break
      }

      if (!lastSelection) throw new Error('Adaptive selector did not produce a result')
      const selectedId = lastSelection.selectedId
      const selectedRow = lastSelection.ranking.find(row => row.id === selectedId)
      const selectedIndex = Number(selectedRow?.id.match(/^generation-(\d+)-/)?.[1])
      const selected = generated[Number.isSafeInteger(selectedIndex) ? selectedIndex : 0]
      if (!selected) throw new Error('Selected inherited Harness candidate was not found')

      const aggregateUsage = addUsage(generationUsage, selectionUsage)
      for await (const chunk of candidateToChunks(selected, aggregateUsage)) {
        yield chunk as unknown as StreamChunk
      }
    })()
  }) as unknown as () => void
}
