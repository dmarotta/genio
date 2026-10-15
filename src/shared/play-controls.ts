import type { PlayerState } from './play'

/** What a control does in main: the Unity button, Play ▶/■, Pause ‖ and Step ⏭. */
export type UnityAction = 'start' | 'start-anyway' | 'cancel' | 'stop' | 'restart' | 'close-again'
export type PlayButtonAction = 'enter' | 'enter-anyway' | 'exit'
export interface PlayerControl<A extends string> {
  label: string
  enabled: boolean
  action: A
  /** Drawn pressed: ■ while Play runs (like Unity's blue ▶), ‖ while paused. */
  active?: boolean
  /** The amber Start anyway of low memory. */
  warn?: boolean
}
export interface PlayerControls {
  unity: PlayerControl<UnityAction>
  play: PlayerControl<PlayButtonAction>
  pause: PlayerControl<'pause'>
  step: PlayerControl<'step'>
  /** The scene and resolution dropdowns: off only while Genio is mid-transition. */
  scene: { enabled: boolean }
  resolution: { enabled: boolean }
}

const BUSY: ReadonlySet<PlayerState> = new Set(['copying', 'starting', 'syncing', 'entering-play', 'exiting-play', 'shutting-down', 'close-stuck'])

/**
 * The Play toolbar for one instance state (Recon appendix B2). ▶ from Off starts Unity, then enters Play (D1).
 * `syncing` only happens while a running editor mirrors a new source on its way into Play (a cold start reports
 * `copying`), so it reads as Entering Play: ■ cancels the Play and Unity stays up. `hard`: low memory that Windows
 * cannot even commit (status.lowMemory.hard), where nothing offers Start anyway and the buttons only retry.
 */
export function controls(state: PlayerState | undefined, { hard = false }: { hard?: boolean } = {}): PlayerControls {
  const s = state ?? 'idle'
  const unity = (label: string, action: UnityAction, enabled = true, warn?: boolean): PlayerControl<UnityAction> => ({ label, action, enabled, ...(warn ? { warn } : {}) })
  const enter = (enabled: boolean, action: PlayButtonAction = 'enter'): PlayerControl<PlayButtonAction> => ({ label: 'Enter Play', action, enabled })
  const exit = (enabled: boolean): PlayerControl<PlayButtonAction> => ({ label: 'Exit Play', action: 'exit', enabled, active: true })
  const live = s === 'playing' || s === 'paused'
  const pause: PlayerControl<'pause'> = { label: s === 'paused' ? 'Resume' : 'Pause', action: 'pause', enabled: live, ...(s === 'paused' ? { active: true } : {}) }
  const step: PlayerControl<'step'> = { label: 'Step', action: 'step', enabled: live }
  const dropdowns = { scene: { enabled: !BUSY.has(s) }, resolution: { enabled: s !== 'close-stuck' } }
  const row = (u: PlayerControl<UnityAction>, p: PlayerControl<PlayButtonAction>): PlayerControls => ({ unity: u, play: p, pause, step, ...dropdowns })
  switch (s) {
    case 'idle': case 'crashed': case 'error': case 'missing-editor': return row(unity('Start Unity', 'start'), enter(true))
    case 'low-memory': return hard ? row(unity('Start Unity', 'start'), enter(true)) : row(unity('Start anyway', 'start-anyway', true, true), enter(true, 'enter-anyway'))
    case 'limit-reached': return row(unity('Start Unity', 'start', false), enter(false))
    case 'copying': case 'starting': return row(unity('Cancel', 'cancel'), enter(false))
    case 'ready': case 'compile-errors': return row(unity('Stop Unity', 'stop'), enter(true))
    case 'syncing': case 'entering-play': case 'playing': case 'paused': return row(unity('Stop Unity', 'stop'), exit(true))
    case 'exiting-play': return row(unity('Stop Unity', 'stop', false), exit(false))
    case 'shutting-down': return row(unity('Stopping…', 'stop', false), enter(false))
    case 'stuck-dialog': return row(unity('Restart Unity', 'restart'), enter(false))
    case 'close-stuck': return row(unity('Close again', 'close-again'), enter(false))
  }
}
