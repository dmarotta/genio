import type { ProjectMode } from './types'

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
