export interface FloatingChatState { x: number; y: number; width: number; height: number; collapsed: boolean; snapped: boolean }
export function clampFloatingChat(s: FloatingChatState, width: number, height: number): FloatingChatState {
  const w = Math.min(width, Math.max(360, s.width)), h = Math.min(height, Math.max(320, s.height))
  return { ...s, width: w, height: h, x: Math.max(0, Math.min(width - w, s.x)), y: Math.max(0, Math.min(height - h, s.y)) }
}
export function readFloatingChat(): FloatingChatState {
  const fallback = { x: 360, y: 110, width: 500, height: 430, collapsed: false, snapped: false }
  try {
    const v = JSON.parse(sessionStorage.getItem('genio.inventory.chat') || 'null')
    if (v && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(v[k]))) return { ...fallback, ...v, collapsed: !!v.collapsed, snapped: !!v.snapped }
  } catch { /* obsolete window state */ }
  return fallback
}
