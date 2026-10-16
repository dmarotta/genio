// Runs before `npm run dev` and `npm start` (predev/prestart): Electron cannot show the recovery card when its
// own binary or .bin was wiped, so say what is broken here. Existence checks only; never installs anything.
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { genioInstallReport } from '../resources/unit-skills/genio/lib/node-deps.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = process.env.GENIO_HOME ? path.resolve(process.env.GENIO_HOME) : path.join(os.homedir(), '.genio')
const report = genioInstallReport(root, home)
if (!report.ok) {
  console.error(`\n${report.message}\n\n  ${report.command}\n\nMissing: ${report.missing.join(', ')}`)
  for (const l of report.linked) console.error(`Unit worktree linked to this node_modules: ${l.worktree}`)
  process.exitCode = 1
}
