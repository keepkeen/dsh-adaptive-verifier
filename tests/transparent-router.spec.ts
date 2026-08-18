import { describe, expect, it } from 'vitest'
import { installTransparentVerification } from '../src/transparent-router.js'
import { harnessVerifierRoute } from '../src/harness-runtime.js'
import { emptyUsage } from '../src/util.js'

function streamFor(label: string): AsyncIterable<any> {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: label }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: label } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' }, replayState: { label } }
  })()
}

describe('transparent Harness routing', () => {
  it('inherits generator route and separately scopes the verifier route', async () => {
    let listener: any
    const secondary: Array<{ provider: string; model: string }> = []
    const ctx = {
      on(event: string, fn: any) {
        if (event === 'llm/stream') listener = fn
        return () => {}
      },
      llm: {
        stream(options: any) {
          secondary.push({ provider: options.provider, model: options.model })
          return streamFor('secondary')
        },
      },
    }
    let verifierRoute: { provider: string; model: string } | undefined
    const core = {
      config: {
        adapter: {
          enabled: true,
          transparent: true,
          targetProviders: [],
          initialCandidates: 2,
          maxCandidates: 2,
          generationTemperature: 0.6,
          generationMaxTokens: undefined,
          actionCriteria: [],
          selectionBudget: {},
        },
        verifier: { backend: 'harness', provider: 'judge-provider', model: 'judge-model' },
      },
      async select(_task: string, candidates: any[]) {
        verifierRoute = harnessVerifierRoute.getStore()
        return {
          selectedId: candidates[1].id,
          ranking: [
            { id: candidates[1].id, score: 0.9 },
            { id: candidates[0].id, score: 0.1 },
          ],
          pairDecisions: [],
          usage: emptyUsage(),
        }
      },
    }

    installTransparentVerification(ctx as any, core as any)
    const options = {
      __agentLoop: true,
      provider: 'openrouter',
      model: 'vendor/deepseek-r1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'task' }] }],
    }
    const chunks: any[] = []
    for await (const chunk of listener(options, () => streamFor('primary'))) chunks.push(chunk)

    expect(secondary).toEqual([{ provider: 'openrouter', model: 'vendor/deepseek-r1' }])
    expect(verifierRoute).toEqual({ provider: 'judge-provider', model: 'judge-model' })
    expect(chunks.find(chunk => chunk.type === 'block-end')?.block.text).toBe('secondary')
    expect(chunks.find(chunk => chunk.type === 'finish')?.replayState).toEqual({ label: 'secondary' })
  })

  it('passes non-target providers through unchanged', async () => {
    let listener: any
    const ctx = {
      on(_event: string, fn: any) { listener = fn; return () => {} },
      llm: { stream: () => streamFor('secondary') },
    }
    const core = {
      config: {
        adapter: { enabled: true, transparent: true, targetProviders: ['deepseek-official'] },
        verifier: { backend: 'harness' },
      },
    }
    installTransparentVerification(ctx as any, core as any)
    const next = () => streamFor('passthrough')
    const chunks: any[] = []
    for await (const chunk of listener({ __agentLoop: true, provider: 'other', model: 'x' }, next)) chunks.push(chunk)
    expect(chunks.find(chunk => chunk.type === 'block-end')?.block.text).toBe('passthrough')
  })

  it('does not intercept non-agent-loop LLM calls', async () => {
    let listener: any
    const ctx = {
      on(_event: string, fn: any) { listener = fn; return () => {} },
      llm: { stream: () => streamFor('secondary') },
    }
    const core = {
      config: {
        adapter: { enabled: true, transparent: true, targetProviders: [] },
        verifier: { backend: 'harness' },
      },
    }
    installTransparentVerification(ctx as any, core as any)
    const chunks: any[] = []
    for await (const chunk of listener({ provider: 'openrouter', model: 'm' }, () => streamFor('passthrough'))) chunks.push(chunk)
    expect(chunks.find(chunk => chunk.type === 'block-end')?.block.text).toBe('passthrough')
  })
})
