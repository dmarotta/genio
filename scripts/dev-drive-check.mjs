// Final Dev Drive check, run by the player once the drive exists:
//   node scripts/dev-drive-check.mjs <project folder> [--library <Library folder to time a real clone>]
// Probes the project's volume, block clones a scratch folder on it, and verifies with
// fsutil file queryExtentsAndRefCounts that the copy shares blocks. Writes only under
// <drive>\.genio\dev-drive-check-*, which it deletes again. Never changes a volume.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { cloneMethod, probeClone, seedTree, volumeHome, volumePlacement, windowsBuild } from '../resources/unit-skills/genio/skills/play/scripts/clone.mjs'
import { seedLibrary } from '../resources/unit-skills/genio/lib/unity-seed.mjs'

const args = process.argv.slice(2)
const at = args.indexOf('--library')
const library = at >= 0 ? args[at + 1] : undefined
const project = args.find((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1))
if (!project || !fs.existsSync(project)) { console.error('Usage: node scripts/dev-drive-check.mjs <project folder> [--library <Library folder>]'); process.exit(2) }
const home = process.env.GENIO_HOME ? path.resolve(process.env.GENIO_HOME) : path.join(os.homedir(), '.genio')
const data = path.join(home, 'data')
const say = (label, value) => console.log(`${label.padEnd(18)} ${value}`)
const failures = []

const build = windowsBuild()
say('Windows build', `${build} (${cloneMethod(build) === 'copyfile' ? '24H2 or later: CopyFile clones by itself' : 'before 24H2: Genio uses its FSCTL clone helper'})`)
const volume = await volumePlacement(project, data)
say('Slots and worktrees', volume ? `on the project's drive, under ${volumeHome(data, volume)} and ${volumeHome(home, volume)}` : `stay in ${home} (the project's drive does not block clone, or it is Genio's own drive)`)

const scratch = path.join(path.parse(path.resolve(project)).root, '.genio', `dev-drive-check-${randomUUID().slice(0, 8)}`)
const probe = await probeClone(project, scratch)
say('Project volume', probe.capable ? `${probe.volume.root} ${probe.volume.fs}, ${probe.volume.cluster}-byte clusters, block cloning supported` : probe.reason)
if (!probe.capable) failures.push(probe.reason)
else {
  try {
    const source = path.join(scratch, 'source')
    fs.mkdirSync(path.join(source, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(source, 'nested', 'large.bin'), Buffer.alloc(8 * 1024 * 1024, 0x5a))
    fs.writeFileSync(path.join(source, 'small.txt'), 'copied normally')
    const result = await seedTree(source, path.join(scratch, 'copy'), { data: scratch, fallback: async () => {} })
    say('Test clone', result.method === 'clone' ? `${result.via}: ${result.cloned} cloned, ${result.copied} copied in ${result.ms} ms` : result.reason)
    say('Shared blocks', result.verified === true ? 'yes (fsutil shows refcounts above 1)' : result.verified === false ? 'NO: fsutil shows no shared blocks' : 'unknown: fsutil output could not be read')
    if (result.method !== 'clone') failures.push(result.reason)
    else if (result.verified !== true) failures.push('fsutil did not confirm shared blocks')
    const same = fs.readFileSync(path.join(scratch, 'copy', 'nested', 'large.bin')).equals(fs.readFileSync(path.join(source, 'nested', 'large.bin')))
    if (!same) failures.push('the cloned file differs from its source')
    if (library) {
      // The same seeding Play slots and unit worktrees use, so the timing is what Genio will see.
      const timed = await seedLibrary(path.join(scratch, 'project'), library, { data: scratch })
      const how = `${timed.method}: ${timed.files} files, ${((timed.bytes ?? 0) / 2 ** 30).toFixed(2)} GiB in ${(timed.elapsedMs / 1000).toFixed(1)} s`
      say('Library seed', timed.seeded ? how + (timed.clone?.reason ? ` (${timed.clone.reason})` : '') : timed.reason)
      if (!timed.method?.startsWith('clone:')) failures.push(`Library was not cloned: ${timed.clone?.reason ?? timed.reason}`)
    }
  } catch (e) { failures.push(e.message) } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
    try { fs.rmdirSync(path.dirname(scratch)) } catch { /* Genio's own folder on the drive stays. */ }
  }
}
console.log(failures.length ? `\nFAILED: ${failures.join('; ')}` : '\nPASSED: Genio will block clone Play slot copies on this drive.')
process.exitCode = failures.length ? 1 : 0
