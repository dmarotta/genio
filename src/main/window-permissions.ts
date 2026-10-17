/**
 * What a web page in Genio may ask the browser for. Only Genio's own windows (a project or Hub window and its chat
 * pop-out) get anything: the microphone for voice input (audio only, from the window's own page, never an embedded
 * frame) and what the UI already uses (clipboard, pointer lock and full screen for Play). Everything else is denied.
 */
const OWN_WINDOW_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write', 'pointerLock', 'fullscreen'])

export interface PermissionAsk {
  /** The asking page belongs to one of Genio's own windows. */
  own: boolean
  isMainFrame: boolean
  /** Requests list their media types; checks give one ('unknown' for device enumeration). */
  mediaTypes?: readonly string[]
}

export function allowPermission(permission: string, ask: PermissionAsk): boolean {
  if (!ask.own) return false
  if (permission === 'media') return ask.isMainFrame && !!ask.mediaTypes?.length && ask.mediaTypes.every(t => t === 'audio')
  return OWN_WINDOW_PERMISSIONS.has(permission)
}
