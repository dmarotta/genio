import type { CloneOptions } from '../skills/play/scripts/clone.mjs'
import type { SeedOptions, SeedReport } from './unity-seed.mjs'
import type { MirrorFiles, MirrorOptions, MirrorProgress, MirrorReport, MirrorSource, RestartAdvice, SourceInfo } from './git-mirror.mjs'

export interface PlayerCopyPolicy { keepCopyWhenEditorQuits: boolean }
export const PLAYER_COPY_POLICY: Readonly<PlayerCopyPolicy>
export const DEFAULT_IDLE_MS: number
export interface PlayerOwner { pid: number; created: string }
/**
 * ready: usable; syncing: a sync runs; pending-delete: marked for deletion, waiting (blocked, timed out, or
 * Genio exited first); deleting: the background deletion runs. A pending or running deletion can be revived.
 */
export type PlayerCopyState = 'ready' | 'syncing' | 'pending-delete' | 'deleting'
export interface PlayerDeletion {
  reason?: string; requestedAt?: number; startedAt?: number
  phase?: 'starting' | 'mirror' | 'library' | 'finishing' | 'stopped' | 'done'
  bytesTotal?: number; bytesLeft?: number; filesTotal?: number; filesLeft?: number
  /** Why it waits: the editor still holds the copy, or a safety check refused the folder. */
  blocked?: string
  error?: string
}
export interface PlayerLastSync {
  at: number; source?: SourceInfo; complete: boolean; elapsedMs: number
  files?: MirrorFiles; bytes?: { copied: number; deleted: number }; restart?: RestartAdvice
  lfsPointers?: string[]; warnings?: string[]; error?: string; cancelled?: boolean
}
export interface PlayerCopyRecord {
  version: 1; key: string; id: string
  /** The project's main checkout. */
  project: string; engineRoot: string
  /** The copy folder (Genio-owned, marked), and the Unity project root inside it that the editor opens. */
  dir: string; root: string
  state: PlayerCopyState
  createdAt: number; revivedAt?: number
  owner?: PlayerOwner
  source?: SourceInfo
  lastSync?: PlayerLastSync
  /** Idle timer: the editor quits (and the copy is deleted) at deadline = stoppedAt + idleMs. */
  idleMs: number; stoppedAt?: number; deadline?: number; lastPlayedAt?: number
  library?: { version?: string; at: number }
  deletion?: PlayerDeletion
  /** A running sync. */
  progress?: MirrorProgress & { startedAt: number; source?: SourceInfo }
}
export interface LibraryReport { version?: string; stashed?: string; restored?: string; seed?: SeedReport; deferred?: string }
export interface PlayerSyncReport extends MirrorReport { source: SourceInfo; library?: LibraryReport }
export interface PlayerCopySizes {
  exists: boolean; state?: PlayerCopyState
  projectBytes?: number; libraryBytes?: number; stashBytes?: number; trashBytes?: number; totalBytes?: number; files?: number
  deletion?: PlayerDeletion
  /** No copy yet: what the first copy would take. */
  estimate?: { projectBytes: number; libraryBytes: number; totalBytes: number; files: number }
}
export interface SweepResult { key: string; project?: string; action: 'deleting' | 'owned' | 'editor-running' | 'kept' | 'stray-deleted'; pid?: number; pids?: number[] }
export interface PlayerCopiesOptions {
  policy?: Partial<PlayerCopyPolicy>
  clone?: CloneOptions
  /** Tests: a slow copy, and the Library robocopy runner. */
  io?: MirrorOptions['io'] & { run?: SeedOptions['run'] }
  statfs?: SeedOptions['statfs']
  system?: { alive?: (pid: number) => boolean; created?: (pid: number) => Promise<string> }
  deletion?: { concurrency?: number; timeoutMs?: number; retries?: number }
  env?: Record<string, string | undefined>
}
export function processCreated(pid: number): Promise<string>
export class PlayerCopies {
  constructor(data: string, options?: PlayerCopiesOptions)
  readonly dir: string
  policy: PlayerCopyPolicy
  keyOf(world: string): string
  markerOk(record: PlayerCopyRecord): boolean
  list(): PlayerCopyRecord[]
  status(world: string): PlayerCopyRecord | undefined
  ensure(world: string, engineRoot?: string): Promise<PlayerCopyRecord>
  sync(world: string, source: MirrorSource, options?: { signal?: AbortSignal; onProgress?: (p: NonNullable<PlayerCopyRecord['progress']>) => void; exclude?: string[]; beforeApply?: (restart: RestartAdvice) => Promise<void> }): Promise<PlayerSyncReport>
  cancel(world: string): boolean
  stopped(world: string, at?: number, idleMs?: number): Promise<PlayerCopyRecord | undefined>
  playing(world: string, at?: number): Promise<PlayerCopyRecord | undefined>
  due(now?: number): PlayerCopyRecord[]
  editorGone(world: string, reason?: string, options?: { manual?: boolean; at?: number; idleMs?: number }): Promise<{ kept?: boolean; deleted?: boolean; record?: PlayerCopyRecord }>
  deleteInBackground(world: string, options?: { reason?: string }): Promise<{ deleted: boolean; record?: PlayerCopyRecord }>
  delete(world: string, options?: { reason?: string }): Promise<{ deleted: boolean; record?: PlayerCopyRecord }>
  editorPids(root: string): number[]
  settle(): Promise<void>
  sweep(options?: { protectedKeys?: string[] }): Promise<SweepResult[]>
  sizes(world: string, engineRoot?: string): Promise<PlayerCopySizes>
}
