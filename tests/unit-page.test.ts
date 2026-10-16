// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Decision, Project, Task, TerminalInfo } from '../src/shared/types'
import { UNIT_ACTION_HINT } from '../src/shared/unit-actions'

// The agent terminal is xterm; here it only records how the page mounts it.
vi.mock('../src/renderer/src/components/Terminal', () => ({
  TerminalView: (p: { id: string; fontSize?: number; passive?: boolean; interactive?: boolean; autoFocus?: boolean }) =>
    React.createElement('div', { className: 'term-mock', 'data-id': p.id, 'data-font-size': String(p.fontSize ?? 12), 'data-passive': String(!!p.passive),
      'data-interactive': String(p.interactive ?? true), 'data-autofocus': String(!!p.autoFocus) })
}))
import { Squad } from '../src/renderer/src/views/Squad'
import { getState, setState } from '../src/renderer/src/store'

const initial = getState()
let root: Root, host: HTMLDivElement
let files: Record<string, string> = {}
const calls = new Map<string, ReturnType<typeof vi.fn>>()
const apiCall = (name: string): ReturnType<typeof vi.fn> => {
  if (!calls.has(name)) {
    calls.set(name, vi.fn(async (...args: unknown[]) => (name === 'readTaskFile' ? files[args[1] as string] ?? '' : { ok: true, message: 'ok' })))
  }
  return calls.get(name)!
}

const NOW = '2026-10-13T12:00:00Z'
const project = { name: 'world', path: 'C:/games/world', engine: 'other', commands: {}, defaultBranch: 'main', mode: 'local-only',
  forge: 'none', yolo: false, branchPrefix: 'genio/', managed: false, addedAt: '', gitRepo: true } as unknown as Project
const unit = (patch: Partial<Task> = {}): Task => ({ id: 'u1', title: 'Fix the jump', kind: 'ship', state: 'working', project: 'world', wksp: 'main',
  mode: 'local-only', harness: 'claude', model: 'opus', effort: 'high', branch: 'genio/u1', baseBranch: 'main', worktree: 'C:/wt/u1', relaunches: 0,
  inbox: { seq: 0, acked: 0, rings: 0 }, createdAt: '2026-10-13T11:00:00Z', updatedAt: '2026-10-13T11:30:00Z', ...patch } as Task)
const pty = (patch: Partial<TerminalInfo> = {}): TerminalInfo => ({ id: 'pty-1', taskId: 'u1', title: 'u1', cwd: 'C:/wt/u1', alive: true, cols: 120, rows: 32, kind: 'worker',
  lastOutputAt: NOW, ...patch })
const decision = (patch: Partial<Decision> = {}): Decision => ({ id: 'd1', key: 'playtest', wksp: 'main', taskId: 'u1', project: 'world', question: 'Keep the Playtest button?',
  options: ['Remove it', 'Keep it'], recommendation: 'Remove it', source: 'unit', urgency: 'normal', createdAt: NOW, ...patch })

async function open(t: Task, terminals: TerminalInfo[] = [], decisions: Decision[] = []): Promise<void> {
  setState({ ...initial, focus: { type: 'task', id: t.id }, terminals: Object.fromEntries(terminals.map((x) => [x.id, x])),
    snap: { ...initial.snap, tasks: [t], projects: [project], decisions } })
  await act(async () => root.render(React.createElement(Squad)))
}
const live = (patch: Partial<Task> = {}): Promise<void> => open(unit({ terminalId: 'pty-1', ...patch }), [pty()])
const button = (label: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)!
const click = async (el: HTMLElement): Promise<void> => { await act(async () => el.click()) }
const badge = (): Element => host.querySelector('.uh-state .chip')!
const primary = (): string[] => [...host.querySelectorAll('.uh-actions > button, .uh-actions > .verdict, .uh-actions > .unit-more > button')].map((b) => b.textContent!.trim() || b.className)
const menu = async (): Promise<{ label: string; hint: string; tone: string }[]> => {
  const more = button('More')
  if (!more) return []
  await click(more)
  const items = [...document.querySelectorAll('.unit-menu-item')].map((i) => ({ label: i.querySelector('.umi-label')!.textContent!, hint: i.querySelector('.umi-hint')!.textContent!,
    tone: i.classList.contains('danger') ? 'danger' : i.classList.contains('warn') ? 'warn' : '' }))
  await click(more)
  return items
}
const type = async (el: HTMLTextAreaElement | HTMLInputElement, value: string): Promise<void> => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  calls.clear()
  files = {}
  Object.assign(window, { genio: { on: () => () => {}, api: new Proxy({}, { get: (_, name: string) => apiCall(name) }) } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  setState(initial)
  vi.useRealTimers()
})

