import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { EvidenceExtractor } from '../src/evidence.js'
import { HarnessPairwiseBackend } from '../src/harness-backend.js'
import { withHarnessVerifierRoute } from '../src/harness-runtime.js'

function response(text: string, seen: Array<{ provider: string; model: string }>) {
  return async function* stream(options: { provider: string; model: string }) {
    seen.push({ provider: options.provider, model: options.model })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('Harness pairwise backend', () => {
  it('uses the inherited Harness route without touching provider credentials', async () => {
    delete process.env.DEEPSEEK_API_KEY
    const seen: Array<{ provider: string; model: string }> = []
    const ctx = { llm: { stream: response('<score_A>B</score_A>\n<score_B>R</score_B>', seen) } } as any
    const config = resolveConfig({
      cache: { enabled: false, directory: '.', memoryEntries: 10 },
      verifier: { backend: 'harness' },
    })
    const backend = new HarnessPairwiseBackend(ctx, new EvidenceExtractor(config.evidence), config)
    const observation = await withHarnessVerifierRoute(
      { provider: 'openrouter', model: 'vendor/deepseek-r1' },
      () => backend.compare(
        'task',
        { id: 'a', content: 'candidate A' },
        { id: 'b', content: 'candidate B' },
        config.verification.criteria[0]!,
        { evidenceLevel: 'partial', effort: 'off', temperature: 0, reverse: false, repeat: 0 },
      ),
    )
    expect(seen).toEqual([{ provider: 'openrouter', model: 'vendor/deepseek-r1' }])
    expect(observation.scoreA.source).toBe('categorical')
    expect(observation.scoreA.mean).toBeGreaterThan(observation.scoreB.mean)
  })

  it('allows an independent fixed verifier route', async () => {
    const seen: Array<{ provider: string; model: string }> = []
    const ctx = { llm: { stream: response('<score_A>A</score_A>\n<score_B>T</score_B>', seen) } } as any
    const config = resolveConfig({
      cache: { enabled: false, directory: '.', memoryEntries: 10 },
      verifier: { backend: 'harness', provider: 'judge-provider', model: 'judge-model' },
    })
    const backend = new HarnessPairwiseBackend(ctx, new EvidenceExtractor(config.evidence), config)
    await withHarnessVerifierRoute(
      { provider: 'generator-provider', model: 'generator-model' },
      () => backend.compare(
        'task',
        { id: 'a', content: 'candidate A' },
        { id: 'b', content: 'candidate B' },
        config.verification.criteria[0]!,
        { evidenceLevel: 'partial', effort: 'off', temperature: 0, reverse: false, repeat: 0 },
      ),
    )
    expect(seen).toEqual([{ provider: 'judge-provider', model: 'judge-model' }])
  })
})
