import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ ipcMain: { removeHandler() {}, handle() {} }, BrowserWindow: {}, dialog: {}, shell: {}, safeStorage: { isEncryptionAvailable: () => false } }))
const playAct = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../src/main/play', () => ({ playService: () => ({ act: playAct }) }))
const writeBible = vi.hoisted(() => vi.fn(() => ({ ok: true })))
vi.mock('../src/main/art-bible-gen', async original => ({ ...await original<typeof import('../src/main/art-bible-gen')>(), writeBibleFile: writeBible }))
import { Home } from '../src/main/home'
import type { AppCtx } from '../src/main/services'
import type { ChatMessage, Settings, Task } from '../src/shared/types'
import { createToolRegistry } from '../src/main/wksp-tools'
import { actionAsks } from '../src/main/chat-tool-policy'

/**
 * The chat's authority over units and git: every action that used to need the player's quoted words, or was refused
 * outright, now runs or asks according to the approval mode alone. A Deny leaves everything as it was, and chat text
 * (the player's own words included) never answers the prompt: only the broker, which the player's click resolves.
 */
type Mode = Settings['chatShellMode']
const MODES: Mode[] = ['ask', 'auto-shell', 'all']

let root: string, home: Home, ctx: AppCtx, task: Task, mode: Mode, chat: ChatMessage[]
let ask: ReturnType<typeof vi.fn>, saved: ReturnType<typeof vi.fn>
const crew = {
  merge: vi.fn(async () => ({ ok: true, message: 'Landed.' })),
  // without force the unit's unlanded work refuses, as the real service does
  cleanup: vi.fn(async (_id: string, force?: boolean) => (force ? { ok: true, message: 'Despawned.' } : { ok: false, message: 'Refusing to despawn unit: unlanded work.' })),
  control: vi.fn(async () => ({ ok: true, message: 'relaunched' })),
  spawn: vi.fn(async (r: { title: string; project: string }) => ({ id: 'u-new', kind: 'ship', title: r.title, project: r.project, harness: 'claude', mode: 'local-only', branch: 'genio/new' }))
}
const projects = { init: vi.fn(async (name: string) => ({ name, path: root, engine: 'web', mode: 'local-only', defaultBranch: 'main' })),
  update: vi.fn((name: string) => ({ name, mode: 'local-only', branchPrefix: 'genio/' })), remove: vi.fn(async () => ({ ok: true, message: 'removed' })) }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-authority-'))
  home = new Home(path.join(root, 'home'))
  fs.mkdirSync(path.join(root, 'game'))
  fs.mkdirSync(path.join(root, 'copy'))
  mode = 'ask'
  chat = []
  ask = vi.fn(async () => false)
  saved = vi.fn()
  vi.clearAllMocks()
  task = { id: 'unit', kind: 'ship', title: 'Menu rework', project: 'game', mode: 'local-only', state: 'ready', branch: 'genio/menu', baseBranch: 'main',
    worktree: path.join(root, 'copy'), readyAt: '2026-10-17T10:00:00.000Z', createdAt: '2026-10-17T09:00:00.000Z', relaunches: 1, automaticRelaunches: 1 } as Task
  const quest = { id: 'q-2', title: 'Step two', project: 'game', state: 'queued' }
  const hc = {
    home, crew: { ...crew, get: (id: string) => (id === task.id ? task : undefined), list: () => [task] },
    backlog: { list: () => [quest], get: (id: string) => (id === quest.id ? quest : undefined) },
    decisions: { list: () => [], get: () => undefined },
    wksp: { history: () => chat, say: vi.fn() }
  }
  ctx = { appRoot: process.cwd(), main: hc, homes: new Map([['main', hc]]), home: () => hc,
    settings: { get: () => ({ chatShellMode: mode, gamertag: 'Alex' }), save: saved }, permissions: { ask },
    allies: { list: () => [] }, away: { state: () => ({ mode: 'online' }) },
    projects: { ...projects, list: () => [{ name: 'game' }], get: (name: string) => (name === 'game' ? { name, path: path.join(root, 'game'), yolo: false } : undefined) },
    forge: { view: vi.fn() }, ledger: { record: vi.fn() }, stats: { unlock: vi.fn() }
  } as unknown as AppCtx
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const tool = (name: string, role: 'genio' | 'ally' | 'bot' = 'genio') => createToolRegistry(() => ctx, home, role).find(t => t.name === name)!
const said = (text: string) => chat.push({ id: `p${chat.length}`, wksp: 'main', role: 'player', text, ts: new Date().toISOString() })

