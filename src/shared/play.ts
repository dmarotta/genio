import type { Engine } from './types'
import type { MirrorSource as PlayerCopySource } from '../../resources/unit-skills/genio/lib/git-mirror.mjs'

/** Engines with shared Unity slots and Genio's editor tools. The single switch: Settings, units and the main-process service all read it. */
export const UNITY_SLOT_ENGINES: readonly Engine[] = ['unity']

/** True when a project with this engine gets Unity slots. Unset or unknown engines never do. */
export function supportsUnitySlots(engine: Engine | undefined): boolean {
  return !!engine && UNITY_SLOT_ENGINES.includes(engine)
}

export interface PlayScene { name: string; path: string; isDirty?: boolean; isActive?: boolean }
export interface PlayStatus {
  connected: boolean
  state: 'stopped' | 'playing' | 'paused' | 'compiling' | 'reloading' | 'gone'
  message?: string
  scenes: PlayScene[]
  capabilities: { input: boolean }
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
  | { type: 'play' | 'pause' | 'stop' }
  | { type: 'scene'; path: string }
  | { type: 'key'; key: string }
  | { type: 'pointer'; x: number; y: number }

export type PlayInput = { type: 'release' } | { type: 'state'; keys: string[]; x: number; y: number; buttons: number; axes: number[]; gamepadButtons: number }

export interface PlayerSettings { idleMinutes: number; maxEditors: number }
export type PlayerState = 'idle' | 'copying' | 'starting' | 'syncing' | 'entering-play' | 'playing' | 'stopped-warm' | 'shutting-down' | 'crashed' | 'stuck-dialog' | 'close-stuck' | 'compile-errors' | 'low-memory' | 'missing-editor' | 'limit-reached' | 'error'
export interface PlayerInstanceStatus {
  state: PlayerState; project: string; root?: string; source?: PlayerCopySource
  pid?: number; created?: string; desktop?: string; deadline?: number; stoppedAt?: number
  unityVersion?: string; peakWorkingSet?: number; message?: string; startup?: string; exitCode?: number
  dialog?: import('../../resources/unit-skills/genio/lib/hidden-desktop.mjs').DialogBlock
  capabilities?: { input: boolean }
  copy?: import('../../resources/unit-skills/genio/lib/player-copy.mjs').PlayerCopyRecord
}
export interface PlayerMachineStatus {
  settings: PlayerSettings; playerEditors: number; unitEditors: number; batchEditors: number; totalEditors: number
  workingSetBytes: number; freeBytes: number; totalBytes: number
}

/**
 * draining: above a lowered cap but still in use; retired: above the cap and idle, kept for reuse.
 * stuck: the slot editor would not close; nobody can lease the slot until Genio or the player recovers it.
 */
export interface PlayPreparation {
  at: number; elapsedMs: number; preflightMs: number; gitMs: number; bytes: number; files: number
  estimatedBytes: number; requiredBytes: number; availableBytes: number; lfsStorage: string
  library: import('../../resources/unit-skills/genio/lib/unity-seed.mjs').SeedReport
  /** What the slot reset before this switch: files Unity created or changed in its own copy. */
  reset?: { at: number; untracked: number; modified: number }
  /** The slot's git submodules, checked out from the source's local copies; only changed ones are touched. */
  submodules?: { elapsedMs: number; entries: { path: string; action?: string }[]; problems?: string[] }
}
/**
 * window: where the running slot editor shows, 'hidden' on Genio's hidden desktop. warning: why a hidden
 * launch fell back to a visible window. failure: the dialog that blocked the last lease, with its screenshot.
 */
export interface PlaySlot { id: number; root: string; revision?: string; owner?: string; expires?: number; preparing?: boolean; preparation?: PlayPreparation; editor?: boolean; closing?: boolean; stuck?: { reason: string; pids: number[]; at: number }; draining?: boolean; retired?: boolean; window?: 'hidden' | 'visible'; warning?: string; failure?: { message: string; at: number; screenshot?: string } }
/** launch: slot editors open on a hidden desktop (default) or visibly, for debugging. */
export interface PlayPoolState { cap: number; launch?: 'hidden' | 'visible'; slots: PlaySlot[]; queue: string[] }

/** The player's own Play copy (one per project, outside the slot pool): records, sync reports and sizes. */
export type { PlayerCopyRecord, PlayerSyncReport, PlayerCopySizes } from '../../resources/unit-skills/genio/lib/player-copy.mjs'
/** A checkout of the project ({ path }) or a branch, tag or commit without one ({ ref }). */
export type { MirrorSource as PlayerCopySource } from '../../resources/unit-skills/genio/lib/git-mirror.mjs'

/** Deep-link target for Settings › This project › Unity slots. */
export const UNITY_SLOTS_ANCHOR = 'unity-slots'

/** Slots within the cap that are taken right now: leased, preparing, closing, stuck, or with an editor open. Draining slots are counted apart. */
export function slotsInUse(state: Pick<PlayPoolState, 'slots' | 'cap'>): number {
  return state.slots.filter(s => s.id <= state.cap && (s.owner || s.preparing || s.editor || s.closing || s.stuck)).length
}

/** "you" for a lease Genio took for the player, the unit's title for a unit lease. */
export function ownerLabel(owner: string, tasks: { id: string; title: string }[]): string {
  if (owner.startsWith('player:')) return 'you'
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
