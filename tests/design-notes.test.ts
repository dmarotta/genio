import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/types'
import { Home } from '../src/main/home'
import { designNotesBriefLines, listNotes, NOTE_LIMITS, readNote, writeNote } from '../src/main/design-notes'
import { createChatToolSession } from '../src/main/chat-tool-session'
import { renderBrief, type BriefInput } from '../src/main/brief'
import { customContract, CUSTOM_CONTRACT_BUDGET, designContract, DESIGN_CONTRACT_BUDGET, procedureText } from '../src/main/prompts'
import { chatUsageLine } from '../src/shared/usage-mode'
import type { AppCtx } from '../src/main/services'

let tmp: string, project: string, outside: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-design-notes-'))
  project = path.join(tmp, 'game'); outside = path.join(tmp, 'outside')
  fs.mkdirSync(project); fs.mkdirSync(outside)
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const NOTE = '---\ntitle: Combat\nupdated: 2026-10-17\n---\n# Combat\nFast, readable melee.\n## Open questions\n- Parry window?\n## Decided\n- 2026-10-17: no stamina bar.\n'
const notePath = (name: string): string => path.join(project, '.genio', 'design', name)
const apply = (old: string, d: { start: number; deleteCount: number; insert: string }): string => old.slice(0, d.start) + d.insert + old.slice(d.start + d.deleteCount)

