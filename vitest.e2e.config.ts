import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: { include: ['tests/e2e/**/*.e2e.ts'], environment: 'node', setupFiles: ['tests/support/setup.ts'], globalSetup: ['tests/support/e2e-global-setup.ts'], testTimeout: 600_000, hookTimeout: 60_000 }
})
