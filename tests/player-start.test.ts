import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StartLog, StartPhases, startBar, validDurations } from '../src/main/player-start'
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

  it('counts Bee nodes while compiling, capped at the total and never moving back', () => {
    const p = new StartPhases(0)
    p.line('[ScriptCompilation] Requested script compilation because: Assembly Definition File(s) changed', 1)
    expect(p.phase).toBe('compiling'); expect(p.bee).toBeUndefined()
    p.line('[ 189/1238  0s] WriteText Library/Bee/artifacts/1900b0aEDbg.dag/Unity.Burst.CodeGen.rsp2', 2)
    expect(p.bee).toEqual({ done: 189, total: 1238 })
    p.line('[  87/1238  0s] WriteText Library/Bee/artifacts/1900b0aEDbg.dag/UnityEngine.TestRunner.rsp2', 3)
    expect(p.bee).toEqual({ done: 189, total: 1238 })
    p.line('[1317/1238  0s] CopyFiles Library/ScriptAssemblies/Unity.VisualEffectGraph.Editor.pdb', 4)
    expect(p.bee).toEqual({ done: 1238, total: 1238 })
    p.line('[           0s] Csc Library/Bee/artifacts/1900b0aEDbg.dag/UnityEngine.UI.dll (+2 others)', 5)
    expect(p.bee).toEqual({ done: 1238, total: 1238 })
  })

  it('times each phase, a phase visited twice included, and ignores lines after Loading completed', () => {
    const p = new StartPhases(0)
    const at = (line: string, s: number) => p.line(line, s * 1000)
    at('Application.AssetDatabase Initial Refresh Start', 25)
    at('[ScriptCompilation] Requested script compilation because: x', 30)
    at('Begin MonoManager ReloadAssembly', 40)
    at('Domain Reload Profiling: 14651ms', 55)
    at('[ScriptCompilation] Requested script compilation because: y', 60)
    at('Begin MonoManager ReloadAssembly', 62)
    at('Domain Reload Profiling: 3000ms', 70)
    at('Application.AssetDatabase Initial Refresh End', 80)
    at('[Project] Loading completed in 83.000 seconds', 83)
    at('Application.AssetDatabase Initial Refresh Start', 90)
    expect(p.durations(85_000)).toEqual({ opening: 30_000, compiling: 12_000, loading: 23_000, importing: 15_000, scene: 5_000 })
  })

  it('stays on opening for a log it does not know', () => {
    const { p, seen } = replay(['Some other program', 'Loading...', 'Done'], false)
    expect(seen).toEqual(['opening']); expect(p.recognized).toBe(false); expect(p.complete).toBe(false)
  })
})

describe('the start bar', () => {
  const last = { opening: 25_000, compiling: 4_000, loading: 15_000, importing: 8_000, scene: 4_000 } // 56 s in all

  it('stays indeterminate without a complete start on record, whatever the counts say', () => {
    expect(startBar('compiling', 3_000, { done: 600, total: 1238 }, undefined)).toBeUndefined()
    expect(startBar('opening', 3_000, undefined, {})).toBeUndefined()
    expect(startBar('opening', 3_000, undefined, { opening: 0 })).toBeUndefined()
  })

  it('weights segments by the last start and fills inside one by time against its last duration, holding at its end', () => {
    expect(startBar('opening', 0, undefined, last)).toBe(0)
    expect(startBar('opening', 12_500, undefined, last)).toBe(22) // 12.5 of 56 s
    expect(startBar('opening', 90_000, undefined, last)).toBe(44) // overran: holds at the segment's end
    expect(startBar('loading', 0, undefined, last)).toBe(51) // opening and compiling done
    expect(startBar('scene', 60_000, undefined, last)).toBe(99) // never 100 before ready
  })

  it('fills the compile and unpack segments from real counts, not from time', () => {
    expect(startBar('compiling', 0, { done: 619, total: 1238 }, last)).toBe(48) // 25 + 2 of 4 s
    expect(startBar('compiling', 60_000, { done: 0, total: 1238 }, last)).toBe(44)
    const cold = { ...last, packages: 120_000 }
    expect(startBar('packages', 5_000, { done: 1, total: 2 }, cold)).toBe(48) // (25 + 60) of 176 s
  })

  it('passes a phase this start skipped, and gives a phase the last start lacked no fill', () => {
    expect(startBar('compiling', 0, { done: 0, total: 1238 }, { ...last, packages: 0 })).toBe(44)
    expect(startBar('packages', 50_000, { done: 9, total: 10 }, last)).toBe(44)
  })

  it('reads durations back from player.json strictly', () => {
    expect(validDurations({ opening: 25_000, compiling: -1, bogus: 3, loading: 'x', scene: Infinity })).toEqual({ opening: 25_000 })
    expect(validDurations(null)).toBeUndefined()
    expect(validDurations({})).toBeUndefined()
  })
})