interface Case {
  tool: string
  args: Record<string, unknown>
  /** what the prompt says will happen */
  line: string | RegExp
  /** true once the action ran */
  ran: () => boolean
  gate?: 'guarded' | 'shell'
}
const CASES: Case[] = [
  { tool: 'merge', args: { task: 'unit' }, line: 'Merge unit ("Menu rework"): its branch genio/menu into local main?', ran: () => crew.merge.mock.calls.length > 0 },
  { tool: 'despawn', args: { task: 'unit', force: true }, line: 'Discard unit unit ("Menu rework") and its unmerged work?', ran: () => crew.cleanup.mock.calls.some(c => c[1] === true) },
  { tool: 'control', args: { task: 'unit', action: 'relaunch' }, line: 'Relaunch unit ("Menu rework")? It is held after its automatic relaunch.', ran: () => crew.control.mock.calls.length > 0 },
  { tool: 'deploy', args: { kind: 'ship', world: 'game', title: 'Step two', intent: 'build step two', quest_id: 'q-2', force: true },
    line: 'Start quest q-2 ("Step two") before the work it waits on lands?', ran: () => crew.spawn.mock.calls.length > 0 },
  { tool: 'settings_update', args: { patch: { sound: false } }, line: 'Change preferences: sound to false?', ran: () => saved.mock.calls.length > 0 },
  { tool: 'play_control', args: { world: 'game', action: { type: 'play' } }, line: 'Play in game: play?', ran: () => playAct.mock.calls.length > 0 },
  { tool: 'project_init', args: { world: 'game', create_remote: true }, line: 'Start the git repo in game with a first commit of everything in the folder, and create the private GitHub repository?',
    ran: () => projects.init.mock.calls.length > 0 },
  { tool: 'world_update', args: { world: 'game', auto_loot: true }, line: /^Turn on Auto-loot in game/, ran: () => projects.update.mock.calls.length > 0 },
  { tool: 'world_update', args: { world: 'game', mode: 'direct-PR' }, line: "Change game's delivery mode to Standard?", ran: () => projects.update.mock.calls.length > 0 },
  { tool: 'world_remove', args: { world: 'game', delete_clone: true, force: true }, line: /^Remove project game and delete Genio's clone of it, even with live units/, ran: () => projects.remove.mock.calls.length > 0 },
  { tool: 'art_bible', args: { world: 'game', action: 'write', text: '# Art' }, line: "Write game's Art Bible (.genio/art-bible.md, uncommitted)?", ran: () => writeBible.mock.calls.length > 0 },
  { tool: 'write_file', args: { task: 'unit', path: 'src/menu.ts', text: 'export {}\n' }, line: "Create src/menu.ts in unit's copy (2 lines, uncommitted)?",
    ran: () => fs.existsSync(path.join(root, 'copy', 'src', 'menu.ts')) },
  { tool: 'run_command', args: { world: 'game', command: 'mkdir made' }, line: "Run in game's main copy: mkdir made", gate: 'shell',
    ran: () => fs.existsSync(path.join(root, 'game', 'made')) }
]

describe('every formerly guarded chat action follows the approval mode', () => {
  for (const c of CASES) {
    for (const m of MODES) {
      const asks = actionAsks(m, c.gate ?? 'guarded')
      it(`${c.tool} in ${m}: ${asks ? 'asks first; Deny changes nothing, Allow once runs it' : 'runs without asking'}`, async () => {
        mode = m
        // The player's own words, even quoted as an argument, never stand in for the click.
        said('yes, do it now')
        const args = { ...c.args, player_words: 'yes, do it now' }
        if (asks) {
          const denied = await tool(c.tool).invoke(args)
          expect(denied.isError, JSON.stringify(denied)).toBe(true)
          expect(denied.content[0]).toMatchObject({ text: expect.stringContaining('Alex denied it') })
          expect(ask).toHaveBeenCalledTimes(1)
          expect(ask).toHaveBeenCalledWith(expect.objectContaining({ wksp: home.name, tool: c.tool,
            input: typeof c.line === 'string' ? c.line : expect.stringMatching(c.line) }))
          expect(c.ran(), 'a Deny leaves everything untouched').toBe(false)
          expect(ctx.ledger.record).toHaveBeenCalledWith(expect.objectContaining({ event: 'approval.action', data: expect.objectContaining({ tool: c.tool, denied: true }) }))
          ask.mockResolvedValueOnce(true)
        }
        const r = await tool(c.tool).invoke(args)
        expect(r.isError, JSON.stringify(r)).toBeUndefined()
        expect(ask).toHaveBeenCalledTimes(asks ? 2 : 0)
        expect(c.ran()).toBe(true)
        expect(ctx.ledger.record).toHaveBeenCalledWith(expect.objectContaining({ event: 'approval.action', data: expect.objectContaining({ tool: c.tool, via: asks ? 'prompt' : 'mode' }) }))
      }, 30_000)
    }
  }

  it('records what cleared a merge: the player\'s Allow once, or YOLO', async () => {
    ask.mockResolvedValueOnce(true)
    await tool('merge').invoke({ task: 'unit' })
    expect(crew.merge).toHaveBeenLastCalledWith('unit', expect.objectContaining({ kind: 'prompt' }), undefined)
    mode = 'all'
    await tool('merge').invoke({ task: 'unit' })
    expect(crew.merge).toHaveBeenLastCalledWith('unit', expect.objectContaining({ kind: 'mode' }), undefined)
  })

  it('records who cleared a discard on the despawn', async () => {
    ask.mockResolvedValueOnce(true)
    await tool('despawn').invoke({ task: 'unit', force: true })
    expect(crew.cleanup).toHaveBeenLastCalledWith('unit', true, 'prompt')
    mode = 'all'
    await tool('despawn').invoke({ task: 'unit', force: true })
    expect(crew.cleanup).toHaveBeenLastCalledWith('unit', true, 'mode')
  })

  it('asks nothing when nothing would be lost or nothing is guarded', async () => {
    crew.cleanup.mockResolvedValueOnce({ ok: true, message: 'Despawned (landed).' })
    expect((await tool('despawn').invoke({ task: 'unit', force: true })).isError).toBeUndefined()
    task.automaticRelaunches = 0
    expect((await tool('control').invoke({ task: 'unit', action: 'relaunch' })).isError).toBeUndefined()
    expect((await tool('run_command').invoke({ world: 'game', command: 'git status' })).content[0]).toMatchObject({ text: expect.stringContaining("game's main copy") })
    expect(ask).not.toHaveBeenCalled()
  }, 30_000)

  it('merges red, still running and draft PRs once cleared, and the prompt says which', async () => {
    task.pr = { url: 'https://example.test/pr/7' } as Task['pr']
    vi.mocked(ctx.forge.view).mockResolvedValue({ ok: true, checks: 'failing', failing: ['unit tests'] } as never)
    ask.mockResolvedValueOnce(true)
    expect((await tool('merge').invoke({ task: 'unit' })).isError).toBeUndefined()
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ input: 'Merge unit ("Menu rework"): its PR https://example.test/pr/7? Its checks are red (unit tests).' }))
    expect(crew.merge).toHaveBeenLastCalledWith('unit', expect.objectContaining({ kind: 'prompt' }), { override: true })
  })

  it('keeps the Bot\'s limits: it never asks, discards, relaunches a held unit or merges without Auto-loot', async () => {
    for (const m of MODES) {
      mode = m
      expect(await tool('merge', 'bot').invoke({ task: 'unit' })).toMatchObject({ isError: true })
      expect(await tool('despawn', 'bot').invoke({ task: 'unit', force: true })).toMatchObject({ isError: true })
      expect(await tool('deploy', 'bot').invoke(CASES[3].args)).toMatchObject({ isError: true })
      expect(await tool('world_update', 'bot').invoke({ world: 'game', auto_loot: true })).toMatchObject({ isError: true })
      expect(await tool('world_remove', 'bot').invoke({ world: 'game', delete_clone: true })).toMatchObject({ isError: true })
      expect(await tool('run_command', 'bot').invoke({ world: 'game', command: 'mkdir made' })).toMatchObject({ isError: true })
    }
    expect(ask).not.toHaveBeenCalled()
    expect(crew.merge).not.toHaveBeenCalled()
    expect(crew.cleanup).not.toHaveBeenCalled()
    expect(projects.update).not.toHaveBeenCalled()
    task.yolo = true
    expect((await tool('merge', 'bot').invoke({ task: 'unit' })).isError).toBeUndefined()
    expect(crew.merge).toHaveBeenLastCalledWith('unit', expect.objectContaining({ kind: 'autoloot' }), undefined)
  })
})

