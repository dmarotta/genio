import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Home } from '../src/main/home'
import type { AppCtx } from '../src/main/services'
import { createToolRegistry } from '../src/main/wksp-tools'
import { createChatToolSession } from '../src/main/chat-tool-session'
import { findHelp, HELP_EXCERPTS, helpDocsDir, helpDocsRoots, helpSetDocs, searchHelp } from '../src/main/help'
import { unitLaunchExtras, unitToolsBrief } from '../src/main/unitskills'
import { SETTINGS_ALIASES, SETTINGS_PAGES, settingsPath } from '../src/shared/settings-pages'

const repo = path.resolve(__dirname, '..')
const docs = path.join(repo, 'docs')
const glossaryFile = path.join(docs, 'help', 'glossary.md')
const PRESENCE = 'Presence: in **DND** routine events go to a separate *Bot* session'

/** The terms the player-facing glossary must explain, one entry each. */
const REQUIRED_TERMS = [
  'Presence', 'Online', 'DND', 'AFK', 'The Bot', 'Welcome back', 'Auto-loot', 'Standing approval', 'Merge approval',
  'Delivery modes', 'Offline', 'Standard', 'Hardcore', 'Plans', 'Plan steps', 'Units', 'Unit kinds and colors', 'Squad states',
  'Despawn and discard', 'Quests', 'Quest log', 'Choices', 'Your Move', 'Usage modes', 'Quota protection', 'Effort levels', 'Spend approval',
  'Unit capabilities', 'Skills', 'Play', 'Play copy', 'Game sound', 'Inventory', 'Art Bible', 'Modeller', 'Generator',
  'Settings pages', 'Gauntlet', 'Worktrees', 'Slots', 'Hidden desktop', 'Dev Drive'
]

const glossary = (): string => fs.readFileSync(glossaryFile, 'utf8')
const entries = (): Map<string, string> => new Map(glossary().split(/^## /m).slice(1).map(s => [s.slice(0, s.indexOf('\n')).trim(), s]))

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-help-')) })
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })

describe('help search', () => {
  it('answers the DND and AFK questions with the ARCHITECTURE presence excerpt', () => {
    for (const q of ['what does DND mode do?', 'What happens when I go AFK', 'what is the difference between DND and AFK presence']) {
      const { matches } = findHelp(docs, q)
      const at = matches.findIndex(m => m.file === 'docs/ARCHITECTURE.md' && m.text.includes(PRESENCE))
      expect(at, q).toBeGreaterThanOrEqual(0)
      expect(at, q).toBeLessThan(HELP_EXCERPTS)
      expect(matches[at].heading).toBe('Genio architecture › Overwatch (zero-token supervision)')
    }
    expect(findHelp(docs, 'what does DND do')['matches'][0]).toMatchObject({ file: 'docs/help/glossary.md', heading: 'Genio glossary › DND' })
    expect(findHelp(docs, 'what does quiet mode do').matches.some(m => m.heading.endsWith('› DND'))).toBe(true)
  })

  it('names the source file and heading of every excerpt and narrows by topic', () => {
    const text = searchHelp(docs, 'how does merge approval work')
    expect(text).toMatch(/^Genio help: \d excerpts? for "how does merge approval work", best first\. Answer from them and name the source doc\./)
    expect(text).toContain('[1] docs/')
    expect(text).toContain('docs/help/glossary.md — Genio glossary › Merge approval')
    const play = findHelp(docs, 'mute the sound', { topic: 'play' }).matches
    expect(play.length).toBeGreaterThan(0)
    for (const m of play) expect(`${m.file} ${m.heading}`.toLowerCase()).toContain('play')
  })

  it('says plainly when nothing matches, for unknown words, stop words only, or an unknown topic', () => {
    for (const q of ['zebra quaternion flux', 'what is it']) {
      const text = searchHelp(docs, q)
      expect(text).toContain(`No help docs match "${q}". Genio's bundled help does not cover this: say so plainly instead of guessing.`)
    }
    expect(searchHelp(docs, 'DND', { topic: 'spaceships' })).toMatch(/^No help doc or heading matches the topic "spaceships"\. Topics: help\/glossary, ARCHITECTURE/)
  })

  it('rebuilds its index when a doc changes', () => {
    fs.cpSync(docs, path.join(root, 'docs'), { recursive: true })
    const dir = path.join(root, 'docs')
    expect(findHelp(dir, 'flibbertigibbet').matches).toEqual([])
    fs.appendFileSync(path.join(dir, 'help', 'glossary.md'), '\n## Flibbertigibbet\n\nA made-up word for the test.\n')
    expect(findHelp(dir, 'flibbertigibbet').matches[0]).toMatchObject({ file: 'docs/help/glossary.md', heading: 'Genio glossary › Flibbertigibbet' })
  })
})

