import type {
  AdaptiveVerifierConfig,
  CriterionObservation,
  DeterministicAssessment,
  EvidenceLevel,
  PairCompareOptions,
  PairDecision,
  PairwiseBackend,
  RankedCandidate,
  SelectionResult,
  TokenUsage,
  VerifierCandidate,
  VerifierCriterion,
} from './types.js'
import { BudgetExceededError, VerificationBudget } from './budget.js'
import { assessEvidence, candidateFingerprint, EvidenceExtractor } from './evidence.js'
import { distributionReliability } from './score-scale.js'
import {
  addUsage,
  clamp,
  emptyUsage,
  estimateTokens,
  sigmoid,
  weightedMean,
} from './util.js'
import { mergeBudget } from './config.js'

interface PreparedCandidate {
  candidate: VerifierCandidate
  deterministic: DeterministicAssessment
  fingerprint: string
  duplicateOf?: string
  active: boolean
  provisionalWins: number
  provisionalCount: number
}

interface AggregateObservation {
  rewardA: number
  rewardB: number
  gap: number
  reliability: number
  entropy: number
  criteriaConflict: boolean
}

function criterionWeight(criterion: VerifierCriterion): number {
  return criterion.weight && criterion.weight > 0 ? criterion.weight : 1
}

function aggregateObservations(
  observations: CriterionObservation[],
  criteria: VerifierCriterion[],
): AggregateObservation {
  if (observations.length === 0) {
    return { rewardA: 0.5, rewardB: 0.5, gap: 0, reliability: 0, entropy: 1, criteriaConflict: false }
  }
  const criterionRows: Array<{
    criterion: VerifierCriterion
    rewardA: number
    rewardB: number
    reliability: number
    entropy: number
    gap: number
  }> = []
  for (const criterion of criteria) {
    const rows = observations.filter(row => row.criterionId === criterion.id)
    if (rows.length === 0) continue
    const rewardA = rows.reduce((sum, row) => sum + row.scoreA.mean, 0) / rows.length
    const rewardB = rows.reduce((sum, row) => sum + row.scoreB.mean, 0) / rows.length
    const reliability = rows.reduce((sum, row) => sum
      + Math.min(distributionReliability(row.scoreA), distributionReliability(row.scoreB)), 0) / rows.length
    const entropy = rows.reduce((sum, row) => sum
      + Math.max(row.scoreA.normalizedEntropy, row.scoreB.normalizedEntropy), 0) / rows.length
    criterionRows.push({ criterion, rewardA, rewardB, reliability, entropy, gap: rewardA - rewardB })
  }
  if (criterionRows.length === 0) {
    return { rewardA: 0.5, rewardB: 0.5, gap: 0, reliability: 0, entropy: 1, criteriaConflict: false }
  }
  const rewardA = weightedMean(criterionRows.map(row => ({ value: row.rewardA, weight: criterionWeight(row.criterion) })))
  const rewardB = weightedMean(criterionRows.map(row => ({ value: row.rewardB, weight: criterionWeight(row.criterion) })))
  const reliability = weightedMean(criterionRows.map(row => ({ value: row.reliability, weight: criterionWeight(row.criterion) })))
  const entropy = weightedMean(criterionRows.map(row => ({ value: row.entropy, weight: criterionWeight(row.criterion) })))
  const signs = criterionRows.filter(row => Math.abs(row.gap) >= 0.04).map(row => Math.sign(row.gap))
  const criteriaConflict = signs.some(sign => sign > 0) && signs.some(sign => sign < 0)
  return { rewardA, rewardB, gap: rewardA - rewardB, reliability, entropy, criteriaConflict }
}

function confidenceFor(aggregate: AggregateObservation): number {
  const gapConfidence = 1 - Math.exp(-Math.abs(aggregate.gap) / 0.08)
  const consistency = aggregate.criteriaConflict ? 0.25 : 1
  return clamp((0.56 * gapConfidence + 0.44 * aggregate.reliability) * consistency)
}

export class AdaptiveRanker {
  constructor(
    private readonly backend: PairwiseBackend,
    private readonly extractor: EvidenceExtractor,
    private readonly config: AdaptiveVerifierConfig,
  ) {}

