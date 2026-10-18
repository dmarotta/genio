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
  project: ['Project', 'Folder'],
  'project-delivery': ['Hardcore', 'Standard', 'Offline', 'Pull request'],
  'project-assets': ['Budget', 'FAL', 'Codex images', 'Inventory'],
  'project-unity': ['Slots', 'Copies'],
  usage: ['Usage mode', 'Plan', 'Limits', 'Save', 'Balanced', 'Max', 'Plan remaining', 'Protection', 'Pinned'],
  accounts: ['Log in', 'Sign in', 'Claude', 'Codex', 'Keys'],
  memory: ['Profile', 'Squad memory', '/save', 'Curate'],
  units: ['Permissions', 'Quests'],
  play: ['Play editor', 'Unity'],
  inbox: ['Notes', 'Phone'],
  system: ['Updates', 'Installed tools', 'Install', 'Windows', 'Past sessions', 'Codex app', 'Claude app'],
  dispatch: ['Category table', 'Rules'],
  harnesses: ['CLI', 'Claude Code']
}

type RowSpec = [label: string, synonyms?: string[], anchor?: string]

/** Rows by page. Without an explicit anchor, the row's id comes from its label (settingAnchor). */
const ROWS: Partial<Record<SettingsPageId, RowSpec[]>> = {
  project: [
    ['Engine', ['Rescan', 'Detected engine', 'Unity version'], 'settings-engine'],
    ['Description', ['Pitch']],
    ['Usage mode', ['Usage mode for this project', 'Project usage mode']],
    ['Max units at once', ['Capacity', 'Cap', 'Unit limit']],
    ['OpenRouter models', ['Allow OpenRouter models for low-stakes work', 'Allow cheap third-party models', 'Cheap models', 'OpenRouter', 'DeepSeek', 'Qwen']],
    ['Commands', ['setup', 'build', 'test', 'lint', 'Build command', 'Test command'], 'settings-commands']
  ],
  'project-delivery': [
    ['Delivery', ['Delivery mode', 'Hardcore', 'Standard', 'Offline']],
    ['Merge finished work automatically', ['Auto-loot', 'Yolo', 'Auto merge']]
  ],
  'project-assets': [['Generation settings', ['Monthly budget', 'Codex images'], 'generation-settings']],
  'project-unity': [['Slots', ['Unity slots for units', 'Maximum slots', 'Slot editor windows', 'Slot windows'], 'unity-slots']],
  general: [
    ['Gamertag', ['Name']],
    // The Voice drop-down under it shows only once the natural voice is downloaded, so its words lead here.
    ['Read replies aloud', ['Voice', 'Speech', 'Reply voice', 'Natural voice', 'Kokoro', 'Windows voice']],
    ['Scanlines and grid', ['Visual FX', 'Effects']],
    ['Clean chat', ['Clean HUD', 'Calm', 'Tool chatter']],
    ['Desktop notifications', ['Toasts', 'Notify']],
    ['Feature tips', ['tips', 'hints']],
    ['Sounds', ['Sound effects', 'SFX']],
    ['Volume'],
    ["While you're away", ['AFK', 'DND', 'Away', 'Alerts'], 'settings-away'],
    ['Send away alerts to', ['Webhook', 'Webhook kind', 'Webhook URL', 'Discord', 'Slack', 'JSON']],
    ["If you don't respond", ['Alarm', 'Run a command']]
  ],
  usage: [
    ['Usage mode', ['Save', 'Balanced', 'Max'], 'settings-usage-mode'],
    ['Units at once', ['Concurrent units', 'Parallel units', 'Global unit limit']],
    ['Allow paid OpenRouter spend', ['Paid spend on cheap models', 'OpenRouter spend', 'Cheap models']]
  ],
  accounts: [['API keys', ['FAL', 'OpenRouter key', 'Uthana', 'Key'], 'settings-api-keys']],
  units: [
    ['Default agent tool', ['Default harness', 'Harness']],
    ['Claude unit permissions', ['Claude permission posture', 'Bypass', 'Accept edits']],
    ['Start queued quests automatically', ['Auto-dispatch queued quests', 'Auto-dispatch']],
    ['Instructions for every unit', ['Brief additions', 'Brief include']],
    ['Remove AI co-author lines', ['Remove AI co-author lines from commits', 'Strip AI commit trailers', 'Commit attribution', 'Co-author lines']],
    ['Credit Genio as co-author', ['Co-authored by Genio']]
  ],
  play: [['Your Play editor', ['Close your Play editor after', 'Play editors open at once', 'Quit after idle', 'Maximum player editors', 'Idle time and editor limit'], 'player-instance']],
  inbox: [
    ['Accept notes from scripts and your phone', ['Mail HTTP intake', 'Mail', 'HTTP']],
    ['Token'],
    ['Scheduled checks', ['Triggers', 'Timer', 'Cron'], 'settings-triggers']
  ],
  system: [
    ['Installed tools', ['Loadout', 'Toolchain', 'Rescan'], 'settings-tools'],
    ['Windows integration', ['Explorer', 'Context menu'], 'settings-explorer'],
    ['Open with Genio', ['Explorer menu']],
    ['Updates', ['Patch', 'Check for updates', 'Update and restart', 'Check for patch', 'Apply patch'], 'settings-updates'],
    ["Genio's past sessions", ["Hide Genio's past sessions from the Codex and Claude apps", 'Housekeeping', 'Maintenance', 'Archive sessions', 'Undo'], 'settings-maintenance']
  ],
  dispatch: [['Learn the order automatically', ['Auto reorder', 'Learning']]],
  harnesses: [
    ['Terminal shell', ['Shell', 'Terminal', 'PowerShell']],
    ['MCP servers', ['MCP', 'Model Context Protocol', 'Tool servers', 'Plugins'], 'settings-mcp']
  ]
}

export const SETTINGS_INDEX: SettingsEntry[] = SETTINGS_PAGES.flatMap((page): SettingsEntry[] => [
  { page: page.id, label: page.label, synonyms: [...(page.term ? [page.term] : []), ...(page.synonyms ?? []), ...(PAGE_WORDS[page.id] ?? [])] },
  ...(ROWS[page.id] ?? []).map(([label, synonyms, anchor]) => ({ page: page.id, label, synonyms, anchor: anchor ?? settingAnchor(label) }))
])

export interface SettingsHit extends SettingsEntry {
  /** "Units", or "General › Send away alerts to". */
  path: string
  /** This project / All projects / Advanced. */
  scope: string
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9/.]+/g, ' ').trim()

/**
 * Entries matching every word of the query, best first: a label that starts with the query, then an
 * old name or synonym typed in full ("Dispatch" before "Auto-dispatch queued quests"), then a label
 * containing it, then a partial synonym, then the page name. Pages rank before their own rows. Only
 * pages in `allowed` are searched, so the Hub never offers project pages.
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
    const exact = e.synonyms?.some((s) => norm(s) === q)
    const partial = e.synonyms?.some(has)
    const rank = label.startsWith(q) ? 0 : exact ? 1 : has(e.label) ? 2 : partial ? 3 : e.anchor && has(`${page.label} ${e.label}`) ? 4 : -1
    if (rank < 0) return
    const path = e.anchor ? `${page.label} › ${e.label}` : page.label
    hits.push({ hit: { ...e, path, scope: SETTINGS_SCOPE_CHIP[page.group] }, rank: rank * 2 + (e.anchor ? 1 : 0), order })
  })
  return hits.sort((a, b) => a.rank - b.rank || a.order - b.order).slice(0, limit).map((h) => h.hit)
}
