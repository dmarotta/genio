/**
 * The Settings page registry: two labelled scopes (this project, Genio for all projects) and the
 * expert pages behind "Show advanced settings". UI only: pages map onto the same stored settings,
 * project fields and files as before. Retired page ids and DOM anchors keep working through
 * SETTINGS_ALIASES, and main-process text names a page only through settingsPath().
 */

export type SettingsPageId =
  | 'project' | 'project-delivery' | 'project-commands' | 'project-assets' | 'project-unity'
  | 'general' | 'notifications' | 'usage' | 'accounts' | 'memory' | 'units' | 'play' | 'inbox' | 'system'
  | 'dispatch' | 'harnesses' | 'gauntlet' | 'overwatch' | 'maintenance'

export type SettingsGroup = 'project' | 'genio' | 'advanced'

export interface SettingsPage {
  id: SettingsPageId
  label: string
  group: SettingsGroup
  /** The game term the rest of the app still uses, shown as a hint next to the plain name. */
  term?: string
  /** Former page names and game terms, so a later settings search still finds them. */
  synonyms?: string[]
  /** Shown only for Unity projects (project page) or when a Unity project is registered (Genio page). */
  unity?: boolean
}

export const SETTINGS_GROUP_LABEL: Record<SettingsGroup, string> = {
  project: 'This project',
  genio: 'Genio · all projects',
  advanced: 'Advanced'
}

export const SETTINGS_PAGES: SettingsPage[] = [
  { id: 'project', label: 'General', group: 'project', synonyms: ['This project'] },
  { id: 'project-delivery', label: 'Delivery', group: 'project', synonyms: ['Auto-loot', 'Sync', 'Push', 'Branch prefix'] },
  { id: 'project-commands', label: 'Commands', group: 'project' },
  { id: 'project-assets', label: 'Asset generation', group: 'project', synonyms: ['Generation'] },
  { id: 'project-unity', label: 'Unity slots', group: 'project', unity: true },
  { id: 'general', label: 'General', group: 'genio', synonyms: ['Profile', 'Comms & FX', 'Clean HUD', 'Gamertag'] },
  { id: 'notifications', label: 'Notifications', group: 'genio', synonyms: ['Alerts', 'Comms & FX', 'Alarm', 'Webhook'] },
  { id: 'usage', label: 'Usage & limits', group: 'genio', synonyms: ['Usage'] },
  { id: 'accounts', label: 'Accounts & keys', group: 'genio', synonyms: ['Accounts', 'API keys'] },
  { id: 'memory', label: 'Memory', group: 'genio' },
  { id: 'units', label: 'Units', group: 'genio', synonyms: ['Genio', 'Brief additions'] },
  { id: 'play', label: 'Unity & Play', group: 'genio', unity: true, synonyms: ['Your Play instance'] },
  { id: 'inbox', label: 'Inbox & automation', group: 'genio', synonyms: ['Mail & replay', 'Mail', 'Triggers'] },
  { id: 'system', label: 'System', group: 'genio', synonyms: ['Loadout', 'Explorer', 'Patch'] },
  { id: 'dispatch', label: 'Model routing', group: 'advanced', term: 'Dispatch', synonyms: ['Dispatch'] },
  { id: 'harnesses', label: 'Agent tools', group: 'advanced', term: 'Harnesses', synonyms: ['Harnesses'] },
  { id: 'gauntlet', label: 'Checks & review', group: 'advanced', term: 'Gauntlet', synonyms: ['Gauntlet'] },
  { id: 'overwatch', label: 'Timing', group: 'advanced', term: 'Overwatch', synonyms: ['Overwatch'] },
  { id: 'maintenance', label: 'Maintenance', group: 'advanced', synonyms: ['Housekeeping'] }
]

/** Retired page ids: each still opens its new home, at the anchor of the part it became. */
export const SETTINGS_ALIASES: Record<string, { page: SettingsPageId; anchor?: string }> = {
  profile: { page: 'general' },
  comms: { page: 'notifications' },
  alerts: { page: 'notifications', anchor: 'settings-away' },
  mail: { page: 'inbox' },
  triggers: { page: 'inbox', anchor: 'settings-triggers' },
  genio: { page: 'units' },
  toolchain: { page: 'system', anchor: 'settings-tools' },
  explorer: { page: 'system', anchor: 'settings-explorer' },
  patch: { page: 'system', anchor: 'settings-updates' }
}

/** DOM anchors that moved off the old This project page, and the page that now holds each. */
export const SETTINGS_ANCHOR_PAGES: Record<string, SettingsPageId> = {
  'generation-settings': 'project-assets',
  'unity-slots': 'project-unity',
  'player-instance': 'play',
  'settings-away': 'notifications',
  'settings-triggers': 'inbox',
  'settings-tools': 'system',
  'settings-explorer': 'system',
  'settings-updates': 'system'
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

/** "Settings → Accounts & keys", or "Settings → This project → Delivery"; optional sub-parts follow. */
export function settingsPath(id: string, ...parts: string[]): string {
  const page = settingsPage(resolveSettingsPage(id).page)
  const scope = page.group === 'project' ? ['This project'] : page.group === 'advanced' ? ['Advanced'] : []
  return ['Settings', ...scope, page.label, ...parts].join(' → ')
}