describe('design notes on disk', () => {
  it('writes plain markdown in .genio/design/ only when saved, and lists and reads it back versioned', () => {
    expect(listNotes(project)).toMatchObject({ notes: [] })
    expect(fs.existsSync(path.join(project, '.genio'))).toBe(false)
    const w = writeNote(project, 'Combat', NOTE)
    expect(w).toMatchObject({ name: 'combat', path: '.genio/design/combat.md', created: true })
    expect(fs.readFileSync(notePath('combat.md'), 'utf8')).toBe(NOTE)
    expect(writeNote(project, 'Enemy Roster', '# Enemies\n')).toMatchObject({ path: '.genio/design/enemy-roster.md' })
    expect(listNotes(project)).toMatchObject({ notes: [{ name: 'combat', title: 'Combat', version: w.version }, { name: 'enemy-roster', title: 'Enemies' }] })

    const cache = path.join(tmp, 'versions.json')
    const r = readNote(project, 'combat.md', undefined, cache) as any
    expect(r).toMatchObject({ path: '.genio/design/combat.md', version: w.version, text: NOTE })
    expect(readNote(project, 'COMBAT', r.version, cache)).toMatchObject({ unchanged: true })
    // the player edits it: a later read returns only the change
    const edited = NOTE.replace('Parry window?', 'Parry window: 6 or 8 frames?')
    fs.writeFileSync(notePath('combat.md'), edited)
    const d = readNote(project, 'combat', r.version, cache) as any
    expect(d.text).toBeUndefined()
    expect(apply(NOTE, d.delta)).toBe(edited)
    expect(readNote(project, 'combat', 'unknown', cache)).toMatchObject({ reset: true, text: edited })
    expect(() => readNote(project, 'missing')).toThrow(/No note named "missing"/)
  })

  it('refuses any path outside the folder, traversal, and names that are not markdown', () => {
    writeNote(project, 'combat', NOTE)
    for (const name of ['../secret', '..\\secret', 'sub/note', 'sub\\note', '/etc/passwd', 'C:\\Windows\\win.ini', '.hidden', '..', 'con']) {
      expect(() => writeNote(project, name, NOTE), name).toThrow(/plain name|letters, digits/)
      expect(() => readNote(project, name), name).toThrow(/plain name|No note|letters, digits/)
    }
    for (const name of ['combat.txt', 'notes.json', 'script.ts', 'combat.md.exe']) {
      expect(() => writeNote(project, name, NOTE), name).toThrow(/markdown only/)
    }
    expect(fs.readdirSync(project)).toEqual(['.genio'])
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('refuses a notes folder or a note that is a link', () => {
    fs.mkdirSync(path.join(project, '.genio'))
    fs.symlinkSync(outside, path.join(project, '.genio', 'design'), 'junction')
    fs.writeFileSync(path.join(outside, 'combat.md'), NOTE)
    expect(() => listNotes(project)).toThrow(/not a link/)
    expect(() => readNote(project, 'combat')).toThrow(/not a link/)
    expect(() => writeNote(project, 'lore', NOTE)).toThrow(/not a link/)
    expect(fs.readdirSync(outside)).toEqual(['combat.md'])

    fs.rmSync(path.join(project, '.genio'), { recursive: true })
    fs.mkdirSync(path.join(project, '.genio', 'design'), { recursive: true })
    try {
      fs.symlinkSync(path.join(outside, 'combat.md'), notePath('combat.md'), 'file')
    } catch {
      return // file links need a privilege on Windows; the folder case above is the one a player can make
    }
    expect(() => readNote(project, 'combat')).toThrow(/not a plain file/)
    expect(() => writeNote(project, 'combat', '# Changed\n', 'x')).toThrow(/not a plain file/)
    expect(listNotes(project)).toMatchObject({ notes: [] })
    expect(fs.readFileSync(path.join(outside, 'combat.md'), 'utf8')).toBe(NOTE)
  })

  it('refuses a note over 16 KB and a folder over 64 KB', () => {
    expect(() => writeNote(project, 'huge', 'x'.repeat(NOTE_LIMITS.noteBytes + 1))).toThrow(/over the 16 KB limit for one note/)
    expect(fs.existsSync(notePath('huge.md'))).toBe(false)
    const big = 'y'.repeat(15 * 1024)
    for (const n of ['a', 'b', 'c', 'd']) writeNote(project, n, big)
    expect(() => writeNote(project, 'e', big)).toThrow(/over the 64 KB limit/)
    expect(fs.existsSync(notePath('e.md'))).toBe(false)
    // replacing a note counts its new size, not both
    const a = readNote(project, 'a') as any
    expect(writeNote(project, 'a', 'z'.repeat(15 * 1024), a.version)).toMatchObject({ created: false })
  })

  it('refuses a stale write: an existing note needs the version the chat read, unchanged since', () => {
    const w = writeNote(project, 'combat', NOTE)
    expect(() => writeNote(project, 'combat', '# Combat v2\n')).toThrow(/already exists. Read it first/)
    fs.writeFileSync(notePath('combat.md'), NOTE + '- Player edit\n')
    expect(() => writeNote(project, 'combat', '# Combat v2\n', String(w.version))).toThrow(/changed since you read it/)
    expect(fs.readFileSync(notePath('combat.md'), 'utf8')).toContain('Player edit')
    const fresh = readNote(project, 'combat') as any
    expect(writeNote(project, 'combat', '# Combat v2\n', fresh.version)).toMatchObject({ created: false })
    fs.rmSync(notePath('combat.md'))
    expect(() => writeNote(project, 'combat', '# Combat v3\n', fresh.version)).toThrow(/no longer exists/)
  })

  it('gives units one brief line only when their copy has the notes folder', () => {
    const input: BriefInput = {
      taskId: 't-1', kind: 'ship', project: 'game', worktree: project, branch: 'b', baseBranch: 'main', intent: 'x',
      statusFile: path.join(tmp, 's'), inboxDir: path.join(tmp, 'i'), taskDataDir: path.join(tmp, 't')
    }
    expect(designNotesBriefLines(project)).toEqual([])
    expect(renderBrief({ ...input, designNotes: designNotesBriefLines(project) })).not.toContain('.genio/design')
    fs.mkdirSync(path.join(project, '.genio', 'design'), { recursive: true })
    const lines = designNotesBriefLines(project)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('`.genio/design/`')
    expect(lines[0]).toContain('context only')
    expect(lines[0]).toContain('Never edit them unless the mission says so.')
    const brief = renderBrief({ ...input, designNotes: lines })
    expect(brief.slice(brief.indexOf('# Project memory'), brief.indexOf('# Engine notes'))).toContain(lines[0])
  })
})

describe('the design_notes tool', () => {
  let ctx: AppCtx, main: Home, home: Home, hc: any
  const stats = { unlock: vi.fn(), addCost: vi.fn() }
  const said: ChatMessage[] = []
  const say = (role: ChatMessage['role'], text: string): void => { said.push({ id: `m-${said.length}`, wksp: 'game', role, text, ts: new Date(Date.now() + said.length).toISOString() }) }

  beforeEach(() => {
    said.length = 0
    stats.unlock.mockReset()
    main = new Home(path.join(tmp, 'genio')); main.ensure()
    home = new Home(path.join(tmp, 'genio', 'wksps', 'game'), 'game', main); home.ensure()
    const empty = { list: () => [], get: () => undefined }
    hc = { home, crew: empty, decisions: { list: () => [], get: () => undefined }, backlog: empty, plans: empty,
      wksp: { history: () => [] }, design: { history: (id: string) => (id === 'd-00000001' ? said : []) } }
    const mainHc = { ...hc, home: main, design: undefined }
    ctx = { appRoot: process.cwd(), main: mainHc, homes: new Map([['main', mainHc], ['game', hc]]), home: (n: string) => (n === 'main' ? mainHc : hc),
      settings: { get: () => ({ chatShellMode: 'all', gamertag: 'Dani' }) }, permissions: { ask: vi.fn(async () => true) },
      allies: { list: () => [{ name: 'game', projects: ['game'] }] },
      projects: { list: () => [{ name: 'game', path: project }], get: (n: string) => (n === 'game' ? { name: n, path: project } : undefined) },
      stats } as unknown as AppCtx
  })

  const session = (role: 'design' | 'genio' | 'ally') => createChatToolSession(() => ctx, {
    home: role === 'genio' ? main : home, role, worlds: role === 'genio' ? '*' : ['game'], signal: new AbortController().signal,
    hooks: role === 'design' ? { conversation: 'd-00000001' } : {}
  })
  const text = (r: any): string => r.content[0].text

  it("writes a note from a design chat only with the player's own words", async () => {
    const design = session('design')
    say('player', 'What if combat had a parry with a short window?')
    say('genio', 'A parry fits the pillars. I could save this as the combat note.')
    const write = (player_words?: string) => design.call('design_notes', { world: 'game', action: 'write', name: 'combat', text: NOTE, ...(player_words ? { player_words } : {}) })
    expect(text(await write())).toMatch(/refused: no player words/)
    expect(text(await write('save this as the combat note'))).toMatch(/refused: .* is not in any of the player's own messages/)
    expect(text(await write('I could save this as the combat note'))).toMatch(/refused/)
    expect(fs.existsSync(notePath('combat.md'))).toBe(false)
    expect(stats.unlock).not.toHaveBeenCalled()

    say('player', 'Save this as the combat note')
    const r = await write('save this as the combat note')
    expect(r.isError).toBeUndefined()
    expect(JSON.parse(text(r))).toMatchObject({ path: '.genio/design/combat.md', created: true })
    expect(fs.readFileSync(notePath('combat.md'), 'utf8')).toBe(NOTE)
    expect(stats.unlock).toHaveBeenCalledWith('design-note-saved')
    // the project chat's words never count for a design chat
    hc.wksp.history = () => [{ id: 'p', wksp: 'game', role: 'player', text: 'save the lore note', ts: new Date().toISOString() }]
    expect(text(await design.call('design_notes', { world: 'game', action: 'write', name: 'lore', text: NOTE, player_words: 'save the lore note' }))).toMatch(/refused/)
  })

  it('lets the main chat and the project chat list and read notes, never write them', async () => {
    writeNote(project, 'combat', NOTE)
    for (const role of ['genio', 'ally'] as const) {
      const s = session(role)
      const tool = s.list().find(t => t.name === 'design_notes')!
      expect(JSON.stringify(tool.inputSchema)).not.toContain('"write"')
      expect(tool.inputSchema.properties).not.toHaveProperty('text')
      expect(tool.description).toContain('never authorization')
      // "plan the combat note": the chat reads it
      const read = JSON.parse(text(await s.call('design_notes', { world: 'game', action: 'read', name: 'combat' })))
      expect(read).toMatchObject({ path: '.genio/design/combat.md', text: NOTE })
      expect(JSON.parse(text(await s.call('design_notes', { world: 'game' }))).notes).toHaveLength(1)
      const refused = await s.call('design_notes', { world: 'game', action: 'write', name: 'combat', text: '# Mine\n', since: read.version, player_words: 'x' })
      expect(refused.isError).toBe(true)
    }
    expect(fs.readFileSync(notePath('combat.md'), 'utf8')).toBe(NOTE)
  })

  it('pages a long note', async () => {
    const long = `# Lore\n${Array.from({ length: 300 }, (_, i) => `- fact ${i}`).join('\n')}\n`
    writeNote(project, 'lore', long)
    const r = await session('genio').call('design_notes', { world: 'game', action: 'read', name: 'lore' })
    expect(text(r)).toMatch(/^\[design_notes characters 0-\d+\/\d+\]/)
    expect(text(r)).toContain('next_cursor=')
  })
})

describe('notes in the prompts', () => {
  it('gives the main and project chats one short line, within the contract budget, and the detail in intake', () => {
    for (const isAlly of [false, true]) for (const bot of [false, true]) {
      const contract = customContract({ gamertag: 'x'.repeat(80), base: 'b'.repeat(128), isAlly }, bot, chatUsageLine('max'))
      expect(contract.length).toBeLessThanOrEqual(CUSTOM_CONTRACT_BUDGET)
      const line = contract.split('\n').find(l => l.startsWith('- Design notes'))
      expect(line).toContain('never authorization')
      expect(line!.length).toBeLessThan(160)
      const intake = procedureText('intake', { gamertag: 'Dani', base: 'game', isAlly })
      expect(intake).toContain('**Design notes.**')
      expect(intake).toContain('You never write notes')
    }
  })

  it('teaches the design chat the note format, its two sections and when to write', () => {
    const text = designContract({ gamertag: 'Dani', project: 'game' }, chatUsageLine('max'))
    expect(text.length).toBeLessThanOrEqual(DESIGN_CONTRACT_BUDGET)
    expect(text).toContain('## Open questions')
    expect(text).toContain('## Decided')
    expect(text).toContain('player_words')
    expect(text).toContain('Never save on your own initiative.')
    expect(text).toContain('since')
  })
})
