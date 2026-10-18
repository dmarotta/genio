import path from 'node:path'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import type { TestProject } from 'vitest/node'
import setupGlobal from './global-setup'

// The e2e files each start their own Vite server over the renderer, and on a fresh checkout they all optimise the
// dependencies into node_modules/.vite/deps at once and rename each other's folders away. Optimise once here first.
export default async function setup(project: TestProject): Promise<() => void> {
  const dispose = setupGlobal(project)
  const server = await createServer({
    configFile: false, root: path.resolve('src/renderer'), logLevel: 'error', server: { middlewareMode: true },
    resolve: { alias: { '@shared': path.resolve('src/shared'), '@': path.resolve('src/renderer/src') } },
    plugins: [react()],
    optimizeDeps: { entries: ['index.html', 'viewer3d.html'] }
  })
  try { await server.environments.client.depsOptimizer?.scanProcessing } finally { await server.close() }
  return dispose
}
