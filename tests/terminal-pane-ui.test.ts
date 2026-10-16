// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ally, ChatMessage, ShellRun, TerminalInfo } from '../src/shared/types'

vi.hoisted(() => window.history.replaceState(null, '', '/?project=forest&wksp=forest'))
vi.mock('../src/renderer/src/views/Systems', () => ({ ModelSelect: () => null, EffortSelect: () => null }))
vi.mock('../src/renderer/src/components/ComingNext', () => ({ ComingNext: () => null }))
// xterm needs a real canvas; here the view only records which terminal it shows.
vi.mock('../src/renderer/src/components/Terminal', () => ({
  TerminalView: (p: { id: string; pane?: boolean }) => React.createElement('div', { className: 'term-mock', 'data-id': p.id, 'data-pane': String(!!p.pane) })
}))
import { ChatPanel } from '../src/renderer/src/views/Comms'
import { GenioPanel } from '../src/renderer/src/components/GenioPanel'
import { TerminalPane } from '../src/renderer/src/components/TerminalPane'
import { getState, setState } from '../src/renderer/src/store'
import { setDraft } from '../src/renderer/src/drafts'
import { PANE_DEFAULT, PANE_KEEP_ABOVE, PANE_MIN, clampPaneHeight, readPanePrefs, shellUnavailable } from '../src/renderer/src/lib/terminal-pane'

const WKSP = 'forest'
const initial = getState()
const shellTerm = (patch: Partial<TerminalInfo> = {}): TerminalInfo => ({ id: 'pane-1', title: 'Terminal', cwd: 'C:/games/forest', alive: true, cols: 120, rows: 32, kind: 'pane', project: WKSP, ...patch })
const api = {
  sendChat: vi.fn(async () => {}), steerChat: vi.fn(async () => {}), sendQueuedNow: vi.fn(async () => true), unqueueChat: vi.fn(async () => null),
  paneRun: vi.fn(async (_w: string, _m: string, command: string) => shellTerm({ id: 'run-1', run: command, title: `! ${command}` })),
  paneOpen: vi.fn(async (_w: string, cwd = 'main') => shellTerm({ cwd: cwd === 'main' ? 'C:/games/forest' : `C:/wt/${cwd}` })),
  paneClose: vi.fn(async () => {}),
  paneCwds: vi.fn(async () => [{ id: 'main', label: 'Main checkout', path: 'C:/games/forest' }, { id: 'u1', label: 'Unit · Fix the jump', path: 'C:/wt/u1', taskId: 'u1' }]),
  terminalKill: vi.fn(async () => {}),
  openExternal: vi.fn(async () => {})
}
let root: Root, host: HTMLDivElement, previous: typeof window.genio

function chatState(messages: ChatMessage[] = []): void {
  const ally: Ally = { name: WKSP, projects: [WKSP], scope: '', charter: '', home: '/fixture', createdAt: '2026-10-16' }
  setState({ ...initial, view: 'comms', chatLoaded: { [WKSP]: true }, settings: { gamertag: 'Dani' } as never,
    snap: { ...initial.snap, allies: [ally], wksps: [{ name: WKSP, displayName: 'Genio', activity: 'idle', costUsd: 0, turns: 0, queued: 0 }] },
    chats: { [WKSP]: messages } })
}
const textarea = () => host.querySelector('textarea')!
const box = () => host.querySelector('.composer-box')!
const type = async (value: string): Promise<void> => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea(), value)
    textarea().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => { textarea().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })) })
}
const flush = async (): Promise<void> => { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }) }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } })
  Object.assign(Element.prototype, { setPointerCapture() {}, releasePointerCapture() {} })
  localStorage.clear()
  previous = window.genio
  window.genio = { api } as never
  for (const f of Object.values(api)) f.mockClear()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(() => root.unmount()); host.remove(); setState(initial); setDraft(WKSP, '')
  window.genio = previous; vi.restoreAllMocks()
})

