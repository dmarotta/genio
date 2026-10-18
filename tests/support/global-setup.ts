import path from 'node:path'
import type { TestProject } from 'vitest/node'
import { ensureElectron } from './ensure-electron.mjs'
import { assertNoAgentLeaks, createIsolatedHomes, realAgentHomes } from './isolated-homes.mjs'

export default function setup(project: TestProject): () => void {
  ensureElectron()
  const real = realAgentHomes()
  const run = createIsolatedHomes('genio-hygiene-')
  project.provide('testRunRoot', run.root)
  return () => {
    try { assertNoAgentLeaks(real, path.basename(run.root)) } finally { run.dispose() }
  }
}
