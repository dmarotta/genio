import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PRIORITY, clearPlayLive, livePlays, lowWhileLive, markPlayLive, playIsLive, setProcessPriority } from '../resources/unit-skills/genio/lib/play-live.mjs'

let data: string
beforeEach(() => { data = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-play-live-')) })
afterEach(() => { fs.rmSync(data, { recursive: true, force: true }) })

describe('live Play markers', () => {
  it('count a Play from its mark to its clear, and ignore one whose process is gone', () => {
    expect(playIsLive(data)).toBe(false)
    markPlayLive(data, 'abc', { project: 'A' })
    expect(livePlays(data).map(p => p.key)).toEqual(['abc']); expect(playIsLive(data)).toBe(true)
    expect(playIsLive(data, { isAlive: () => false })).toBe(false)
    clearPlayLive(data, 'abc'); expect(playIsLive(data)).toBe(false)
    expect(() => clearPlayLive(data, 'abc')).not.toThrow()
  })
  it('refuse a key that is not a plain name', () => { expect(() => markPlayLive(data, '../x')).toThrow('Invalid Play key') })
})

describe('below-normal priority while a Play is live', () => {
  const child = (pid: number) => Object.assign(Promise.resolve({}), { child: { pid } })
  it('lowers only the process the wrapped runner starts, and only while live', async () => {
    const set: [number, number][] = [], options = { set: (pid: number, p: number) => { set.push([pid, p]) } }
    const run = lowWhileLive(data, () => child(4242), options)
    await run(); expect(set).toEqual([])
    markPlayLive(data, 'abc'); await run(); expect(set).toEqual([[4242, PRIORITY.belowNormal]])
    clearPlayLive(data, 'abc'); await run(); expect(set).toHaveLength(1)
  })
  it('never fails the work: a runner without a child, a refused priority or a missing data folder change nothing', async () => {
    markPlayLive(data, 'abc')
    await expect(lowWhileLive(data, () => Promise.resolve('ok'), { set: () => {} })()).resolves.toBe('ok')
    await expect(lowWhileLive(data, () => child(7), { set: () => { throw new Error('access denied') } })()).resolves.toBeDefined()
    await expect(lowWhileLive(undefined, () => child(7), { set: () => { throw new Error('unreachable') } })()).resolves.toBeDefined()
    expect(setProcessPriority(0, PRIORITY.belowNormal, { set: () => { throw new Error('unreachable') } })).toBe(false)
    expect(setProcessPriority(5, PRIORITY.belowNormal, { set: () => { throw new Error('gone') } })).toBe(false)
  })
})
