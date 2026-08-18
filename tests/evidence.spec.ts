import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.js'
import { assessEvidence, EvidenceExtractor } from '../src/evidence.js'

describe('evidence extraction', () => {
  const extractor = new EvidenceExtractor(DEFAULT_CONFIG.evidence)

  it('recognizes a mutation followed by passing verification', () => {
    const packet = extractor.fromText(`
[Command] apply_patch src/main.ts
[Output] Done
[Command] npm test
[Output] 12 tests passed\nexit code 0
`, 'repair the project')
    const assessment = assessEvidence(packet)
    expect(packet.mutations.length).toBeGreaterThan(0)
    expect(packet.tests.at(-1)?.status).toBe('pass')
    expect(packet.verificationAfterLastMutation).toBe(true)
    expect(assessment.score).toBeGreaterThan(0.7)
  })

  it('flags edits after the last passing test as stale', () => {
    const packet = extractor.fromText(`
[Command] npm test
[Output] all tests passed\nexit code 0
[Command] sed -i 's/a/b/' src/main.ts
`, 'repair the project')
    expect(packet.verificationAfterLastMutation).toBe(false)
    expect(assessEvidence(packet).reasons.join(' ')).toMatch(/after the last successful verification|no verification/i)
  })

  it('identifies unresolved failures', () => {
    const packet = extractor.fromText('[Command] pytest\n[Output] 3 tests failed\nexit code 1')
    const assessment = assessEvidence(packet)
    expect(assessment.status).toBe('fail')
    expect(assessment.hardFailure).toBe(true)
  })
})
