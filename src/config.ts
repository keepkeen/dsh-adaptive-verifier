import type {
  AdaptiveVerifierConfig,
  VerificationBudgetConfig,
  VerifierCriterion,
} from './types.js'

export const TRAJECTORY_CRITERIA: VerifierCriterion[] = [
  {
    id: 'specification',
    name: 'Specification adherence',
    description: 'Check exact task requirements, paths, formats, constraints, and whether the candidate solved the requested task rather than a nearby task.',
    weight: 1,
  },
  {
    id: 'output',
    name: 'Observed output and verification',
    description: 'Prefer observed terminal or test evidence over self-reported success. Check whether the final verification actually demonstrates the requested result.',
    weight: 1,
  },
  {
    id: 'errors',
    name: 'Unresolved error signals',
    description: 'Check for unresolved exceptions, failed tests, non-zero exits, missing files, timeouts, regressions, or edits made after the last successful verification.',
    weight: 1,
  },
]

export const ACTION_CRITERIA: VerifierCriterion[] = [
  {
    id: 'task_progress',
    name: 'Expected task progress',
    description: 'Which proposed response or tool action is more likely to make correct, efficient progress on the user task from the current state?',
    weight: 1,
  },
  {
    id: 'safety_and_reversibility',
    name: 'Safety and reversibility',
    description: 'Prefer actions that preserve evidence, avoid destructive or unjustified changes, and verify assumptions before committing side effects.',
    weight: 0.75,
  },
]

export const DEFAULT_BUDGET: VerificationBudgetConfig = {
  maxCalls: 12,
  maxUncachedInputTokens: 120_000,
  maxOutputTokens: 40_000,
  maxWallClockMs: 120_000,
  maxEstimatedInputTokensPerCall: 90_000,
}

export const DEFAULT_CONFIG: AdaptiveVerifierConfig = {
  deepseek: {
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    timeoutMs: 120_000,
    maxRetries: 3,
    retryInitialDelayMs: 500,
    retryMaxDelayMs: 10_000,
    concurrency: 16,
    userAgent: 'dsh-adaptive-verifier/0.2.0',
  },
  verifier: {
    backend: 'harness',
    provider: undefined,
    model: undefined,
  },
  cache: {
    enabled: true,
    directory: '.dsh-adaptive-verifier/cache',
    memoryEntries: 2_000,
  },
  evidence: {
    rawTailChars: 16_000,
    outputTailChars: 4_000,
    summaryMaxChars: 4_000,
    partialMaxChars: 12_000,
    fullMaxChars: 120_000,
    testCommandPatterns: [
      '\\bpytest\\b', '\\bpython\\s+-m\\s+pytest\\b', '\\bnpm\\s+(?:run\\s+)?test\\b',
      '\\bpnpm\\s+(?:run\\s+)?test\\b', '\\byarn\\s+test\\b', '\\bgo\\s+test\\b',
      '\\bcargo\\s+test\\b', '\\bmake\\s+(?:test|check)\\b', '\\bctest\\b',
      '\\bmvn\\s+test\\b', '\\bgradle\\s+test\\b', '\\bdotnet\\s+test\\b',
      '\\btsc\\b', '\\btypecheck\\b', '\\blint\\b', '\\bgit\\s+diff\\s+--check\\b',
    ],
    mutationPatterns: [
      '\\bapply_patch\\b', '\\bgit\\s+apply\\b', '\\bsed\\s+-i\\b', '\\bperl\\s+-pi\\b',
      '\\bcat\\s+>+', '\\btee\\b', '\\bmv\\b', '\\bcp\\b', '\\brm\\b',
      '\\bnpm\\s+install\\b', '\\bpnpm\\s+add\\b', '\\bpip\\s+install\\b',
      '\\bwrite_file\\b', '\\bedit_file\\b', '\\bcreate_file\\b',
    ],
    errorPatterns: [
      'traceback \\(most recent call last\\)', '\\bsegmentation fault\\b', '\\bcommand not found\\b',
      '\\bno such file or directory\\b', '\\btests? failed\\b', '\\bfailed tests?\\b',
      '\\bcompilation failed\\b', '\\bsyntaxerror\\b', '\\btypeerror\\b', '\\bexception\\b',
      '\\bexit code [1-9][0-9]*\\b', '\\bnon-zero exit\\b', '\\btimeout\\b',
      '\\bassertionerror\\b', '\\bpermission denied\\b', '\\bout of memory\\b',
    ],
    successPatterns: [
      '\\b0 failed\\b', '\\ball tests passed\\b', '\\btests? passed\\b', '\\bbuild succeeded\\b',
      '\\bexit code 0\\b', '\\bpassed in [0-9.]+s\\b', '\\bno errors?\\b',
    ],
  },
  verification: {
    topLogprobs: 20,
    cheapEffort: 'off',
    fullEffort: 'high',
    cheapTemperature: 0,
    fullTemperature: 0.2,
    initialRepeats: 1,
    maxRepeats: 4,
    reverseOnAmbiguity: true,
    minScoreCoverage: 0.45,
    decisiveGap: 0.12,
    decisiveConfidence: 0.72,
    maxEntropyForEarlyStop: 0.72,
    slotBias: 0,
    bradleyTerryTemperature: 0.18,
    criteriaEarlyExit: true,
    criteria: TRAJECTORY_CRITERIA,
  },
  ranking: {
    finalists: 3,
    enableDeterministicPruning: true,
    exactPassWins: true,
    eliminateExactFailures: true,
    deduplicate: true,
    partialCascade: true,
    rescueUncertainLosers: true,
    maxRescuedCandidates: 1,
  },
  budget: DEFAULT_BUDGET,
  adapter: {
    enabled: true,
    transparent: true,
    targetProviders: [],
    provider: 'deepseek-verified',
    generatorModel: undefined,
    initialCandidates: 2,
    maxCandidates: 4,
    generationTemperature: 0.6,
    generationMaxTokens: undefined,
    actionCriteria: ACTION_CRITERIA,
    selectionBudget: {
      maxCalls: 8,
      maxUncachedInputTokens: 80_000,
      maxOutputTokens: 24_000,
      maxWallClockMs: 90_000,
    },
  },
  hooks: {
    observeSessions: true,
    evidenceGate: 'advisory',
    blockFinalizationWithoutVerification: false,
    steerBeforeTurnEnd: false,
    maxSteersPerTurn: 1,
    riskyToolPatterns: [
      '\\brm\\s+-rf\\b', '\\bgit\\s+reset\\s+--hard\\b', '\\bgit\\s+clean\\s+-f',
      '\\bgit\\s+push\\b', '\\bnpm\\s+publish\\b', '\\bpnpm\\s+publish\\b',
      '\\bdeploy\\b', '\\brelease\\b', '\\bsubmit\\b',
    ],
  },
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const prior = out[key]
    out[key] = isPlainObject(prior) && isPlainObject(value)
      ? deepMerge(prior, value)
      : value
  }
  return out as T
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`)
}

function finiteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`)
}

