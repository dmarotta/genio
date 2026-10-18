import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StreamLog, type StallMonitor } from '../src/main/play-stream-log'

let dir: string, file: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-stream-log-')); file = path.join(dir, 'data', 'play-stream.log') })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })
const monitor = (stalls: number[]): StallMonitor => ({ start() {}, stop() {}, longest: () => stalls.shift() ?? 0 })
const lines = () => fs.readFileSync(file, 'utf8').trim().split('\n').map(l => l.replace(/^\S+ /, ''))

describe('stream log', () => {
  it('records the path, a fallback reason and the longest stall of one session', async () => {
    let now = Date.parse('2026-10-18T20:00:00Z')
    const log = new StreamLog(file, { now: () => now, monitor: monitor([30, 2400, 90]), sampleMs: 3_600_000 })
    log.begin('gpu', 1280, 720)
    log.fallback('texture-failed', 'device lost')
    now += 95_000; log.end(); await log.flush()
    expect(lines()).toEqual([
      'stream start: path=gpu 1280x720',
      'fallback to JPEG: texture-failed (device lost)',
      'main-thread stall 2400ms',
      'stream end: path=jpeg 1280x720 fallback=texture-failed (device lost) longestStall=2400ms duration=95s'
    ])
  })
  it('keeps the worst stall of the session and says none when the stream ran clean', async () => {
    const log = new StreamLog(file, { monitor: monitor([]), sampleMs: 3_600_000 })
    log.begin('jpeg', 640, 360); log.end(); log.end(); await log.flush()
    expect(lines().at(-1)).toMatch(/^stream end: path=jpeg 640x360 fallback=none longestStall=0ms duration=\d+s$/)
    expect(lines()).toHaveLength(2)
  })
  it('a resize on a running session records the size, not a second session', async () => {
    const log = new StreamLog(file, { monitor: monitor([]), sampleMs: 3_600_000 })
    log.begin('gpu', 1280, 720); log.begin('gpu', 1920, 1080); log.end(); await log.flush()
    expect(lines().filter(l => l.startsWith('stream start'))).toHaveLength(1)
    expect(lines().at(-1)).toContain('1920x1080')
  })
  it('moves the file aside once it is past its cap, keeping one older file', async () => {
    const log = new StreamLog(file, { monitor: monitor([]), sampleMs: 3_600_000, maxBytes: 200 })
    for (let n = 0; n < 12; n++) { log.begin('gpu', 1280, 720); log.end() }
    await log.flush()
    expect(fs.statSync(file).size).toBeLessThan(600); expect(fs.existsSync(`${file}.1`)).toBe(true)
    expect(fs.existsSync(`${file}.2`)).toBe(false)
  })
  it('never throws when the folder cannot be written', async () => {
    fs.writeFileSync(path.join(dir, 'data'), 'a file where the folder should be')
    const log = new StreamLog(file, { monitor: monitor([]), sampleMs: 3_600_000 })
    log.begin('gpu', 1280, 720); log.end()
    await expect(log.flush()).resolves.toBeUndefined()
  })
})
