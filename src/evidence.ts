import type {
  DeterministicAssessment,
  ErrorEvidence,
  EvidenceConfig,
  EvidenceLevel,
  EvidencePacket,
  MutationEvidence,
  SessionEvidenceState,
  TestRunEvidence,
} from './types.js'
import {
  compilePatterns,
  hashObject,
  matchesAny,
  normaliseWhitespace,
  tail,
  textFromUnknown,
  truncateMiddle,
  unique,
} from './util.js'

interface CompiledEvidenceConfig {
  test: RegExp[]
  mutation: RegExp[]
  error: RegExp[]
  success: RegExp[]
}

function nearby(lines: string[], index: number, radius = 4): string {
  return lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + radius + 1)).join('\n')
}

function inferExitCode(value: string): number | undefined {
  const match = /(?:exit(?:ed)?(?: with)?(?: code)?|status)\s*[:=]?\s*(-?\d+)/i.exec(value)
  return match ? Number(match[1]) : undefined
}

function inferTestStatus(value: string, compiled: CompiledEvidenceConfig): 'pass' | 'fail' | 'unknown' {
  const exitCode = inferExitCode(value)
  if (exitCode !== undefined) return exitCode === 0 ? 'pass' : 'fail'
  if (matchesAny(value, compiled.error)) return 'fail'
  if (matchesAny(value, compiled.success)) return 'pass'
  return 'unknown'
}