describe('what the approval mode never clears', () => {
  it('spend still needs the player\'s own words or click, even in YOLO', async () => {
    mode = 'all'
    const deploy = { kind: 'ship', world: 'game', title: 'Boat textures', intent: 'make boat textures', budget_usd: 2 }
    expect(await tool('deploy').invoke(deploy)).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('USD 2') }] })
    expect(await tool('deploy').invoke({ ...deploy, player_words: 'go ahead' })).toMatchObject({ isError: true })
    expect(crew.spawn).not.toHaveBeenCalled()
    said('yes, spend up to $2 on the boat textures')
    expect((await tool('deploy').invoke({ ...deploy, player_words: 'yes, spend up to $2 on the boat textures' })).isError).toBeUndefined()
    expect(crew.spawn).toHaveBeenCalledWith(expect.objectContaining({ approvedBudget: { usd: 2, via: 'chat', words: 'yes, spend up to $2 on the boat textures' } }))
    expect(ask).not.toHaveBeenCalled()
  })

  it('credentials, logins and spend records stay closed to commands and edits in every mode', async () => {
    for (const m of MODES) {
      mode = m
      ask.mockResolvedValue(true)
      for (const command of ['type %USERPROFILE%\\.codex\\auth.json', 'cat ~/.claude/.credentials.json', 'codex login', 'set', 'echo %FAL_KEY%']) {
        expect(await tool('run_command').invoke({ world: 'game', command }), command).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('Credentials') }] })
      }
      for (const file of ['.env', '.genio/fal/config.json', 'data/spend-grants.jsonl']) {
        expect(await tool('write_file').invoke({ world: 'game', path: file, text: 'x' }), file).toMatchObject({ isError: true })
      }
    }
    expect(ask).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(root, 'game', '.env'))).toBe(false)
  })

  it('write_file stays inside the copy and out of .git', async () => {
    mode = 'all'
    for (const file of ['../outside.txt', '.git/config', 'a/../../outside.txt', path.join(root, 'abs.txt')]) {
      expect(await tool('write_file').invoke({ world: 'game', path: file, text: 'x' }), file).toMatchObject({ isError: true })
    }
    expect(fs.existsSync(path.join(root, 'outside.txt'))).toBe(false)
  })
})
