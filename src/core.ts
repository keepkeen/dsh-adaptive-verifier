import type {
  AdaptiveVerifierConfig,
  EvidencePacket,
  PairCompareOptions,
  PairDecision,
  SelectionResult,
  VerifierCandidate,
  VerifierCriterion,
} from './types.js'
import { resolveConfig } from './config.js'
import { DeepSeekClient } from './deepseek-client.js'
import { DeepSeekPairwiseBackend } from './backend.js'
import { EvidenceExtractor, SessionEvidenceTracker } from './evidence.js'
import { AdaptiveRanker } from './ranker.js'

export class AdaptiveVerifierCore {
  readonly config: AdaptiveVerifierConfig
  readonly client: DeepSeekClient
  readonly evidence: EvidenceExtractor
  readonly tracker: SessionEvidenceTracker
  readonly backend: DeepSeekPairwiseBackend
  readonly ranker: AdaptiveRanker

  constructor(config?: Partial<AdaptiveVerifierConfig>) {
    this.config = resolveConfig(config)
    this.client = new DeepSeekClient(this.config.deepseek)
    this.evidence = new EvidenceExtractor(this.config.evidence)
    this.tracker = new SessionEvidenceTracker(this.evidence)
    this.backend = new DeepSeekPairwiseBackend(this.client, this.evidence, this.config)
    this.ranker = new AdaptiveRanker(this.backend, this.evidence, this.config)
  }

  extractEvidence(content: string, task?: string): EvidencePacket {
    return this.evidence.fromText(content, task)
  }

  extractSessionEvidence(events: unknown[], task?: string): EvidencePacket {
    return this.evidence.fromEvents(events, task)
  }

  compare(
    task: string,
    candidateA: VerifierCandidate,
    candidateB: VerifierCandidate,
    options?: Omit<PairCompareOptions, 'task'>,
  ): Promise<PairDecision> {
    return this.ranker.compare(task, candidateA, candidateB, { task, ...(options ?? {}) })
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
    return this.ranker.select(task, candidates, options)
  }
}