describe("'!' shell mode in the composer", () => {
  it('typing ! first switches to shell mode: glyph, amber border, placeholder; the draft keeps the !', async () => {
    chatState()
    await act(() => root.render(React.createElement(ChatPanel, { wksp: WKSP })))
    expect(textarea().placeholder).toContain('Message Genio')
    await type('!')
    expect(box().classList.contains('shell')).toBe(true)
    expect(host.querySelector('.composer-shell-glyph')?.textContent).toBe('!')
    expect(textarea().value).toBe('')
    expect(textarea().placeholder).toBe('run a shell command')
    expect(host.querySelector('.composer-shell-keys')?.textContent).toContain('Shell mode · Enter run')
    expect(host.querySelector('.composer-shell-keys [title]')?.getAttribute('title')).toContain('Genio reads the output with your next message')
    await type('git status')
    // switching screens keeps the shell draft
    await act(() => root.render(React.createElement('div')))
    await act(() => root.render(React.createElement(ChatPanel, { wksp: WKSP })))
    expect(box().classList.contains('shell')).toBe(true)
    expect(textarea().value).toBe('git status')
  })

  it('Enter runs the command in the pane (opening it on the run), never as chat, and remembers it for the up arrow', async () => {
    chatState()
    await act(() => root.render(React.createElement(ChatPanel, { wksp: WKSP })))
    await type('!')
    await type('npm test')
    await key('Enter')
    await flush()
    expect(api.paneRun).toHaveBeenCalledExactlyOnceWith(WKSP, WKSP, 'npm test', 'main')
    expect(api.sendChat).not.toHaveBeenCalled()
    expect(getState()).toMatchObject({ paneOpen: true, paneTab: 'run-1' })
    expect(getState().terminals['run-1']).toMatchObject({ run: 'npm test' })
    expect(box().classList.contains('shell')).toBe(false)
    expect(textarea().value).toBe('')
    await type('!')
    await key('ArrowUp')
    expect(textarea().value).toBe('npm test')
    await key('ArrowDown')
    expect(textarea().value).toBe('')
  })

  it('Esc and Backspace on the empty prompt leave shell mode; Esc first clears a typed command', async () => {
    chatState()
    await act(() => root.render(React.createElement(ChatPanel, { wksp: WKSP })))
    await type('!')
    await key('Backspace')
    expect(box().classList.contains('shell')).toBe(false)
    await type('!')
    await type('dir')
    await key('Escape')
    expect(box().classList.contains('shell')).toBe(true)
    expect(textarea().value).toBe('')
    await key('Escape')
    expect(box().classList.contains('shell')).toBe(false)
  })

  it('is unavailable while the pane shell cannot start: the ! stays text, and it is still never sent to Genio', async () => {
    chatState()
    setState({ terminals: { 'pane-1': shellTerm({ alive: false, exitCode: -1, startError: 'nosh did not start: not found' }) } })
    expect(shellUnavailable(getState())).toBe('The terminal shell could not start: nosh did not start: not found')
    await act(() => root.render(React.createElement(ChatPanel, { wksp: WKSP })))
    await type('!ls')
    expect(box().classList.contains('shell')).toBe(false)
    expect(host.querySelector('.composer-shell-off')?.textContent).toContain('nosh did not start')
    await key('Enter')
    await flush()
    expect(api.sendChat).not.toHaveBeenCalled()
    expect(api.paneRun).not.toHaveBeenCalled()
    expect(getState().toasts.at(-1)).toMatchObject({ title: 'Shell unavailable' })
    expect(textarea().value).toBe('!ls')
  })

  it('works the same from the floating Genio panel, opening the pane in this window', async () => {
    chatState()
    setState({ view: 'inventory' })
    await act(() => root.render(React.createElement(GenioPanel)))
    await type('!')
    await type('git log -1')
    await key('Enter')
    await flush()
    expect(api.paneRun).toHaveBeenCalledWith(WKSP, WKSP, 'git log -1', 'main')
    expect(getState().paneOpen).toBe(true)
  })
})

