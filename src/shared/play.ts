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
/**
 * draining: above a lowered cap but still in use; retired: above the cap and idle, kept for reuse.
 * stuck: the slot editor would not close; nobody can lease the slot until Genio or the player recovers it.
 */
export interface PlayPreparation {
  at: number; elapsedMs: number; preflightMs: number; gitMs: number; bytes: number; files: number
  estimatedBytes: number; requiredBytes: number; availableBytes: number; lfsStorage: string
  library: import('../../resources/unit-skills/genio/lib/unity-seed.mjs').SeedReport
}
export interface PlaySlot { id: number; root: string; revision?: string; owner?: string; expires?: number; preparing?: boolean; preparation?: PlayPreparation; editor?: boolean; closing?: boolean; stuck?: { reason: string; pids: number[]; at: number }; draining?: boolean; retired?: boolean }
export interface PlayPoolState { cap: number; slots: PlaySlot[]; queue: string[]; selected?: number }

/** Deep-link target: the Play screen's "N of X slots in use" opens Settings › This project › Unity slots. */
export const UNITY_SLOTS_ANCHOR = 'unity-slots'

/** Slots within the cap that are taken right now: leased, preparing, closing, stuck, or with an editor open. Draining slots are counted apart. */
export function slotsInUse(state: Pick<PlayPoolState, 'slots' | 'cap'>): number {
  return state.slots.filter(s => s.id <= state.cap && (s.owner || s.preparing || s.editor || s.closing || s.stuck)).length
}

/** "you" for the Play screen's lease, the unit's title for a unit lease. */
export function ownerLabel(owner: string, tasks: { id: string; title: string }[]): string {
  if (owner.startsWith('player:')) return 'you (Play screen)'
  const id = owner.startsWith('unit:') ? owner.slice(5) : owner
  const task = tasks.find(t => t.id === id)
  return task ? `unit ${task.title}` : `unit ${id}`
}

/** One plain status word for a slot, most urgent first. */
export function slotStatus(slot: PlaySlot | undefined): 'stuck' | 'closing' | 'preparing' | 'leased' | 'editor' | 'retired' | 'free' {
  if (!slot) return 'free'
  if (slot.stuck) return 'stuck'
  if (slot.closing) return 'closing'
  if (slot.preparing) return 'preparing'
  if (slot.owner) return 'leased'
  if (slot.editor) return 'editor'
  return slot.retired ? 'retired' : 'free'
}

/** Delay after completion: no overlapping captures or catch-up bursts. */
export function snapshotDelay(latencyMs: number, failures = 0): number {
  return failures ? Math.min(10000, 1000 * 2 ** Math.min(failures, 4)) : Math.max(200, 1000 - latencyMs)
}