function extractPaths(value: string): string[] {
  const found = new Set<string>()
  for (const match of value.matchAll(/(?:^|[\s"'`])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)(?=$|[\s"'`,:])/g)) {
    if (match[1]) found.add(match[1])
  }
  for (const match of value.matchAll(/\b(?:modified|created|deleted|updated|writing|editing)\s+([A-Za-z0-9_./-]+)/gi)) {
    if (match[1]) found.add(match[1])
  }
  return [...found].slice(0, 200)
}

function lineSummary(packet: Omit<EvidencePacket, 'summary'>): string {
  const latestTest = packet.tests.at(-1)
  const unresolved = packet.errors.filter(error => !error.resolved)
  const sections = [
    `Changed files: ${packet.changedFiles.length ? packet.changedFiles.join(', ') : '(none observed)'}`,
    `Mutations: ${packet.mutations.length}`,
    `Latest test: ${latestTest ? `${latestTest.status} — ${latestTest.command}` : '(none observed)'}`,
    `Verification after last mutation: ${packet.verificationAfterLastMutation ? 'yes' : 'no'}`,
    `Unresolved error signals: ${unresolved.length}`,
  ]
  if (unresolved.length) sections.push(...unresolved.slice(-5).map(error => `- ${error.message}`))
  if (packet.finalOutput) sections.push(`Final output:\n${packet.finalOutput}`)
  return sections.join('\n')
}

export class EvidenceExtractor {
  private readonly compiled: CompiledEvidenceConfig

  constructor(public readonly config: EvidenceConfig) {
    this.compiled = {
      test: compilePatterns(config.testCommandPatterns),
      mutation: compilePatterns(config.mutationPatterns),
      error: compilePatterns(config.errorPatterns),
      success: compilePatterns(config.successPatterns),
    }
  }

  fromText(source: string, task?: string): EvidencePacket {
    const normalized = source.replace(/\r\n/g, '\n')
    const lines = normalized.split('\n')
    const tests: TestRunEvidence[] = []
    const mutations: MutationEvidence[] = []
    const errors: ErrorEvidence[] = []
    const toolCalls: string[] = []
    const claims: string[] = []
    const changedFiles = new Set<string>()

    lines.forEach((line, index) => {
      const trimmed = line.trim()
      if (!trimmed) return
      const sequence = index + 1
      if (/^(?:\[Command\]|\$|>)/.test(trimmed)) toolCalls.push(trimmed.slice(0, 500))
      if (matchesAny(trimmed, this.compiled.test)) {
        const window = nearby(lines, index)
        tests.push({
          command: trimmed.slice(0, 1_000),
          status: inferTestStatus(window, this.compiled),
          exitCode: inferExitCode(window),
          stdoutTail: tail(window, this.config.outputTailChars),
          sequence,
        })
      }
      if (matchesAny(trimmed, this.compiled.mutation)) {
        const files = extractPaths(trimmed)
        files.forEach(file => changedFiles.add(file))
        mutations.push({ description: trimmed.slice(0, 1_000), files, sequence })
      }
      if (matchesAny(trimmed, this.compiled.error)) {
        errors.push({ message: trimmed.slice(0, 1_000), kind: 'observed-error', sequence })
      }
      if (/\b(?:done|completed|fixed|solved|success(?:ful(?:ly)?)?)\b/i.test(trimmed)) {
        claims.push(trimmed.slice(0, 500))
      }
      extractPaths(trimmed).forEach(file => changedFiles.add(file))
    })

    // A later passing test can resolve earlier generic errors, but only those observed before it.
    const lastPassing = [...tests].reverse().find(test => test.status === 'pass')
    if (lastPassing) {
      for (const error of errors) {
        if (error.sequence < lastPassing.sequence) error.resolved = true
      }
    }
    const lastMutationSequence = mutations.at(-1)?.sequence
    const lastVerification = [...tests].reverse().find(test => test.status === 'pass')
    const verificationAfterLastMutation = Boolean(
      lastVerification && (lastMutationSequence === undefined || lastVerification.sequence > lastMutationSequence),
    )
    const finalOutput = tail(normalized, this.config.outputTailChars)
    const base: Omit<EvidencePacket, 'summary'> = {
      task,
      finalOutput,
      changedFiles: [...changedFiles],
      tests,
      mutations,
      errors,
      artifacts: [],
      claims,
      toolCalls,
      verificationAfterLastMutation,
      lastMutationSequence,
      lastVerificationSequence: lastVerification?.sequence,
      sourceLength: normalized.length,
      sourceHash: hashObject(normalized),
      rawTail: tail(normalized, this.config.rawTailChars),
    }
    return { ...base, summary: truncateMiddle(lineSummary(base), this.config.summaryMaxChars) }
  }

  fromEvents(events: unknown[], task?: string): EvidencePacket {
    const rows: string[] = []
    for (const [index, raw] of events.entries()) {
      const event = raw as Record<string, unknown>
      const type = typeof event.type === 'string' ? event.type : 'event'
      const data = event.data ?? event
      rows.push(`--- Event ${index + 1}: ${type} ---`)
      rows.push(textFromUnknown(data))
    }
    return this.fromText(rows.join('\n'), task)
  }

  render(packet: EvidencePacket, level: EvidenceLevel, original?: string): string {
    const common = [
      packet.task ? `Task:\n${packet.task}` : '',
      `Evidence summary:\n${packet.summary}`,
      packet.changedFiles.length ? `Changed files:\n${packet.changedFiles.join('\n')}` : '',
      packet.tests.length
        ? `Test evidence:\n${packet.tests.map(test => `${test.status.toUpperCase()} [${test.sequence}] ${test.command}\n${test.stdoutTail ?? ''}`).join('\n')}`
        : 'Test evidence: none observed',
      packet.errors.length
        ? `Error evidence:\n${packet.errors.map(error => `${error.resolved ? 'RESOLVED' : 'UNRESOLVED'} [${error.sequence}] ${error.message}`).join('\n')}`
        : 'Error evidence: none observed',
    ].filter(Boolean).join('\n\n')
    if (level === 'summary') return truncateMiddle(common, this.config.summaryMaxChars)
    const partial = [common, packet.rawTail ? `Recent trajectory:\n${packet.rawTail}` : ''].filter(Boolean).join('\n\n')
    if (level === 'partial') return truncateMiddle(partial, this.config.partialMaxChars)
    return truncateMiddle([common, original ?? packet.rawTail ?? ''].join('\n\nFull trajectory:\n'), this.config.fullMaxChars)
  }
}

export function assessEvidence(packet: EvidencePacket, exactOutcome: 'pass' | 'fail' | 'unknown' = 'unknown'): DeterministicAssessment {
  if (exactOutcome === 'pass') {
    return {
      status: 'pass', score: 1, confidence: 1, hardFailure: false,
      verifiedAfterMutation: true, reasons: ['Caller supplied exact pass outcome.'],
    }
  }
  if (exactOutcome === 'fail') {
    return {
      status: 'fail', score: 0, confidence: 1, hardFailure: true,
      verifiedAfterMutation: false, reasons: ['Caller supplied exact fail outcome.'],
    }
  }

  const unresolved = packet.errors.filter(error => !error.resolved)
  const latestTest = packet.tests.at(-1)
  const reasons: string[] = []
  let score = 0.5
  let confidence = 0.35
  let hardFailure = false

  if (latestTest?.status === 'pass') {
    score += 0.24
    confidence += 0.16
    reasons.push('Latest observed test passed.')
  } else if (latestTest?.status === 'fail') {
    score -= 0.28
    confidence += 0.22
    hardFailure = true
    reasons.push('Latest observed test failed.')
  }
  if (packet.verificationAfterLastMutation) {
    score += 0.16
    confidence += 0.16
    reasons.push('Successful verification occurred after the last observed mutation.')
  } else if (packet.mutations.length > 0) {
    score -= 0.12
    reasons.push('Changes were observed after the last successful verification, or no verification was observed.')
  }
  if (unresolved.length > 0) {
    score -= Math.min(0.3, unresolved.length * 0.07)
    confidence += Math.min(0.2, unresolved.length * 0.04)
    hardFailure ||= unresolved.length >= 2
    reasons.push(`${unresolved.length} unresolved error signal(s) remain.`)
  } else if (packet.errors.length > 0) {
    score += 0.04
    reasons.push('Earlier error signals appear to be followed by a passing verification.')
  }
  if (packet.tests.length === 0) reasons.push('No explicit test or verification command was observed.')
  const status: DeterministicStatus = score >= 0.8 && packet.verificationAfterLastMutation
    ? 'pass'
    : score <= 0.28 || hardFailure
      ? 'fail'
      : 'unknown'
  return {
    status,
    score: Math.max(0, Math.min(1, score)),
    confidence: Math.max(0, Math.min(1, confidence)),
    reasons,
    hardFailure,
    verifiedAfterMutation: packet.verificationAfterLastMutation,
  }
}

export class SessionEvidenceTracker {
  private readonly states = new Map<string, SessionEvidenceState>()

  constructor(private readonly extractor: EvidenceExtractor) {}

  observe(session: unknown, event: unknown): void {
    const id = this.sessionId(session)
    const state = this.states.get(id) ?? {
      events: [],
      packet: this.extractor.fromEvents([]),
      updatedAt: Date.now(),
    }
    state.events.push(event)
    state.packet = this.extractor.fromEvents(state.events)
    state.updatedAt = Date.now()
    this.states.set(id, state)
  }

  get(sessionOrId: unknown): SessionEvidenceState | undefined {
    return this.states.get(typeof sessionOrId === 'string' ? sessionOrId : this.sessionId(sessionOrId))
  }

  delete(sessionOrId: unknown): void {
    this.states.delete(typeof sessionOrId === 'string' ? sessionOrId : this.sessionId(sessionOrId))
  }

  private sessionId(session: unknown): string {
    if (typeof session === 'string') return session
    const record = session as Record<string, unknown> | null
    return String(record?.id ?? (record?.header as Record<string, unknown> | undefined)?.id ?? 'unknown-session')
  }
}

export function candidateFingerprint(content: string, artifactHash?: string): string {
  return hashObject({ content: normaliseWhitespace(content), artifactHash: artifactHash ?? null })
}

export function changedFilesFromPacket(packet: EvidencePacket): string[] {
  return unique(packet.changedFiles)
}
