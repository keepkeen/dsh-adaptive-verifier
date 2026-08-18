import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  AdaptiveVerifierConfig,
  EvidencePacket,
  PairCompareOptions,
  PairDecision,
  SelectionResult,
  VerifierCandidate,
  VerifierCriterion,
} from './types.js'
import { AdaptiveVerifierCore } from './core.js'
import { resolveConfig } from './config.js'
import { HarnessPairwiseBackend } from './harness-backend.js'

export class AdaptiveVerifierRuntime extends Service {
  readonly core: AdaptiveVerifierCore

  constructor(ctx: Context, config?: Partial<AdaptiveVerifierConfig>) {
    super(ctx, 'adaptiveVerifier')
    const resolved = resolveConfig(config)
    this.core = resolved.verifier.backend === 'harness'
      ? new AdaptiveVerifierCore(resolved, (extractor, effective) => (
          new HarnessPairwiseBackend(ctx, extractor, effective)
        ))
      : new AdaptiveVerifierCore(resolved)
  }

  get config(): AdaptiveVerifierConfig {
    return this.core.config
  }

  extractEvidence(content: string, task?: string): EvidencePacket {
    return this.core.extractEvidence(content, task)
  }

  extractSessionEvidence(events: unknown[], task?: string): EvidencePacket {
    return this.core.extractSessionEvidence(events, task)
  }

  compare(
    task: string,
    candidateA: VerifierCandidate,
    candidateB: VerifierCandidate,
    options?: Omit<PairCompareOptions, 'task'>,
  ): Promise<PairDecision> {
    return this.core.compare(task, candidateA, candidateB, options)
  }

  select(
    task: string,
    candidates: VerifierCandidate[],
    options?: {
      criteria?: VerifierCriterion[]
      budget?: Partial<AdaptiveVerifierConfig['budget']>
      signal?: AbortSignal
    },
  ): Promise<SelectionResult> {
    return this.core.select(task, candidates, options)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    adaptiveVerifier: AdaptiveVerifierRuntime
  }
}
