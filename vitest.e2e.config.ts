import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: { include: ['tests/e2e/**/*.e2e.ts'], environment: 'node', testTimeout: 600_000, hookTimeout: 60_000 }
})
