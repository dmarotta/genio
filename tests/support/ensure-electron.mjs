import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Electron 44 has no install script: its binary downloads on the first `require('electron')`, so parallel test
// workers on a fresh `npm ci` race each other ("Electron failed to install correctly"). Download it once, here,
// before any worker starts. Needs the network on that first run only.
export function ensureElectron(root = process.cwd()) {
  const dir = path.join(root, 'node_modules', 'electron')
  if (!fs.existsSync(path.join(dir, 'install.js'))) return
  if (fs.existsSync(path.join(dir, 'path.txt')) && fs.existsSync(path.join(dir, 'dist'))) return
  console.log('Downloading the Electron binary once before the tests start (first run only, needs the network)...')
  const result = spawnSync(process.execPath, [path.join(dir, 'install.js')], { cwd: dir, stdio: 'inherit' })
  if (result.status !== 0) throw new Error('The Electron binary could not be downloaded. Check the network and run `node node_modules/electron/install.js`, then run the tests again.')
}
