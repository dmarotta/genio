import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GENIO_CODEX, signInLines, signInNeeds, type AccountStatus, type LoginState } from '@shared/api'
import type { GenioEvent } from '@shared/types'

// The accounts the watch reads: swapped per test, no CLI ever runs.
const rows = vi.hoisted(() => ({ list: [] as AccountStatus[] }))
vi.mock('../src/main/accounts', () => ({ listSignInAccounts: async () => rows.list }))
import { bus } from '../src/main/bus'
import { currentSignInNeeds, noteSignInAccounts, refreshSignInNeeds, startSignInWatch, stopSignInWatch } from '../src/main/sign-in-watch'

const account = (tool: string, state: LoginState, installed = true): AccountStatus =>
  ({ tool, label: tool, purpose: '', installed, state, canLogin: true, canLogout: true, verified: true })

/** Claude, the player's own Codex login, and Genio's own Codex home, in the named states. */
const accounts = (claude: LoginState, genioCodex: LoginState | undefined, ownCodex: LoginState = 'logged-in'): AccountStatus[] => [
  account('claude', claude), account('codex', ownCodex), ...(genioCodex ? [account(GENIO_CODEX, genioCodex)] : [])
]

describe('which sign-ins need a warning', () => {
  it('Claude: only a logged-out Claude warns (signed in, expired and unreadable states)', () => {
    expect(signInNeeds(accounts('logged-in', 'logged-in'))).toEqual([])
    expect(signInNeeds(accounts('logged-out', 'logged-in'))).toEqual(['Claude'])
    // `claude auth status` reports an expired or revoked login as logged out
    expect(signInNeeds(accounts('unknown', 'logged-in'))).toEqual([])
  })

  it("Codex: Genio's own home decides, never the player's own login", () => {
    expect(signInNeeds(accounts('logged-in', 'logged-in', 'logged-out'))).toEqual([])
    expect(signInNeeds(accounts('logged-in', 'logged-out', 'logged-in'))).toEqual(['Codex'])
    // an API-key login (or any home that cannot be used) reads as unknown in the Genio row: still not signed in
    expect(signInNeeds(accounts('logged-in', 'unknown', 'logged-in'))).toEqual(['Codex'])
  })

  it('names exactly the tools that need it, one line each', () => {
    expect(signInNeeds(accounts('logged-out', 'logged-out'))).toEqual(['Claude', 'Codex'])
    expect(signInLines(['Claude', 'Codex'])).toEqual(['Claude is not signed in', 'Codex is not signed in'])
  })

  it('a tool that is not installed has nothing to sign in to', () => {
    expect(signInNeeds([account('claude', 'logged-out', false), account('codex', 'logged-out', false), account(GENIO_CODEX, 'logged-out', false)])).toEqual([])
  })

  it('no other sign-in ever warns', () => {
    const others = ['gh', 'glab', 'gemini', 'opencode', 'cursor-agent', 'fal', 'uthana', 'unity', 'mcp', 'github', 'openrouter'].map(t => account(t, 'logged-out'))
    expect(signInNeeds([...accounts('logged-in', 'logged-in'), ...others])).toEqual([])
    expect(signInNeeds(others)).toEqual([])
  })
})

describe('the warning follows the state', () => {
  const events: GenioEvent[] = []
  let off: () => void
  beforeEach(() => { events.length = 0; off = bus.onEvent(ev => { if (ev.type === 'sign-in-needed') events.push(ev) }); stopSignInWatch() })
  afterEach(() => { off(); stopSignInWatch(); vi.useRealTimers() })

  it('appears at start, says nothing more while unchanged, and clears by itself once signed in', async () => {
    rows.list = accounts('logged-in', 'logged-out')
    startSignInWatch(60_000)
    await vi.waitFor(() => expect(currentSignInNeeds()).toEqual(['Codex']))
    await refreshSignInNeeds()
    noteSignInAccounts(rows.list)
    expect(events).toEqual([{ type: 'sign-in-needed', tools: ['Codex'] }])
    rows.list = accounts('logged-in', 'logged-in')
    await refreshSignInNeeds()
    expect(currentSignInNeeds()).toEqual([])
    expect(events.at(-1)).toEqual({ type: 'sign-in-needed', tools: [] })
    expect(events).toHaveLength(2)
  })

  it('warns again when a signed-in tool loses its sign-in', async () => {
    rows.list = accounts('logged-in', 'logged-in')
    await refreshSignInNeeds()
    expect(events).toHaveLength(0)
    rows.list = accounts('logged-out', 'logged-in')
    await refreshSignInNeeds()
    expect(currentSignInNeeds()).toEqual(['Claude'])
    rows.list = accounts('logged-out', 'unknown')
    await refreshSignInNeeds()
    expect(currentSignInNeeds()).toEqual(['Claude', 'Codex'])
    expect(events.map(e => (e as { tools: string[] }).tools)).toEqual([['Claude'], ['Claude', 'Codex']])
  })

  it('re-reads on a timer, and a failed read keeps the last answer', async () => {
    vi.useFakeTimers()
    rows.list = accounts('logged-in', 'logged-in')
    startSignInWatch(1_000)
    await vi.advanceTimersByTimeAsync(0)
    rows.list = accounts('logged-in', 'logged-out')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(currentSignInNeeds()).toEqual(['Codex'])
    rows.list = undefined as unknown as AccountStatus[]
    await vi.advanceTimersByTimeAsync(1_000)
    expect(currentSignInNeeds()).toEqual(['Codex'])
  })
})
