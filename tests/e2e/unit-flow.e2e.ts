/**
 * Opt-in end-to-end check (spends a few cents of model usage):
 *   npm run test:e2e
 * Registers a scratch world, deploys a real Claude unit on an Offline Build,
 * lets overwatch follow it to "ready", merges it fast-forward and despawns it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { createApp, startApp, stopApp } from '../../src/main/ctx'
import { bus } from '../../src/main/bus'

const MODEL = process.env.GENIO_E2E_MODEL ?? 'haiku'
const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

describe('deploy → overwatch → merge → despawn', () => {
  it('runs a real Offline Build end to end', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-e2e-'))
    const world = path.join(root, 'tiny-game')
    fs.mkdirSync(world)
    sh(world, 'init', '-b', 'main')
    sh(world, 'config', 'user.email', 'e2e@genio.local')
    sh(world, 'config', 'user.name', 'Genio E2E')
    fs.writeFileSync(path.join(world, 'README.md'), '# Tiny game\n')
    fs.writeFileSync(path.join(world, 'main.lua'), 'function love.draw() love.graphics.print("hi", 10, 10) end\n')
    sh(world, 'add', '-A')
    sh(world, 'commit', '-m', 'init')

    const events: string[] = []
    bus.onEvent((e) => {
      if (e.type === 'status') events.push(`status ${e.event.kind}: ${e.event.text}`)
      if (e.type === 'wake') events.push(`event ${e.wake.kind}: ${e.wake.reason}`)
    })

    const ctx = createApp(process.cwd(), path.join(root, 'base'))
    ctx.settings.save({ firstRunDone: true, pollSeconds: 3, signalGraceSeconds: 2, defaultWorkerModel: MODEL, defaultWorkerEffort: 'low' })
    // keep Genio itself idle: this test drives the squad directly
    ctx.main.wksp.deliverWakes = () => undefined
    await startApp(ctx)

    const p = await ctx.projects.add({ source: world, inPlace: true, mode: 'local-only' })
    expect(p.engine).toBe('love2d')

    const task = await ctx.main.crew.spawn({
      kind: 'ship',
      project: p.name,
      title: 'Add hello file',
      intent: 'Add a file named HELLO.md containing exactly the line "hello genio", then commit it.',
      mode: 'local-only',
      harness: 'claude',
      model: MODEL,
      effort: 'low'
    })
    expect(fs.existsSync(task.worktree)).toBe(true)

    const deadline = Date.now() + 6 * 60_000
    let t = ctx.main.crew.get(task.id)!
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000))
      t = ctx.main.crew.get(task.id)!
      if (['ready', 'failed', 'needs-decision', 'blocked', 'exited'].includes(t.state)) break
    }
    console.log(events.join('\n'))
    console.log('final state:', t.state, t.stateReason ?? '')
    if (t.state !== 'ready') console.log(ctx.terminals.tail(t.terminalId ?? '', 60))
    expect(t.state).toBe('ready')
    expect(sh(task.worktree, 'log', '--oneline', '-n1')).not.toContain('init')

    const merged = await ctx.main.crew.merge(task.id)
    console.log('merge:', merged.message)
    expect(merged.ok).toBe(true)
    expect(fs.readFileSync(path.join(world, 'HELLO.md'), 'utf8')).toContain('hello genio')
    const after = ctx.main.crew.get(task.id)!
    console.log('after merge:', after.state)
    expect(['merged', 'cleaned']).toContain(after.state)
    if (after.state !== 'cleaned') {
      const c = await ctx.main.crew.cleanup(task.id)
      console.log('despawn:', c.message)
      expect(c.ok).toBe(true)
    }
    expect(fs.existsSync(task.worktree)).toBe(false)
    await stopApp(ctx)
  }, 8 * 60_000)
})
