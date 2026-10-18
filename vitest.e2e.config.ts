import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  // Two files at a time: the checks open real Electron windows and send native clicks, which time out when a dozen
  // windows compete for the machine (each file passes alone).
  test: { maxWorkers: 2, include: ['tests/e2e/**/*.e2e.ts'], environment: 'node', setupFiles: ['tests/support/setup.ts'], globalSetup: ['tests/support/e2e-global-setup.ts'], testTimeout: 600_000, hookTimeout: 60_000 }
})
