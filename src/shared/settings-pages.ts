/**
 * The Settings page registry: two labelled scopes (this project, all projects) and the Advanced
 * pages. UI only: pages map onto the same stored settings, project fields and files as before.
 * Retired page ids and DOM anchors keep working through SETTINGS_ALIASES, and main-process text
 * names a page only through settingsPath().
 */

export type SettingsPageId =
  | 'project' | 'project-delivery' | 'project-assets' | 'project-unity'
  | 'general' | 'usage' | 'accounts' | 'memory' | 'units' | 'play' | 'inbox' | 'system'
  | 'dispatch' | 'harnesses'

export type SettingsGroup = 'project' | 'genio' | 'advanced'

export interface SettingsPage {
  id: SettingsPageId
  label: string
  group: SettingsGroup
  /** The game term the rest of the app still uses: a search word, and a hint in settingsPath() text. */
  term?: string
  /** Former page names and game terms, so a later settings search still finds them. */
  synonyms?: string[]
  /** Shown only for Unity projects (project page) or when a Unity project is registered (Genio page). */
  unity?: boolean
}

export const SETTINGS_GROUP_LABEL: Record<SettingsGroup, string> = {
  project: 'This project',
  genio: 'All projects',
  advanced: 'Advanced'
}

export const SETTINGS_PAGES: SettingsPage[] = [
  { id: 'project', label: 'General', group: 'project', synonyms: ['This project', 'Commands'] },
  { id: 'project-delivery', label: 'Delivery', group: 'project', synonyms: ['Auto-loot', 'Gauntlet'] },
  { id: 'project-assets', label: 'Asset generation', group: 'project', synonyms: ['Generation'] },
  { id: 'project-unity', label: 'Unity slots', group: 'project', unity: true },
  { id: 'general', label: 'General', group: 'genio', synonyms: ['Profile', 'Comms & FX', 'Clean HUD', 'Gamertag', 'Notifications', 'Alerts', 'Webhook'] },
  { id: 'usage', label: 'Usage & limits', group: 'genio', synonyms: ['Usage'] },
  { id: 'accounts', label: 'Accounts & keys', group: 'genio', synonyms: ['Accounts', 'API keys'] },
  { id: 'memory', label: 'Memory', group: 'genio' },
  { id: 'units', label: 'Units', group: 'genio', synonyms: ['Genio', 'Brief additions'] },
  { id: 'play', label: 'Unity & Play', group: 'genio', unity: true, synonyms: ['Your Play instance'] },
  { id: 'inbox', label: 'Inbox & automation', group: 'genio', synonyms: ['Mail & replay', 'Mail', 'Triggers'] },
  { id: 'system', label: 'System', group: 'genio', synonyms: ['Loadout', 'Explorer', 'Patch', 'Maintenance', 'Housekeeping'] },
  { id: 'dispatch', label: 'Model routing', group: 'advanced', term: 'Dispatch', synonyms: ['Dispatch'] },
  { id: 'harnesses', label: 'Agent tools', group: 'advanced', term: 'Harnesses', synonyms: ['Harnesses'] }
]

/**
 * Titled parts of a page that other text names: an old page that merged into a part keeps its game
 * term as the hint ("Updates (Patch)"). Keyed by the part's DOM anchor.
 */
export const SETTINGS_PARTS: Record<string, { label: string; term?: string }> = {
  'settings-away': { label: "While you're away" },
  'settings-commands': { label: 'Commands' },
  'settings-triggers': { label: 'Scheduled checks', term: 'Triggers' },
  'settings-tools': { label: 'Installed tools', term: 'Loadout' },
  'settings-explorer': { label: 'Windows integration' },
  'settings-updates': { label: 'Updates', term: 'Patch' },
  'settings-maintenance': { label: "Genio's past sessions" },
  'settings-api-keys': { label: 'API keys' }
}

/** A plain name with its game term as a hint: "Model routing (Dispatch)". */
export const withTerm = ({ label, term }: { label: string; term?: string }): string => (term ? `${label} (${term})` : label)

/**
 * Retired page ids: each still opens its new home, at the anchor of the part it became. Pages whose
 * settings were removed (Timing, Checks & review) open the page closest to what they were about.
 */
export const SETTINGS_ALIASES: Record<string, { page: SettingsPageId; anchor?: string }> = {
  profile: { page: 'general' },
  comms: { page: 'general' },
  notifications: { page: 'general' },
  alerts: { page: 'general', anchor: 'settings-away' },
  mail: { page: 'inbox' },
  triggers: { page: 'inbox', anchor: 'settings-triggers' },
  genio: { page: 'units' },
  toolchain: { page: 'system', anchor: 'settings-tools' },
  explorer: { page: 'system', anchor: 'settings-explorer' },
  patch: { page: 'system', anchor: 'settings-updates' },
  maintenance: { page: 'system', anchor: 'settings-maintenance' },
  'project-commands': { page: 'project', anchor: 'settings-commands' },
  gauntlet: { page: 'project-delivery' },
  overwatch: { page: 'units' }
}

/** DOM anchors that moved off the old This project page, and the page that now holds each. */
export const SETTINGS_ANCHOR_PAGES: Record<string, SettingsPageId> = {
  'generation-settings': 'project-assets',
  'unity-slots': 'project-unity',
  'player-instance': 'play',
  'settings-away': 'general',
  'settings-triggers': 'inbox',
  'settings-tools': 'system',
  'settings-explorer': 'system',
  'settings-updates': 'system',
  'settings-maintenance': 'system'
}

export const isSettingsPageId = (id: string): id is SettingsPageId => SETTINGS_PAGES.some((p) => p.id === id)

/** Any id ever used for a Settings section, current or retired, with an optional anchor, resolved to a page. */
export function resolveSettingsPage(id: string, anchor?: string): { page: SettingsPageId; anchor?: string } {
  const alias = SETTINGS_ALIASES[id]
  if (alias) return { page: alias.page, anchor: anchor ?? alias.anchor }
  // The old This project page held every project block: an anchor picks the page it moved to.
  if (id === 'project' && anchor && SETTINGS_ANCHOR_PAGES[anchor]) return { page: SETTINGS_ANCHOR_PAGES[anchor], anchor }
  if (isSettingsPageId(id)) return { page: id, anchor }
  return { page: 'general', anchor }
}

export const settingsPage = (id: SettingsPageId): SettingsPage => SETTINGS_PAGES.find((p) => p.id === id)!

/**
 * The one way text names a place in Settings, with the game term as a hint: "Settings → Accounts & keys",
 * "Settings → Advanced → Model routing (Dispatch)". A retired id that became a part adds it
 * ("patch" → "Settings → System → Updates (Patch)"); optional sub-parts follow.
 */
export function settingsPath(id: string, ...parts: string[]): string {
  const { page: pageId, anchor } = resolveSettingsPage(id)
  const page = settingsPage(pageId)
  const scope = page.group === 'project' ? ['This project'] : page.group === 'advanced' ? ['Advanced'] : []
  const part = anchor && SETTINGS_PARTS[anchor] ? [withTerm(SETTINGS_PARTS[anchor])] : []
  return ['Settings', ...scope, withTerm(page), ...part, ...parts].join(' → ')
}
