import type { Project, ProjectMode } from './types'

/** Player-facing names for delivery modes (see docs/VOCABULARY.md). */
export const MODE_LABEL: Record<ProjectMode, string> = {
  'no-mistakes': 'Hardcore',
  'direct-PR': 'Standard',
  'local-only': 'Offline',
  'no-mistakes-prod-only': 'Hardcore (prod)'
}

export function modeLabel(mode?: string): string {
  return (mode && MODE_LABEL[mode as ProjectMode]) || mode || 'Recon'
}

/** Whether a world's mode follows its remote. Older entries predate the flag: only the old
 *  no-remote default (Offline without a remote) counts as automatic; anything else was chosen. */
export function modeSourceOf(p: Pick<Project, 'mode' | 'modeSource' | 'remote'>): 'auto' | 'manual' {
  if (p.modeSource) return p.modeSource
  return !p.remote && p.mode === 'local-only' ? 'auto' : 'manual'
}
