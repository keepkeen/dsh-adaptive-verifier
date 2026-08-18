import { AsyncLocalStorage } from 'node:async_hooks'

export interface HarnessVerifierRoute {
  provider: string
  model: string
}

export const internalHarnessCall = new AsyncLocalStorage<boolean>()
export const harnessVerifierRoute = new AsyncLocalStorage<HarnessVerifierRoute>()

export function withHarnessVerifierRoute<T>(route: HarnessVerifierRoute, operation: () => T): T {
  return harnessVerifierRoute.run(route, operation)
}
