import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { GenioEvent } from '@shared/types'

/** node-pty stand-in: records spawns, lets the test emit output and exits. */
const pty = vi.hoisted(() => {
  const spawned: { file: string; args: string[] | string; opts: { cwd: string; env: Record<string, string> }; proc: FakePty }[] = []
  class FakePty {
    pid = 4242
    written: string[] = []
    killed = false
    private data: ((d: string) => void)[] = []
    private exit: ((e: { exitCode: number }) => void)[] = []
    onData(fn: (d: string) => void) { this.data.push(fn) }
    onExit(fn: (e: { exitCode: number }) => void) { this.exit.push(fn) }
    write(d: string) { this.written.push(d) }
    resize() {}
    kill() { this.killed = true; this.end(1) }
    emit(d: string) { for (const f of this.data) f(d) }
    end(exitCode: number) { for (const f of this.exit) f({ exitCode }) }
  }
  const state = { fail: '' }
  return { spawned, FakePty, state }
})
vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[] | string, opts: { cwd: string; env: Record<string, string> }) => {
    if (pty.state.fail) throw new Error(pty.state.fail)
    const proc = new pty.FakePty()
    pty.spawned.push({ file, args, opts, proc })
    return proc
  }
}))

const { createTerminalService } = await import('../src/main/terminals')
const { bus } = await import('../src/main/bus')

const service = (shell = 'powershell.exe') => createTerminalService(() => ({ settings: { get: () => ({ shell }) } }) as never)

describe('the pane PTY', () => {
  it('runs the player\'s shell with a UTF-8 console and environment, tagged with its project window', () => {
    const svc = service()
    const t = svc.create({ kind: 'pane', project: 'world', title: 'Terminal', cwd: process.cwd() })
    expect(t).toMatchObject({ kind: 'pane', project: 'world', alive: true })
    const s = pty.spawned.at(-1)!
    if (process.platform === 'win32') expect(String(s.args)).toContain('chcp 65001')
    expect(String(s.args)).toContain('$OutputEncoding=')
    expect(s.opts.env).toMatchObject({ PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' })
    expect(s.opts.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('takes no automated input: submit (used only for units) refuses it, the player\'s keys still reach it', async () => {
    const svc = service()
    const t = svc.create({ kind: 'pane', project: 'world', title: 'Terminal', cwd: process.cwd() })
    await expect(svc.submit(t.id, 'rm -rf /')).rejects.toThrow(/takes no input from Genio/)
    const proc = pty.spawned.at(-1)!.proc
    expect(proc.written).toEqual([])
    svc.write(t.id, 'dir\r')
    expect(proc.written).toEqual(['dir\r'])
  })

  it('reports how it ended: exit code and time, or why it never started', () => {
    const svc = service()
    const t = svc.create({ kind: 'pane', project: 'world', title: 'Terminal', cwd: process.cwd() })
    pty.spawned.at(-1)!.proc.end(3)
    expect(svc.get(t.id)).toMatchObject({ alive: false, exitCode: 3 })
    expect(svc.get(t.id)!.exitedAt).toBeGreaterThan(0)
    pty.state.fail = 'File not found'
    try {
      const bad = service('nosuchshell').create({ kind: 'pane', project: 'world', title: 'Terminal', cwd: process.cwd() })
      expect(bad).toMatchObject({ alive: false, exitCode: -1, startError: 'nosuchshell did not start: File not found' })
    } finally {
      pty.state.fail = ''
    }
  })

  it('kill stops the process and removes the terminal for every window', () => {
    const svc = service()
    const seen: GenioEvent[] = []
    const off = bus.onEvent((e) => seen.push(e))
    try {
      const t = svc.create({ kind: 'pane', project: 'world', title: 'Terminal', cwd: process.cwd() })
      const proc = pty.spawned.at(-1)!.proc
      svc.kill(t.id)
      expect(proc.killed).toBe(true)
      expect(svc.get(t.id)).toBeUndefined()
      expect(seen).toContainEqual({ type: 'terminal-removed', id: t.id })
    } finally {
      off()
    }
  })
})

describe('no agent can write to the player\'s terminal', () => {
  const main = path.resolve('src/main')
  const sources = fs.readdirSync(main).filter((f) => f.endsWith('.ts')).map((f) => ({ f, text: fs.readFileSync(path.join(main, f), 'utf8') }))

  it('the only raw terminal write is the window keyboard IPC; automated submits are the unit crew\'s own terminals', () => {
    const writes = sources.filter((s) => /terminals\.write\(/.test(s.text)).map((s) => s.f)
    expect(writes).toEqual(['ipc.ts'])
    expect(sources.find((s) => s.f === 'ipc.ts')!.text).toMatch(/terminalWrite: \(id, data\) => ctx\(\)\.terminals\.write\(id, data\)/)
    const submits = sources.filter((s) => /terminals\.submit\(/.test(s.text)).map((s) => s.f)
    expect(submits).toEqual(['crew.ts'])
    for (const call of sources.find((s) => s.f === 'crew.ts')!.text.match(/terminals\.submit\([^,]+/g)!) expect(call).toMatch(/submit\((term\.id|t\.terminalId!)/)
  })

  it('Genio\'s and allies\' tools never reach the pane or its PTY', () => {
    for (const s of sources.filter((x) => /^(wksp-tools|wksp-sdk-tools|chat-tool-.*|asset-tools|agent-generation)\.ts$/.test(x.f))) {
      expect(s.text, s.f).not.toMatch(/terminals\.(write|submit|create)\(|paneRun|runShell|openPane|terminalWrite/)
    }
  })
})
