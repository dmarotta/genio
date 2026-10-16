import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** node-pty stand-in whose TUI reacts to keys the way the test scripts it. */
const pty = vi.hoisted(() => {
  class FakeTui {
    pid = 7
    written: string[] = []
    /** called for every write; returns the output the TUI prints in answer */
    react: (d: string, nth: number) => string | undefined = () => undefined
    private data: ((d: string) => void)[] = []
    private exit: ((e: { exitCode: number }) => void)[] = []
    onData(fn: (d: string) => void) { this.data.push(fn) }
    onExit(fn: (e: { exitCode: number }) => void) { this.exit.push(fn) }
    write(d: string) {
      this.written.push(d)
      const out = this.react(d, this.written.filter(w => w === d).length)
      if (out) setTimeout(() => this.emit(out), 20)
    }
    resize() {}
    kill() {}
    emit(d: string) { for (const f of this.data) f(d) }
  }
  const spawned: FakeTui[] = []
  return { FakeTui, spawned }
})
vi.mock('node-pty', () => ({ spawn: () => { const p = new pty.FakeTui(); pty.spawned.push(p); return p } }))

const { createTerminalService, SUBMIT_CHECKS_MS } = await import('../src/main/terminals')
const { TUI_WORKING } = await import('../src/main/harness')

const PING = 'Genio ping waiting: list C:/state/unit.inbox/*.msg, read and act on each in numeric order, then move each into C:/state/unit.inbox/handled/.'
const squash = (s: string): string => s.replace(/\s+/g, '').toLowerCase()
/** what crew's ring confirms on for a Codex unit: its working line */
const working = (since: string): boolean => TUI_WORKING.test(squash(since))

let svc: ReturnType<typeof createTerminalService>
const unit = () => {
  const t = svc.create({ kind: 'worker', title: 'unit', cwd: process.cwd(), file: 'codex', harness: 'codex' })
  return { id: t.id, tui: pty.spawned.at(-1)! }
}
const run = async <T>(p: Promise<T>): Promise<T> => {
  await vi.advanceTimersByTimeAsync(20_000)
  return p
}

beforeEach(() => {
  vi.useFakeTimers()
  svc = createTerminalService(() => ({ settings: { get: () => ({}) } }) as never)
})
afterEach(() => vi.useRealTimers())

describe('a confirmed submit', () => {
  it('presses Enter again when the TUI swallows the first one, and confirms on its working line', async () => {
    const { id, tui } = unit()
    tui.react = (d, nth) => d === PING ? `› ${PING}` : d === '\r' && nth >= 2 ? '\r\n• Working (0s • esc to interrupt)' : undefined
    expect(await run(svc.submit(id, PING, '\r', working))).toBe(true)
    expect(tui.written).toEqual([PING, '\r', '\r'])
  })

  it('retries when the Enter only became a newline in the input box (the text is drawn again, no working line)', async () => {
    const { id, tui } = unit()
    tui.react = (d, nth) => d === '\r' ? (nth === 1 ? `› ${PING}\r\n  ` : '• Working (1s • esc to interrupt)') : undefined
    expect(await run(svc.submit(id, PING, '\r', working))).toBe(true)
    expect(tui.written.filter(w => w === '\r')).toHaveLength(2)
  })

  it('gives up after a few presses with backoff and says so', async () => {
    const { id, tui } = unit()
    const p = svc.submit(id, PING, '\r', working)
    await vi.advanceTimersByTimeAsync(2_000)
    const early = tui.written.filter(w => w === '\r').length
    expect(early).toBeLessThan(SUBMIT_CHECKS_MS.length)
    expect(await run(p)).toBe(false)
    expect(tui.written.filter(w => w === '\r')).toHaveLength(SUBMIT_CHECKS_MS.length)
  })

  it('confirms at once on the first Enter when the TUI takes it', async () => {
    const { id, tui } = unit()
    tui.react = d => d === '\r' ? '• Working (0s • esc to interrupt)' : undefined
    expect(await run(svc.submit(id, PING, '\r', working))).toBe(true)
    expect(tui.written).toEqual([PING, '\r'])
  })

  it('waits for the echo of the typed text to settle before pressing Enter', async () => {
    const { id, tui } = unit()
    let keyAt = 0
    tui.react = d => { if (d === '\r' && !keyAt) keyAt = Date.now(); return d === '\r' ? 'esc to interrupt' : undefined }
    const start = Date.now()
    // the TUI keeps echoing the typed burst for 600 ms
    for (let i = 1; i <= 6; i++) setTimeout(() => tui.emit(PING.slice(0, i * 20)), i * 100)
    expect(await run(svc.submit(id, PING, '\r', working))).toBe(true)
    expect(keyAt - start).toBeGreaterThanOrEqual(600 + 250)
  })

  it('without a confirmation keeps the old single retry', async () => {
    const { id, tui } = unit()
    expect(await run(svc.submit(id, '/exit'))).toBe(true)
    expect(tui.written).toEqual(['/exit', '\r', '\r'])
  })
})
