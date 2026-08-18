import type { Context } from '@deepseek-ai/cordis'
import type { AdaptiveVerifierConfig } from './types.js'
import { AdaptiveVerifierRuntime } from './service.js'
import { VerifiedDeepSeekAdapter } from './verified-adapter.js'
import { installHarnessHooks } from './hooks.js'

export const name = 'dsh-adaptive-verifier'
export const inject = ['llm']

export function apply(ctx: Context, config?: Partial<AdaptiveVerifierConfig>): void {
  const runtime = new AdaptiveVerifierRuntime(ctx, config)
  if (runtime.config.adapter.enabled) {
    ctx.llm.registerAdapter(
      [runtime.config.adapter.provider],
      new VerifiedDeepSeekAdapter(runtime.core),
    )
  }
  installHarnessHooks(ctx, runtime)
}

export * from './service.js'
export * from './core.js'
export * from './types.js'
export * from './config.js'
