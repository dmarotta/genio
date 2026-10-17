import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACHIEVEMENTS } from '../src/main/stats'
import { navItems } from '../src/renderer/src/lib/railmenu'
import { SETTINGS_PAGES } from '../src/shared/settings-pages'

// Deliberately explicit: add new player-facing tools here, with their feature tag.
const PLAYER_FACING_TOOLS: Record<string, string> = {
  play_frame: 'play_frame', play_control: 'play',
  fal_generate: 'fal_generate', uthana_motion: 'uthana_motion', uthana_character: 'agent_generation', asset_place: 'asset_place',
  approve_run: 'approve_run', art_bible: 'art_bible', design_notes: 'design_notes', genio_help: 'genio_help',
  deploy: 'deploy', merge: 'move', run_gauntlet: 'squad', quest_add: 'quests', plan_create: 'plans', plan_update: 'plans',
  world_add: 'worlds', world_create: 'worlds', world_push: 'world_push',
  memory_write: 'memory', generate_image: 'generate_image', rate_task: 'rate_task',
  loadout_preview: 'loadout_preview', assets_find: 'assets_find', asset_locate: 'asset_locate'
}
// Supporting reads, orchestration and maintenance. New tools must be classified
// explicitly so adding a registration cannot silently bypass the coverage guard.
const SUPPORTING_TOOLS = [
  'play_status', 'play_console', 'play_stats', 'play_slot_recover',
  'fal_models', 'generation_status',
  'fleet_view', 'unit_state', 'read_task_file', 'terminal_tail', 'ping', 'control',
  'despawn', 'upgrade_recon', 'quest_list', 'quest_update', 'quest_hold', 'quest_release',
  'quest_remove', 'plan_status', 'choice_open', 'choice_resolve', 'choice_list', 'world_list',
  'world_posture', 'world_update', 'world_engine_root', 'world_remove', 'world_sync', 'status_report',
  'memory_read', 'memory_report', 'memory_archive', 'mail_list', 'mail_ack', 'mail_reply',
  'dispatch_profiles', 'toolchain_check', 'presence_set', 'ally_list', 'ally_route',
  'report_to_main', 'escalate', 'asset_info', 'procedure_read', 'skill_read', 'settings_read', 'settings_update', 'event_read', 'events_ack'
]

// Unit kinds (TaskKind in src/shared/types.ts) and the flags that make a Build a different unit, with their feature tags.
const UNIT_KINDS: Record<string, string> = { ship: 'ship', scout: 'scout' }
const UNIT_FLAGS: Record<string, string> = { modeller: 'modeller', generator: 'generator' }
// SpawnRequest yes/no options that do not make a different kind of unit.
const SPAWN_OPTIONS = ['yolo', 'force']

// Every Settings page: the achievement earned there, or 'none: <why>' (a page of preferences is no feat).
const SETTINGS_PAGE_ACHIEVEMENTS: Record<string, string> = {
  project: 'none: the project name, engine and folder',
  'project-delivery': 'none: how work lands; landing itself earns First Blood and Go Live',
  'project-commands': 'none: build and test commands',
  'project-assets': 'none: generation budget and folders; generating earns the asset achievements',
  'project-unity': 'play-pool-configured',
  general: 'none: looks and wording',
  notifications: 'none: alert preferences',
  usage: 'usage-mode',
  accounts: 'account-login',
  memory: 'lore-first',
  units: 'none: unit defaults',
  play: 'none: Play editor preferences; playing earns the Play achievements',
  inbox: 'none: mail and scheduled checks',
  system: 'explorer-install',
  dispatch: 'none: advanced tuning',
  harnesses: 'mcp-call',
  gauntlet: 'none: advanced tuning',
  overwatch: 'none: advanced tuning',
  maintenance: 'none: housekeeping'
}