describe('genio_help tool', () => {
  const ctx = { appRoot: repo } as unknown as AppCtx
  const help = (role: 'genio' | 'bot' = 'genio') => createToolRegistry(() => ctx, new Home(root), role).find(t => t.name === 'genio_help')!

  it('pages its excerpts 2000 characters at a time with a cursor', async () => {
    const tool = help()
    expect(Object.keys(tool.shape).sort()).toEqual(['cursor', 'full', 'page_size', 'query', 'topic'])
    const args = { query: 'what happens when I go AFK and what does the Bot do' }
    const first = await tool.invoke(args)
    const page = (first.structuredContent as { page: { end: number; total: number; next_cursor: string } }).page
    expect(page.total).toBeGreaterThan(2000)
    expect(page.end).toBeLessThanOrEqual(2000)
    const text = (first.content[0] as { text: string }).text
    expect(text).toMatch(/^\[genio_help characters 0-\d+\/\d+\]\nGenio help: /)
    const next = await tool.invoke({ ...args, cursor: page.next_cursor })
    expect((next.content[0] as { text: string }).text).toContain(`[genio_help characters ${page.end}-`)
    const full = await tool.invoke({ ...args, full: true })
    expect((full.content[0] as { text: string }).text).toBe(searchHelp(docs, args.query))
  })

  it('is read-only: never writes a file, and the Bot has it', async () => {
    const writes = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'renameSync', 'copyFileSync'].map(m => vi.spyOn(fs, m as 'writeFileSync'))
    const r = await help('bot').invoke({ query: 'what does Auto-loot do', topic: 'glossary' })
    expect(r.isError).toBeUndefined()
    expect((r.content[0] as { text: string }).text).toContain('Genio glossary › Auto-loot')
    for (const w of writes) expect(w).not.toHaveBeenCalled()
    vi.restoreAllMocks()

    const home = new Home(root)
    const hc = { home, crew: { get: () => undefined }, backlog: { get: () => undefined }, decisions: { get: () => undefined } }
    const botCtx = { appRoot: repo, main: hc, homes: new Map([['main', hc]]), home: () => hc, allies: { list: () => [] },
      settings: { get: () => ({ chatShellMode: 'ask' }) }, permissions: { ask: vi.fn(async () => false) } } as unknown as AppCtx
    const session = createChatToolSession(() => botCtx, { home, role: 'bot', worlds: '*', signal: new AbortController().signal })
    expect(session.list().map(t => t.name)).toContain('genio_help')
    expect((await session.call('genio_help', { query: 'DND' })).content[0]).toMatchObject({ text: expect.stringContaining('docs/') })
  })

  it('says the help is missing rather than guessing when the install has none', async () => {
    const empty = { appRoot: root } as unknown as AppCtx
    const tool = createToolRegistry(() => empty, new Home(root), 'genio').find(t => t.name === 'genio_help')!
    expect(await tool.invoke({ query: 'DND' })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('help docs are missing from this install') }] })
  })
})

