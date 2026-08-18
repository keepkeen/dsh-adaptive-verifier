export type VerificationEffort = 'off' | 'low' | 'high' | 'max'
export type EvidenceLevel = 'summary' | 'partial' | 'full'
export type ExactOutcome = 'pass' | 'fail' | 'unknown'
export type DeterministicStatus = 'pass' | 'fail' | 'unknown'

export interface TokenUsage {
  calls: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
}

export interface ScoreTokenProbability {
  token: string
  probability: number
  value: number
}

export interface ScoreDistribution {
  mean: number
  variance: number
  entropy: number
  normalizedEntropy: number
  coverage: number
  actualToken?: string
  /** How this score distribution was obtained. */
  source?: 'logprob' | 'categorical'
  probabilities: ScoreTokenProbability[]
}

export interface TestRunEvidence {
  command: string
  status: 'pass' | 'fail' | 'unknown'
  exitCode?: number
  stdoutTail?: string
  stderrTail?: string
  sequence: number
}

export interface MutationEvidence {
  description: string
  files: string[]
  sequence: number
}

export interface ErrorEvidence {
  message: string
  kind: string
  sequence: number
  resolved?: boolean
}

export interface ArtifactEvidence {
  path: string
  exists?: boolean
  hash?: string
  summary?: string
}

export interface EvidencePacket {
  task?: string
  summary: string
  finalOutput?: string
  changedFiles: string[]
  tests: TestRunEvidence[]
  mutations: MutationEvidence[]
  errors: ErrorEvidence[]
  artifacts: ArtifactEvidence[]
  claims: string[]
  toolCalls: string[]
  verificationAfterLastMutation: boolean
  lastMutationSequence?: number
  lastVerificationSequence?: number
  sourceLength: number
  sourceHash: string
  rawTail?: string
}

export interface DeterministicAssessment {
  status: DeterministicStatus
  score: number
  confidence: number
  reasons: string[]
  hardFailure: boolean
  verifiedAfterMutation: boolean
}

export interface VerifierCriterion {
  id: string
  name: string
  description: string
  weight?: number
}

export interface VerifierCandidate {
  id: string
  content: string
  evidence?: EvidencePacket
  exactOutcome?: ExactOutcome
  artifactHash?: string
  metadata?: Record<string, unknown>
}

export interface PairCompareOptions {
  task: string
  criteria?: VerifierCriterion[]
  evidenceLevel?: EvidenceLevel
  signal?: AbortSignal
  budget?: Partial<VerificationBudgetConfig>
}

export interface CriterionObservation {
  criterionId: string
  direction: 'forward' | 'reverse'
  repeat: number
  scoreA: ScoreDistribution
  scoreB: ScoreDistribution
  rawText?: string
  usage: TokenUsage
  cacheHit: boolean
}

export interface PairDecision {
  candidateA: string
  candidateB: string
  rewardA: number
  rewardB: number
  preferenceA: number
  gap: number
  confidence: number
  uncertain: boolean
  evidenceLevel: EvidenceLevel
  observations: CriterionObservation[]
  usage: TokenUsage
  calls: number
  stopReason: string
}

export interface RankedCandidate {
  id: string
  score: number
  comparisons: number
  deterministic: DeterministicAssessment
  duplicateOf?: string
  exactOutcome: ExactOutcome
}

export interface SelectionResult {
  selectedId: string
  ranking: RankedCandidate[]
  pairDecisions: PairDecision[]
  usage: TokenUsage
  budget: VerificationBudgetSnapshot
  stoppedBy: string
  candidatesReceived: number
  candidatesCompared: number
  duplicatesRemoved: number
  exactWinner: boolean
}

export interface VerificationBudgetConfig {
  maxCalls: number
  maxUncachedInputTokens: number
  maxOutputTokens: number
  maxWallClockMs: number
  maxEstimatedInputTokensPerCall: number
}

export interface VerificationBudgetSnapshot extends TokenUsage {
  elapsedMs: number
  exhausted: boolean
  exhaustionReason?: string
}

export interface DeepSeekClientConfig {
  apiKeyEnv: string
  baseURL: string
  model: string
  timeoutMs: number
  maxRetries: number
  retryInitialDelayMs: number
  retryMaxDelayMs: number
  concurrency: number
  userAgent: string
}

export interface CacheConfig {
  enabled: boolean
  directory: string
  memoryEntries: number
}

export interface EvidenceConfig {
  rawTailChars: number
  outputTailChars: number
  summaryMaxChars: number
  partialMaxChars: number
  fullMaxChars: number
  testCommandPatterns: string[]
  mutationPatterns: string[]
  errorPatterns: string[]
  successPatterns: string[]
}

export interface VerificationConfig {
  topLogprobs: number
  cheapEffort: VerificationEffort
  fullEffort: VerificationEffort
  cheapTemperature: number
  fullTemperature: number
  initialRepeats: number
  maxRepeats: number
  reverseOnAmbiguity: boolean
  minScoreCoverage: number
  decisiveGap: number
  decisiveConfidence: number
  maxEntropyForEarlyStop: number
  slotBias: number
  bradleyTerryTemperature: number
  criteriaEarlyExit: boolean
  criteria: VerifierCriterion[]
}

