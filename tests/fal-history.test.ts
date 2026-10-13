import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FalRun } from '@shared/api'
import { FalHistory } from '../src/main/fal-history'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-fal-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const mk = (id: string, patch: Partial<FalRun> = {}): FalRun => ({
  id,
  endpoint: 'fal-ai/flux/dev',
  input: { prompt: 'a golem' },
  status: 'completed',
  logs: [],
  outputs: [],
  createdAt: '2026-10-13T10:00:00.000Z',
  ...patch
})

describe('FalHistory', () => {
  it('starts empty and survives a corrupt file', () => {
    const h = new FalHistory(dir)
    expect(h.list()).toEqual([])
    fs.writeFileSync(h.file, '{not json')
    expect(h.list()).toEqual([])
    fs.writeFileSync(h.file, '{"a":1}')
    expect(h.list()).toEqual([])
  })

  it('adds newest first, gets, updates and persists across instances', () => {
    const h = new FalHistory(dir)
    h.add(mk('fal-1'))
    h.add(mk('fal-2', { status: 'queued' }))
    expect(h.list().map((r) => r.id)).toEqual(['fal-2', 'fal-1'])
    const u = h.update('fal-2', { status: 'completed', costUsd: 0.03, completedAt: '2026-10-13T10:01:00.000Z' })
    expect(u).toMatchObject({ id: 'fal-2', status: 'completed', costUsd: 0.03, endpoint: 'fal-ai/flux/dev' })
    expect(h.update('nope', { status: 'failed' })).toBeUndefined()
    const again = new FalHistory(dir)
    expect(again.get('fal-2')?.costUsd).toBe(0.03)
    expect(again.inFlight()).toEqual([])
  })

  it('lists in-flight runs', () => {
    const h = new FalHistory(dir)
    h.add(mk('a', { status: 'submitting' }))
    h.add(mk('b', { status: 'running' }))
    h.add(mk('c', { status: 'failed' }))
    expect(h.inFlight().map((r) => r.id).sort()).toEqual(['a', 'b'])
  })

  it('trims inline data in inputs and results', () => {
    const h = new FalHistory(dir)
    const big = 'data:image/png;base64,' + 'A'.repeat(50_000)
    h.add(mk('d', { input: { image_url: big, prompt: 'x' } }))
    h.update('d', { result: { images: [{ url: big }] } })
    const raw = fs.readFileSync(h.file, 'utf8')
    expect(raw.length).toBeLessThan(2000)
    expect(h.get('d')?.input.prompt).toBe('x')
  })

  it('evicts the oldest finished runs over the cap, with their files, but never in-flight ones', () => {
    const h = new FalHistory(dir, 3)
    h.add(mk('old-live', { status: 'running' }))
    h.add(mk('old-done'))
    fs.mkdirSync(h.runDir('old-done'), { recursive: true })
    fs.writeFileSync(path.join(h.runDir('old-done'), 'x.png'), 'x')
    h.add(mk('n1'))
    h.add(mk('n2'))
    expect(h.list().map((r) => r.id)).toEqual(['n2', 'n1', 'old-live'])
    expect(fs.existsSync(h.runDir('old-done'))).toBe(false)
  })

  it('removes a run and its files', () => {
    const h = new FalHistory(dir)
    h.add(mk('r1'))
    fs.mkdirSync(h.runDir('r1'), { recursive: true })
    fs.writeFileSync(path.join(h.runDir('r1'), 'a.wav'), 'x')
    expect(h.remove('r1')).toBe(true)
    expect(h.remove('r1')).toBe(false)
    expect(fs.existsSync(h.runDir('r1'))).toBe(false)
  })

  it('resolves run files without escaping the run folder', () => {
    const h = new FalHistory(dir)
    expect(h.filePath('r1', 'a.png')).toBe(path.join(dir, 'runs', 'r1', 'a.png'))
    expect(h.filePath('r1', '../r2/a.png')).toBeUndefined()
    expect(h.filePath('r1', '..')).toBeUndefined()
    expect(h.filePath('../x', 'a.png')).toBeUndefined()
    expect(() => h.runDir('../x')).toThrow()
  })
})
