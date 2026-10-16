import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { clearPlayStarting, markPlayStarting, playStarts, QUIET_CAP_MS, quietDir, waitForQuiet } from '../resources/unit-skills/genio/lib/quiet-start.mjs'

let data: string
beforeEach(() => { data = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-quiet-start-')) })
afterEach(() => { fs.rmSync(data, { recursive: true, force: true }) })

it('does not wait when no Play is starting', async () => {
  expect(playStarts(data)).toEqual([])
  expect(await waitForQuiet(data)).toEqual({ waitedMs: expect.any(Number), deferred: false, resumed: 'quiet' })
  expect(await waitForQuiet(undefined as unknown as string)).toMatchObject({ deferred: false, resumed: 'quiet' })
})

it('defers while a Play is starting and resumes at once when it is ready', async () => {
  markPlayStarting(data, 'a1', { project: 'A', phase: 'starting' })
  expect(playStarts(data)).toEqual([expect.objectContaining({ key: 'a1', project: 'A', phase: 'starting', pid: process.pid })])
  let waits = 0, done = false
  const wait = waitForQuiet(data, { pollMs: 60_000, onWait: () => { waits++ } }).then(r => { done = true; return r })
  await new Promise(r => setTimeout(r, 50))
  expect(done).toBe(false); expect(waits).toBe(1)
  // A phase change keeps the hold; ready clears the marker and wakes waiters in this process without a poll.
  markPlayStarting(data, 'a1', { project: 'A', phase: 'entering-play' })
  clearPlayStarting(data, 'a1')
  expect(await wait).toMatchObject({ deferred: true, resumed: 'quiet' })
  expect(fs.readdirSync(quietDir(data))).toEqual([])
})

it('resumes after the cap when a Play never gets ready', async () => {
  let clock = 1_000_000
  markPlayStarting(data, 'stuck', { project: 'A', phase: 'starting', since: clock + 1000 })
  const r = await waitForQuiet(data, { now: () => clock, sleep: async ms => { clock += ms } })
  expect(r).toEqual({ waitedMs: QUIET_CAP_MS, deferred: true, resumed: 'cap' })
  // The same start no longer holds anyone back once it is past the cap itself.
  clock += 1000
  expect(await waitForQuiet(data, { now: () => clock, sleep: async ms => { clock += ms } })).toMatchObject({ deferred: false, resumed: 'quiet' })
})

it('caps each wait even when new starts keep arriving', async () => {
  let clock = 0, n = 0
  const fresh = () => markPlayStarting(data, `s${n++ % 2}`, { phase: 'copying', since: clock })
  fresh()
  const capped = await waitForQuiet(data, { now: () => clock, sleep: async ms => { clock += ms; fresh() } })
  expect(capped).toEqual({ deferred: true, resumed: 'cap', waitedMs: QUIET_CAP_MS })
})

it('ignores markers of a process that is gone, and stops waiting on abort', async () => {
  markPlayStarting(data, 'dead', { phase: 'starting', pid: 2 ** 22 + 7 })
  expect(playStarts(data, { isAlive: () => false })).toEqual([])
  expect(await waitForQuiet(data, { isAlive: () => false })).toMatchObject({ deferred: false, resumed: 'quiet' })
  markPlayStarting(data, 'live', { phase: 'copying' })
  const controller = new AbortController()
  const wait = waitForQuiet(data, { pollMs: 60_000, signal: controller.signal })
  controller.abort()
  expect(await wait).toMatchObject({ deferred: true, resumed: 'aborted' })
  expect(() => markPlayStarting(data, '../escape', { phase: 'copying' })).toThrow('Invalid')
})
