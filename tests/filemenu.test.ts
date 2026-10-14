import { describe, expect, it } from 'vitest'
import { RECENT_LIMIT, fileKeyAction, fileMenu } from '../src/renderer/src/lib/filemenu'
import type { WindowList } from '../src/shared/api'

const project = (name: string, addedAt = '2026-10-01') => ({ name, path: `C:/${name}`, addedAt })
const list: WindowList = {
  projects: [project('one'), project('alpha', '2026-09-01'), project('beta', '2026-08-01'), project('gamma', '2026-10-05')],
  windows: [{ project: 'one', current: true }, { project: null, current: false }, { project: 'beta', current: false }]
}
const recent = (value: WindowList, paths: string[] = []) => {
  const entry = fileMenu(value, paths)[1]
  if (entry.kind !== 'submenu') throw new Error('Missing recent projects submenu')
  return entry
}
const key = (k: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> = { ctrlKey: true }) =>
  ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods })

describe('File menu entries', () => {
  it.each([list, { projects: [], windows: [{ project: null, current: true }] }])('offers exactly Hub, Open Recent and Exit in every window', value => {
    const entries = fileMenu(value, [])
    expect(entries.map(e => e.label)).toEqual(['Hub', 'Open Recent', 'Exit'])
    expect(entries[0]).toMatchObject({ key: 'N', action: { type: 'hub' } })
    expect(entries[2]).toMatchObject({ action: { type: 'exit' } })
    expect(entries[2]).not.toHaveProperty('key')
  })

  it('orders recent projects, includes the current project and marks open projects for focus', () => {
    expect(recent(list, ['C:/beta', 'C:/missing']).items.map(i => [i.label, i.hint, i.action])).toEqual([
      ['beta', 'Open', { type: 'open-project', path: 'C:/beta' }],
      ['gamma', undefined, { type: 'open-project', path: 'C:/gamma' }],
      ['one', 'Open', { type: 'open-project', path: 'C:/one' }],
      ['alpha', undefined, { type: 'open-project', path: 'C:/alpha' }]
    ])
    expect(recent({ ...list, projects: Array.from({ length: 20 }, (_, i) => project(`p${i}`)) }).items).toHaveLength(RECENT_LIMIT)
    expect(recent({ ...list, projects: [] }).items).toEqual([])
    expect(recent({ ...list, projects: [] }).empty).toBe('No recent projects yet.')
  })
})

describe('File menu accelerator', () => {
  it('maps only Ctrl/Cmd N to the Hub', () => {
    expect(fileKeyAction(key('n'))).toEqual({ type: 'hub' })
    expect(fileKeyAction(key('N', { metaKey: true }))).toEqual({ type: 'hub' })
    for (const k of ['o', 'w', 'q', 'k', '1']) expect(fileKeyAction(key(k))).toBeNull()
  })

  it('ignores plain, shifted and alt-modified keys', () => {
    expect(fileKeyAction(key('n', {}))).toBeNull()
    expect(fileKeyAction(key('n', { ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(fileKeyAction(key('n', { ctrlKey: true, altKey: true }))).toBeNull()
  })
})
