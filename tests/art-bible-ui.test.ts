// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtBibleView } from '../src/shared/art-bible'
const f = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }))
vi.mock('../src/renderer/src/store', () => ({
  PROJECT_WINDOW: 'alpha',
  useStore: (select: (s: unknown) => unknown) => select({ snap: { projects: [{ name: 'alpha', path: 'C:/alpha' }] } }),
  api: () => ({ artBibleRead: f.read, artBibleWrite: f.write }),
  op: async (_: string, fn: () => unknown) => { try { return await fn() } catch { return undefined } },
  errText: String
}))
import { ArtBible } from '../src/renderer/src/views/ArtBible'
import { getScreenContext } from '../src/renderer/src/lib/screen-context'

const TEXT = '# Art Bible\n\n## Style\nChunky.\n'
const bible = (over: Partial<ArtBibleView> = {}): ArtBibleView => ({
  path: '.genio/art-bible.md', text: TEXT, source: null, ...over,
  bible: {
    title: 'Art Bible', source: over.source?.path ?? null, style: { summary: 'Chunky low-poly shapes.', text: 'Chunky low-poly shapes.' },
    palette: [{ name: 'Limestone', hex: '#CBBF9F', use: 'walls' }], accents: [{ name: 'Aether', hex: '#53D9D1', use: 'crystals only' }],
    references: [
      { path: 'docs/smithy.png', href: '../docs/smithy.png', caption: 'Smithy', role: 'style', types: ['building'], weight: 3, exists: true, external: false, url: 'genio-media://art-bible/alpha/docs/smithy.png' },
      { path: 'docs/gone.png', href: '../docs/gone.png', caption: '', role: 'style', types: [], weight: 1, exists: false, external: false, url: null }
    ],
    do: ['Big roofs'], dont: ['Tiny shingles'], avoid: ['grunge'], issues: [{ level: 'warning', message: 'Reference docs/gone.png is missing; it is skipped.' }]
  }
})

let root: Root, host: HTMLDivElement
const flush = async (): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(0) }) }
async function render(): Promise<void> { await act(async () => root.render(React.createElement(ArtBible))); await flush() }
const text = (): string => host.textContent ?? ''
const tab = (label: string): HTMLButtonElement => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent === label)!
const button = (label: string): HTMLButtonElement => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === label)!
async function type(value: string): Promise<void> {
  const area = host.querySelector('textarea')!
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => { set.call(area, value); area.dispatchEvent(new Event('input', { bubbles: true })) })
}

beforeEach(() => {
  vi.useFakeTimers()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.clearAllMocks() })