describe('unit page header and primary action', () => {
  it('a working unit: no toolbar, no play or Gauntlet button, no primary button, the terminal watched without focus, the ping box steers', async () => {
    await live()
    expect(host.querySelector('.detail-toolbar')).toBeNull()
    expect(host.textContent).not.toMatch(/Playtest|Gauntlet/)
    expect(calls.has('validateTask')).toBe(false)
    expect(badge().textContent).toBe('WORKING')
    expect(host.querySelector('.detail-clock')?.textContent).toBe('working 1 h 00 min')
    expect(primary()).toEqual(['More'])
    const term = host.querySelector('.detail-term .term-mock')!
    expect([term.getAttribute('data-passive'), term.getAttribute('data-interactive'), term.getAttribute('data-autofocus')]).toEqual(['true', 'true', 'false'])
    expect(host.querySelector('.unit-ping')!.classList.contains('steer')).toBe(true)
    expect(host.querySelector('.verdict')).toBeNull()
  })

  it('puts Interrupt, Respawn, Recall, Open folder and Despawn under More, each with its one-line consequence', async () => {
    await live()
    const items = await menu()
    expect(items.map((i) => i.label)).toEqual(['Interrupt', 'Respawn', 'Recall', 'Open folder', 'Despawn…'])
    expect(items.map((i) => i.hint)).toEqual([UNIT_ACTION_HINT.interrupt, UNIT_ACTION_HINT.respawn, UNIT_ACTION_HINT.recall, UNIT_ACTION_HINT.folder, UNIT_ACTION_HINT.despawn])
    for (const i of items) expect(i.hint).not.toMatch(/\n/)
    expect(items.find((i) => i.label === 'Despawn…')!.tone).toBe('danger')
  })

  it('a ready Offline Build: Merge into main, the clock stopped, no Respawn, rating left to the Merge confirm', async () => {
    await open(unit({ state: 'ready', readyAt: '2026-10-13T11:54:00Z' }))
    expect(badge().textContent).toBe('READY TO MERGE')
    expect(host.querySelector('.detail-clock')?.textContent).toBe('took 54 min')
    expect(host.querySelector('.uh-since')?.textContent).toBe('· ready 6m ago')
    expect(primary()).toEqual(['Merge into main', 'More'])
    expect((await menu()).map((i) => i.label)).toEqual(['Open folder', 'Despawn…'])
    await click(button('Merge into main'))
    expect(document.body.textContent).toContain('Fast-forward genio/u1 into main')
    expect(document.querySelector('.verdict-pick')).not.toBeNull()
    await click(button('Merge'))
    expect(calls.get('mergeTask')).toHaveBeenCalledWith('u1')
  })

  it('a ready PR: Merge PR #n off until green, plus Open PR', async () => {
    const pr = { url: 'https://github.com/o/r/pull/7', number: 7, state: 'OPEN' as const, checks: 'pending' as const }
    await open(unit({ state: 'ready', mode: 'direct-PR', readyAt: NOW, pr }))
    expect(primary()).toEqual(['Merge PR #7', 'Open PR', 'More'])
    expect(button('Merge PR #7').disabled).toBe(true)
    expect(button('Merge PR #7').title).toMatch(/still running/)
    await click(button('Open PR'))
    expect(calls.get('openExternal')).toHaveBeenCalledWith(pr.url)
    await open(unit({ state: 'ready', mode: 'direct-PR', readyAt: NOW, pr: { ...pr, checks: 'passing' } }))
    expect(button('Merge PR #7').disabled).toBe(false)
  })

  it('a failed unit: FAILED, Respawn with the reason in words, and the rating', async () => {
    await open(unit({ state: 'failed', stateReason: 'usage limit reached', finishedAt: '2026-10-13T11:20:00Z' }))
    expect(badge().textContent).toBe('FAILED')
    expect(badge().className).toContain('alert')
    expect(host.querySelector('.uh-line')?.textContent).toBe('Stopped: usage limit reached')
    expect(host.querySelector('.detail-clock')?.textContent).toBe('took 20 min')
    expect(primary()).toEqual(['verdict', 'Respawn', 'More'])
    await click(button('Respawn'))
    expect(calls.get('controlTask')).toHaveBeenCalledWith('u1', 'relaunch')
  })

  it('exited and detached units say they stopped instead of DONE or WORKING, and offer Respawn', async () => {
    await open(unit({ state: 'exited', stateReason: 'recalled' }))
    expect(badge().textContent).toBe('RECALLED')
    expect(primary()).toContain('Respawn')
    await open(unit({ state: 'detached', stateReason: undefined }))
    expect(badge().textContent).toBe('NOT RUNNING')
    expect(host.querySelector('.uh-line')?.textContent).toBe('Stopped: Genio restarted while it ran; its copy is intact.')
  })

  it('a merged, despawned Build: MERGED, no primary action and no More menu, the ping box off', async () => {
    await open(unit({ state: 'cleaned', landedAt: '2026-10-13T11:40:00Z', finishedAt: '2026-10-13T11:40:00Z', cleanedAt: '2026-10-13T11:41:00Z', landedCommit: '8f2c1e9a4b7d03' }))
    expect(badge().textContent).toBe('MERGED')
    expect(host.querySelector('.detail-clock')?.textContent).toBe('took 40 min')
    expect(primary()).toEqual(['verdict'])
    expect(host.querySelector<HTMLTextAreaElement>('.unit-ping textarea')!.disabled).toBe(true)
  })

  it('a finished Recon: its report first, Build from this report and Archive, never Respawn', async () => {
    await open(unit({ kind: 'scout', state: 'done', reportPath: 'C:/r.md', mode: undefined }))
    expect(primary()).toEqual(['verdict', 'Build from this report', 'Archive', 'More'])
    expect((await menu()).map((i) => i.label)).not.toContain('Respawn')
    expect(host.querySelector('.detail-side-tabs .tab.on')?.textContent).toBe('Report')
    expect(calls.get('readTaskFile')).toHaveBeenCalledWith('u1', 'report')
    await click(button('Archive'))
    expect(document.body.textContent).toContain('report, timeline and record stay')
    await click([...document.querySelectorAll<HTMLButtonElement>('.modal button')].find((b) => b.textContent?.trim() === 'Archive')!)
    expect(calls.get('cleanupTask')).toHaveBeenCalledWith('u1', false)
    await open(unit({ kind: 'scout', state: 'done', reportPath: 'C:/r.md', mode: undefined }))
    await click(button('Build from this report'))
    expect(document.body.textContent).toContain("The Recon's report becomes the context for a Build")
  })

  it('a unit waiting on the player: the open question inline, answered with one click', async () => {
    await live({ state: 'needs-decision' })
    expect(host.textContent).not.toContain('Open question')
    await open(unit({ state: 'needs-decision', terminalId: 'pty-1' }), [pty()], [decision()])
    expect(host.querySelector('.uq-q')?.textContent).toBe('Keep the Playtest button?')
    expect(button('Remove it').className).toContain('solid')
    await click(button('Remove it'))
    expect(calls.get('answerDecision')).toHaveBeenCalledWith('d1', 'Remove it')
  })

  it('a blocked unit with no recorded choice shows its last word and points to the ping box', async () => {
    files.status = 'blocked [at=1791892800]: need the Steam app id\n'
    await live({ state: 'blocked' })
    expect(host.querySelector('.uq-q')?.textContent).toBe('need the Steam app id')
    expect(host.querySelector('.uq-hint')?.textContent).toBe('Answer in the ping box below.')
  })

  it('keeps the facts in a details popover: branch, model, effort, delivery as Merge into main, Auto-loot, commit', async () => {
    await open(unit({ state: 'merged', category: 'bugfix', landedCommit: '8f2c1e9a4b7d03', loadout: ['Rule: bugfix → claude/opus'] }))
    expect(document.querySelector('.unit-info-pop')).toBeNull()
    await click(host.querySelector<HTMLButtonElement>('.uh-info')!)
    const facts = Object.fromEntries([...document.querySelectorAll('.ui-row')].map((r) => [r.querySelector('dt')!.textContent, r.querySelector('dd')!.textContent]))
    expect(facts).toMatchObject({ Project: 'world', Branch: 'genio/u1 → main', Model: 'claude / opus', Effort: 'high', Delivery: 'Merge into main',
      'Auto-loot': 'Off: merging waits for you', Commit: '8f2c1e9a4b7d' })
    expect(facts.Category).toBeTruthy()
    expect(document.querySelector('.ui-loadout')?.textContent).toContain('Rule: bugfix')
    expect(document.body.textContent).not.toMatch(/Offline/)
  })
})