describe('the result block', () => {
  const run = (patch: Partial<ShellRun> = {}): ShellRun => ({ command: 'npm test', cwd: 'C:/games/forest', exitCode: 1, durationMs: 2300, output: 'Error: boom', truncated: false, ...patch })
  const block = (r: ShellRun): ChatMessage => ({ id: 'sh-1', wksp: WKSP, role: 'system', text: '! npm test', ts: '2026-10-16T12:00:00Z', shell: r })

  it('shows command, exit code, duration and output, marked run by you', async () => {
    chatState([block(run())])
    await act(() => root.render(React.createElement(ChatPanel, { wksp: WKSP })))
    const el = host.querySelector('.msg-shell')!
    expect(el.classList.contains('bad')).toBe(true)
    expect(el.querySelector('.msg-shell-who')?.textContent).toBe('run by you')
    expect(el.querySelector('.msg-shell-cmd')?.textContent).toBe('$ npm test')
    expect(el.querySelector('.msg-shell-exit')?.textContent).toBe('exit 1')
    expect(el.querySelector('.msg-shell-time')?.textContent).toContain('2.3 s')
    expect(el.querySelector('.msg-shell-out')?.textContent).toBe('Error: boom')
    await act(async () => el.querySelector<HTMLButtonElement>('.msg-shell-toggle')!.click())
    expect(el.querySelector('.msg-shell-out')).toBeNull()
  })

  it('long output shows its first lines, then Show more', async () => {
    const output = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    chatState([block(run({ exitCode: 0, output, truncated: true }))])
    await act(() => root.render(React.createElement(ChatPanel, { wksp: WKSP })))
    const out = () => host.querySelector('.msg-shell-out')!.textContent!
    expect(out().split('\n')).toHaveLength(12)
    expect(host.textContent).toContain('Long output: its start and end are kept.')
    const more = [...host.querySelectorAll<HTMLButtonElement>('.msg-shell .link-btn')].find((b) => b.textContent?.startsWith('Show more'))!
    expect(more.textContent).toBe('Show more (28 more lines)')
    await act(async () => more.click())
    expect(out().split('\n')).toHaveLength(40)
  })

  it('a command that could not run says why', async () => {
    chatState([block(run({ exitCode: undefined, error: 'pwsh did not start', output: '' }))])
    await act(() => root.render(React.createElement(ChatPanel, { wksp: WKSP })))
    expect(host.querySelector('.msg-shell-exit')?.textContent).toBe('did not run')
    expect(host.querySelector('.msg-shell-body')?.textContent).toContain('pwsh did not start')
  })
})

