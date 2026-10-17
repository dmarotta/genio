// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '../src/shared/types'
const f = vi.hoisted(() => ({ read: vi.fn(), refs: vi.fn(async () => []), open: vi.fn(async () => undefined) }))
vi.mock('../src/renderer/src/store', () => ({ api: () => ({ readTaskFile: f.read, taskReferences: f.refs, openPath: f.open }), errText: (e: unknown) => String((e as Error)?.message ?? e) }))
import { BriefSummaryView, BriefTab } from '../src/renderer/src/components/BriefTab'
import { briefSummary, SUMMARY_CHARS } from '../src/shared/unit-brief'
import { BRIEF_BOILERPLATE } from './unit-brief-boilerplate'
// Real unit briefs, trimmed (see tests/unit-brief.test.ts)
import build from './fixtures/briefs/build.md?raw'
import recon from './fixtures/briefs/recon.md?raw'
import modeller from './fixtures/briefs/modeller.md?raw'
import generator from './fixtures/briefs/generator.md?raw'

let root: Root, host: HTMLDivElement
const render = async (el: React.ReactElement): Promise<void> => { await act(async () => root.render(el)) }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks() })

describe('Brief tab', () => {
  const kinds: { name: string; t: Partial<Task>; brief: string }[] = [
    { name: 'Build', t: { kind: 'ship', title: 'Unit timeline: rename NOTE to EVENT' }, brief: build },
    { name: 'Recon', t: { kind: 'scout', title: 'Recon: true GPU buffer sharing for Play' }, brief: recon },
    { name: 'Modeller', t: { kind: 'ship', modeller: true, title: 'Model a small stylized sailing ship' }, brief: modeller },
    { name: 'Generator', t: { kind: 'ship', generator: true, title: 'Tavern sounds' }, brief: generator }
  ]

  it.each(kinds)('shows a $name unit\'s ask and a short summary, never the brief\'s boilerplate or the title the header already shows', async ({ t, brief }) => {
    const unit = { id: 'u1', state: 'working', ...t } as Task
    await render(React.createElement(BriefSummaryView, { t: unit, brief }))
    const { ask, summary } = briefSummary(undefined, brief)
    expect(ask.length).toBeGreaterThan(10)
    expect([...host.querySelectorAll('.brief-label')].map((e) => e.textContent)).toEqual(['Your ask', 'What the unit will do'])
    expect(host.querySelector('.brief-ask')!.textContent).toBe(ask)
    expect(host.querySelector('.brief-what')!.textContent).toBe(summary)
    const text = host.textContent!
    for (const b of BRIEF_BOILERPLATE) expect(text, b).not.toContain(b)
    expect(text).not.toContain(unit.title)
    expect(text.length).toBeLessThan(ask.length + SUMMARY_CHARS + 40)
    expect(host.querySelectorAll('button')).toHaveLength(0)
  })

  it('reads the brief file and shows the summary Genio wrote at deploy', async () => {
    f.read.mockResolvedValue(modeller)
    const unit = { id: 'u2', kind: 'ship', modeller: true, title: 'Sailing ship', summary: 'Builds a small low-poly sailing ship in live steps so you can watch the page.' } as Task
    await render(React.createElement(BriefTab, { t: unit }))
    expect(f.read).toHaveBeenCalledWith('u2', 'brief')
    expect(host.querySelector('.brief-ask')!.textContent).toBe('make a new model unit I want to check the UI of the unit, then do not merge it')
    expect(host.querySelector('.brief-what')!.textContent).toBe(unit.summary)
  })

  it('lists the player\'s attachments under References (name, note, a thumbnail for images) and opens one on click; nothing without any', async () => {
    f.read.mockResolvedValue(modeller)
    f.refs.mockResolvedValueOnce([
      { file: 'sketch.png', note: 'the silhouette to match', type: 'image', path: 'C:/data/u5/references/sketch.png', thumb: 'data:image/png;base64,cG5n' },
      { file: 'size.md', type: 'text', path: 'C:/data/u5/references/size.md' }
    ])
    await render(React.createElement(BriefTab, { t: { id: 'u5', kind: 'ship', modeller: true, title: 'Tower' } as Task }))
    expect(f.refs).toHaveBeenCalledWith('u5')
    expect([...host.querySelectorAll('.brief-label')].map((e) => e.textContent)).toEqual(['Your ask', 'What the unit will do', 'References'])
    const rows = [...host.querySelectorAll('.brief-refs li')]
    expect(rows.map((r) => r.textContent)).toEqual(['sketch.pngthe silhouette to match', 'size.md'])
    expect(rows[0].querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,cG5n')
    expect(rows[1].querySelector('img')).toBeNull()
    expect(host.textContent).not.toContain('C:/data')
    await act(async () => (rows[1].querySelector('button') as HTMLButtonElement).click())
    expect(f.open).toHaveBeenCalledWith('C:/data/u5/references/size.md')
    await render(React.createElement(BriefTab, { t: { id: 'u6', kind: 'ship', title: 'Plain' } as Task }))
    expect(host.querySelector('.brief-refs')).toBeNull()
  })

  it('says so when the brief is missing or unreadable', async () => {
    f.read.mockResolvedValue('(no brief)')
    await render(React.createElement(BriefTab, { t: { id: 'u3', kind: 'ship', title: 'Old unit' } as Task }))
    expect(host.textContent).toBe('Your askNot recorded.What the unit will doNo summary.')
    f.read.mockRejectedValue(new Error('gone'))
    await render(React.createElement(BriefTab, { t: { id: 'u4', kind: 'ship', title: 'Gone unit', summary: 'Fixed the jump.' } as Task }))
    expect(host.textContent).toContain('The brief could not be read.')
    expect(host.textContent).toContain('Fixed the jump.')
  })
})
