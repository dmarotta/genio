import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StartLog, StartPhases } from '../src/main/player-start'
import type { PlayerStartPhase } from '../src/shared/play'

// Excerpts of the Play start speed Recon's real editor.log evidence: a cold start (run 3, no PackageCache, full
// recompile, imports) and the second start of a kept copy (G2, packages restored from cache, one Bee node).
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures/play-start', name), 'utf8').split(/\r?\n/)
/** Feeds a log one line per second; returns the phases in the order they showed and the parser. */
function replay(lines: string[], cold: boolean) {
  const p = new StartPhases(0, cold), seen: PlayerStartPhase[] = ['opening']
  lines.forEach((line, n) => { p.line(line, (n + 1) * 1000); if (seen.at(-1) !== p.phase) seen.push(p.phase) })
  return { p, seen }
}

describe('reading the start phase from editor.log', () => {
  it('follows a cold start through every phase, unpacking packages only when the PackageCache was missing', () => {
    const lines = fixture('cold-editor.txt')
    const { p, seen } = replay(lines, true)
    expect(seen).toEqual(['opening', 'packages', 'compiling', 'loading', 'importing', 'scene'])
    expect(p.complete).toBe(true)
    // The first domain reload, before the refresh, is still opening.
    const early = new StartPhases(0, true)
    for (const line of lines.slice(0, lines.findIndex(l => l.startsWith('Domain Reload Profiling')) + 1)) early.line(line, 1)
    expect(early.phase).toBe('opening'); expect(early.recognized).toBe(true); expect(early.complete).toBe(false)
  })

  it('follows the second start of a kept copy: no unpacking, a one-node compile, then loading, importing and the scene', () => {
    const { p, seen } = replay(fixture('warm-editor.txt'), false)
    expect(seen).toEqual(['opening', 'compiling', 'loading', 'importing', 'scene'])
    expect(p.complete).toBe(true)
  })

  it('stamps when each phase began, a phase visited twice included, and ignores lines after Loading completed', () => {
    const p = new StartPhases(0)
    const at = (line: string, s: number) => p.line(line, s * 1000)
    expect(p.since).toBe(0)
    at('Application.AssetDatabase Initial Refresh Start', 25)
    at('[ScriptCompilation] Requested script compilation because: x', 30)
    expect(p.phase).toBe('compiling'); expect(p.since).toBe(30_000)
    at('[ 189/1238  0s] WriteText Library/Bee/artifacts/1900b0aEDbg.dag/Unity.Burst.CodeGen.rsp2', 31)
    expect(p.since).toBe(30_000)
    at('Begin MonoManager ReloadAssembly', 40)
    at('Domain Reload Profiling: 14651ms', 55)
    at('[ScriptCompilation] Requested script compilation because: y', 60)
    expect(p.phase).toBe('compiling'); expect(p.since).toBe(60_000)
    at('Begin MonoManager ReloadAssembly', 62)
    at('Domain Reload Profiling: 3000ms', 70)
    at('Application.AssetDatabase Initial Refresh End', 80)
    at('[Project] Loading completed in 83.000 seconds', 83)
    at('Application.AssetDatabase Initial Refresh Start', 90)
    expect(p.phase).toBe('scene'); expect(p.since).toBe(80_000)
  })

  it('stays on opening for a log it does not know', () => {
    const { p, seen } = replay(['Some other program', 'Loading...', 'Done'], false)
    expect(seen).toEqual(['opening']); expect(p.recognized).toBe(false); expect(p.complete).toBe(false)
  })
})

describe('StartLog: following one start\'s editor.log', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-player-start-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('reads forward across polls, waits for half-written lines, and reports the phase and when it began', () => {
    const file = path.join(dir, 'editor.log'), log = new StartLog(file, 0)
    log.read(1000)
    expect(log.status()).toEqual({ phase: 'opening', since: 0 })
    fs.writeFileSync(file, 'Begin MonoManager ReloadAssembly\nApplication.AssetDatabase Initial Refresh St')
    log.read(2000)
    expect(log.phases.phase).toBe('opening'); expect(log.phases.recognized).toBe(true)
    fs.appendFileSync(file, 'art\n[ScriptCompilation] Requested script compilation because: x\r\n[ 952/1238  0s] ILPP')
    log.read(3000)
    expect(log.status()).toEqual({ phase: 'compiling', since: 3000 })
    expect(log.quietFor(9000)).toBe(6000)
  })

  it('treats a copy without a PackageCache as unpacking, and one that kept it as opening', () => {
    const main = path.join(dir, 'main/Library/PackageCache'), copy = path.join(dir, 'copy/Library/PackageCache')
    fs.mkdirSync(path.join(main, 'com.a'), { recursive: true }); fs.writeFileSync(path.join(main, 'com.a/x.bin'), Buffer.alloc(4000))
    const file = path.join(dir, 'editor.log'), log = new StartLog(file, 0, { copy, main })
    fs.writeFileSync(file, 'Application.AssetDatabase Initial Refresh Start\n')
    log.read(1000)
    expect(log.status()).toEqual({ phase: 'packages', since: 1000 })
    const warm = new StartLog(path.join(dir, 'warm.log'), 0, { copy: main, main })
    fs.writeFileSync(path.join(dir, 'warm.log'), 'Application.AssetDatabase Initial Refresh Start\n')
    warm.read(1000)
    expect(warm.phases.phase).toBe('opening')
  })
})
