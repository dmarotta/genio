import type { Engine } from './types'

/** Engines the Play screen can drive. The single switch for Play: nav, routing and the main-process service all read it. */
export const PLAY_ENGINES: readonly Engine[] = ['unity']

/** True when a project with this engine gets the Play screen. Unset or unknown engines never do. */
export function supportsPlay(engine: Engine | undefined): boolean {
  return !!engine && PLAY_ENGINES.includes(engine)
}

export interface PlayScene { name: string; path: string; isDirty?: boolean; isActive?: boolean }
export interface PlayStatus {
  connected: boolean
  state: 'stopped' | 'playing' | 'paused' | 'compiling' | 'reloading' | 'gone'
  message?: string
  genioDriving?: boolean
  scenes: PlayScene[]
  capabilities: { resolution: boolean; input: boolean }
}
export interface PlayFrame { base64: string; width: number; height: number; capturedAt: string; latencyMs: number }
export interface PlayConsole { entries: { message: string; level?: string; stackTrace?: string; seq?: number }[]; cursor?: number; session?: string; reset?: boolean }
export interface PlayStats {
  fps?: number
  render?: { drawCalls: number; triangles: number }
  memory?: { totalAllocatedBytes: number }
  frameTiming?: { available: boolean; cpuFrameTimeMs: number; gpuFrameTimeMs: number }
}
export type PlayAction =
  | { type: 'play' | 'pause' | 'stop' | 'step' }
  | { type: 'scene'; path: string }
  | { type: 'resolution'; width: number; height: number }
  | { type: 'key'; key: string }
  | { type: 'pointer'; x: number; y: number }

export type PlayInput = { type: 'release' } | { type: 'state'; keys: string[]; x: number; y: number; buttons: number; axes: number[]; gamepadButtons: number }
/** stuck: the slot editor would not close; nobody can lease the slot until Genio or the player recovers it. */
export interface PlaySlot { id: number; root: string; revision?: string; owner?: string; expires?: number; preparing?: boolean; editor?: boolean; closing?: boolean; stuck?: { reason: string; pids: number[]; at: number } }
export interface PlayPoolState { cap: number; slots: PlaySlot[]; queue: string[]; selected?: number }

/** Delay after completion: no overlapping captures or catch-up bursts. */
export function snapshotDelay(latencyMs: number, failures = 0): number {
  return failures ? Math.min(10000, 1000 * 2 ** Math.min(failures, 4)) : Math.max(200, 1000 - latencyMs)
}