  async compare(
    task: string,
    candidateA: VerifierCandidate,
    candidateB: VerifierCandidate,
    options: PairCompareOptions = { task },
  ): Promise<PairDecision> {
    const preparedA = this.prepare(candidateA, task)
    const preparedB = this.prepare(candidateB, task)
    const budget = new VerificationBudget(mergeBudget(this.config.budget, options.budget))
    return this.compareAdaptive(
      task,
      preparedA.candidate,
      preparedB.candidate,
      options.criteria ?? this.config.verification.criteria,
      options.evidenceLevel ?? 'full',
      budget,
      options.signal,
    )
  }

  async select(
    task: string,
    candidates: VerifierCandidate[],
    options: {
      criteria?: VerifierCriterion[]
      budget?: Partial<AdaptiveVerifierConfig['budget']>
      signal?: AbortSignal
    } = {},
  ): Promise<SelectionResult> {
    if (candidates.length === 0) throw new Error('At least one candidate is required')
    const criteria = options.criteria ?? this.config.verification.criteria
    const budget = new VerificationBudget(mergeBudget(this.config.budget, options.budget))
    const prepared = candidates.map(candidate => this.prepare(candidate, task))
    let duplicatesRemoved = 0

    if (this.config.ranking.deduplicate) {
      const firstByFingerprint = new Map<string, PreparedCandidate>()
      for (const item of prepared) {
        const prior = firstByFingerprint.get(item.fingerprint)
        if (prior) {
          item.duplicateOf = prior.candidate.id
          item.active = false
          duplicatesRemoved += 1
        } else {
          firstByFingerprint.set(item.fingerprint, item)
        }
      }
    }

    const exactPasses = prepared.filter(item => !item.duplicateOf && item.candidate.exactOutcome === 'pass')
    if (this.config.ranking.exactPassWins && exactPasses.length > 0) {
      const selected = exactPasses[0]!
      return this.finish(
        selected.candidate.id,
        prepared,
        [],
        budget,
        'exact-pass',
        duplicatesRemoved,
      )
    }

    let active = prepared.filter(item => item.active)
    if (this.config.ranking.eliminateExactFailures) {
      const nonFailures = active.filter(item => item.candidate.exactOutcome !== 'fail')
      if (nonFailures.length > 0) {
        for (const failure of active.filter(item => item.candidate.exactOutcome === 'fail')) failure.active = false
        active = nonFailures
      }
    }
    if (active.length === 1) {
      return this.finish(active[0]!.candidate.id, prepared, [], budget, 'single-survivor', duplicatesRemoved)
    }

    const decisions: PairDecision[] = []
    if (this.config.ranking.partialCascade && active.length > this.config.ranking.finalists) {
      active = await this.partialCascade(task, active, criteria, budget, decisions, options.signal)
    }

    if (active.length > this.config.ranking.finalists) {
      active = [...active].sort((a, b) => this.provisionalScore(b) - this.provisionalScore(a))
        .slice(0, this.config.ranking.finalists)
    }

    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        if (!budget.canCall()) break
        const a = active[i]!
        const b = active[j]!
        try {
          const decision = await this.compareAdaptive(
            task, a.candidate, b.candidate, criteria, 'full', budget, options.signal,
          )
          decisions.push(decision)
          this.addSoftWin(a, b, decision.preferenceA)
        } catch (error) {
          if (error instanceof BudgetExceededError) break
          throw error
        }
      }
    }

    const selected = [...active].sort((a, b) => this.provisionalScore(b) - this.provisionalScore(a))[0]!
    return this.finish(
      selected.candidate.id,
      prepared,
      decisions,
      budget,
      budget.snapshot().exhausted ? 'budget-exhausted' : 'adaptive-ranking-complete',
      duplicatesRemoved,
    )
  }

  private prepare(candidate: VerifierCandidate, task: string): PreparedCandidate {
    const evidence = candidate.evidence ?? this.extractor.fromText(candidate.content, task)
    const normalized: VerifierCandidate = {
      ...candidate,
      exactOutcome: candidate.exactOutcome ?? 'unknown',
      evidence,
    }
    return {
      candidate: normalized,
      deterministic: assessEvidence(evidence, normalized.exactOutcome),
      fingerprint: candidateFingerprint(candidate.content, candidate.artifactHash),
      active: true,
      provisionalWins: 0,
      provisionalCount: 0,
    }
  }

  private async partialCascade(
    task: string,
    initial: PreparedCandidate[],
    criteria: VerifierCriterion[],
    budget: VerificationBudget,
    decisions: PairDecision[],
    signal?: AbortSignal,
  ): Promise<PreparedCandidate[]> {
    let survivors = [...initial]
    let rescued = 0
    while (survivors.length > this.config.ranking.finalists && budget.canCall()) {
      const ordered = [...survivors].sort((a, b) => this.provisionalScore(b) - this.provisionalScore(a))
      const next: PreparedCandidate[] = []
      const used = new Set<PreparedCandidate>()
      for (let index = 0; index < Math.floor(ordered.length / 2); index++) {
        const a = ordered[index]!
        const b = ordered[ordered.length - 1 - index]!
        used.add(a); used.add(b)
        if (!budget.canCall()) {
          next.push(a, b)
          continue
        }
        try {
          const decision = await this.compareAdaptive(
            task, a.candidate, b.candidate, criteria, 'partial', budget, signal,
          )
          decisions.push(decision)
          this.addSoftWin(a, b, decision.preferenceA)
          const winner = decision.preferenceA >= 0.5 ? a : b
          const loser = winner === a ? b : a
          next.push(winner)
          if (
            decision.uncertain
            && this.config.ranking.rescueUncertainLosers
            && rescued < this.config.ranking.maxRescuedCandidates
          ) {
            next.push(loser)
            rescued += 1
          } else {
            loser.active = false
          }
        } catch (error) {
          if (error instanceof BudgetExceededError) {
            next.push(a, b)
            continue
          }
          throw error
        }
      }
      for (const item of ordered) if (!used.has(item)) next.push(item)
      const deduped = [...new Set(next)]
      if (deduped.length >= survivors.length) break
      survivors = deduped
    }
    return survivors
  }

  private async compareAdaptive(
    task: string,
    candidateA: VerifierCandidate,
    candidateB: VerifierCandidate,
    criteria: VerifierCriterion[],
    evidenceLevel: EvidenceLevel,
    budget: VerificationBudget,
    signal?: AbortSignal,
  ): Promise<PairDecision> {
    const observations: CriterionObservation[] = []
    let stopReason = 'maximum adaptive verification reached'
    const verification = this.config.verification
    const effort = evidenceLevel === 'full' ? verification.fullEffort : verification.cheapEffort
    const temperature = evidenceLevel === 'full'
      ? verification.fullTemperature
      : verification.cheapTemperature

    const run = async (criterion: VerifierCriterion, repeat: number, reverse: boolean): Promise<void> => {
      const renderedA = candidateA.evidence
        ? this.extractor.render(candidateA.evidence, evidenceLevel, candidateA.content)
        : candidateA.content
      const renderedB = candidateB.evidence
        ? this.extractor.render(candidateB.evidence, evidenceLevel, candidateB.content)
        : candidateB.content
      budget.assertCanCall(estimateTokens(task + renderedA + renderedB + criterion.description))
      const observation = await this.backend.compare(
        task, candidateA, candidateB, criterion,
        { evidenceLevel, effort, temperature, reverse, repeat, signal },
      )
      observations.push(observation)
      budget.record(observation.usage)
    }

    for (let repeat = 0; repeat < verification.initialRepeats; repeat++) {
      for (let criterionIndex = 0; criterionIndex < criteria.length; criterionIndex++) {
        const criterion = criteria[criterionIndex]!
        await run(criterion, repeat, false)
        const current = aggregateObservations(observations, criteria)
        const currentConfidence = confidenceFor(current)
        if (
          verification.criteriaEarlyExit
          && criterionIndex === 0
          && Math.abs(current.gap) >= verification.decisiveGap * 1.8
          && currentConfidence >= verification.decisiveConfidence
          && current.entropy <= verification.maxEntropyForEarlyStop
        ) {
          stopReason = 'decisive first criterion'
          return this.makeDecision(candidateA, candidateB, evidenceLevel, observations, criteria, stopReason)
        }
      }
    }

    let current = aggregateObservations(observations, criteria)
    let uncertain = this.isUncertain(current)
    if (!uncertain) {
      stopReason = 'decisive initial verification'
      return this.makeDecision(candidateA, candidateB, evidenceLevel, observations, criteria, stopReason)
    }

    if (verification.reverseOnAmbiguity && budget.canCall()) {
      for (const criterion of criteria) {
        if (!budget.canCall()) break
        await run(criterion, 0, true)
      }
      current = aggregateObservations(observations, criteria)
      uncertain = this.isUncertain(current)
      if (!uncertain) {
        stopReason = 'decisive after slot reversal'
        return this.makeDecision(candidateA, candidateB, evidenceLevel, observations, criteria, stopReason)
      }
    }

    for (let repeat = verification.initialRepeats; repeat < verification.maxRepeats && uncertain; repeat++) {
      for (const criterion of criteria) {
        if (!budget.canCall()) break
        await run(criterion, repeat, repeat % 2 === 1)
      }
      current = aggregateObservations(observations, criteria)
      uncertain = this.isUncertain(current)
      if (!uncertain) stopReason = `decisive after ${repeat + 1} repeat(s)`
    }
    if (uncertain && budget.snapshot().exhausted) stopReason = 'budget exhausted while comparison remained uncertain'
    return this.makeDecision(candidateA, candidateB, evidenceLevel, observations, criteria, stopReason)
  }

  private isUncertain(aggregate: AggregateObservation): boolean {
    const verification = this.config.verification
    return Math.abs(aggregate.gap) < verification.decisiveGap
      || confidenceFor(aggregate) < verification.decisiveConfidence
      || aggregate.entropy > verification.maxEntropyForEarlyStop
      || aggregate.criteriaConflict
  }

  private makeDecision(
    candidateA: VerifierCandidate,
    candidateB: VerifierCandidate,
    evidenceLevel: EvidenceLevel,
    observations: CriterionObservation[],
    criteria: VerifierCriterion[],
    stopReason: string,
  ): PairDecision {
    const aggregate = aggregateObservations(observations, criteria)
    const confidence = confidenceFor(aggregate)
    const correctedGap = aggregate.gap - this.config.verification.slotBias
    return {
      candidateA: candidateA.id,
      candidateB: candidateB.id,
      rewardA: aggregate.rewardA,
      rewardB: aggregate.rewardB,
      preferenceA: sigmoid(correctedGap / this.config.verification.bradleyTerryTemperature),
      gap: aggregate.gap,
      confidence,
      uncertain: this.isUncertain(aggregate),
      evidenceLevel,
      observations,
      usage: observations.reduce<TokenUsage>((usage, row) => addUsage(usage, row.usage), emptyUsage()),
      calls: observations.filter(row => !row.cacheHit).length,
      stopReason,
    }
  }

  private addSoftWin(a: PreparedCandidate, b: PreparedCandidate, preferenceA: number): void {
    a.provisionalWins += preferenceA
    a.provisionalCount += 1
    b.provisionalWins += 1 - preferenceA
    b.provisionalCount += 1
  }

  private provisionalScore(item: PreparedCandidate): number {
    if (item.candidate.exactOutcome === 'pass') return 1
    if (item.candidate.exactOutcome === 'fail') return 0
    const comparison = item.provisionalCount > 0 ? item.provisionalWins / item.provisionalCount : 0.5
    return clamp(0.82 * comparison + 0.18 * item.deterministic.score)
  }

  private finish(
    selectedId: string,
    prepared: PreparedCandidate[],
    pairDecisions: PairDecision[],
    budget: VerificationBudget,
    stoppedBy: string,
    duplicatesRemoved: number,
  ): SelectionResult {
    const byId = new Map(prepared.map(item => [item.candidate.id, item]))
    const ranking: RankedCandidate[] = prepared.map(item => {
      const source = item.duplicateOf ? byId.get(item.duplicateOf) : item
      const score = source ? this.provisionalScore(source) : 0
      return {
        id: item.candidate.id,
        score: item.duplicateOf ? Math.max(0, score - 1e-6) : score,
        comparisons: source?.provisionalCount ?? 0,
        deterministic: item.deterministic,
        duplicateOf: item.duplicateOf,
        exactOutcome: item.candidate.exactOutcome ?? 'unknown',
      }
    }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    return {
      selectedId,
      ranking,
      pairDecisions,
      usage: pairDecisions.reduce<TokenUsage>((usage, row) => addUsage(usage, row.usage), emptyUsage()),
      budget: budget.snapshot(),
      stoppedBy,
      candidatesReceived: prepared.length,
      candidatesCompared: new Set(pairDecisions.flatMap(row => [row.candidateA, row.candidateB])).size,
      duplicatesRemoved,
      exactWinner: byId.get(selectedId)?.candidate.exactOutcome === 'pass',
    }
  }
}