export interface RankingConfig {
  finalists: number
  enableDeterministicPruning: boolean
  exactPassWins: boolean
  eliminateExactFailures: boolean
  deduplicate: boolean
  partialCascade: boolean
  rescueUncertainLosers: boolean
  maxRescuedCandidates: number
}

export interface VerifierRouteConfig {
  /** Harness is provider-agnostic. DeepSeek logprob mode is an explicit provider-specific opt-in. */
  backend: 'harness' | 'deepseek-logprob'
  /** Optional fixed Harness provider for verifier calls. Omit to inherit the current agent request route. */
  provider?: string
  /** Optional fixed verifier model. Omit to inherit the current agent request model in Harness mode. */
  model?: string
}

export interface VerifiedAdapterConfig {
  enabled: boolean
  /** Transparent mode keeps the Harness-selected provider/model and intercepts agent-loop requests. */
  transparent: boolean
  /** Optional provider filter. Empty means every Harness agent-loop provider. */
  targetProviders: string[]
  /** Legacy explicit provider route used only when transparent=false. */
  provider: string
  /** Legacy explicit generator override used only when transparent=false. */
  generatorModel?: string
  initialCandidates: number
  maxCandidates: number
  generationTemperature: number
  generationMaxTokens?: number
  actionCriteria: VerifierCriterion[]
  selectionBudget: Partial<VerificationBudgetConfig>
}

export interface HookConfig {
  observeSessions: boolean
  evidenceGate: 'off' | 'advisory' | 'enforce'
  blockFinalizationWithoutVerification: boolean
  steerBeforeTurnEnd: boolean
  maxSteersPerTurn: number
  riskyToolPatterns: string[]
}

export interface AdaptiveVerifierConfig {
  /** Standalone / explicit DeepSeek-logprob backend configuration only. */
  deepseek: DeepSeekClientConfig
  /** Independent verifier routing. Never inferred by parsing generator credentials. */
  verifier: VerifierRouteConfig
  cache: CacheConfig
  evidence: EvidenceConfig
  verification: VerificationConfig
  ranking: RankingConfig
  budget: VerificationBudgetConfig
  adapter: VerifiedAdapterConfig
  hooks: HookConfig
}

export interface DeepSeekTopLogprob {
  token: string
  logprob: number
  bytes?: number[]
}

export interface DeepSeekTokenLogprob {
  token: string
  logprob: number
  bytes?: number[]
  top_logprobs?: DeepSeekTopLogprob[]
}

export interface DeepSeekChoice {
  index?: number
  message?: {
    role?: string
    content?: string | null
    reasoning_content?: string | null
    tool_calls?: Array<{
      id: string
      type?: string
      function: { name: string; arguments: string }
    }>
  }
  finish_reason?: string | null
  logprobs?: {
    content?: DeepSeekTokenLogprob[] | null
    reasoning_content?: DeepSeekTokenLogprob[] | null
  } | null
}

export interface DeepSeekUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

export interface DeepSeekResponse {
  id?: string
  model?: string
  choices: DeepSeekChoice[]
  usage?: DeepSeekUsage
}

export interface DeepSeekRequest {
  model: string
  messages: Array<Record<string, unknown>>
  tools?: Array<Record<string, unknown>>
  temperature?: number
  max_tokens?: number
  stream?: boolean
  logprobs?: boolean
  top_logprobs?: number
  thinking?: { type: 'enabled' | 'disabled' }
  reasoning_effort?: 'low' | 'high' | 'max'
  stop?: string[]
}

export interface DeepSeekCallResult {
  response: DeepSeekResponse
  usage: TokenUsage
  latencyMs: number
}

export interface GenerateCandidateResult {
  id: string
  content: string
  reasoning?: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  finishReason: string
  usage: TokenUsage
  raw: unknown
  /** Original provider-neutral assistant blocks when generated through Harness. */
  blocks?: HarnessContentBlock[]
  /** Adapter-private replay state from the winning upstream stream. */
  replayState?: unknown
  /** Original provider-neutral finish reason from the winning upstream stream. */
  nativeFinishReason?: Record<string, unknown>
}

export interface PairwiseBackend {
  compare(
    task: string,
    candidateA: VerifierCandidate,
    candidateB: VerifierCandidate,
    criterion: VerifierCriterion,
    options: {
      evidenceLevel: EvidenceLevel
      effort: VerificationEffort
      temperature: number
      reverse: boolean
      repeat: number
      signal?: AbortSignal
    },
  ): Promise<CriterionObservation>
}

export interface HarnessContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  arguments?: string
  toolCallId?: string
  content?: HarnessContentBlock[]
  isError?: boolean
  [key: string]: unknown
}

export interface HarnessMessage {
  id?: string
  role: 'system' | 'user' | 'assistant'
  content: HarnessContentBlock[]
  source?: Record<string, unknown>
}

export interface HarnessGenerateOptions {
  provider: string
  model: string
  messages: HarnessMessage[]
  system?: string
  tools?: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }>
  temperature?: number
  maxTokens?: number
  stop?: string[]
  reasoningEffort?: string
  signal?: AbortSignal
  sessionId?: string
  purpose?: string
}

export type HarnessStreamChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: HarnessContentBlock }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number } }
  | { type: 'finish'; reason: Record<string, unknown>; replayState?: unknown }

export interface SessionEvidenceState {
  events: unknown[]
  packet: EvidencePacket
  updatedAt: number
}
