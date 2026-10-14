import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Performance harness (`npm run perf`): measures the hot paths behind chat
 * sluggishness and main-process lag with realistic data shapes, and prints a
 * table to copy into docs/performance.md. Numbers are informative; the
 * regression guards with hard bounds live in the ordinary test suite.
 */
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: { include: ['tests/perf/**/*.perf.ts'], environment: 'node', setupFiles: ['tests/support/setup.ts'], globalSetup: ['tests/support/global-setup.ts'], testTimeout: 300_000, hookTimeout: 120_000, fileParallelism: false }
})
