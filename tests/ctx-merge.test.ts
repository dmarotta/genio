import { describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const merge = vi.fn(async () => ({ ok: true, message: 'merged' }))
vi.mock('../src/main/secrets', () => ({ getSecret: () => undefined }))
vi.mock('../src/main/crew', () => ({ createCrewService: () => ({ merge, get: () => undefined, spawn: vi.fn(), control: vi.fn() }) }))
vi.mock('../src/main/backlog', () => ({ createBacklogService: () => ({}) }))
vi.mock('../src/main/decisions', () => ({ createDecisionService: () => ({}) }))
vi.mock('../src/main/wakes', () => ({ createWakeService: () => ({}) }))
vi.mock('../src/main/supervisor', () => ({ createSupervisor: () => ({}) }))
vi.mock('../src/main/workspace', () => ({ createWorkspaceService: () => ({}) }))
vi.mock('../src/main/reactions', () => ({ createReactionService: () => ({}) }))
vi.mock('../src/main/plans', () => ({ createPlanService: () => ({}) }))
import { makeHomeCtx } from '../src/main/ctx'
import { Home } from '../src/main/home'
import type { MergeApproval } from '../src/shared/types'

describe('home context merge guard', () => {
  it('passes what approved the merge through to the crew, so a main-chat merge records it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-ctx-merge-'))
    try {
      const hc = makeHomeCtx(new Home(root))
      const approval: MergeApproval = { kind: 'specific', at: '2026-10-16T12:00:00.000Z', words: 'merge the plans build' }
      expect(await hc.crew.merge('unit-1', approval)).toEqual({ ok: true, message: 'merged' })
      expect(merge).toHaveBeenCalledWith('unit-1', approval)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
