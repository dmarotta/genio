import { describe, expect, it } from 'vitest'
import { RECENT_LIMIT, fileKeyAction, fileMenu, type FileEntry } from '../src/renderer/src/lib/filemenu'
import type { WindowList } from '../src/shared/api'

const project = (name: string, addedAt = '2026-10-01') => ({ name, path: `C:/${name}`, addedAt })
const list: WindowList = {
  projects: [project('one'), project('alpha', '2026-09-01'), project('beta', '2026-08-01'), project('gamma', '2026-10-05')],
  windows: [{ project: 'one', current: true }, { project: null, current: false }, { project: 'beta', current: false }]
}
const labels = (entries: FileEntry[]) => entries.map(e => e.kind === 'separator' ? '---' : e.kind === 'item' && e.key ? `${e.label} [Ctrl ${e.key}]` : e.label)
const submenu = (entries: FileEntry[], id: string) => {
  const s = entries.find(e => e.id === id)
  if (s?.kind !== 'submenu') throw new Error(`no submenu ${id}`)
  return s
}
const key = (k: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> = { ctrlKey: true }) =>
  ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods })

describe('File menu entries', () => {
  it('offers open, recent, Hub, windows, close and exit in a project window with one set of accelerators', () => {
    expect(labels(fileMenu('one', list, []))).toEqual([
      'Open project… [Ctrl O]', 'Open recent', 'New window / Hub [Ctrl N]', 'Open windows', '---', 'Close window [Ctrl W]', 'Exit Genio [Ctrl Q]'
    ])
  })

  it('keeps only the relevant entries in the Hub', () => {
    expect(labels(fileMenu(undefined, list, []))).toEqual(['Open project… [Ctrl O]', 'Open windows', '---', 'Close window [Ctrl W]', 'Exit Genio [Ctrl Q]'])
  })

  it('lists other projects in the Hub order, marks open ones and opens them by path', () => {
    const recent = submenu(fileMenu('one', list, ['C:/beta', 'C:/missing']), 'recent')
    expect(recent.items.map(i => [i.label, i.hint, i.action])).toEqual([
      ['beta', 'Open', { type: 'open-project', path: 'C:/beta' }],
      ['gamma', undefined, { type: 'open-project', path: 'C:/gamma' }],
      ['alpha', undefined, { type: 'open-project', path: 'C:/alpha' }]
    ])
    const many = { ...list, projects: Array.from({ length: 20 }, (_, i) => project(`p${i}`)) }
    expect(submenu(fileMenu('one', many, []), 'recent').items).toHaveLength(RECENT_LIMIT)
    expect(submenu(fileMenu('one', { ...list, projects: [project('one')] }, []), 'recent').items).toEqual([])
  })

  it('counts open windows and switches to each, marking this one', () => {
    const windows = submenu(fileMenu('one', list, []), 'windows')
    expect(windows.count).toBe(3)
    expect(windows.items.map(i => [i.label, i.on, i.hint, i.action])).toEqual([
      ['one', true, 'This window', { type: 'open-project', path: 'C:/one' }],
      ['Hub', false, undefined, { type: 'hub' }],
      ['beta', false, undefined, { type: 'open-project', path: 'C:/beta' }]
    ])
  })
})

describe('File menu accelerators', () => {
  it('maps Ctrl/Cmd O, N, W and Q to their entries', () => {
    expect(fileKeyAction(key('o'), true)).toEqual({ type: 'open-folder' })
    expect(fileKeyAction(key('N'), true)).toEqual({ type: 'hub' })
    expect(fileKeyAction(key('w', { metaKey: true }), true)).toEqual({ type: 'close' })
    expect(fileKeyAction(key('q'), false)).toEqual({ type: 'quit' })
  })

  it('ignores plain, shifted and unrelated keys, and New window inside the Hub', () => {
    expect(fileKeyAction(key('o', {}), true)).toBeNull()
    expect(fileKeyAction(key('o', { ctrlKey: true, shiftKey: true }), true)).toBeNull()
    expect(fileKeyAction(key('k'), true)).toBeNull()
    expect(fileKeyAction(key('1'), true)).toBeNull()
    expect(fileKeyAction(key('n'), false)).toBeNull()
  })
})
