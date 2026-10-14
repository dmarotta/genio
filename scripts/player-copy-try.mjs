// Try the player's Play copy on a throwaway repository:
//   node scripts/player-copy-try.mjs [--keep]
// Builds a small Unity-like git repository in the temp folder (a worktree, a branch with no checkout, an
// uncommitted edit, an untracked file), then ensures a player copy, syncs it from each source, prints what
// each sync changed and whether Unity would restart, and deletes the copy in the background. Never touches a
// real project or Genio's own data: everything lives under one temp folder, removed unless --keep.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PlayerCopies } from '../resources/unit-skills/genio/lib/player-copy.mjs'

const keep = process.argv.includes('--keep')
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_CONFIG')))
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Try', '-c', 'user.email=try@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', env, windowsHide: true }).trim()
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
const say = (label, value) => console.log(`${label.padEnd(22)} ${value}`)
const mb = n => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-player-copy-try-'))
const world = path.join(root, 'Demo'), data = path.join(root, 'data')
try {
  git(root, 'init', '-q', '-b', 'main', world)
  write(path.join(world, '.gitignore'), 'Game/Library/\nGame/Temp/\n')
  write(path.join(world, 'Game', 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.1f1\n')
  write(path.join(world, 'Game', 'Packages', 'manifest.json'), '{"dependencies":{}}\n')
  for (let i = 0; i < 200; i++) write(path.join(world, 'Game', 'Assets', 'Scripts', `S${i}.cs`), `class S${i} {}\n`.repeat(50))
  git(world, 'add', '.'); git(world, 'commit', '-qm', 'demo')
  write(path.join(world, 'Game', 'Library', 'ArtifactDB'), 'warm Library of the main checkout')
  const wt = path.join(root, 'worktrees', 'unit')
  git(world, 'worktree', 'add', '-q', '-b', 'unit', wt)
  write(path.join(wt, 'Game', 'Assets', 'Scripts', 'S1.cs'), 'class S1 { int changed; }\n')
  git(wt, 'commit', '-qam', 'unit change')
  write(path.join(wt, 'Game', 'Assets', 'Scripts', 'S2.cs'), 'class S2 { int uncommitted; }\n')
  write(path.join(wt, 'Game', 'Assets', 'Untracked.txt'), 'untracked\n')
  git(wt, 'checkout', '-q', '-b', 'packages')
  write(path.join(wt, 'Game', 'Packages', 'manifest.json'), '{"dependencies":{"com.unity.inputsystem":"1.19.0"}}\n')
  git(wt, 'commit', '-qm', 'packages', '--', 'Game/Packages/manifest.json'); git(wt, 'checkout', '-q', 'unit')

  const copies = new PlayerCopies(data)
  console.log(`Temp folder: ${root}\n`)
  say('Before', JSON.stringify(await copies.sizes(world, 'Game')))
  const rec = await copies.ensure(world, 'Game')
  say('Copy', rec.root)
  for (const [label, source] of [['main checkout', { path: world }], ['again, no change', { path: world }], ['unit worktree', { path: wt }], ['branch, no checkout', { ref: 'packages' }], ['main checkout', { path: world }]]) {
    const r = await copies.sync(world, source)
    const f = r.files
    say(label, `${r.elapsedMs} ms: ${f.unchanged} unchanged, ${f.added} added, ${f.updated} updated, ${f.restored} restored, ${f.deleted} deleted; ${mb(r.bytes.copied)} copied; restart: ${r.restart.needed ? r.restart.reasons.join('; ') : 'no'}${r.library?.seed?.seeded ? `; Library seeded (${r.library.seed.method})` : ''}`)
  }
  say('Sizes', JSON.stringify(await copies.sizes(world, 'Game')))
  await copies.stopped(world)
  say('Idle deadline', new Date(copies.status(world).deadline).toISOString())
  const started = Date.now()
  await copies.editorGone(world)
  say('Delete started', `${Date.now() - started} ms (runs in the background)`)
  await copies.settle()
  say('Deleted', `${Date.now() - started} ms; record ${copies.status(world) ? 'still there' : 'gone'}; folder ${fs.existsSync(rec.dir) ? 'still there' : 'gone'}`)
} finally {
  if (!keep) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 })
}