// Feature tags that are neither a Rail view, a tool, a unit kind nor a flag: each names the source that proves it is still live.
const OTHER_FEATURES: Record<string, [file: string, needle: string]> = {
  explorer: ['src/main/ipc.ts', 'explorerSet'],
  'project-window': ['src/main/index.ts', 'export function openProject'],
  'project-cli': ['src/main/index.ts', 'projectFromArgv'],
  'file-menu': ['src/renderer/src/App.tsx', '<FileMenu'],
  'inventory-chat': ['src/main/wksp.ts', 'hasInventoryChips'],
  'genio-panel': ['src/renderer/src/components/GenioPanel.tsx', 'screenContextFor'],
  'inventory-index': ['src/main/inventory.ts', "feature: 'inventory-index'"],
  terminal: ['src/main/terminal-pane.ts', 'export function runShell'],
  assets: ['resources/unit-skills/genio/skills/imagegen-codex/scripts/codex-image.mjs', 'genio-codex-image'],
  blender: ['resources/unit-skills/genio/skills/blender/scripts/blender.mjs', 'genio-blender-run'],
  'unit-uthana': ['resources/unit-skills/genio/skills/uthana/scripts/uthana.mjs', 'genio-uthana-run'],
  'spend-grant': ['src/main/spend-grants.ts', 'export function recordGrant'],
  mcp: ['src/main/mcp-gateway.ts', 'export function createMcpGateway'],
  'mcp-chat': ['src/main/chat-mcp.ts', 'export async function chatMcpServers'],
  'mcp-chat-only': ['src/shared/mcp.ts', 'chatOnly?: boolean'],
  'mcp-signin': ['src/main/mcp-signin.ts', 'export async function mcpSignIn']
}

// Retired achievements and why. Their ids stay in ACHIEVEMENTS for saved stats; they never unlock again and never cover a
// live feature. Retiring another achievement means adding it here explicitly, with the reason.
const RETIRED: Record<string, string> = {
  'play-package': 'the old Play screen: package install',
  'play-slot': 'the old Play screen: shared slot lease',
  'play-takeover': 'the old Play screen: slot takeover',
  'play-snapshot': 'the old Play screen: snapshots',
  'modeller-rewind': 'the Modeller Steps tab lost Revert to N and Branch from N: the player steers in words, the unit runs the kernel itself',
  'reaction-like': 'the chat lost its like button: telling Genio it is on the right path does the same',
  'reaction-dislike': 'the chat lost its dislike button: telling Genio to stop and what is wrong does the same'
}
// Un-retired by the new Play screen (Step and the resolution dropdown by the minimal one): same ids, so earned dates carry over.
const UNRETIRED = ['play-stream', 'play-input', 'play-fullscreen', 'play-step', 'play-resolution']
// Live achievements with no unlock call of their own, and why (none today).
const PASSIVE: Record<string, string> = {}
const LIVE = ACHIEVEMENTS.filter((a) => !a.retired)