describe('the terminal pane', () => {
  const pane = () => host.querySelector<HTMLDivElement>('.term-pane')!
  const press = async (init: KeyboardEventInit): Promise<void> => {
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) })
    await flush()
  }
  const mount = async (): Promise<void> => { await act(() => root.render(React.createElement(TerminalPane))); await flush() }

  it('the height stays within the window: never under the minimum, always leaving the screen above usable', () => {
    expect(clampPaneHeight(10, 900)).toBe(PANE_MIN)
    expect(clampPaneHeight(5000, 900)).toBe(900 - PANE_KEEP_ABOVE)
    expect(clampPaneHeight(Number.NaN, 900)).toBe(PANE_DEFAULT)
    expect(clampPaneHeight(300, 200)).toBe(PANE_MIN)
  })

  it('hidden by default; Ctrl+` slides it open and starts the shell in the main checkout, again hides it with the shell kept', async () => {
    setState({ ...initial })
    await mount()
    expect(pane().style.height).toBe('0px')
    expect(pane().hasAttribute('inert')).toBe(true)
    expect(api.paneOpen).not.toHaveBeenCalled()
    await press({ key: '`', code: 'Backquote', ctrlKey: true })
    expect(getState().paneOpen).toBe(true)
    expect(pane().style.height).toBe(`${PANE_DEFAULT}px`)
    expect(pane().classList.contains('open')).toBe(true)
    expect(api.paneOpen).toHaveBeenCalledExactlyOnceWith(WKSP, 'main', false)
    expect(host.querySelector('.term-pane-view.on .term-mock')?.getAttribute('data-pane')).toBe('true')
    expect(document.documentElement.style.getPropertyValue('--term-pane-h')).toBe(`${PANE_DEFAULT}px`)
    await press({ key: '`', code: 'Backquote', ctrlKey: true })
    expect(pane().style.height).toBe('0px')
    expect(api.paneClose).not.toHaveBeenCalled()
    expect(getState().terminals['pane-1']).toBeDefined()
  })

  it('resizes by dragging or with the arrow keys, and remembers height and open state', async () => {
    setState({ ...initial })
    await mount()
    await press({ key: '`', code: 'Backquote', ctrlKey: true })
    const grip = host.querySelector<HTMLDivElement>('.term-pane-grip')!
    await act(async () => {
      grip.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientY: 500 }))
    })
    expect(pane().classList.contains('dragging')).toBe(true)
    await act(async () => { grip.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientY: 400 })) })
    await act(async () => { grip.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientY: 400 })) })
    expect(pane().classList.contains('dragging')).toBe(false)
    expect(pane().style.height).toBe(`${PANE_DEFAULT + 100}px`)
    await act(async () => { grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    expect(pane().style.height).toBe(`${PANE_DEFAULT + 120}px`)
    expect(readPanePrefs(WKSP)).toEqual({ height: PANE_DEFAULT + 120, open: true })
    // a new window session comes back open at that height
    await act(() => root.unmount())
    setState({ ...initial, terminals: getState().terminals })
    root = createRoot(host)
    await mount()
    expect(getState().paneOpen).toBe(true)
    expect(pane().style.height).toBe(`${PANE_DEFAULT + 120}px`)
  })


  it('a shell that ended shows its exit code and a Restart instead of a bare "session closed"', async () => {
    setState({ ...initial, paneOpen: true, terminals: { 'pane-1': shellTerm({ alive: false, exitCode: 2 }) } })
    await mount()
    expect(api.paneOpen).not.toHaveBeenCalled()
    const ended = host.querySelector('.term-pane-ended')!
    expect(ended.textContent).toContain('The shell ended with exit code 2.')
    expect(host.textContent).not.toMatch(/session closed/i)
    await act(async () => [...ended.querySelectorAll('button')].find((b) => b.textContent?.includes('Restart'))!.click())
    await flush()
    expect(api.paneOpen).toHaveBeenCalledWith(WKSP, 'main', true)
  })

  it('a folder that cannot be used shows the reason and blocks shell mode until Restart works', async () => {
    api.paneOpen.mockRejectedValueOnce(new Error('The terminal cannot start there: C:/games/forest does not exist.'))
    setState({ ...initial, paneOpen: true })
    await mount()
    expect(host.querySelector('.term-pane-empty')?.textContent).toContain('C:/games/forest does not exist.')
    expect(shellUnavailable(getState())).toContain('does not exist')
    await act(async () => host.querySelector<HTMLButtonElement>('.term-pane-empty button')!.click())
    await flush()
    expect(getState().paneError).toBeUndefined()
    expect(shellUnavailable(getState())).toBeUndefined()
  })

  it('switches folder between the main checkout and live unit copies', async () => {
    setState({ ...initial, paneOpen: true })
    await mount()
    const select = host.querySelector<HTMLSelectElement>('.term-pane-cwd')!
    expect([...select.options].map((o) => o.textContent)).toEqual(['Main checkout', 'Unit · Fix the jump'])
    await act(async () => {
      select.value = 'u1'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    expect(api.paneOpen).toHaveBeenLastCalledWith(WKSP, 'u1', false)
    expect(getState().paneCwd).toBe('u1')
  })

  it('shows ! runs as tabs with their exit codes; Close stops the shell and every run', async () => {
    setState({ ...initial, paneOpen: true, paneTab: 'run-1', terminals: {
      'pane-1': shellTerm(), 'run-1': shellTerm({ id: 'run-1', run: 'npm test', alive: false, exitCode: 1, processStartedAt: 1000, exitedAt: 3500 }),
      'elsewhere': shellTerm({ id: 'elsewhere', project: 'other' }) } })
    await mount()
    const tabs = [...host.querySelectorAll('.term-pane-tab')].map((t) => t.textContent?.trim())
    expect(tabs).toEqual(['Terminal', '! npm test1'])
    expect(host.querySelector('.term-pane-view.on .term-mock')?.getAttribute('data-id')).toBe('run-1')
    expect(host.querySelector('.term-pane-view.on .term-pane-run')?.textContent).toContain('exit 1 · 2.5 s · run by you')
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close terminal"]')!.click())
    expect(api.paneClose).toHaveBeenCalledWith(WKSP)
    expect(getState()).toMatchObject({ paneOpen: false, paneTab: undefined })
  })
})