describe('unit page content', () => {
  it('marks the terminal "needs input" when the agent has been quiet past the lagging window, or is stale', async () => {
    await live()
    expect(host.querySelector('.needs-input')).toBeNull()
    await open(unit({ terminalId: 'pty-1' }), [pty({ lastOutputAt: '2026-10-13T11:50:00Z' })])
    expect(host.querySelector('.detail-term .needs-input')?.textContent).toContain('needs input')
    await live({ state: 'stale' })
    expect(host.querySelector('.needs-input')).not.toBeNull()
  })

  it('shows the diffstat, changed files, commits and the unit\'s reported tests on the Changes tab', async () => {
    files.diffstat = JSON.stringify({
      stat: ' src/a.ts | 12 ++++++----\n src/b.ts |  4 ++++\n 2 files changed, 13 insertions(+), 3 deletions(-)\n',
      commits: ['abc123 Add jump buffer'], uncommitted: [' M src/c.ts'] })
    files.status = 'working [at=1791892000]: wiring\ndone [at=1791892500]: branch ready, tests green\n'
    await open(unit({ state: 'ready', readyAt: NOW }))
    expect(calls.get('readTaskFile')).toHaveBeenCalledWith('u1', 'diffstat')
    expect(host.querySelector('.ch-sum')?.textContent).toBe('+13 −3 · 2 files · 1 commit · 1 uncommitted')
    expect([...host.querySelectorAll('.ch-files .ch-path')].map((p) => p.textContent)).toEqual(['src/a.ts', 'src/b.ts', ' M src/c.ts'])
    expect(host.querySelector('.ch-tests-line')?.textContent).toBe('The unit reported: “branch ready, tests green”')
    expect(host.querySelector('.detail-side-tabs .tab.on')?.textContent).toBe('Changes2')
  })

  it('merges status lines and pings into one Timeline, newest first', async () => {
    files.status = 'working [at=1791892000]: wiring the jump\nworking [at=1791892600]: tests next\n'
    files.inbox = '--- READ 001.msg at=2026-10-13T11:50:00.000Z ---\nkeep the old input map'
    await open(unit())
    await click([...host.querySelectorAll<HTMLButtonElement>('.detail-side-tabs .tab')].find((t) => t.textContent === 'Timeline')!)
    const rows = [...host.querySelectorAll('.tl-row')].map((r) => `${r.querySelector('.tl-verb')!.textContent} ${r.querySelector('.tl-text')!.textContent}`)
    expect(rows).toEqual(['working tests next', 'you keep the old input map', 'working wiring the jump'])
  })

  it('keeps Changes, Timeline and Brief one click away in narrow windows, with the terminal as the default pane', async () => {
    await live({ mode: 'no-mistakes' })
    const strip = (): string[] => [...host.querySelectorAll('.detail-switch .tab')].map((t) => t.textContent!)
    expect(strip()).toEqual(['Terminal', 'Changes', 'Timeline', 'Brief', 'Checks'])
    const body = host.querySelector('.detail-body')!
    expect(body.classList.contains('pane-terminal')).toBe(true)
    await click([...host.querySelectorAll<HTMLButtonElement>('.detail-switch .tab')].find((t) => t.textContent === 'Brief')!)
    expect(body.classList.contains('pane-side')).toBe(true)
    expect(host.querySelector('.detail-side-tabs .tab.on')?.textContent).toBe('Brief')
  })

  it('sends a ping full width under the content, optionally interrupting first', async () => {
    await live()
    const box = host.querySelector<HTMLTextAreaElement>('.unit-ping textarea')!
    await type(box, 'use the old input map')
    await click(host.querySelector<HTMLInputElement>('.ping-interrupt input')!)
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.unit-ping .btn')!.click()
      await new Promise((r) => setTimeout(r, 600))
    })
    expect(calls.get('controlTask')).toHaveBeenCalledWith('u1', 'interrupt')
    expect(calls.get('sendToTask')).toHaveBeenCalledWith('u1', 'use the old input map')
    expect(calls.get('controlTask')!.mock.invocationCallOrder[0]).toBeLessThan(calls.get('sendToTask')!.mock.invocationCallOrder[0])
    await type(box, 'just a note')
    await act(async () => host.querySelector<HTMLButtonElement>('.unit-ping .btn')!.click())
    expect(calls.get('controlTask')).toHaveBeenCalledTimes(1)
  })

  it('offers no shell: not under More, not in the Squad header; the unit page keeps only the agent terminal', async () => {
    await live()
    expect((await menu()).map((i) => i.label)).not.toContain('Open shell')
    expect(host.textContent).not.toMatch(/\bShell\b/)
    expect(host.querySelectorAll('.term-mock')).toHaveLength(1)
    await act(async () => setState({ focus: null }))
    expect([...host.querySelectorAll('button')].map((b) => b.textContent?.trim())).not.toContain('Shell')
    expect(calls.has('terminalOpenShell')).toBe(false)
  })

  it('warns before despawning a Build with an open PR, and says Recall does not stick', async () => {
    await open(unit({ state: 'ready', mode: 'direct-PR', pr: { url: 'https://github.com/o/r/pull/7', number: 7, state: 'OPEN' } }))
    await click(button('More'))
    await click([...document.querySelectorAll<HTMLButtonElement>('.unit-menu-item')].find((b) => b.textContent?.startsWith('Despawn'))!)
    expect(document.querySelector('.despawn-pr')?.textContent).toContain('PR #7 is still open')
    await click(button('Cancel'))
    await live()
    await click(button('More'))
    await click([...document.querySelectorAll<HTMLButtonElement>('.unit-menu-item')].find((b) => b.textContent?.startsWith('Recall'))!)
    expect(document.body.textContent).toContain('reopening the project respawns it automatically')
    expect(document.body.textContent).not.toContain('respawn any time')
  })
})