const help = 'Add an achievement with this feature tag in src/main/stats.ts and wire its unlock to a real successful event.'
const add = (tag: string): string => `no live achievement has feature tag '${tag}'. Add one to ACHIEVEMENTS in src/main/stats.ts with feature: '${tag}' and wire its unlock to a real successful event.`

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (/\.(ts|tsx|mjs)$/.test(name) && !name.endsWith('.d.ts') && !name.endsWith('.d.mts')) out.push(p)
  }
  return out
}
const SRC = [...sources('src'), ...sources('resources/unit-skills')].map((file) => ({ file, text: readFileSync(file, 'utf8') }))
const STATS = readFileSync('src/main/stats.ts', 'utf8')
/** stats.ts's feature-used map: event feature -> achievement id. */
const FEATURE_MAP: Record<string, string> = Object.fromEntries(
  [...(STATS.match(/const ids: Record<string, string> = \{([\s\S]*?)\n\s*\}/)?.[1] ?? '').matchAll(/'?([\w-]+)'?\s*:\s*'([\w-]+)'/g)].map((m) => [m[1], m[2]])
)
/** Every achievement id the source unlocks: unlock('id') and unlockQuietly('id') calls, stats.ts asset('id', ...) and the feature-used map. */
const UNLOCKED = new Map<string, string>()
for (const { file, text } of SRC) for (const m of text.matchAll(/\bunlock\w*\(\s*'([^']+)'/g)) UNLOCKED.set(m[1], file)
for (const m of STATS.matchAll(/\basset\(\s*'([^']+)'/g)) UNLOCKED.set(m[1], 'src/main/stats.ts')
for (const id of Object.values(FEATURE_MAP)) UNLOCKED.set(id, 'src/main/stats.ts (feature-used)')

function liveTags(): Set<string> {
  return new Set([
    ...navItems().map((v) => v.id),
    ...Object.values(PLAYER_FACING_TOOLS), ...Object.values(UNIT_KINDS), ...Object.values(UNIT_FLAGS), ...Object.keys(OTHER_FEATURES)
  ])
}

describe('achievement feature coverage', () => {
  it('retires exactly the listed achievements and keeps their ids', () => {
    expect(ACHIEVEMENTS.filter((a) => a.retired).map((a) => a.id).sort()).toEqual(Object.keys(RETIRED).sort())
    for (const id of UNRETIRED) expect(LIVE.find((a) => a.id === id)?.feature, id).toBe('play')
  })
  it('ties the Play screen to live Play achievements wired in the main process', () => {
    expect(navItems().find((v) => v.id === 'play')?.label).toBe('Play')
    const ipc = readFileSync('src/main/ipc.ts', 'utf8'), instance = readFileSync('src/main/player-instance.ts', 'utf8')
    expect(instance).toContain("unlock('play-first')")
    expect(instance).toContain("unlock('play-kept-copy')")
    for (const id of ['play-stream', 'play-input', 'play-unit', 'play-step', 'play-resolution', 'play-audio']) expect(ipc, id).toMatch(new RegExp(`unlock\\w*\\('${id}'\\)`))
    expect(FEATURE_MAP['play-fullscreen']).toBe('play-fullscreen')
  })
  it('ties the Design screen to the first design chat reply, unlocked when a design chat answers', () => {
    expect(navItems().find((v) => v.id === 'design')).toMatchObject({ label: 'Design', key: '7' })
    expect(ACHIEVEMENTS.find((a) => a.id === 'design-chat-reply')?.feature).toBe('design')
    expect(readFileSync('src/main/design-chats.ts', 'utf8')).toMatch(/onTurnEnd[\s\S]*if \(lastText\.trim\(\)\) safe\(\(\) => getCtx\(\)\.stats\.unlock\('design-chat-reply'\)\)/)
  })
  it('keeps Character Sheet tied to the stable streak achievement and screen id', () => {
    expect(navItems().find((v) => v.label === 'Character Sheet')?.id).toBe('status')
    expect(ACHIEVEMENTS.find((a) => a.id === 'on-a-roll')?.feature).toBe('status')
    expect(ACHIEVEMENTS.find((a) => a.id === 'character-sheet-open')?.feature).toBe('status')
    expect(navItems().some((v) => v.label === 'Status')).toBe(false)
  })
  it('covers every Rail view', () => {
    const tags = new Set(LIVE.map((a) => a.feature))
    const ids = new Set(navItems().map((v) => v.id))
    for (const id of ids) expect(tags.has(id), `Rail ${id}: ${add(id)}`).toBe(true)
  })
  it('covers every screen that publishes screen context', () => {
    const tags = new Set(LIVE.map((a) => a.feature))
    const screens = new Set(SRC.flatMap(({ text }) => [...text.matchAll(/\b(?:useScreenContext|publishScreenContext)\(\s*'([^']+)'/g)].map((m) => m[1])))
    expect(screens.size).toBeGreaterThan(0)
    for (const id of screens) expect(tags.has(id), `screen ${id}: ${add(id)}`).toBe(true)
  })
  it('covers all explicitly player-facing Genio tools', () => {
    const tags = new Set(LIVE.map((a) => a.feature))
    const source = readFileSync('src/main/wksp-tools.ts', 'utf8')
    const registered = [...source.matchAll(/\bt\(\s*'([^']+)'/g)].map((m) => m[1])
    for (const tool of registered) {
      expect(tool in PLAYER_FACING_TOOLS || SUPPORTING_TOOLS.includes(tool),
        `${tool}: classify this new tool in PLAYER_FACING_TOOLS with its feature tag (or SUPPORTING_TOOLS for internal helpers) in tests/achievement-coverage.test.ts. ${help}`).toBe(true)
    }
    for (const tool of [...Object.keys(PLAYER_FACING_TOOLS), ...SUPPORTING_TOOLS]) {
      expect(registered, `${tool} is no longer a registered tool: remove it from tests/achievement-coverage.test.ts and retire achievements only it unlocked`).toContain(tool)
    }
    for (const [tool, feature] of Object.entries(PLAYER_FACING_TOOLS)) expect(tags.has(feature), `tool ${tool}: ${add(feature)}`).toBe(true)
  })
  it('covers every unit kind and unit flag', () => {
    const tags = new Set(LIVE.map((a) => a.feature))
    const types = readFileSync('src/shared/types.ts', 'utf8'), api = readFileSync('src/shared/api.ts', 'utf8')
    const kinds = [...(types.match(/export type TaskKind = ([^\n]+)/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(kinds.sort(), 'TaskKind changed: map each unit kind to its feature tag in UNIT_KINDS (tests/achievement-coverage.test.ts) and add or retire its achievement').toEqual(Object.keys(UNIT_KINDS).sort())
    const task = types.match(/export interface Task \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const spawn = api.match(/export interface SpawnRequest \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const options = [...spawn.matchAll(/^\s+(\w+)\?: boolean/gm)].map((m) => m[1])
    for (const o of options) {
      expect(o in UNIT_FLAGS || SPAWN_OPTIONS.includes(o), `SpawnRequest.${o}: classify it in UNIT_FLAGS with its feature tag if it makes a new kind of unit, else in SPAWN_OPTIONS`).toBe(true)
    }
    for (const flag of Object.keys(UNIT_FLAGS)) {
      expect(options, `unit flag ${flag} is gone from SpawnRequest: remove it from UNIT_FLAGS and retire its achievements`).toContain(flag)
      expect(task, `unit flag ${flag} is gone from Task`).toMatch(new RegExp(`\\n\\s+${flag}\\?: boolean`))
    }
    for (const [kind, tag] of Object.entries({ ...UNIT_KINDS, ...UNIT_FLAGS })) expect(tags.has(tag), `unit ${kind}: ${add(tag)}`).toBe(true)
  })
  it('classifies every Settings page', () => {
    const live = new Set(LIVE.map((a) => a.id))
    expect(Object.keys(SETTINGS_PAGE_ACHIEVEMENTS).sort(),
      "Settings pages changed: map each page in SETTINGS_PAGE_ACHIEVEMENTS to the achievement earned there or 'none: <why>', and add one for a page with a real feat").toEqual(SETTINGS_PAGES.map((p) => p.id).sort())
    for (const [page, v] of Object.entries(SETTINGS_PAGE_ACHIEVEMENTS)) {
      if (!v.startsWith('none: ')) expect(live.has(v), `Settings page ${page}: achievement ${v} is not live. Map the page to a live achievement or 'none: <why>'`).toBe(true)
    }
  })
  it('points every feature tag at something live, or retires it', () => {
    for (const [tag, [file, needle]] of Object.entries(OTHER_FEATURES)) {
      expect(existsSync(file) && readFileSync(file, 'utf8').includes(needle), `feature ${tag} is gone (${file} no longer has ${needle}): retire its achievements or point OTHER_FEATURES at its new home`).toBe(true)
    }
    const tags = liveTags()
    for (const a of LIVE) {
      expect(tags.has(a.feature), `${a.id}: feature tag '${a.feature}' matches nothing live. Point it at a Rail view, a PLAYER_FACING_TOOLS tag, a unit kind or flag, or an OTHER_FEATURES entry; or retire it (retired: true in src/main/stats.ts and RETIRED here with the reason)`).toBe(true)
    }
  })
  it('unlocks only known achievements, and every live one has an unlock', () => {
    const byId = new Map(ACHIEVEMENTS.map((a) => [a.id, a]))
    for (const [id, file] of UNLOCKED) {
      expect(byId.has(id), `${file} unlocks '${id}', which is not in ACHIEVEMENTS: add it to src/main/stats.ts or remove the call`).toBe(true)
      expect(byId.get(id)?.retired, `${file} unlocks retired '${id}': retired achievements never unlock; remove the call`).not.toBe(true)
    }
    for (const a of LIVE) {
      expect(UNLOCKED.has(a.id) || a.id in PASSIVE, `${a.id}: nothing unlocks it. Wire unlock('${a.id}') to its real successful event, or list it in PASSIVE with the reason`).toBe(true)
    }
    for (const id of Object.keys(PASSIVE)) expect(byId.has(id) && !UNLOCKED.has(id), `PASSIVE ${id}: remove it (unknown, or it has an unlock now)`).toBe(true)
  })
  it('emits every feature-used event the achievement map listens for', () => {
    const emitted = new Set(SRC.filter(({ file }) => !file.endsWith(path.join('main', 'stats.ts')))
      .flatMap(({ text }) => [...text.matchAll(/(?:feature: |featureUsed\()\s*'([\w-]+)'/g)].map((m) => m[1])))
    for (const feature of Object.keys(FEATURE_MAP)) {
      expect(emitted.has(feature), `stats.ts maps feature-used '${feature}' but nothing publishes it: remove the mapping or retire ${FEATURE_MAP[feature]}`).toBe(true)
    }
  })
  it('gives every achievement a tag, short copy and a unique stable id', () => {
    expect(new Set(ACHIEVEMENTS.map((a) => a.id)).size).toBe(ACHIEVEMENTS.length)
    expect(new Set(LIVE.map((a) => a.name)).size, 'two live achievements share a name').toBe(LIVE.length)
    for (const a of ACHIEVEMENTS) {
      expect(a.feature.trim(), `${a.id}: ${help}`).not.toBe('')
      expect(a.name.length, `${a.id}: keep the name short`).toBeLessThanOrEqual(24)
      expect(a.description.length, `${a.id}: keep the description to one short sentence`).toBeLessThanOrEqual(90)
    }
  })
  it('keeps stale screen names out of the copy', () => {
    for (const a of LIVE) {
      expect(`${a.name} ${a.description}`, `${a.id}: say project, not world`).not.toMatch(/\bworlds?\b/i)
      expect(a.description, `${a.id}: the Status screen is the Character Sheet`).not.toMatch(/\bStatus screen\b/)
      expect(a.description, `${a.id}: the Accept step is gone`).not.toMatch(/\bAccept\b/)
      expect(a.description, `${a.id}: the shell buttons became the terminal pane`).not.toMatch(/shell button/i)
    }
  })
  it('keeps the original provider achievement ids mapped to live agent tools', () => {
    for (const [id, tool] of [['fal-first', 'fal_generate'], ['animation-first', 'uthana_motion']]) {
      expect(ACHIEVEMENTS.find((a) => a.id === id)?.feature).toBe(PLAYER_FACING_TOOLS[tool])
      expect(navItems().map((v) => v.id)).not.toContain(tool === 'fal_generate' ? 'fal' : 'animation')
    }
  })
})
