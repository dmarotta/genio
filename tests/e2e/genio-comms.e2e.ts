/**
 * Opt-in end-to-end check of the Genio agent (spends a few cents):
 *   npm run test:e2e
 * Starts a real Agent SDK session with the genio toolbelt and asks about worlds.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, startApp, stopApp } from '../../src/main/ctx'

describe.skipIf(process.env.GENIO_E2E_REAL !== '1')('Genio comms', () => {
  let root: string | undefined
  let ctx: ReturnType<typeof createApp> | undefined
  afterEach(async () => {
    try { if (ctx) await stopApp(ctx) } finally {
      for (const terminal of ctx?.terminals.list() ?? []) ctx?.terminals.kill(terminal.id)
      if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    }
  })
  it('answers from its own tools, by gamertag, in gaming vocabulary', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-e2e-'))
    const world = path.join(root, 'neon-runner')
    fs.mkdirSync(world)
    execFileSync('git', ['init', '-b', 'main'], { cwd: world })
    fs.writeFileSync(path.join(world, 'project.godot'), '[application]\nconfig/name="Neon Runner"\n')
    execFileSync('git', ['add', '-A'], { cwd: world })
    execFileSync('git', ['-c', 'user.email=e2e@genio.local', '-c', 'user.name=E2E', 'commit', '-m', 'init'], { cwd: world })

    ctx = createApp(process.cwd(), path.join(root, 'base'))
    ctx.settings.save({ firstRunDone: true, gamertag: 'Nova', wkspModel: process.env.GENIO_E2E_WKSP_MODEL ?? 'haiku', wkspEffort: 'low' })
    await startApp(ctx)
    await ctx.projects.add({ source: world, inPlace: true })

    await ctx.main.wksp.send(`Which worlds are registered, and what engine does each use? One short line. Test run: ${path.basename(process.env.GENIO_TEST_RUN_ROOT!)}`)
    const deadline = Date.now() + 4 * 60_000
    let reply = ''
    let tools: string[] = []
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000))
      const info = ctx.main.wksp.info()
      const msgs = ctx.main.wksp.history(50).filter((m) => m.role === 'genio' && !m.partial)
      tools = msgs.flatMap((m) => (m.tools ?? []).map((t) => t.name))
      reply = msgs.map((m) => m.text).join('\n')
      if (reply && info.activity === 'idle') break
      if (info.activity === 'error') break
    }
    const errors = ctx.main.wksp.history(50).filter((m) => m.role === 'error').map((m) => m.text)
    console.log('tools:', tools.join(', '))
    console.log('reply:', reply)
    if (errors.length) console.log('errors:', errors.join('\n'))
    expect(errors).toEqual([])
    expect(reply.toLowerCase()).toContain('neon-runner')
    expect(reply.toLowerCase()).toContain('godot')
    expect(reply).toMatch(/Nova/)
    expect(reply).not.toMatch(/captain|aye\b|shipshape|ahoy/i)
    expect(reply).not.toMatch(/local-only|no-mistakes|direct-PR/)
    expect(tools.some((t) => t.includes('world_list') || t.includes('fleet_view'))).toBe(true)
  }, 6 * 60_000)
})