describe('Play this unit', () => {
  const unity = { ...project, engine: 'unity' } as Project
  const openUnity = async (t: Task, terminals: TerminalInfo[] = []): Promise<void> => {
    setState({ ...initial, focus: { type: 'task', id: t.id }, terminals: Object.fromEntries(terminals.map((x) => [x.id, x])),
      snap: { ...initial.snap, tasks: [t], projects: [unity], decisions: [] } })
    await act(async () => root.render(React.createElement(Squad)))
  }
  const play = (): HTMLButtonElement | undefined => host.querySelector<HTMLButtonElement>('.uh-actions > button.uh-play') ?? undefined
  afterEach(() => { localStorage.clear(); Reflect.deleteProperty(window, 'matchMedia') })

  it('is offered only for Builds in a project with Play', async () => {
    await open(unit({ state: 'ready', readyAt: NOW }))
    expect(play()).toBeUndefined()
    await openUnity(unit({ kind: 'scout', state: 'working', mode: undefined }))
    expect(play()).toBeUndefined()
  })

  it('sits beside Merge on a ready Build, never instead of it', async () => {
    await openUnity(unit({ state: 'ready', readyAt: NOW }))
    expect(primary()).toEqual(['Merge into main', 'Play', 'More'])
    expect(play()!.disabled).toBe(false)
    expect(play()!.title).toContain('as the source')
  })

  it.each([
    ['working', { terminalId: 'pty-1' }],
    ['blocked', {}],
    ['needs-decision', {}],
    ['paused', {}],
    ['failed', {}],
    ['merged', { landedCommit: '8f2c1e9' }]
  ] as const)('is enabled while the worktree exists: %s', async (state, patch) => {
    await openUnity(unit({ state, ...patch }), [pty()])
    expect(play()!.disabled).toBe(false)
  })

  it('is disabled with the reason once the worktree is gone', async () => {
    await openUnity(unit({ state: 'cleaned', landedCommit: '8f2c1e9a4b7d03', cleanedAt: NOW }))
    expect(play()!.disabled).toBe(true)
    expect(play()!.title).toBe('Merged and removed: its work is in main now. Play main from the Play screen.')
    await openUnity(unit({ state: 'cleaned', cleanedAt: NOW }))
    expect(play()!.title).toBe('Despawned: its worktree is gone, so there is nothing of it to play.')
    files = { diffstat: '(worktree removed)' }
    await openUnity(unit({ id: 'u2', state: 'done' }))
    await act(async () => { await Promise.resolve() })
    expect(play()!.disabled).toBe(true)
    expect(play()!.title).toBe('Its worktree was removed, so there is nothing of it to play.')
  })

  it('opens that project\'s Play with the unit preselected, once, without starting Unity', async () => {
    await openUnity(unit({ state: 'ready', readyAt: NOW }))
    await click(play()!)
    expect(JSON.parse(localStorage.getItem('genio.play.request')!)).toMatchObject({ world: 'world', source: 'unit:u1' })
    expect(apiCall('projectOpen')).toHaveBeenCalledWith('C:/games/world')
    expect(calls.has('playerInstanceEnterPlay')).toBe(false)
    expect(calls.has('playerInstanceStartUnity')).toBe(false)
  })

  it('moves under More on narrow widths, where a disabled Play says why', async () => {
    Object.assign(window, { matchMedia: (q: string) => ({ matches: q.includes('720px'), addEventListener: () => {}, removeEventListener: () => {} }) })
    await openUnity(unit({ state: 'ready', readyAt: NOW }))
    expect(play()).toBeUndefined()
    expect(primary()).toEqual(['Merge into main', 'More'])
    const items = await menu()
    expect(items[0]).toMatchObject({ label: 'Play' })
    await openUnity(unit({ state: 'cleaned', cleanedAt: NOW }))
    await click(button('More'))
    expect(document.querySelector<HTMLButtonElement>('.unit-menu-item')!.disabled).toBe(true)
  })
})

