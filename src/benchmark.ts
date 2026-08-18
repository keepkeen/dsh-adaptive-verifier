#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { AdaptiveVerifierCore } from './core.js'
import type { AdaptiveVerifierConfig, ExactOutcome, TokenUsage, VerifierCandidate } from './types.js'
import { addUsage, emptyUsage } from './util.js'

interface LabeledCandidate {
  id: string
  content: string
  label: ExactOutcome
  artifactHash?: string
}

interface BenchmarkTask {
  id: string
  task: string
  candidates: LabeledCandidate[]
}

interface BenchmarkInput {
  tasks: BenchmarkTask[]
  config?: Partial<AdaptiveVerifierConfig>
  budget?: Partial<AdaptiveVerifierConfig['budget']>
}

function flags(): { input?: string; output?: string; limit?: number } {
  const values = process.argv.slice(2)
  const result: { input?: string; output?: string; limit?: number } = {}
  for (let index = 0; index < values.length; index++) {
    const value = values[index]
    if (value === '--input' || value === '-i') result.input = values[++index]
    else if (value === '--output' || value === '-o') result.output = values[++index]
    else if (value === '--limit') result.limit = Number(values[++index])
    else if (value === '--help' || value === '-h') {
      console.log('Usage: dsh-adaptive-benchmark --input benchmark.json [--output results.json] [--limit N]')
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
  const args = flags()
  const raw = args.input ? await readFile(args.input, 'utf8') : await stdin()
  const input = JSON.parse(raw) as BenchmarkInput
  if (!Array.isArray(input.tasks)) throw new Error('Input must contain a tasks array')
  const tasks = Number.isSafeInteger(args.limit) && (args.limit ?? 0) > 0
    ? input.tasks.slice(0, args.limit)
    : input.tasks
  const verifier = new AdaptiveVerifierCore(input.config)
  let pass1 = 0
  let oracle = 0
  let selected = 0
  let usage: TokenUsage = emptyUsage()
  const rows: unknown[] = []

  for (const item of tasks) {
    if (!item.candidates.length) continue
    const passCount = item.candidates.filter(candidate => candidate.label === 'pass').length
    pass1 += passCount / item.candidates.length
    oracle += passCount > 0 ? 1 : 0
    // Ground-truth labels are deliberately withheld from the selector.
    const candidates: VerifierCandidate[] = item.candidates.map(candidate => ({
      id: candidate.id,
      content: candidate.content,
      artifactHash: candidate.artifactHash,
      exactOutcome: 'unknown',
    }))
    const result = await verifier.select(item.task, candidates, { budget: input.budget })
    usage = addUsage(usage, result.usage)
    const label = item.candidates.find(candidate => candidate.id === result.selectedId)?.label ?? 'unknown'
    if (label === 'pass') selected += 1
    rows.push({
      id: item.id,
      selectedId: result.selectedId,
      selectedLabel: label,
      oracle: passCount > 0,
      passRate: passCount / item.candidates.length,
      stoppedBy: result.stoppedBy,
      budget: result.budget,
    })
  }

  const denominator = Math.max(1, tasks.length)
  const headroom = oracle - pass1
  const summary = {
    tasks: tasks.length,
    pass1: pass1 / denominator,
    selected: selected / denominator,
    oracle: oracle / denominator,
    recoveredOracleHeadroom: headroom > 0 ? (selected - pass1) / headroom : 0,
    usage,
    rows,
  }
  const text = `${JSON.stringify(summary, null, 2)}\n`
  if (args.output) await writeFile(args.output, text, 'utf8')
  else process.stdout.write(text)
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
