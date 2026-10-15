import { SETTINGS_PAGES, settingsPage, type SettingsGroup, type SettingsPageId } from './settings-pages'

/**
 * The static Settings search index: every page plus the rows a player looks for, each with the
 * words it answers to (old page names and game terms included, so "Gauntlet" or "Loadout" still
 * find their new homes). A row's anchor is the DOM id the page renders for it; a test checks that
 * every anchor here still renders, so the index cannot drift from the screens.
 */

export interface SettingsEntry {
  page: SettingsPageId
  /** The row's label as the page shows it; for a page entry, the page name. */
  label: string
  synonyms?: string[]
  /** DOM id to reveal and focus on the page. Absent for a page entry. */
  anchor?: string
}

/** The id a Settings row renders from its label, so search can reveal it: "Webhook URL" → setting-webhook-url. */
export const settingAnchor = (label: string): string =>
  `setting-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`

/** What a result's chip says about where the setting applies. */
export const SETTINGS_SCOPE_CHIP: Record<SettingsGroup, string> = {
  project: 'This project',
  genio: 'All projects',
  advanced: 'Advanced'
}

/** Extra words for whole pages, beyond the registry's label, term and synonyms. */
const PAGE_WORDS: Partial<Record<SettingsPageId, string[]>> = {
  project: ['Project', 'Folder', 'Remove project', 'Danger zone'],
  'project-delivery': ['Main branch', 'Hardcore', 'Standard', 'Offline', 'Pull request'],
  'project-commands': ['Build command', 'Test command', 'Lint', 'Setup'],
  'project-assets': ['Budget', 'FAL', 'Codex images', 'Asset folders', 'Inventory'],
  'project-unity': ['Slots', 'Copies'],
  usage: ['Usage mode', 'Plan', 'Limits', 'Save', 'Balanced', 'Max', 'Plan remaining', 'Protection'],
  accounts: ['Log in', 'Sign in', 'Claude', 'Codex', 'Keys'],
  memory: ['Profile', 'Squad memory', '/save', 'Curate'],
  units: ['Permissions', 'Quests'],
  play: ['Play editor', 'Unity'],
  inbox: ['Notes', 'Phone'],
  system: ['Updates', 'Installed tools', 'Install', 'Windows', 'Data folder'],
  dispatch: ['Category table', 'Rules', 'Scorecard', 'Learning'],
  harnesses: ['CLI', 'Adapters', 'Claude Code'],
  gauntlet: ['Review', 'Fix rounds'],
  overwatch: ['Polling', 'Heartbeat', 'Lag'],
  maintenance: ['Past sessions', 'Codex app', 'Claude app']
}

type RowSpec = [label: string, synonyms?: string[], anchor?: string]

