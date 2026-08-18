import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AdaptiveVerifierRuntime } from './service.js'
import { compilePatterns, matchesAny, textFromUnknown } from './util.js'

function toolDescription(execution: unknown): string {
  const value = execution as Record<string, unknown>
  const tool = value.tool as Record<string, unknown> | undefined
  return [
    value.name,
    tool?.name,
    value.arguments,
    value.input,
    value.params,
  ].map(textFromUnknown).filter(Boolean).join('\n')
}

function sessionFromExecution(execution: unknown): unknown {
  const value = execution as Record<string, unknown>
  const agent = value.agent as Record<string, unknown> | undefined
  return agent?.session ?? value.session ?? (value.context as Record<string, unknown> | undefined)?.session
}

function logger(ctx: Context): { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void } {
  const candidate = (ctx as unknown as { logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void } }).logger
  return {
    info: candidate?.info?.bind(candidate) ?? console.info,
    warn: candidate?.warn?.bind(candidate) ?? console.warn,
  }
}

export function installHarnessHooks(ctx: Context, runtime: AdaptiveVerifierRuntime): void {
  const config = runtime.config.hooks
  const log = logger(ctx)
  const risky = compilePatterns(config.riskyToolPatterns)
  const steers = new Map<string, number>()

  if (config.observeSessions) {
    ctx.on('session/event', (session: unknown, event: unknown) => {
      runtime.core.tracker.observe(session, event)
    })
    ctx.on('session/disposed', (session: unknown) => {
      runtime.core.tracker.delete(session)
    })
  }

  if (config.evidenceGate !== 'off') {
    ctx.on('tools/pre-execute', async (execution: unknown, next: () => Promise<unknown>) => {
      const description = toolDescription(execution)
      if (!matchesAny(description, risky)) return next()
      const session = sessionFromExecution(execution)
      const packet = runtime.core.tracker.get(session)?.packet
      if (packet?.verificationAfterLastMutation) return next()
      const reason = 'Adaptive Verifier: risky/finalizing action lacks a successful verification after the latest observed mutation.'
      if (config.evidenceGate === 'enforce') return { kind: 'deny', reason }
      log.warn(reason, description.slice(0, 500))
      return next()
    })
  }

  if (config.steerBeforeTurnEnd) {
    ctx.on('agent/turn-stopping', async (payload: unknown) => {
      const value = payload as { agent?: { id?: string; session?: unknown; steer?: (message: unknown) => void }; turn?: number }
      const agent = value.agent
      if (!agent?.steer) return
      const packet = runtime.core.tracker.get(agent.session)?.packet
      if (!packet || packet.mutations.length === 0 || packet.verificationAfterLastMutation) return
      const key = `${String(agent.id ?? 'agent')}:${String(value.turn ?? 0)}`
      const used = steers.get(key) ?? 0
      if (used >= config.maxSteersPerTurn) return
      steers.set(key, used + 1)
      agent.steer(createUserMessage({
        content: [{
          type: 'text',
          text: 'Adaptive Verifier notice: changes were made after the last successful verification. Run the most relevant tests or inspect the final artifact before concluding.',
        }],
        source: { kind: 'plugin', plugin: 'dsh-adaptive-verifier', form: 'notice', summary: 'Verification is stale after recent changes.' },
      }))
    })
  }
}
