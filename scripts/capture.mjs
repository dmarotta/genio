import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { assertChildHomes, assertNoAgentLeaks, copyFixtureBase, createIsolatedHomes, realAgentHomes } from '../tests/support/isolated-homes.mjs'

const output = process.argv[2]
if (!output) throw new Error('Usage: npm run capture -- <output-dir> [app arguments]')
const real = realAgentHomes()
const homes = createIsolatedHomes('genio-capture-')
try {
  // An optional fixture Base is copied into the sandbox, never used in place.
  if (process.env.GENIO_CAPTURE_BASE) copyFixtureBase(process.env.GENIO_CAPTURE_BASE, homes.env.GENIO_HOME, homes.env)
  const env = { ...process.env, ...homes.env, GENIO_CAPTURE_ROOT: homes.root, GENIO_CAPTURE_DIR: path.resolve(output) }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  if (env.GENIO_CAPTURE_PROMPT) env.GENIO_CAPTURE_PROMPT += `\nTest capture token: ${path.basename(homes.root)}`
  for (const key of Object.keys(env)) if (key.startsWith('GIT_CONFIG_')) delete env[key]
  assertChildHomes(env)
  const electron = createRequire(import.meta.url)('electron')
  const appRoot = fileURLToPath(new URL('..', import.meta.url))
  const child = spawn(electron, [appRoot, `--user-data-dir=${path.join(homes.root, 'electron-user-data')}`, ...process.argv.slice(3)], { env, cwd: homes.root, stdio: 'inherit', windowsHide: true })
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
} finally {
  try { assertNoAgentLeaks(real, path.basename(homes.root)) } finally { homes.dispose() }
}