describe('StartLog: following one start\'s editor.log', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-player-start-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('reads forward across polls, waits for half-written lines, and starts over on a new log', () => {
    const file = path.join(dir, 'editor.log'), log = new StartLog(file, 0)
    log.read(1000)
    expect(log.status(1000, undefined)).toEqual({ phase: 'opening' })
    fs.writeFileSync(file, 'Begin MonoManager ReloadAssembly\nApplication.AssetDatabase Initial Refresh St')
    log.read(2000)
    expect(log.phases.phase).toBe('opening'); expect(log.phases.recognized).toBe(true)
    fs.appendFileSync(file, 'art\n[ScriptCompilation] Requested script compilation because: x\r\n[ 952/1238  0s] ILPP')
    log.read(3000)
    expect(log.status(3000, undefined)).toEqual({ phase: 'compiling' })
    expect(log.phases.bee).toBeUndefined()
    fs.appendFileSync(file, '-Configuration Library/ilpp-configuration.nevergeneratedoutput\n')
    log.read(4000)
    expect(log.phases.bee).toEqual({ done: 952, total: 1238 })
    expect(log.quietFor(9000)).toBe(5000)
  })

  it('treats a copy without a PackageCache as unpacking, sized against the main checkout\'s', async () => {
    const main = path.join(dir, 'main/Library/PackageCache'), copy = path.join(dir, 'copy/Library/PackageCache')
    fs.mkdirSync(path.join(main, 'com.a'), { recursive: true }); fs.writeFileSync(path.join(main, 'com.a/x.bin'), Buffer.alloc(4000))
    const file = path.join(dir, 'editor.log'), log = new StartLog(file, 0, { copy, main })
    fs.writeFileSync(file, 'Application.AssetDatabase Initial Refresh Start\n')
    await new Promise(r => setTimeout(r, 50)) // the main checkout's size, measured in the background
    log.read(1000)
    expect(log.phases.phase).toBe('packages')
    fs.mkdirSync(path.join(copy, 'com.a'), { recursive: true }); fs.writeFileSync(path.join(copy, 'com.a/x.bin'), Buffer.alloc(1000))
    log.read(7000)
    await new Promise(r => setTimeout(r, 50))
    expect(log.status(7000, { opening: 30_000, packages: 100_000, scene: 10_000 })).toEqual({ phase: 'packages', bar: 39 }) // (30 + a quarter of 100) of 140 s
    // A copy that kept its PackageCache opens without unpacking.
    const warm = new StartLog(path.join(dir, 'warm.log'), 0, { copy: main, main })
    fs.writeFileSync(path.join(dir, 'warm.log'), 'Application.AssetDatabase Initial Refresh Start\n')
    warm.read(1000)
    expect(warm.phases.phase).toBe('opening')
  })

  it('never moves the bar back, even when a recompile returns to an earlier phase', () => {
    const file = path.join(dir, 'editor.log'), log = new StartLog(file, 0), last = { opening: 10_000, compiling: 10_000, loading: 10_000, importing: 10_000 }
    fs.writeFileSync(file, 'Application.AssetDatabase Initial Refresh Start\nBegin MonoManager ReloadAssembly\nDomain Reload Profiling: 1ms\n')
    log.read(10_000)
    expect(log.status(12_500, last)).toEqual({ phase: 'importing', bar: 81 }) // (30 + 2.5) of 40 s
    fs.appendFileSync(file, '[ScriptCompilation] Requested script compilation because: y\n')
    log.read(21_000)
    expect(log.status(21_000, last)).toEqual({ phase: 'compiling', bar: 81 })
  })
})