export function resolveConfig(patch?: Partial<AdaptiveVerifierConfig>): AdaptiveVerifierConfig {
  const config = deepMerge(structuredClone(DEFAULT_CONFIG), patch ?? {})
  if (!config.deepseek.baseURL) throw new Error('deepseek.baseURL is required')
  if (!config.deepseek.model) throw new Error('deepseek.model is required')
  positiveInteger(config.deepseek.timeoutMs, 'deepseek.timeoutMs')
  positiveInteger(config.deepseek.concurrency, 'deepseek.concurrency')
  finiteNonNegative(config.deepseek.maxRetries, 'deepseek.maxRetries')
  positiveInteger(config.verification.topLogprobs, 'verification.topLogprobs')
  if (config.verification.topLogprobs > 20) throw new Error('verification.topLogprobs cannot exceed 20')
  positiveInteger(config.verification.initialRepeats, 'verification.initialRepeats')
  positiveInteger(config.verification.maxRepeats, 'verification.maxRepeats')
  if (config.verification.initialRepeats > config.verification.maxRepeats) {
    throw new Error('verification.initialRepeats cannot exceed maxRepeats')
  }
  if (!(config.verification.bradleyTerryTemperature > 0)) {
    throw new Error('verification.bradleyTerryTemperature must be positive')
  }
  if (config.verifier.backend !== 'harness' && config.verifier.backend !== 'deepseek-logprob') {
    throw new Error('verifier.backend must be harness or deepseek-logprob')
  }
  if (config.verifier.provider !== undefined && config.verifier.provider.length === 0) {
    throw new Error('verifier.provider must be non-empty when provided')
  }
  if (config.verifier.model !== undefined && config.verifier.model.length === 0) {
    throw new Error('verifier.model must be non-empty when provided')
  }
  if (config.verifier.backend === 'deepseek-logprob' && config.verifier.provider !== undefined) {
    throw new Error('verifier.provider is only valid for the harness backend; deepseek-logprob uses explicit deepseek.* transport config')
  }
  positiveInteger(config.ranking.finalists, 'ranking.finalists')
  if (!Array.isArray(config.adapter.targetProviders) || config.adapter.targetProviders.some(provider => !provider)) {
    throw new Error('adapter.targetProviders must contain non-empty provider names')
  }
  positiveInteger(config.adapter.initialCandidates, 'adapter.initialCandidates')
  positiveInteger(config.adapter.maxCandidates, 'adapter.maxCandidates')
  if (config.adapter.initialCandidates > config.adapter.maxCandidates) {
    throw new Error('adapter.initialCandidates cannot exceed maxCandidates')
  }
  for (const [key, value] of Object.entries(config.budget)) {
    positiveInteger(value, `budget.${key}`)
  }
  return config
}

export function mergeBudget(
  base: VerificationBudgetConfig,
  patch?: Partial<VerificationBudgetConfig>,
): VerificationBudgetConfig {
  return { ...base, ...(patch ?? {}) }
}
