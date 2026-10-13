import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Home } from '../src/main/home'
import { createWkspService } from '../src/main/wksp'
import { createWakeService } from '../src/main/wakes'
import { claudeLimitsFile, recordClaudeRateLimit } from '../src/main/usage'
import { defaultSettings } from '../src/main/settings'
import type { AppCtx, WkspService } from '../src/main/services'
import { SessionQuotaPolicy } from '../src/main/session-usage'

const sdk = vi.hoisted(() => ({ query: vi.fn(), streams: [] as { input: any[]; emit(message: any): void }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query, tool: (name: string) => ({ name }), createSdkMcpServer: () => ({}) }))
vi.mock('../src/main/claude-usage-probe', () => ({ refreshClaudePlanUsage: async () => {}, claudeProbeError: () => undefined }))
let dir: string
let services: WkspService[] = []
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime('2026-10-13T19:00:00Z')
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-claude-wakes-'))
  sdk.streams.length = 0; sdk.query.mockReset()
  sdk.query.mockImplementation(({ prompt }) => {
    let resolve!: (result: any) => void
    const stream = { input: [] as any[], emit: (message: any) => resolve({ value: message, done: false }) }
    sdk.streams.push(stream)
    void (async () => { for await (const message of prompt) stream.input.push(message) })()
    return { close: () => resolve?.({ done: true }), interrupt: async () => {},
      [Symbol.asyncIterator]() { return { next: () => new Promise(r => { resolve = r }) } } }
  })
})
afterEach(async () => {
  for (const service of services) await service.stop()
  services = []; vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const main = new Home(dir); main.ensure()
  const home = new Home(path.join(dir, 'wksps', 'genio'), 'genio', main); home.ensure()
  const ctx = { appRoot: process.cwd(), settings: { get: () => defaultSettings() },
    main: { home: main }, away: { state: () => ({ mode: 'online' }) },
    allies: { list: () => [{ name: 'genio', projects: [] }] }, projects: { list: () => [] }, stats: { unlock: vi.fn(), addCost: vi.fn() },
    inventory: { thumbnail: vi.fn() }, memory: { read: () => '' }, permissions: { ask: vi.fn(async () => true) }
  } as unknown as AppCtx
  const wakes = createWakeService(() => ctx, home)
  const hc = { home, wakes, crew: { list: () => [] }, decisions: { list: () => [] }, backlog: { list: () => [] } }
  ctx.home = () => hc as any; ctx.homes = new Map([['genio', hc as any]])
  const service = createWkspService(() => ctx, home)
  services.push(service)
  return { service, wakes, main }
}

async function complete(index: number, ok: boolean) {
  const stream = sdk.streams[index]
  stream.emit({ type: 'system', subtype: 'init', session_id: `test-${index}` }); await vi.advanceTimersByTimeAsync(0)
  stream.emit({ type: 'result', uuid: `result-${index}`, is_error: !ok, subtype: ok ? 'success' : 'error_during_execution', total_cost_usd: 0, errors: [] })
  await vi.advanceTimersByTimeAsync(0)
}

it.each([false, true])('delivers ready/blocked project wakes with stale=%s 97%, acknowledging only after successful handling', async stale => {
  const { service, wakes, main } = setup()
  if (stale) vi.setSystemTime(Date.now() - 3600_000)
  recordClaudeRateLimit(claudeLimitsFile(main.data), { status: 'allowed', utilization: 0.97, rateLimitType: 'five_hour' })
  if (stale) vi.setSystemTime(Date.now() + 3600_000)
  wakes.enqueue({ kind: 'signal', reason: 'unit is ready', routine: false })
  wakes.enqueue({ kind: 'signal', reason: 'unit is blocked', routine: false })
  service.deliverWakes(); service.deliverWakes() // busy delivery must not submit the batch twice
  await vi.advanceTimersByTimeAsync(0)
  expect(service.info().lastError).toBeUndefined()
  expect(sdk.query).toHaveBeenCalledOnce(); expect(sdk.streams[0].input).toHaveLength(1)
  expect(JSON.stringify(sdk.streams[0].input)).toContain('unit is ready')
  expect(JSON.stringify(sdk.streams[0].input)).toContain('unit is blocked')
  expect(wakes.pending()).toHaveLength(2)
  await complete(0, true)
  expect(wakes.pending()).toEqual([])
})

it('replays an unhandled event after process restart with a persisted stale snapshot, without a player message', async () => {
  const first = setup()
  vi.setSystemTime(Date.now() - 3600_000)
  recordClaudeRateLimit(claudeLimitsFile(first.main.data), { status: 'allowed', utilization: 0.97, rateLimitType: 'five_hour' })
  vi.setSystemTime(Date.now() + 3600_000)
  first.wakes.enqueue({ kind: 'signal', reason: 'done: ready in branch test', routine: false })
  first.service.deliverWakes(); await vi.advanceTimersByTimeAsync(0)
  await complete(0, false)
  expect(first.wakes.pending()).toHaveLength(1)
  await first.service.stop()
  const restarted = setup()
  restarted.service.deliverWakes(); await vi.advanceTimersByTimeAsync(0)
  expect(sdk.streams[1].input).toHaveLength(1)
  expect(restarted.wakes.pending()).toHaveLength(1)
  await complete(1, true)
  expect(restarted.wakes.pending()).toEqual([])
})

it('publishes one durable actual-rejection hold with the pending count, retaining and later delivering the batch', async () => {
  const first = setup()
  const policy = new SessionQuotaPolicy(first.main.data)
  policy.observe({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: Date.now() / 1000 + 3600 })
  first.wakes.enqueue({ kind: 'signal', reason: 'ready', routine: false })
  first.wakes.enqueue({ kind: 'signal', reason: 'blocked', routine: false })
  first.service.deliverWakes(); first.service.deliverWakes()
  expect(first.service.info().limit?.reason).toContain('2 pending events')
  expect(first.service.history().filter(m => m.text.includes('2 pending events'))).toHaveLength(1)
  expect(first.wakes.pending()).toHaveLength(2); expect(sdk.query).not.toHaveBeenCalled()
  await first.service.stop()
  const restarted = setup()
  restarted.service.deliverWakes()
  expect(restarted.service.history().filter(m => m.text.includes('2 pending events'))).toHaveLength(1)
  policy.observe({ status: 'allowed', rateLimitType: 'five_hour' })
  restarted.service.deliverWakes(); await vi.advanceTimersByTimeAsync(0)
  expect(sdk.query).toHaveBeenCalledOnce()
  await complete(0, true)
  expect(restarted.wakes.pending()).toEqual([])
})

it('retains routine batching at fresh 97%, while a new urgent status batch goes immediately', async () => {
  const { service, wakes, main } = setup()
  recordClaudeRateLimit(claudeLimitsFile(main.data), { status: 'allowed', utilization: 0.97, rateLimitType: 'five_hour' })
  wakes.enqueue({ kind: 'heartbeat', reason: 'routine check', routine: true })
  service.deliverWakes(); await vi.advanceTimersByTimeAsync(1000)
  expect(sdk.query).not.toHaveBeenCalled()
  wakes.enqueue({ kind: 'signal', reason: 'unit done', routine: false })
  service.deliverWakes(); await vi.advanceTimersByTimeAsync(0)
  expect(sdk.query).toHaveBeenCalledOnce()
  await complete(0, true); expect(wakes.pending()).toEqual([])
})
