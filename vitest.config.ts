import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: { include: ['tests/**/*.test.ts'], environment: 'node', setupFiles: ['tests/support/setup.ts'], globalSetup: ['tests/support/global-setup.ts'] }
})
