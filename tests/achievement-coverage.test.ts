import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ACHIEVEMENTS } from '../src/main/stats'
import { RAIL, navItems } from '../src/renderer/src/lib/railmenu'

// Deliberately explicit: add new player-facing tools here, with their feature tag.
const PLAYER_FACING_TOOLS: Record<string, string> = {
  deploy: 'deploy', merge: 'move', run_gauntlet: 'squad', quest_add: 'quests',
  world_add: 'worlds', world_create: 'worlds', world_push: 'world_push',
  memory_write: 'lore', generate_image: 'generate_image', rate_task: 'rate_task',
  loadout_preview: 'loadout_preview'
}
// Supporting reads, orchestration and maintenance. New tools must be classified
// explicitly so adding a registration cannot silently bypass the coverage guard.
const SUPPORTING_TOOLS = [
  'fleet_view', 'unit_state', 'read_task_file', 'terminal_tail', 'ping', 'control',
  'despawn', 'upgrade_recon', 'quest_list', 'quest_update', 'quest_hold', 'quest_release',
  'quest_remove', 'choice_open', 'choice_resolve', 'choice_list', 'world_list',
  'world_posture', 'world_update', 'world_remove', 'world_sync', 'status_report',
  'memory_read', 'memory_report', 'memory_archive', 'mail_list', 'mail_ack', 'mail_reply',
  'dispatch_profiles', 'toolchain_check', 'presence_set', 'ally_list', 'ally_route',
  'report_to_main', 'escalate'
]

const help = 'Add an achievement with this feature tag in src/main/stats.ts and wire its unlock to a real successful event.'

describe('achievement feature coverage', () => {
  it('covers every Rail view and submenu', () => {
    const tags = new Set(ACHIEVEMENTS.map((a) => a.feature))
    const ids = new Set([...navItems().map((v) => v.id), ...RAIL.filter((e) => e.kind === 'menu').map((e) => e.id)])
    for (const id of ids) expect(tags.has(id), `${id}: ${help}`).toBe(true)
  })
  it('covers all explicitly player-facing Genio tools', () => {
    const tags = new Set(ACHIEVEMENTS.map((a) => a.feature))
    const source = readFileSync('src/main/wksp-tools.ts', 'utf8')
    const registered = [...source.matchAll(/\bt\(\s*'([^']+)'/g)].map((m) => m[1])
    for (const tool of registered) {
      expect(tool in PLAYER_FACING_TOOLS || SUPPORTING_TOOLS.includes(tool),
        `${tool}: classify this new tool in PLAYER_FACING_TOOLS (or SUPPORTING_TOOLS for internal helpers). ${help}`).toBe(true)
    }
    for (const [tool, feature] of Object.entries(PLAYER_FACING_TOOLS)) {
      expect(registered, `Remove stale tool coverage for ${tool}`).toContain(tool)
      expect(tags.has(feature), `${tool} (${feature}): ${help}`).toBe(true)
    }
  })
  it('gives every achievement a tag and a unique stable id', () => {
    expect(new Set(ACHIEVEMENTS.map((a) => a.id)).size).toBe(ACHIEVEMENTS.length)
    for (const a of ACHIEVEMENTS) expect(a.feature.trim(), `${a.id}: ${help}`).not.toBe('')
  })
})