describe('Art Bible screen', () => {
  it('shows only a plain line when the project has no bible', async () => {
    f.read.mockResolvedValue({ path: '.genio/art-bible.md', text: null, source: null, bible: null })
    await render()
    expect(f.read).toHaveBeenCalledWith('alpha')
    expect(host.querySelector('.ab-empty')?.textContent).toBe('No Art Bible yet. Ask Genio to create one.')
    expect(host.querySelector('[role="tablist"]')).toBeNull()
    expect(host.querySelectorAll('button')).toHaveLength(0)
    expect(text()).not.toMatch(/import|template/i)
    expect(getScreenContext('art-bible')?.facts).toContainEqual({ label: 'Art Bible', value: 'none yet' })
  })

  it('treats an empty file as no bible', async () => {
    f.read.mockResolvedValue({ path: '.genio/art-bible.md', text: '\n', source: null, bible: null })
    await render()
    expect(host.querySelector('.ab-empty')?.textContent).toBe('No Art Bible yet. Ask Genio to create one.')
  })

  it('shows the overview: style, moodboard, palette, do and don\'t, avoid terms', async () => {
    f.read.mockResolvedValue(bible())
    await render()
    expect([...host.querySelectorAll('[role="tab"]')].map(t => t.textContent)).toEqual(['Overview', 'Markdown'])
    expect(text()).toContain('.genio/art-bible.md')
    expect(text()).toContain('Chunky low-poly shapes.')
    expect(text()).toContain('Moodboard · 2 references')
    const img = host.querySelector<HTMLImageElement>('.ab-ref img')!
    expect(img.getAttribute('src')).toBe('genio-media://art-bible/alpha/docs/smithy.png')
    expect(host.querySelectorAll('.ab-ref')[1].textContent).toContain('Missing file')
    expect(host.querySelectorAll('.ab-weight i:not(.off)')).toHaveLength(4)
    expect(text()).toContain('Limestone')
    expect(text()).toContain('#53D9D1')
    expect(text()).toContain('Big roofs')
    expect(text()).toContain('Tiny shingles')
    expect(host.querySelector('.ab-avoid')?.textContent).toBe('grunge')
    expect(host.querySelector('.ab-issues')?.textContent).toContain('gone.png')
    expect(host.querySelectorAll('.ab-strip b')).toHaveLength(2)
    expect(host.querySelector('.ab-from')).toBeNull()
    expect(text()).not.toMatch(/Try it|Import|Template|Extract|History/)
  })

  it('edits the bible in the Markdown tab and saves with Ctrl+S', async () => {
    f.read.mockResolvedValue(bible())
    f.write.mockImplementation(async (_w, _f, t: string) => bible({ text: t }))
    await render()
    await act(async () => tab('Markdown').click())
    expect(host.querySelector('textarea')?.value).toBe(TEXT)
    expect(button('Save file').disabled).toBe(true)
    await type(TEXT + '\n## Do\n- More\n')
    expect(button('Save file').disabled).toBe(false)
    await act(async () => host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })))
    await flush()
    expect(f.write).toHaveBeenCalledWith('alpha', 'bible', TEXT + '\n## Do\n- More\n')
    expect(button('Save file').disabled).toBe(true)
  })

  it('keeps a refused edit unsaved', async () => {
    f.read.mockResolvedValue(bible())
    f.write.mockRejectedValue(new Error('Not written: `source: x.md` does not exist.'))
    await render()
    await act(async () => tab('Markdown').click())
    await type('---\nsource: x.md\n---\n')
    await act(async () => button('Save file').click())
    await flush()
    expect(host.querySelector('textarea')?.value).toBe('---\nsource: x.md\n---\n')
    expect(button('Save file').disabled).toBe(false)
    // the draft survives a visit to the Overview, until discarded
    await act(async () => tab('Overview').click())
    await act(async () => tab('Markdown').click())
    expect(host.querySelector('textarea')?.value).toBe('---\nsource: x.md\n---\n')
    await act(async () => button('Discard').click())
    expect(host.querySelector('textarea')?.value).toBe(TEXT)
  })

  it('with a source: line, says where it comes from and edits both files', async () => {
    const source = { path: 'docs/ART.md', text: '# Art direction\n' }
    f.read.mockResolvedValue(bible({ source, text: '---\nsource: docs/ART.md\n---\n' }))
    f.write.mockImplementation(async () => bible({ source: { ...source, text: '# Changed\n' }, text: '---\nsource: docs/ART.md\n---\n' }))
    await render()
    expect(host.querySelector('.ab-from')?.textContent).toBe('From docs/ART.md')
    await act(async () => tab('Markdown').click())
    expect(host.querySelector('textarea')?.value).toBe('---\nsource: docs/ART.md\n---\n')
    await act(async () => tab('docs/ART.md').click())
    expect(host.querySelector('textarea')?.value).toBe('# Art direction\n')
    await type('# Changed\n')
    await act(async () => button('Save file').click())
    await flush()
    expect(f.write).toHaveBeenCalledWith('alpha', 'source', '# Changed\n')
  })

  it('picks up a bible written while the screen is open', async () => {
    f.read.mockResolvedValueOnce({ path: '.genio/art-bible.md', text: null, source: null, bible: null }).mockResolvedValue(bible())
    await render()
    expect(host.querySelector('.ab-empty')).not.toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(host.querySelector('.ab-empty')).toBeNull()
    expect(text()).toContain('Chunky low-poly shapes.')
  })
})
