import type {
  EvidenceLevel,
  VerifierCandidate,
  VerifierCriterion,
} from './types.js'
import type { EvidenceExtractor } from './evidence.js'
import { truncateMiddle } from './util.js'

const SCALE = `Use exactly one letter from A through T for each candidate.
A means clearly and completely correct with strong observed verification.
B-D mean successful with only minor concerns.
E-G mean mostly correct but with meaningful residual risk.
H-J mean uncertain, leaning toward success.
K-M mean uncertain, leaning toward failure.
N-P mean substantial problems remain.
Q-S mean failed with limited partial progress.
T means clearly and completely failed.`

function candidateView(
  candidate: VerifierCandidate,
  level: EvidenceLevel,
  extractor: EvidenceExtractor,
): string {
  if (!candidate.evidence) return truncateMiddle(candidate.content, level === 'full' ? 120_000 : 12_000)
  return extractor.render(candidate.evidence, level, candidate.content)
}

export function buildPairwiseVerifierMessages(args: {
  task: string
  candidateA: VerifierCandidate
  candidateB: VerifierCandidate
  criterion: VerifierCriterion
  evidenceLevel: EvidenceLevel
  extractor: EvidenceExtractor
}): Array<Record<string, unknown>> {
  const prefix = `You are a strict verifier of an autonomous agent. Judge observed evidence, not the agent's self-assessment.
A plausible narrative is not success. Terminal output, tests, artifacts, exact requirements, and unresolved errors are stronger evidence.
Compare the two candidates independently under the requested criterion.

TASK
${args.task}

CANDIDATE A
${candidateView(args.candidateA, args.evidenceLevel, args.extractor)}

CANDIDATE B
${candidateView(args.candidateB, args.evidenceLevel, args.extractor)}

SCORING SCALE
${SCALE}`

  // Criterion intentionally stays at the tail so all criteria for the same pair share a long cacheable prefix.
  const tail = `EVALUATION CRITERION: ${args.criterion.name}
${args.criterion.description}

Return exactly these two tags and no other visible text:
<score_A>X</score_A>
<score_B>Y</score_B>
where X and Y are letters A through T.`
  return [
    { role: 'system', content: 'You verify agent trajectories and proposed actions with calibrated, evidence-grounded scoring.' },
    { role: 'user', content: `${prefix}\n\n${tail}` },
  ]
}
