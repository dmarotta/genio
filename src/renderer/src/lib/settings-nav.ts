import { resolveSettingsPage, type SettingsPageId } from '@shared/settings-pages'

export interface SettingsRequest { page: SettingsPageId; anchor?: string }

let pending: SettingsRequest | null = null
const listeners = new Set<(request: SettingsRequest) => void>()

/**
 * Open a Settings page; with an anchor, also scroll that element into view and focus it.
 * Takes current and retired ids alike ('patch' opens System › Updates), so old links keep working.
 */
export function requestSystemsSection(section: string, anchor?: string): void {
  const request = resolveSettingsPage(section, anchor)
  pending = listeners.size ? null : request
  for (const listener of listeners) listener(request)
}

/** A request made before Settings mounted, handed over once. */
export function takePendingSection(): SettingsRequest | null {
  const p = pending
  pending = null
  return p
}

export function onSectionRequest(listener: (request: SettingsRequest) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