/** Rows by page. Without an explicit anchor, the row's id comes from its label (settingAnchor). */
const ROWS: Partial<Record<SettingsPageId, RowSpec[]>> = {
  project: [
    ['Engine', ['Rescan', 'Detected engine', 'Unity version'], 'settings-engine'],
    ['Description', ['Pitch']],
    ['Usage mode', ['Usage mode for this project', 'Project usage mode']],
    ['Capacity', ['Max units at once', 'Cap']],
    ['Allow cheap third-party models', ['OpenRouter', 'DeepSeek', 'Qwen']],
    ['Remove project from Genio', ['Delete project', 'Danger zone'], 'settings-danger']
  ],
  'project-delivery': [
    ['Delivery', ['Delivery mode', 'Hardcore', 'Standard', 'Offline']],
    ['Merge finished work automatically', ['Auto-loot', 'Yolo', 'Auto merge']],
    ['Branch prefix', ['Branch name prefix']],
    ['Main branch', ['Sync', 'Push'], 'settings-main-branch']
  ],
  'project-commands': [['Commands', ['setup', 'build', 'test', 'lint'], 'settings-commands']],
  'project-assets': [['Generation settings', ['Monthly budget', 'Ask above', 'Codex images', 'Asset folders'], 'generation-settings']],
  'project-unity': [['Unity slots for units', ['Maximum slots', 'Slot windows'], 'unity-slots']],
  general: [
    ['Gamertag', ['Name']],
    ['Voice', ['Read aloud', 'Speech']],
    ['Visual FX', ['Scanlines', 'Grid', 'Effects']],
    ['Clean HUD', ['Clean chat', 'Calm', 'Tool chatter']],
    ['Replay onboarding', ['First run', 'Intro', 'Setup again']]
  ],
  notifications: [
    ['Desktop notifications', ['Toasts', 'Notify']],
    ['Sound effects', ['Sounds', 'SFX']],
    ['Volume'],
    ["While you're away", ['AFK', 'DND', 'Away', 'Alerts'], 'settings-away'],
    ['Webhook kind', ['Discord', 'Slack', 'JSON']],
    ['Webhook URL', ['Send away alerts to']],
    ['Alarm', ["If you don't respond", 'Command']],
    ['Alarm after (min)'],
    ['AFK digest window (s)', ['Bundle away alerts', 'Digest']]
  ],
  usage: [
    ['Usage mode', ['Save', 'Balanced', 'Max'], 'settings-usage-mode'],
    ['Paid spend on cheap models', ['OpenRouter spend', 'Cheap models']],
    ['Chat model', ['Pin models and effort', 'Pinned']],
    ['Chat effort'],
    ['Unit model'],
    ['Unit effort'],
    ['Category table, rules, scorecard', ['Model routing']]
  ],
  accounts: [['API keys', ['FAL', 'OpenRouter key', 'Uthana', 'Key'], 'settings-api-keys']],
  memory: [['Memory budget (tokens)', ['Memory size']]],
  units: [
    ['Default harness', ['Default agent tool']],
    ['Claude permission posture', ['Claude unit permissions', 'Bypass', 'Accept edits']],
    ['Auto-dispatch queued quests', ['Start queued quests automatically']],
    ['Brief additions', ['Instructions for every unit', 'Brief include']],
    ['Strip AI commit trailers', ['Commit attribution', 'Co-author lines']],
    ['Co-authored by Genio'],
    ['Genio trailer identity']
  ],
  play: [['Play editor idle time and limit', ['Close your Play editor after', 'Play editors open at once', 'Quit after idle', 'Maximum player editors'], 'player-instance']],
  inbox: [
    ['Mail HTTP intake', ['Accept notes from scripts and your phone', 'Mail']],
    ['Port'],
    ['Token'],
    ['Replay log', ['Activity log', 'Ledger', 'fleet-ledger.jsonl']],
    ['Scheduled checks', ['Triggers', 'Timer', 'Cron'], 'settings-triggers']
  ],
  system: [
    ['Installed tools', ['Loadout', 'Toolchain', 'Rescan'], 'settings-tools'],
    ['Windows integration', ['Explorer', 'Context menu'], 'settings-explorer'],
    ['Open with Genio', ['Explorer menu']],
    ['Terminal command', ['genio .', 'PATH']],
    ['Updates', ['Patch', 'Check for updates', 'Update and restart'], 'settings-updates'],
    ['Base', ['Genio data folder']]
  ],
  dispatch: [['Learn the order automatically', ['Auto reorder', 'Learning']]],
  harnesses: [
    ['Claude Code path', ['Claude path']],
    ['Shell']
  ],
  gauntlet: [
    ['Reviewer model', ['Review model']],
    ['Max fix rounds', ['Validation rounds']]
  ],
  overwatch: [
    ['Poll every (s)', ['Check units every']],
    ['Lagging after (s)', ['Call a unit lagging after', 'Stale']],
    ['Lag escalations', ['Lag warnings before a deep check']],
    ['Paused resurface (h)', ['Bring paused units back after']],
    ['PR poll (min)', ['Check pull requests every']],
    ['Ping re-ring (s)', ['Re-send a ping after']],
    ['Ping rings before escalating', ['Re-sends before escalating']]
  ],
  maintenance: [["Hide Genio's past sessions from the Codex and Claude apps", ['Housekeeping', 'Archive sessions', 'Undo']]]
}

export const SETTINGS_INDEX: SettingsEntry[] = SETTINGS_PAGES.flatMap((page): SettingsEntry[] => [
  { page: page.id, label: page.label, synonyms: [...(page.term ? [page.term] : []), ...(page.synonyms ?? []), ...(PAGE_WORDS[page.id] ?? [])] },
  ...(ROWS[page.id] ?? []).map(([label, synonyms, anchor]) => ({ page: page.id, label, synonyms, anchor: anchor ?? settingAnchor(label) }))
])

export interface SettingsHit extends SettingsEntry {
  /** "Units", or "Notifications › Webhook URL". */
  path: string
  /** This project / All projects / Advanced. */
  scope: string
  /** The old name or synonym that matched, shown so "Gauntlet" visibly finds Checks & review. */
  via?: string
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9/.]+/g, ' ').trim()

/**
 * Entries matching every word of the query, best first: a label that starts with the query, then an
 * old name or synonym typed in full ("Dispatch" before "Auto-dispatch queued quests"), then a label
 * containing it, then a partial synonym, then the page name. Pages rank before their own rows. Only
 * pages in `allowed` are searched, so the Hub never offers project pages; Advanced pages are
 * searchable even while hidden.
 */
export function searchSettings(query: string, allowed: (page: SettingsPageId) => boolean = () => true, limit = 30): SettingsHit[] {
  const q = norm(query)
  if (!q) return []
  const words = q.split(' ')
  const has = (text: string): boolean => { const t = norm(text); return words.every((w) => t.includes(w)) }
  const hits: { hit: SettingsHit; rank: number; order: number }[] = []
  SETTINGS_INDEX.forEach((e, order) => {
    if (!allowed(e.page)) return
    const page = settingsPage(e.page)
    const label = norm(e.label)
    const exact = e.synonyms?.find((s) => norm(s) === q)
    const via = exact ?? e.synonyms?.find(has)
    const rank = label.startsWith(q) ? 0 : exact ? 1 : has(e.label) ? 2 : via ? 3 : e.anchor && has(`${page.label} ${e.label}`) ? 4 : -1
    if (rank < 0) return
    const path = e.anchor ? `${page.label} › ${e.label}` : page.label
    hits.push({ hit: { ...e, path, scope: SETTINGS_SCOPE_CHIP[page.group], via: rank === 1 || rank === 3 ? via : undefined }, rank: rank * 2 + (e.anchor ? 1 : 0), order })
  })
  return hits.sort((a, b) => a.rank - b.rank || a.order - b.order).slice(0, limit).map((h) => h.hit)
}