describe('Modeller unit before its first step', () => {
  const step = { id: 's001', n: 1, caption: 'Raising four timber legs', triangles: 12, parts: 4, warnings: 0, ms: 1500, glb: 'genio-media://model/x/modeller/tower/steps/s001/model.glb', view: 'genio-media://model/x/modeller/tower/steps/s001/view.png' }
  const model = (steps: typeof step[]) => ({ model: 'tower', branch: 'main', branches: ['main'], steps, checks: [], running: null, failure: null, stamp: String(steps.length) })
  const sideTabs = (): string[] => [...host.querySelectorAll('.detail-side-tabs [role="tab"]')].map((b) => b.textContent!.trim())
  const sideTab = (label: string): HTMLButtonElement => [...host.querySelectorAll<HTMLButtonElement>('.detail-side-tabs [role="tab"]')].find((b) => b.textContent!.trim() === label)!

  it('is canvas first from the start: an empty 3D scene, Steps then Terminal then Changes, no steps yet, no Accept', async () => {
    calls.set('modellerLive', vi.fn(async () => null))
    await live({ modeller: true })
    const canvas = host.querySelector('.detail-body .detail-canvas')!
    expect(canvas.querySelector('iframe')!.getAttribute('title')).toBe('Live 3D view')
    expect(canvas.querySelector('[role="status"]')).toBeNull()
    expect(canvas.textContent).not.toMatch(/Waiting|loading|step/i)
    expect(host.querySelector('.detail-body > .detail-term .term-mock')).toBeNull()
    expect([...host.querySelectorAll('.detail-switch [role="tab"]')].map((b) => b.textContent!.trim())).toEqual(['Model', 'Steps', 'Terminal', 'Changes', 'Timeline', 'Brief'])
    expect(sideTabs()).toEqual(['Steps', 'Terminal', 'Changes', 'Timeline', 'Brief'])
    expect(host.querySelector('.detail-tab')!.textContent).toBe('No steps yet.')
    expect(primary()).toEqual(['More'])
    expect(host.textContent).not.toMatch(/accept/i)
  })

  it('shows its terminal tab at the legible size, fitted to the tab, with no enlarge or click-to-type control', async () => {
    calls.set('modellerLive', vi.fn(async () => null))
    await live({ modeller: true })
    await click(sideTab('Terminal'))
    const term = host.querySelector('.detail-tab-term .term-mock')!
    expect([term.getAttribute('data-font-size'), term.getAttribute('data-passive'), term.getAttribute('data-interactive')]).toEqual(['13', 'false', 'true'])
    expect(host.querySelector('.detail-tab-term')!.querySelectorAll('button')).toHaveLength(0)
    expect(host.textContent).not.toMatch(/enlarge|click to type/i)
  })

  it('shows the head step once one exists and offers what a working Build offers: steering, no Accept', async () => {
    calls.set('modellerLive', vi.fn(async () => model([step])))
    await live({ modeller: true })
    expect(host.querySelector('.detail-canvas [role="status"]')!.textContent).toBe('Step 1 · Raising four timber legs')
    expect(primary()).toEqual(['More'])
    expect(button('Accept step 1')).toBeUndefined()
    expect(host.querySelector('.ping-box, textarea')).not.toBeNull()
  })

  it('a ready Modeller offers Merge like any Build', async () => {
    calls.set('modellerLive', vi.fn(async () => model([step])))
    await live({ modeller: true, state: 'ready', readyAt: NOW })
    expect(primary()).toEqual(['Merge into main', 'More'])
  })

  it('a landed Modeller with no model data falls back to its terminal', async () => {
    calls.set('modellerLive', vi.fn(async () => null))
    await live({ modeller: true, state: 'merged', landedAt: NOW })
    expect(host.querySelector('.detail-canvas')).toBeNull()
    expect(host.querySelector('.detail-term .term-mock')).not.toBeNull()
  })

  it('its Squad card shows an empty frame, never the terminal', async () => {
    calls.set('modellerLive', vi.fn(async () => null))
    setState({ ...initial, focus: null, terminals: { 'pty-1': pty() }, snap: { ...initial.snap, tasks: [unit({ modeller: true, terminalId: 'pty-1' })], projects: [project] } })
    await act(async () => root.render(React.createElement(Squad)))
    const card = host.querySelector('.unit-card .unit-term')!
    expect(card.querySelector('.term-mock')).toBeNull()
    expect(card.querySelector('.modeller-card img')).toBeNull()
    expect(card.querySelector('.modeller-card-empty')!.textContent).toBe('')
    expect(card.querySelector('.modeller-card-caption')!.textContent).toBe('No steps yet')
  })
})