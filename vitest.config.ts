import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-llm': fileURLToPath(new URL('./tests/support/dsh-llm.ts', import.meta.url)),
    },
  },
})
