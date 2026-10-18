import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GENIO_CODEX, launchNeedsSignIn, signInsOf, type AccountStatus, type LoginState } from '../src/shared/api'
import { defaultChatModel, defaultProvider } from '../src/shared/unit-model-policy'
import type { AppCtx } from '../src/main/services'

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => Promise<unknown>>())
const reads = vi.hoisted(() => ({ list: [] as AccountStatus[], count: 0 }))
vi.mock('electron', () => ({
  app: { getAppPath: () => '.', quit: vi.fn() }, BrowserWindow: {}, dialog: {}, shell: {}, MessageChannelMain: {},
  ipcMain: { removeHandler: (channel: string) => handlers.delete(channel), handle: (channel: string, fn: (...args: any[]) => Promise<unknown>) => handlers.set(channel, fn) }
}))
const { registerIpc } = await import('../src/main/ipc')
const { bus } = await import('../src/main/bus')
const watch = await import('../src/main/sign-in-watch')
// Never runs a real status, login or logout command: the account rows are fixtures.
const reader = async (): Promise<AccountStatus[]> => { reads.count++; return reads.list }

const row = (tool: string, state: LoginState, installed = true): AccountStatus =>
  ({ tool, label: tool, purpose: '', installed, state, canLogin: true, canLogout: true, verified: true })
/** Claude's row and Genio's own Codex home (the player's own Codex login never counts). */
const rows = (claude: LoginState | 'missing', codex: LoginState | 'missing'): AccountStatus[] => [
  row('claude', claude === 'missing' ? 'unknown' : claude, claude !== 'missing'),
  row('codex', 'logged-in', codex !== 'missing'),
  row(GENIO_CODEX, codex === 'missing' ? 'unknown' : codex, codex !== 'missing')
]

describe('sign-ins and the default provider', () => {
  it('reads each combination, and only an unreadable state never blocks', () => {
    const cases: [LoginState | 'missing', LoginState | 'missing', boolean, 'claude' | 'codex'][] = [
      ['logged-in', 'logged-in', false, 'claude'],
      ['logged-in', 'logged-out', false, 'claude'],
      ['logged-out', 'logged-in', false, 'codex'],
      ['missing', 'logged-in', false, 'codex'],
      ['logged-out', 'logged-out', true, 'claude'],
      ['missing', 'missing', true, 'claude'],
      ['logged-out', 'missing', true, 'claude'],
      ['unknown', 'logged-out', false, 'claude']
    ]
    for (const [claude, codex, gate, provider] of cases) {
      const list = rows(claude, codex)
      expect(launchNeedsSignIn(list), `${claude}/${codex}`).toBe(gate)
      expect(defaultProvider(signInsOf(list)), `${claude}/${codex}`).toBe(provider)
    }
    expect(launchNeedsSignIn([])).toBe(false)
    expect(defaultChatModel(signInsOf(rows('logged-out', 'logged-in')))).toBe('codex:OpenAI:gpt-6.1-sol')
    expect(defaultChatModel(signInsOf(rows('logged-in', 'logged-in')))).toBe('claude-sonnet-5-5')
  })
})

describe('the launcher gate in the main process', () => {
  const events: unknown[] = []
  let off: () => void
  const openProject = vi.fn(async () => {})
  const manager = { binding: vi.fn(() => undefined), openHub: vi.fn(async () => {}), openProject, list: () => [], close: vi.fn() }
  const open = (): Promise<unknown> => handlers.get('genio:projectOpen')!({ sender: { id: 1 } }, 'C:/games/Zebra')

  beforeEach(() => {
    handlers.clear()
    openProject.mockClear()
    events.length = 0
    reads.count = 0
    off = bus.onEvent(ev => { if (ev.type === 'sign-in-needed') events.push(ev) })
    registerIpc((() => { throw new Error('opening must not need project services') }) as unknown as () => AppCtx, manager)
  })
  afterEach(() => { off(); watch.stopSignInWatch() })

  it('blocks opening while neither is signed in, and opens as soon as one is, without a restart', async () => {
    reads.list = rows('logged-out', 'logged-out')
    watch.startSignInWatch(60_000, reader)
    await expect(open()).rejects.toThrow('Sign in with Claude or Codex first.')
    expect(openProject).not.toHaveBeenCalled()
    expect(await handlers.get('genio:signInGate')!({ sender: { id: 1 } })).toBe(true)
    expect(events).toContainEqual({ type: 'sign-in-needed', tools: ['Claude', 'Codex'], gate: true })
    // the player finishes a sign-in: the next open reads again and goes through
    reads.list = rows('logged-out', 'logged-in')
    await expect(open()).resolves.toBeUndefined()
    expect(openProject).toHaveBeenCalledWith('C:/games/Zebra')
    expect(events.at(-1)).toEqual({ type: 'sign-in-needed', tools: ['Claude'], gate: false })
    expect(watch.currentSignIns()).toEqual({ claude: false, codex: true })
  })

  it('opens straight away while signed in, without reading the accounts again', async () => {
    reads.list = rows('logged-in', 'logged-out')
    watch.startSignInWatch(60_000, reader)
    await expect(open()).resolves.toBeUndefined()
    expect(reads.count).toBe(1)
    expect(openProject).toHaveBeenCalledOnce()
  })

  it('updates the gate live when a sign-in is lost or comes back', () => {
    watch.noteSignInAccounts(rows('logged-in', 'logged-in'))
    expect(watch.currentSignInGate()).toBe(false)
    watch.noteSignInAccounts(rows('logged-out', 'logged-out'))
    expect(watch.currentSignInGate()).toBe(true)
    watch.noteSignInAccounts(rows('logged-in', 'logged-out'))
    expect(watch.currentSignInGate()).toBe(false)
    expect(events.map(e => (e as { gate: boolean }).gate)).toEqual([true, false])
  })
})
