/** The floating Genio panel's geometry, relative to the project window's stage. */
export interface FloatingPanelState { x: number; y: number; width: number; height: number; collapsed: boolean }
export const PANEL_MIN = { width: 300, height: 240 }

/**
 * Fit the panel inside the stage so it can never be lost: shrink to the stage when it is smaller,
 * then pull the whole panel (header first) back on screen. Free placement otherwise; no snapping.
 */
export function clampFloatingPanel(s: FloatingPanelState, width: number, height: number): FloatingPanelState {
  const w = Math.max(0, Math.min(width, Math.max(PANEL_MIN.width, s.width))), h = Math.max(0, Math.min(height, Math.max(PANEL_MIN.height, s.height)))
  return { ...s, width: w, height: h, x: Math.max(0, Math.min(width - w, s.x)), y: Math.max(0, Math.min(height - h, s.y)) }
}

const key = (project: string): string => `genio.panel.${project}`
const fallback: FloatingPanelState = { x: 10_000, y: 10_000, width: 460, height: 520, collapsed: false }

/** Remembered per project; the default lands bottom-right after clamping. */
export function readFloatingPanel(project: string): FloatingPanelState {
  try {
    const v = JSON.parse(localStorage.getItem(key(project)) || 'null')
    if (v && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(v[k]))) return { x: v.x, y: v.y, width: v.width, height: v.height, collapsed: !!v.collapsed }
  } catch { /* storage unavailable or obsolete */ }
  return fallback
}
export function writeFloatingPanel(project: string, s: FloatingPanelState): void {
  try { localStorage.setItem(key(project), JSON.stringify(s)) } catch { /* storage unavailable */ }
}
