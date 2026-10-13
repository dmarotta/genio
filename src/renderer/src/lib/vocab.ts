import type { AwayMode, DeliveryMode, Engine, Priority, ProjectMode, TaskKind, TaskState } from '@shared/types'

export type Tone = 'neon' | 'volt' | 'amber' | 'alert' | 'violet' | 'mute'

export const MODE_LABEL: Record<ProjectMode, string> = {
  'no-mistakes': 'Hardcore',
  'direct-PR': 'Standard',
  'local-only': 'Offline',
  'no-mistakes-prod-only': 'Hardcore (prod)'
}

export const MODE_HINT: Record<ProjectMode, string> = {
  'no-mistakes': 'Full Gauntlet: review, fix rounds, checks, then a PR',
  'direct-PR': 'The unit pushes and opens a PR itself',
  'local-only': 'A clean local branch; fast-forward merge on your word',
  'no-mistakes-prod-only': 'Product work runs Hardcore, internal tooling runs Standard'
}

export const DELIVERY_MODES: DeliveryMode[] = ['no-mistakes', 'direct-PR', 'local-only']
export const PROJECT_MODES: ProjectMode[] = ['no-mistakes', 'no-mistakes-prod-only', 'direct-PR', 'local-only']

export const KIND_LABEL: Record<TaskKind, string> = { ship: 'Build', scout: 'Recon' }

export const STATE_LABEL: Record<TaskState, string> = {
  spawning: 'Deploying',
  working: 'Working',
  paused: 'Waiting',
  blocked: 'Blocked',
  'needs-decision': 'Your move',
  validating: 'Gauntlet',
  ready: 'Ready',
  merged: 'Merged',
  done: 'Done',
  failed: 'Failed',
  exited: 'Exited',
  stale: 'Lagging',
  detached: 'Detached',
  cleaned: 'Despawned'
}

export function stateTone(s: TaskState): Tone {
  switch (s) {
    case 'spawning':
    case 'working':
    case 'validating':
      return 'neon'
    case 'needs-decision':
      return 'amber'
    case 'paused':
      return 'mute'
    case 'blocked':
    case 'failed':
    case 'exited':
    case 'stale':
      return 'alert'
    case 'ready':
    case 'merged':
    case 'done':
      return 'volt'
    default:
      return 'mute'
  }
}

export const isActive = (s: TaskState): boolean => s === 'spawning' || s === 'working' || s === 'validating'

export const ENGINE_LABEL: Record<Engine, string> = {
  godot: 'Godot',
  unity: 'Unity',
  unreal: 'Unreal',
  bevy: 'Bevy',
  web: 'Web',
  love2d: 'LÖVE',
  gamemaker: 'GameMaker',
  defold: 'Defold',
  monogame: 'MonoGame',
  other: 'Other'
}

export const ENGINE_COLOR: Record<Engine, string> = {
  godot: '#478cbf',
  unity: '#e4efff',
  unreal: '#c9c9d4',
  bevy: '#f0a35e',
  web: '#00e5ff',
  love2d: '#e74a99',
  gamemaker: '#8bc34a',
  defold: '#ff7a3d',
  monogame: '#e73c00',
  other: '#8a98ad'
}

export const ENGINES: Engine[] = ['godot', 'unity', 'unreal', 'bevy', 'love2d', 'gamemaker', 'defold', 'monogame', 'web', 'other']

export const PRESENCE: { mode: AwayMode; label: string; hint: string }[] = [
  { mode: 'online', label: 'Online', hint: 'Genio reports everything in Comms' },
  { mode: 'dnd', label: 'DND', hint: 'Routine events handled off-screen; only real choices reach you' },
  { mode: 'afk', label: 'AFK', hint: 'The Bot plays for you; outcomes replay when you return' }
]

export const PRIORITY_GLYPH: Record<Priority, { glyph: string; tone: Tone; label: string }> = {
  critical: { glyph: '◆', tone: 'alert', label: 'Critical' },
  high: { glyph: '▲', tone: 'amber', label: 'High' },
  normal: { glyph: '●', tone: 'neon', label: 'Normal' },
  low: { glyph: '▽', tone: 'mute', label: 'Low' }
}

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']


export const toneVar = (t: Tone): string => (t === 'mute' ? 'var(--text-mute)' : `var(--${t})`)