describe('bundled help path', () => {
  it('resolves to the checkout docs in dev', () => {
    expect(helpDocsDir(repo)).toBe(docs)
  })

  it('resolves in a packaged layout (resources/app/docs), also from a bundle that moved', () => {
    const app = path.join(root, 'Genio', 'resources', 'app')
    fs.cpSync(docs, path.join(app, 'docs'), { recursive: true })
    expect(helpDocsDir(app, path.join(root, 'Genio', 'resources'))).toBe(path.join(app, 'docs'))
    expect(helpDocsDir(path.join(root, 'elsewhere'), path.join(root, 'Genio', 'resources'))).toBe(path.join(app, 'docs'))
    expect(helpDocsRoots(path.join(root, 'elsewhere'), undefined)).toEqual([path.join(root, 'elsewhere', 'docs')])
    expect(helpDocsDir(path.join(root, 'elsewhere'), path.join(root, 'none'))).toBeUndefined()
    expect(findHelp(path.join(app, 'docs'), 'what does DND do').matches[0].file).toBe('docs/help/glossary.md')
  })

  it('ships docs/** with the app, and the build fails when a listed doc is missing', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
    expect(pkg.build.files).toContain('docs/**/*')
    expect(pkg.build.asar).toBe(false)
    expect(pkg.scripts.build).toMatch(/^node scripts\/check-help\.mjs && /)
    expect(pkg.scripts.dist).toMatch(/^node scripts\/check-help\.mjs && /)
    const script = path.join(repo, 'scripts', 'check-help.mjs')
    expect(execFileSync(process.execPath, [script, docs], { encoding: 'utf8' })).toContain('docs OK')
    fs.cpSync(docs, path.join(root, 'docs'), { recursive: true })
    fs.rmSync(path.join(root, 'docs', 'plans.md'))
    expect(() => execFileSync(process.execPath, [script, path.join(root, 'docs')], { encoding: 'utf8', stdio: 'pipe' })).toThrow(/listed doc is missing: docs\/plans\.md/)
  })

  it('gives units the folder in GENIO_HELP_DOCS and one brief line', () => {
    expect(unitLaunchExtras('codex', { helpDocs: 'C:\\Genio\\docs' }).env).toEqual({ GENIO_HELP_DOCS: 'C:/Genio/docs' })
    expect(unitLaunchExtras('codex', {}).env).not.toHaveProperty('GENIO_HELP_DOCS')
    const lines = unitToolsBrief('C:/genio/skills/genio', 'C:\\Genio\\docs').split('\n').filter(l => l.includes('GENIO_HELP_DOCS'))
    expect(lines).toEqual(['- Genio help (what a Genio feature, mode or setting does): read `C:/Genio/docs/help/glossary.md`, then the docs listed in `C:/Genio/docs/help/help-set.json` (folder also in GENIO_HELP_DOCS).'])
    expect(unitToolsBrief('C:/genio/skills/genio')).not.toContain('GENIO_HELP_DOCS')
  })
})

describe('glossary freshness', () => {
  it('has one entry for every required term, each saying where to find it and its source', () => {
    const e = entries()
    for (const term of REQUIRED_TERMS) {
      expect(e.has(term), `glossary entry "## ${term}"`).toBe(true)
      expect(e.get(term), term).toMatch(/\nWhere: .+\n/)
      expect(e.get(term), term).toMatch(/\nSource: .+/)
    }
    expect(new Set([...glossary().matchAll(/^## (.+)$/gm)].map(m => m[1])).size).toBe(e.size)
  })

  it('links only docs that exist, and every doc in the help set exists', () => {
    const links = [...glossary().matchAll(/\]\(([^)]+)\)/g)].map(m => m[1])
    expect(links.length).toBeGreaterThan(REQUIRED_TERMS.length)
    for (const link of links) expect(fs.existsSync(path.resolve(path.dirname(glossaryFile), link)), link).toBe(true)
    const listed = helpSetDocs(docs)
    expect(listed[0]).toBe('help/glossary.md')
    for (const doc of listed) expect(fs.existsSync(path.join(docs, doc)), doc).toBe(true)
    for (const link of links) expect(listed, `${link} is in the help set`).toContain(path.relative(docs, path.resolve(path.dirname(glossaryFile), link)).replace(/\\/g, '/'))
  })

  it('names only real Settings places', () => {
    // Longest first: a page, or a part a retired page became, followed by nothing, a field (→ …) or plain words.
    const pages = [...SETTINGS_PAGES.map(p => settingsPath(p.id)), ...Object.keys(SETTINGS_ALIASES).map(id => settingsPath(id))].sort((a, b) => b.length - a.length)
    const mentions = [...glossary().matchAll(/Settings → [^.;\n]+/g)].map(m => m[0].trim())
    expect(mentions.length).toBeGreaterThan(10)
    for (const m of mentions) expect(pages.some(v => m === v || m.startsWith(`${v} `)), m).toBe(true)
  })
})
