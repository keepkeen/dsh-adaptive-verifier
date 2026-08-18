#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { AdaptiveVerifierCore } from './core.js'
import type { AdaptiveVerifierConfig, VerifierCandidate } from './types.js'

interface CliInput {
  task: string
  candidates: VerifierCandidate[]
  config?: Partial<AdaptiveVerifierConfig>
  budget?: Partial<AdaptiveVerifierConfig['budget']>
}

function args(): { input?: string; output?: string; evidenceOnly: boolean } {
  const values = process.argv.slice(2)
  const result = { evidenceOnly: false } as { input?: string; output?: string; evidenceOnly: boolean }
  for (let index = 0; index < values.length; index++) {
    const value = values[index]
    if (value === '--input' || value === '-i') result.input = values[++index]
    else if (value === '--output' || value === '-o') result.output = values[++index]
    else if (value === '--evidence-only') result.evidenceOnly = true
    else if (value === '--help' || value === '-h') {
      console.log('Usage: dsh-adaptive-verify --input candidates.json [--output result.json] [--evidence-only]')
      process.exit(0)
    }
  }
  return result
}

async function stdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  const flags = args()
  const raw = flags.input ? await readFile(flags.input, 'utf8') : await stdin()
  const input = JSON.parse(raw) as CliInput
  if (!input.task || !Array.isArray(input.candidates) || input.candidates.length === 0) {
    throw new Error('Input must contain task and a non-empty candidates array')
  }
  const verifier = new AdaptiveVerifierCore(input.config)
  const output = flags.evidenceOnly
    ? {
        task: input.task,
        candidates: input.candidates.map(candidate => ({
          id: candidate.id,
          evidence: verifier.extractEvidence(candidate.content, input.task),
        })),
      }
    : await verifier.select(input.task, input.candidates, { budget: input.budget })
  const text = `${JSON.stringify(output, null, 2)}\n`
  if (flags.output) await writeFile(flags.output, text, 'utf8')
  else process.stdout.write(text)
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
